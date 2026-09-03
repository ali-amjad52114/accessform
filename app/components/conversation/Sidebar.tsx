'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Id } from '../../lib/contract';
import {
  CASE_HISTORY_EVENT,
  fetchCaseSummaries,
  historyPill,
  readCaseHistory,
  rememberCase,
  type CaseSummary,
} from './case-history';
import { StartConversationButton } from './StartConversationButton';
import { formatDay } from './timeline-model';

/** Newest cases pulled from the system of record for the list. */
const RECENT_CASES = 8;
const HISTORY_REFRESH_MS = 10_000;

/**
 * Conversation history for this browser. The id list is localStorage; the
 * words on each row come from GET /api/cases/summary. An id the server does
 * not know is still listed (as "New conversation") so an SMS link is never
 * lost from the list.
 */
export function Sidebar({
  currentCaseId,
  open,
  onClose,
  id,
}: {
  currentCaseId: Id;
  /** Drawer state on narrow screens; ignored on wide ones by CSS. */
  open: boolean;
  onClose: () => void;
  id: string;
}) {
  const [ids, setIds] = useState<Id[]>([]);
  const [summaries, setSummaries] = useState<Map<Id, CaseSummary>>(new Map());
  /** Server order (newest first), including cases opened by phone. */
  const [serverOrder, setServerOrder] = useState<Id[]>([]);
  const [error, setError] = useState<string | null>(null);

  /* Keep the current case in history (an SMS link lands here directly). */
  useEffect(() => {
    const current = readCaseHistory();
    setIds(current.includes(currentCaseId) ? current : rememberCase(currentCaseId));
  }, [currentCaseId]);

  /* Re-read when another component changes the history. */
  useEffect(() => {
    const onChange = () => setIds(readCaseHistory());
    window.addEventListener(CASE_HISTORY_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CASE_HISTORY_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  /*
   * This browser's ids plus the newest cases in the system of record, so a
   * conversation started by phone shows up here while it is happening.
   * Re-read every 10 s while the tab is visible.
   */
  useEffect(() => {
    let cancelled = false;
    const load = (force = false) => {
      if (!force && document.visibilityState !== 'visible') return;
      fetchCaseSummaries(ids, { recent: RECENT_CASES })
        .then((rows) => {
          if (cancelled) return;
          setSummaries(new Map(rows.map((row) => [row.id, row])));
          setServerOrder(rows.map((row) => row.id));
          setError(null);
        })
        .catch((fetchError: Error) => {
          if (!cancelled) setError(fetchError.message);
        });
    };
    load(true);
    const timer = window.setInterval(() => load(), HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ids]);

  /* Newest first as the server orders them, then any local id the server did not return. */
  const listed: Id[] = [...serverOrder, ...ids.filter((id) => !serverOrder.includes(id))];

  return (
    <aside
      id={id}
      className={open ? 'af-cv-side af-cv-side--open' : 'af-cv-side'}
      aria-label="Conversation history"
    >
      <div className="af-cv-side__head">
        <div className="af-cv-side__brandrow">
          <Link className="af-cv-brand" href="/">
            AccessForm
          </Link>
          <button
            type="button"
            className="af-cv-ctl af-cv-side__close"
            onClick={onClose}
            aria-label="Close history"
          >
            Close
          </button>
        </div>
        <StartConversationButton className="af-cv-newbtn" label="+ New conversation" compact />
      </div>

      {error ? (
        <p className="af-cv-side__note" role="status">
          {error}
        </p>
      ) : null}

      <ul className="af-cv-hist">
        {listed.map((caseId) => {
          const summary = summaries.get(caseId) ?? null;
          const pill = historyPill(summary);
          const current = caseId === currentCaseId;
          const title = summary?.situation_text?.trim() || summary?.program_name?.trim() || 'New conversation';
          const organization = summary?.organization_name?.trim() || null;
          const byPhone = Boolean(summary?.caller_phone_last4) && !ids.includes(caseId);
          const day = formatDay(summary?.created_at);
          return (
            <li key={caseId}>
              <Link
                href={`/c/${encodeURIComponent(caseId)}`}
                className="af-cv-hist__row"
                aria-current={current ? 'page' : undefined}
                onClick={onClose}
              >
                <span className="af-cv-hist__title">{title}</span>
                {organization ? <span className="af-cv-hist__org">{organization}</span> : null}
                <span className="af-cv-hist__meta">
                  {day ? <span>{day}</span> : null}
                  {byPhone ? <span>by phone</span> : null}
                  <span className={`af-cv-pill af-cv-pill--${pill.tone}`}>{pill.label}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="af-cv-side__foot">History is remembered on this browser. No account.</p>
    </aside>
  );
}
