'use client';

/**
 * Authoritative case state for the conversation page, read from
 * GET /api/voice/case/:caseId. Fetched once on mount, every 2 s while the
 * browser call is active, and once more after it ends. Errors are surfaced
 * as text; there is no fixture fallback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CaseBundle,
  CaseEvent,
  CaseProgress,
  CompletenessSummary,
  Id,
} from '../../lib/contract';

export interface CaseStatePayload {
  bundle: CaseBundle;
  progress: CaseProgress | null;
  completeness: CompletenessSummary | null;
  events: CaseEvent[];
  /**
   * Signed, absolute link to the filled document (the same link the SMS
   * carries). The bare /api/document/:id route is token-gated in live mode,
   * so this is the only link that opens. Null until a document exists.
   */
  documentUrl: string | null;
}

export interface UseCaseStateResult {
  data: CaseStatePayload | null;
  /** Human sentence describing the last failed read, or null. */
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const POLL_MS = 2000;
const IDLE_POLL_MS = 4000;
/** One full read (with Xano progress) per this many polls. */
const FULL_EVERY = 4;
const SETTLE_MS = 900;

export function useCaseState(caseId: Id, active: boolean): UseCaseStateResult {
  const [data, setData] = useState<CaseStatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  /** Every Nth read asks Xano for progress; the others are light. */
  const reads = useRef(0);
  const lastProgress = useRef<CaseProgress | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const full = reads.current % FULL_EVERY === 0;
    reads.current += 1;
    try {
      const response = await fetch(`/api/voice/case/${encodeURIComponent(caseId)}${full ? '' : '?light=1'}`, {
        cache: 'no-store',
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        /* handled below */
      }
      if (!mounted.current) return;
      if (!response.ok) {
        const record = (payload ?? {}) as { error?: string; detail?: string };
        setError(record.error || `This conversation could not be loaded (HTTP ${response.status}).`);
        return;
      }
      const record = (payload ?? {}) as Partial<CaseStatePayload>;
      if (!record.bundle || !record.bundle.case) {
        setError('The server returned an incomplete conversation.');
        return;
      }
      if (record.progress) lastProgress.current = record.progress;
      setData({
        bundle: record.bundle,
        progress: record.progress ?? lastProgress.current,
        completeness: record.completeness ?? null,
        events: Array.isArray(record.events) ? record.events : record.bundle.events ?? [],
        documentUrl: typeof record.documentUrl === 'string' && record.documentUrl ? record.documentUrl : null,
      });
      setError(null);
    } catch (networkError) {
      if (mounted.current) {
        setError(`Could not reach AccessForm: ${(networkError as Error).message}`);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [caseId]);

  /* Once on mount (and again if the case id changes). */
  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  /*
   * Poll while the page is visible, not only during a browser call: the page
   * is also how a phone call is watched from a laptop, and how an SMS link
   * catches up on a call that ended minutes ago. Every 2 s while a call is
   * live, every 4 s otherwise, paused when the tab is hidden.
   */
  useEffect(() => {
    let id: number | null = null;
    const start = () => {
      if (id !== null) return;
      id = window.setInterval(() => void refresh(), active ? POLL_MS : IDLE_POLL_MS);
    };
    const stop = () => {
      if (id !== null) window.clearInterval(id);
      id = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, refresh]);

  /* One more read shortly after the call ends, so the last tool result lands. */
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      const id = window.setTimeout(() => void refresh(), SETTLE_MS);
      wasActive.current = active;
      return () => window.clearTimeout(id);
    }
    wasActive.current = active;
    return undefined;
  }, [active, refresh]);

  return { data, error, loading, refresh };
}
