/**
 * Environment access for the adapter layer.
 *
 * Rules encoded here:
 * - Secrets (SerpApi, the three Nutrient server keys, Vapi private key, Xano)
 *   are read through `serverSecret()` which refuses to hand anything back when
 *   it is evaluated in a browser bundle. Those keys must never reach the client.
 * - `NEXT_PUBLIC_*` values are read via literal member access so Next.js can
 *   statically inline them.
 */

/** True when this module is evaluating inside a browser. */
export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

type ProcessEnvLike = Record<string, string | undefined>;

function env(): ProcessEnvLike {
  if (typeof process === 'undefined' || !process.env) return {};
  return process.env as unknown as ProcessEnvLike;
}

/**
 * Read a server-only secret. Returns `undefined` in the browser so a stray
 * client import can never leak a key — it degrades to fixtures instead.
 */
export function serverSecret(name: string): string | undefined {
  if (isBrowser()) return undefined;
  const value = env()[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read a server-only secret or throw — only call this behind a `has*` guard. */
export function requireServerSecret(name: string): string {
  const value = serverSecret(name);
  if (!value) {
    throw new Error(
      `Missing server environment variable ${name}. ` +
        'Set it in app/.env.local, or run with NEXT_PUBLIC_DEMO_MODE=true to use fixtures.',
    );
  }
  return value;
}

function publicValue(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Demo mode. Default is `true`: the demo must never break, and live SerpApi
 * calls cost real credits, so anything other than an explicit "false" opts in
 * to fixtures.
 */
export function isDemoMode(): boolean {
  const raw = publicValue(process.env.NEXT_PUBLIC_DEMO_MODE);
  if (raw === undefined) return true;
  return raw.toLowerCase() !== 'false' && raw !== '0';
}

/** Browser-safe Nutrient Viewer key (`pdf_pub_live_…`). 401s on the REST API. */
export function nutrientViewerKey(): string | undefined {
  return publicValue(process.env.NEXT_PUBLIC_NUTRIENT_VIEWER_KEY);
}

/** Browser-safe Vapi public key, used by the Vapi web SDK only. */
export function vapiPublicKey(): string | undefined {
  return publicValue(process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY);
}

/* ------------------------------------------------------------------ */
/* Per-integration credential checks                                   */
/* ------------------------------------------------------------------ */

export interface XanoCredentials {
  baseUrl: string;
  apiKey?: string;
}

/**
 * Xano needs a base URL. `XANO_API_KEY` is optional — the workspace 2 branch
 * may expose the endpoints without auth.
 */
export function xanoCredentials(): XanoCredentials | undefined {
  const baseUrl = serverSecret('XANO_BASE_URL');
  if (!baseUrl) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: serverSecret('XANO_API_KEY'),
  };
}

export function serpApiKey(): string | undefined {
  return serverSecret('SERPAPI_API_KEY');
}

export interface NutrientKeys {
  /** POST https://api.nutrient.io/build */
  processor?: string;
  /** POST https://api.nutrient.io/extraction/parse */
  extraction?: string;
  /** POST https://api.nutrient.io/accessibility/autotag */
  accessibility?: string;
}

/**
 * Three separate keys, each locked to exactly one path. A key used on the wrong
 * path returns 403; a wrong key returns 401. There is no base-URL env var.
 */
export function nutrientKeys(): NutrientKeys {
  return {
    processor: serverSecret('NUTRIENT_DWS_PROCESSOR_API'),
    extraction: serverSecret('NUTRIENT_DATA_EXTRACTION_API'),
    accessibility: serverSecret('NUTRIENT_ACCESSIBILITY_API'),
  };
}

export function hasAllNutrientKeys(): boolean {
  const keys = nutrientKeys();
  return Boolean(keys.processor && keys.extraction && keys.accessibility);
}

/* ------------------------------------------------------------------ */
/* Document engine                                                     */
/* ------------------------------------------------------------------ */

/** Which implementation fills and flattens the official PDF. */
export type DocumentEngineName = 'nutrient' | 'local';

/**
 * `DOCUMENT_ENGINE` selects the fill engine. Default is `local` (pdf-lib, no
 * paid API, no evaluation watermark). `nutrient` is honoured only when it is
 * set explicitly AND `NUTRIENT_DWS_PROCESSOR_API` is present — the paid path
 * can never be selected by accident. Mirrors `lib/document/engine.ts`
 * `resolveEngine()` without importing it, so this module stays dependency-free.
 */
export function documentEngine(): DocumentEngineName {
  const raw = env().DOCUMENT_ENGINE;
  const wanted = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (wanted === 'nutrient' && serverSecret('NUTRIENT_DWS_PROCESSOR_API')) {
    return 'nutrient';
  }
  return 'local';
}

export function vapiPrivateKey(): string | undefined {
  return serverSecret('VAPI_PRIVATE_KEY');
}
