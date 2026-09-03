'use client';

import { useEffect, useRef } from 'react';
import type { TranscriptTurn } from '../lib/contract';

const SPEAKER_NAME = {
  patient: 'Jane',
  agent: 'AccessForm',
} as const;

/**
 * Live transcript. It auto-scrolls to the newest turn, but stops doing so the
 * moment the reader scrolls up to review earlier turns (UI.md), and resumes
 * once they scroll back to the bottom.
 */
export function Transcript({
  turns,
  patientName,
}: {
  turns: TranscriptTurn[];
  patientName?: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);
  const selfScrolling = useRef(false);

  useEffect(() => {
    const node = listRef.current;
    if (!node || !pinnedToBottom.current) return;
    selfScrolling.current = true;
    node.scrollTop = node.scrollHeight;
  }, [turns]);

  function handleScroll() {
    const node = listRef.current;
    if (!node) return;
    if (selfScrolling.current) {
      // Ignore the scroll event our own auto-follow just produced.
      selfScrolling.current = false;
      return;
    }
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    pinnedToBottom.current = distanceFromBottom < 48;
  }

  return (
    <div
      className="af-transcript"
      ref={listRef}
      onScroll={handleScroll}
      tabIndex={0}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Conversation transcript"
    >
      {turns.length === 0 ? (
        <p className="af-transcript__empty">
          The conversation will appear here as it happens.
        </p>
      ) : (
        turns.map((turn) => (
          <p
            key={turn.id}
            className={[
              'af-bubble',
              `af-bubble--${turn.speaker}`,
              turn.final ? '' : 'af-bubble--interim',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="af-bubble__who">
              {turn.speaker === 'patient'
                ? (patientName ?? SPEAKER_NAME.patient)
                : SPEAKER_NAME.agent}
            </span>
            {turn.text}
          </p>
        ))
      )}
    </div>
  );
}
