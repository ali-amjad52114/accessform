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

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    fetchCaseSummaries(ids)
      .then((rows) => {
        if (cancelled) return;
        setSummaries(new Map(rows.map((row) => [row.id, row])));
        setError(null);
      })
      .catch((fetchError: Error) => {
        if (!cancelled) setError(fetchError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [ids]);

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
        {ids.map((caseId) => {
          const summary = summaries.get(caseId) ?? null;
          const pill = historyPill(summary);
          const current = caseId === currentCaseId;
          const title = summary?.situation_text?.trim() || summary?.program_name?.trim() || 'New conversation';
          const organization = summary?.organization_name?.trim() || null;
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
