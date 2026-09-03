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
}

export interface UseCaseStateResult {
  data: CaseStatePayload | null;
  /** Human sentence describing the last failed read, or null. */
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const POLL_MS = 2000;
const SETTLE_MS = 900;

export function useCaseState(caseId: Id, active: boolean): UseCaseStateResult {
  const [data, setData] = useState<CaseStatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(`/api/voice/case/${encodeURIComponent(caseId)}`, {
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
      setData({
        bundle: record.bundle,
        progress: record.progress ?? null,
        completeness: record.completeness ?? null,
        events: Array.isArray(record.events) ? record.events : record.bundle.events ?? [],
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

  /* Every 2 s while the call is live. */
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
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
