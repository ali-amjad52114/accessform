'use client';

/**
 * Nutrient Web SDK viewer with an accessible degradation path.
 *
 * The SDK is pulled from Nutrient's CDN as a UMD bundle (loading it through the
 * npm package would make Next.js re-bundle a 6 MB library and its WASM assets),
 * and licensed with the browser-safe `pdf_pub_live_` publishable key.
 *
 * If the SDK cannot be fetched, cannot mount, or simply takes too long, the
 * component falls back to a native embedded PDF view. The demo always reaches a
 * visible filled document; it never reaches a broken page.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import styles from './DocumentViewer.module.css';

const SDK_VERSION = '1.21.0';
const SDK_BASE_URL = `https://cdn.cloud.nutrient.io/pspdfkit-web@${SDK_VERSION}/`;
const SDK_SRC = `${SDK_BASE_URL}nutrient-viewer.js`;
const SDK_TIMEOUT_MS = 20_000;

interface NutrientViewerApi {
  load(config: {
    container: HTMLElement;
    document: string;
    licenseKey?: string;
    baseUrl?: string;
    styleSheets?: string[];
  }): Promise<unknown>;
  unload(target: HTMLElement | unknown): void;
}

declare global {
  interface Window {
    NutrientViewer?: NutrientViewerApi;
  }
}

function loadSdk(): Promise<NutrientViewerApi> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Nutrient Web SDK requires a browser'));
  }
  if (window.NutrientViewer) return Promise.resolve(window.NutrientViewer);

  return new Promise<NutrientViewerApi>((resolve, reject) => {
    const settle = () => {
      if (window.NutrientViewer) resolve(window.NutrientViewer);
      else reject(new Error('Nutrient Web SDK loaded without exposing NutrientViewer'));
    };

    const existing = document.querySelector<HTMLScriptElement>('script[data-nutrient-viewer]');
    if (existing) {
      existing.addEventListener('load', settle, { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('Nutrient Web SDK script failed to load')),
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.src = SDK_SRC;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.nutrientViewer = 'true';
    script.addEventListener('load', settle, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Nutrient Web SDK script failed to load')),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export type ViewerMode = 'loading' | 'sdk' | 'embedded';

export interface DocumentViewerProps {
  /** Same-origin URL that streams the PDF, e.g. /api/document/AF-001. */
  documentUrl: string;
  /** Screen-reader name for the document region. */
  title: string;
  /** Notified whenever the viewer changes mode, for the status line. */
  onModeChange?: (mode: ViewerMode) => void;
}

export default function DocumentViewer({
  documentUrl,
  title,
  onModeChange,
}: DocumentViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<ViewerMode>('loading');
  const [forcedPlain, setForcedPlain] = useState(false);
  const statusId = useId();

  const changeMode = useCallback(
    (next: ViewerMode) => {
      setMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  useEffect(() => {
    if (forcedPlain) {
      changeMode('embedded');
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let instance: unknown = null;

    /* Browser-safe key from NEXT_PUBLIC_NUTRIENT_VIEWER_KEY.
       Verified against Web SDK 1.21.0: a `pdf_pub_*` publishable key is issued
       for Nutrient's hosted viewer, and the standalone SDK core rejects it with
       "Could not decode license key" and refuses to initialise. So we only hand
       over a real Web SDK license key, and the retry below is the safety net if
       even that is rejected. */
    const rawKey = process.env.NEXT_PUBLIC_NUTRIENT_VIEWER_KEY;
    const licenseKey = rawKey && !rawKey.startsWith('pdf_pub_') ? rawKey : undefined;

    void (async () => {
      try {
        const sdk = await withTimeout(loadSdk(), SDK_TIMEOUT_MS, 'Nutrient Web SDK download');
        if (cancelled) return;

        try {
          sdk.unload(container);
        } catch {
          /* nothing mounted yet */
        }

        const mount = (key?: string) =>
          withTimeout(
            sdk.load({
              container,
              document: documentUrl,
              // Pin where the WASM/worker assets come from; auto-detection is
              // deprecated and warns from SDK 1.9 onward.
              baseUrl: SDK_BASE_URL,
              ...(key ? { licenseKey: key } : {}),
            }),
            SDK_TIMEOUT_MS,
            'Nutrient Viewer document load',
          );

        try {
          instance = await mount(licenseKey);
        } catch (licenseError) {
          if (cancelled) return;
          if (!licenseKey) throw licenseError;
          console.warn('[AccessForm] Retrying Nutrient Viewer without a license key.', licenseError);
          try {
            sdk.unload(container);
          } catch {
            /* nothing mounted */
          }
          instance = await mount();
        }

        if (cancelled) {
          try {
            sdk.unload(instance ?? container);
          } catch {
            /* already gone */
          }
          return;
        }
        changeMode('sdk');
      } catch (error) {
        if (cancelled) return;
        console.warn('[AccessForm] Nutrient Viewer unavailable, using embedded PDF view.', error);
        changeMode('embedded');
      }
    })();

    return () => {
      cancelled = true;
      try {
        window.NutrientViewer?.unload(instance ?? container);
      } catch {
        /* nothing to unload */
      }
    };
  }, [documentUrl, forcedPlain, changeMode]);

  const usingSdk = mode === 'sdk';

  return (
    <div className={styles.wrap}>
      <div
        className={styles.stage}
        role="region"
        aria-label={title}
        aria-describedby={statusId}
        tabIndex={-1}
        id="application-document"
      >
        {/* The SDK measures this node while it boots, so it must stay laid out
            and sized. The loading notice sits on top of it instead. */}
        {!forcedPlain && mode !== 'embedded' && (
          <div ref={containerRef} className={styles.sdkContainer} />
        )}

        {mode === 'loading' && !forcedPlain && (
          <p className={styles.placeholder} role="status">
            Preparing your filled application…
          </p>
        )}

        {mode === 'embedded' && (
          <object
            className={styles.embed}
            data={documentUrl}
            type="application/pdf"
            aria-label={title}
          >
            <iframe className={styles.embed} src={documentUrl} title={title} />
          </object>
        )}
      </div>

      <p className={styles.status} id={statusId}>
        <span aria-hidden="true" className={styles.statusIcon}>
          {usingSdk ? '◆' : '○'}
        </span>{' '}
        {usingSdk
          ? 'Shown in the Nutrient document viewer.'
          : 'Shown in your browser’s built-in PDF view.'}
      </p>

      <div className={styles.viewerActions}>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => setForcedPlain((plain) => !plain)}
        >
          {forcedPlain ? 'Use the Nutrient document viewer' : 'Use my browser’s PDF view instead'}
        </button>
        <a className={styles.linkButton} href={documentUrl} target="_blank" rel="noreferrer">
          Open the filled application in a new tab
        </a>
      </div>
    </div>
  );
}
