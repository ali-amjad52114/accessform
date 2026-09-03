import type { CaseEvent, EventActor } from '../lib/contract';

/** Display names for the sponsor/system actors shown in the feed. */
const ACTOR_LABEL: Readonly<Record<EventActor, string>> = {
  user: 'Caller',
  voice_agent: 'AccessForm',
  serpapi: 'SerpApi',
  xano: 'Xano',
  nutrient: 'Nutrient',
};

function clockTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return '';
  const hours = String(parsed.getHours()).padStart(2, '0');
  const minutes = String(parsed.getMinutes()).padStart(2, '0');
  const seconds = String(parsed.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

interface FeedRow {
  id: string;
  actor: EventActor;
  message: string;
  timestamp: string;
  /** How many identical consecutive events this row stands for. */
  count: number;
}

/**
 * A run of identical consecutive events (26 "Answer saved" rows) collapses to
 * one row with a count. This is a product surface, not a log console.
 */
function collapse(events: CaseEvent[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const event of events) {
    const previous = rows[rows.length - 1];
    if (
      previous &&
      previous.actor === event.actor &&
      previous.message === event.message
    ) {
      previous.count += 1;
      previous.timestamp = event.timestamp;
      continue;
    }
    rows.push({
      id: event.id,
      actor: event.actor,
      message: event.message,
      timestamp: event.timestamp,
      count: 1,
    });
  }
  return rows;
}

/**
 * Sponsor visibility without turning the product into a dev console: one
 * short human sentence per integration step, newest last. The rows are
 * whatever the case record says — nothing here assumes a particular form.
 */
export function IntegrationFeed({
  events,
  simulated,
  callerName,
}: {
  events: CaseEvent[];
  /** True when the run is replaying fixtures instead of calling live APIs. */
  simulated: boolean;
  /** Display name for the `user` actor; defaults to "Caller". */
  callerName?: string;
}) {
  if (events.length === 0) {
    return (
      <p className="af-transcript__empty">
        Activity appears here as the call runs: the need being understood, the
        official form being found and verified, each answer being saved, and
        the form being filled.
      </p>
    );
  }

  const rows = collapse(events);
  const actorLabel = (actor: EventActor) =>
    actor === 'user' && callerName ? callerName : ACTOR_LABEL[actor];

  return (
    <>
      <ol className="af-feed">
        {rows.map((row) => (
          <li className="af-feed__row" key={row.id}>
            <span className="af-feed__actor">{actorLabel(row.actor)}</span>
            <span className="af-feed__message">
              {row.message}
              {row.count > 1 ? (
                <span className="af-feed__count">{` ×${row.count}`}</span>
              ) : null}
            </span>
            <span className="af-feed__time">
              <span className="af-sr-only">at </span>
              {clockTime(row.timestamp)}
            </span>
          </li>
        ))}
      </ol>
      <p className="af-feed__caption">
        {simulated
          ? 'Demo mode: this run replays a recorded call against a verified catalog form; no service is called and nothing is sent. '
          : 'Each row above is one call to a named service. '}
        Source URLs and retrieval times are kept with the case record.
      </p>
    </>
  );
}
