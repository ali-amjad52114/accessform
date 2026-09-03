'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Id } from '../../lib/contract';
import { fetchCaseSummaries, rememberCase, type CaseSummary } from './case-history';

/**
 * Follows a phone call as it happens.
 *
 * A call that comes in on the phone number creates its case on the server; no
 * browser knows about it. This watcher polls the recent-cases list and, when
 * a case opened by phone in the last few minutes appears:
 *
 *   - on the start page (`mode="start"`) it opens that conversation, so a
 *     laptop left on the start page becomes the live view of the call;
 *   - on a conversation page (`mode="conversation"`) it shows a banner with a
 *     link, and never yanks the reader away from what they are looking at.
 */

const POLL_MS = 5000;
/** A phone case younger than this counts as "a call happening now". */
const LIVE_WINDOW_MS = 3 * 60 * 1000;
const FINISHED_STATUSES: ReadonlySet<string> = new Set(['READY_FOR_REVIEW', 'BLOCKED']);

function isLivePhoneCase(row: CaseSummary, now: number): boolean {
  if (!row.caller_phone_last4) return false;
  if (row.status && FINISHED_STATUSES.has(String(row.status))) return false;
  const created = new Date(row.created_at ?? '').getTime();
  return Number.isFinite(created) && now - created < LIVE_WINDOW_MS;
}

export function LiveCallWatcher({
  mode,
  currentCaseId,
}: {
  mode: 'start' | 'conversation';
  currentCaseId?: Id;
}) {
  const router = useRouter();
  const [live, setLive] = useState<CaseSummary | null>(null);
  const [opening, setOpening] = useState(false);
  /** Cases seen at first poll are not "new"; only ones that appear later are. */
  const seenAtStart = useRef<Set<Id> | null>(null);
  const dismissed = useRef<Set<Id>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      // Cheap (one Xano list read), so it runs even in a background tab: the
      // whole point is a laptop left alone switching to the call by itself.
      let rows: CaseSummary[];
      try {
        rows = await fetchCaseSummaries([], { recent: 5 });
      } catch {
        return;
      }
      if (cancelled) return;
      const now = Date.now();
      if (seenAtStart.current === null) {
        // First look: on the start page a call already in progress is worth
        // following; on a conversation page only later arrivals are news.
        seenAtStart.current = new Set(mode === 'start' ? [] : rows.map((row) => row.id));
      }
      const candidate = rows.find(
        (row) =>
          isLivePhoneCase(row, now) &&
          row.id !== currentCaseId &&
          !seenAtStart.current?.has(row.id) &&
          !dismissed.current.has(row.id),
      );
      if (!candidate) return;
      if (mode === 'start') {
        setOpening(true);
        rememberCase(candidate.id);
        router.push(`/c/${encodeURIComponent(candidate.id)}`);
        return;
      }
      setLive(candidate);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [mode, currentCaseId, router]);

  if (mode === 'start') {
    return (
      <p className="af-cv-livenote" role="status" aria-live="polite">
        {opening
          ? 'A call just came in. Opening it…'
          : 'Leave this page open while you call: it will switch to the live call by itself.'}
      </p>
    );
  }

  if (!live) return null;
  return (
    <div className="af-cv-livebanner" role="status" aria-live="polite">
      <span>
        A new call started
        {live.caller_phone_last4 ? ` from a number ending in ${live.caller_phone_last4}` : ''}.
      </span>
      <Link className="af-cv-ctl af-cv-ctl--primary" href={`/c/${encodeURIComponent(live.id)}`}>
        Follow the call
      </Link>
      <button
        type="button"
        className="af-cv-ctl"
        onClick={() => {
          dismissed.current.add(live.id);
          setLive(null);
        }}
      >
        Stay here
      </button>
    </div>
  );
}
