'use client';

import { useEffect, useRef } from 'react';
import type {
  CaseBundle,
  CaseEvent,
  CaseProgress,
  CompletenessSummary,
  Id,
} from '../../lib/contract';
import MapCard from '../map/MapCard';
import { CardShell, FormCard, MissingCard, ResultCard, SearchCard, SituationCard } from './cards';
import type { TimelineItem } from './timeline-model';

export interface TimelineProps {
  items: TimelineItem[];
  bundle: CaseBundle | null;
  progress: CaseProgress | null;
  completeness: CompletenessSummary | null;
  events: CaseEvent[];
  caseId: Id;
  /** Signed link to the filled document, when one exists. */
  signedUrl?: string | null;
  /** Name for the caller's bubbles. */
  callerName?: string;
  /** Scroll container the timeline lives in (for auto-follow). */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  emptyText: string;
}

/**
 * The conversation itself: agent turns left, caller turns right, cards inline
 * where the event that created them happened. Follows the newest item unless
 * the reader has scrolled up to re-read something.
 */
export function Timeline({
  items,
  bundle,
  progress,
  completeness,
  events,
  caseId,
  signedUrl = null,
  callerName = 'You',
  scrollRef,
  emptyText,
}: TimelineProps) {
  const pinned = useRef(true);
  const selfScrolling = useRef(false);
  const lastCount = useRef(0);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      if (selfScrolling.current) {
        selfScrolling.current = false;
        return;
      }
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinned.current || items.length === lastCount.current) {
      lastCount.current = items.length;
      return;
    }
    lastCount.current = items.length;
    selfScrolling.current = true;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollTo({ top: node.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  }, [items, scrollRef]);

  return (
    <div
      className="af-cv-timeline"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Conversation"
    >
      {items.length === 0 ? <p className="af-cv-gap">{emptyText}</p> : null}

      {items.map((item) => {
        if (item.kind === 'turn') {
          return (
            <p
              key={item.id}
              className={[
                'af-cv-turn',
                `af-cv-turn--${item.speaker}`,
                item.final ? '' : 'af-cv-turn--interim',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="af-cv-who">{item.speaker === 'agent' ? 'AccessForm' : callerName}</span>
              {item.text}
            </p>
          );
        }

        if (item.kind === 'system') {
          return (
            <p key={item.id} className="af-cv-gap">
              {item.text}
            </p>
          );
        }

        switch (item.card) {
          case 'situation':
            return <SituationCard key={item.id} event={item.event} bundle={bundle} />;
          case 'location': {
            // Newest organizations_found event wins; the card that anchors the
            // position is the first one. The list is the interface; the map is
            // a picture of it (see components/map/README.md).
            const latest = [...events]
              .reverse()
              .find((event) => event.event_type === 'organizations_found');
            const location =
              typeof latest?.metadata_json?.location === 'string' ? latest.metadata_json.location : null;
            return (
              <CardShell
                key={item.id}
                kind="Location"
                title={location ? `Nearby, around ${location}` : 'Nearby organizations'}
                sub="The numbered list AccessForm read aloud. Choosing one here does not verify its program; the search does that."
              >
                <MapCard
                  data={latest?.metadata_json ?? item.event.metadata_json}
                  selectedName={bundle?.organization?.name ?? bundle?.hospital?.name ?? null}
                />
              </CardShell>
            );
          }
          case 'search':
            return <SearchCard key={item.id} events={events} bundle={bundle} />;
          case 'form':
            return <FormCard key={item.id} bundle={bundle} progress={progress} events={events} />;
          case 'missing':
            return <MissingCard key={item.id} completeness={completeness} bundle={bundle} />;
          case 'result':
            return (
              <ResultCard
                key={item.id}
                event={item.event}
                bundle={bundle}
                progress={progress}
                events={events}
                caseId={caseId}
                signedUrl={signedUrl}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
