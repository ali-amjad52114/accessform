/**
 * Pure functions that turn the backend's event stream (plus, for browser
 * calls, the live transcript) into the ordered list of things the timeline
 * renders: spoken turns, inline cards, and small system lines.
 *
 * No React, no fetch. Everything here is derived; nothing is recomputed that
 * Xano owns (progress, completeness). Cards are anchored at the event that
 * created them and read their *content* from the bundle at render time.
 */

import type {
  Answer,
  AnswerValue,
  CaseEvent,
  IsoTimestamp,
  TranscriptTurn,
} from '../../lib/contract';
import type { ProgramCandidate } from '../../lib/m1/contract';

/* ------------------------------------------------------------------ */
/* Timeline items                                                      */
/* ------------------------------------------------------------------ */

export type TurnSpeaker = 'agent' | 'user';

export type CardKind = 'situation' | 'location' | 'search' | 'form' | 'missing' | 'result';

export interface TurnItem {
  kind: 'turn';
  id: string;
  speaker: TurnSpeaker;
  text: string;
  timestamp: IsoTimestamp;
  /** False while the browser is still transcribing this utterance. */
  final: boolean;
}

export interface CardItem {
  kind: 'card';
  id: string;
  card: CardKind;
  timestamp: IsoTimestamp;
  /** The event that made the card appear. */
  event: CaseEvent;
  /**
   * The events that belong to this card's request: from its trigger up to the
   * next card of the same kind. A caller who changes what they need mid-call
   * gets a fresh card for the new request instead of the old one up top.
   */
  events: CaseEvent[];
  /** False for a card that a later request of the same kind superseded. */
  latest: boolean;
}

export interface SystemItem {
  kind: 'system';
  id: string;
  text: string;
  timestamp: IsoTimestamp;
}

export type TimelineItem = TurnItem | CardItem | SystemItem;

/** Event types rendered as one quiet centred line. */
const SYSTEM_LINE_TYPES: ReadonlySet<string> = new Set([
  'case_created',
  'call_started',
  'call_ended',
  'organizations_not_found',
  'approval_recorded',
  'email_skipped',
  'email_failed',
  'application_emailed',
]);

const CARD_TRIGGERS: Readonly<Record<string, CardKind>> = {
  need_resolved: 'situation',
  organizations_found: 'location',
  search_started: 'search',
  program_discovered: 'search',
  source_not_verified: 'search',
  form_extracted: 'form',
  missing_requirement_detected: 'missing',
  document_generated: 'result',
};

/** Loose text match for deduplicating a browser turn against a saved one. */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function actorToSpeaker(actor: string): TurnSpeaker | null {
  if (actor === 'user') return 'user';
  if (actor === 'voice_agent') return 'agent';
  return null;
}

/**
 * Event times arrive as ISO strings from the contract but as epoch
 * milliseconds (number, or a numeric string) straight from Xano. Accept all.
 */
export function toMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^\d{10,}$/.test(value)) return Number(value);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }
  return Number.NaN;
}

function compareByTime(a: { timestamp: unknown }, b: { timestamp: unknown }): number {
  const ta = toMillis(a.timestamp);
  const tb = toMillis(b.timestamp);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return ta - tb;
}

/**
 * Build the timeline. `events` come from the server (oldest first or not —
 * they are sorted here); `browserTurns` come from `useVoiceSession` and are
 * only present during a browser call.
 */
export function buildTimeline(
  events: CaseEvent[],
  browserTurns: TranscriptTurn[],
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const savedUtterances = new Set<string>();

  const sorted = [...events].sort(compareByTime);

  /*
   * Cards repeat per request. A card kind gets a new card when its trigger
   * arrives after the caller has spoken since the previous card of that kind;
   * otherwise the trigger just updates the card that is already there. So one
   * request = one search card, one form card; a second request mid-call gets
   * its own, in the right place, below the words that asked for it.
   */
  const lastCard = new Map<CardKind, { item: CardItem; userTurnsAtCreation: number }>();
  let userTurns = 0;

  const openCard = (card: CardKind, event: CaseEvent) => {
    const previous = lastCard.get(card);
    if (previous && previous.userTurnsAtCreation === userTurns) return; // same request: update in place
    const item: CardItem = {
      kind: 'card',
      id: `card:${card}:${event.id}`,
      card,
      timestamp: event.timestamp,
      event,
      events: [],
      latest: true,
    };
    if (previous) previous.item.latest = false;
    lastCard.set(card, { item, userTurnsAtCreation: userTurns });
    items.push(item);
  };

  for (const event of sorted) {
    if (event.event_type === 'transcript_turn') {
      const speaker = actorToSpeaker(event.actor);
      const text = event.message?.trim();
      if (!speaker || !text) continue;
      if (speaker === 'user') userTurns += 1;
      savedUtterances.add(`${speaker}:${normalizeUtterance(text)}`);
      items.push({
        kind: 'turn',
        id: `evt:${event.id}`,
        speaker,
        text,
        timestamp: event.timestamp,
        final: true,
      });
      continue;
    }

    const card = CARD_TRIGGERS[event.event_type];
    if (card) {
      openCard(card, event);
      continue;
    }

    /* The form card should exist before the first answer lands in it. */
    if (event.event_type === 'answer_saved' && !lastCard.has('form')) {
      openCard('form', event);
      continue;
    }

    if (SYSTEM_LINE_TYPES.has(event.event_type) || event.event_type.startsWith('accessibility_')) {
      const text = event.message?.trim();
      if (!text) continue;
      items.push({
        kind: 'system',
        id: `sys:${event.id}`,
        text,
        timestamp: event.timestamp,
      });
    }
  }

  /* Slice the event stream per card: its trigger up to the next card of its kind. */
  const cards = items.filter((item): item is CardItem => item.kind === 'card');
  for (const card of cards) {
    const next = cards.find(
      (other) => other.card === card.card && compareByTime(other, card) > 0 && other !== card,
    );
    const from = toMillis(card.timestamp);
    const to = next ? toMillis(next.timestamp) : Number.POSITIVE_INFINITY;
    card.events = sorted.filter((event) => {
      const at = toMillis(event.timestamp);
      return at >= from && at < to;
    });
  }

  for (const turn of browserTurns) {
    const speaker: TurnSpeaker = turn.speaker === 'agent' ? 'agent' : 'user';
    const text = turn.text.trim();
    if (!text) continue;
    if (turn.final && savedUtterances.has(`${speaker}:${normalizeUtterance(text)}`)) continue;
    items.push({
      kind: 'turn',
      id: `live:${turn.id}`,
      speaker,
      text,
      timestamp: turn.timestamp,
      final: turn.final,
    });
  }

  /* Stable sort: equal timestamps keep insertion order (events before live turns). */
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareByTime(a.item, b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/* ------------------------------------------------------------------ */
/* Search card state                                                   */
/* ------------------------------------------------------------------ */

export type SearchPhase = 'searching' | 'found' | 'not_verified';

export interface SearchCardState {
  phase: SearchPhase;
  queries: string[];
  candidates: ProgramCandidate[];
  organization: string | null;
  programName: string | null;
  sourceDomain: string | null;
  applicationUrl: string | null;
  formKind: string | null;
  fromCatalog: boolean;
  /** Plain sentence when nothing official could be verified. */
  reason: string | null;
  searchesUsed: number | null;
}

function str(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function strList(metadata: Record<string, unknown> | null, key: string): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function candidateList(metadata: Record<string, unknown> | null): ProgramCandidate[] {
  const value = metadata?.candidates;
  if (!Array.isArray(value)) return [];
  const out: ProgramCandidate[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const url = typeof row.url === 'string' ? row.url : '';
    if (!url) continue;
    out.push({
      title: typeof row.title === 'string' && row.title ? row.title : url,
      url,
      source_domain:
        typeof row.source_domain === 'string' && row.source_domain
          ? row.source_domain
          : domainOf(url),
      verified: row.verified === true,
      reason: typeof row.reason === 'string' && row.reason ? row.reason : undefined,
    });
  }
  return out;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Fold every discovery-related event into one card state. */
export function searchCardState(events: CaseEvent[]): SearchCardState {
  const state: SearchCardState = {
    phase: 'searching',
    queries: [],
    candidates: [],
    organization: null,
    programName: null,
    sourceDomain: null,
    applicationUrl: null,
    formKind: null,
    fromCatalog: false,
    reason: null,
    searchesUsed: null,
  };

  for (const event of [...events].sort(compareByTime)) {
    const meta = event.metadata_json;
    switch (event.event_type) {
      case 'search_started': {
        state.phase = 'searching';
        state.queries = mergeUnique(state.queries, strList(meta, 'queries'));
        state.organization = str(meta, 'organization') ?? state.organization;
        break;
      }
      case 'program_discovered': {
        state.phase = 'found';
        state.queries = mergeUnique(state.queries, strList(meta, 'queries'));
        state.candidates = candidateList(meta);
        state.organization = str(meta, 'organization') ?? str(meta, 'organization_name') ?? state.organization;
        state.programName = str(meta, 'program_name') ?? str(meta, 'program') ?? state.programName;
        state.sourceDomain = str(meta, 'source_domain');
        state.applicationUrl = str(meta, 'application_url');
        state.formKind = str(meta, 'form_kind');
        state.fromCatalog = meta?.from_catalog === true;
        state.reason = null;
        state.searchesUsed = typeof meta?.searches_used === 'number' ? meta.searches_used : null;
        break;
      }
      case 'source_not_verified': {
        state.phase = 'not_verified';
        state.queries = mergeUnique(state.queries, strList(meta, 'queries'));
        state.candidates = candidateList(meta);
        state.organization = str(meta, 'organization') ?? state.organization;
        state.reason = str(meta, 'reason') ?? (event.message?.trim() || null);
        state.searchesUsed = typeof meta?.searches_used === 'number' ? meta.searches_used : null;
        break;
      }
      default:
        break;
    }
  }
  return state;
}

function mergeUnique(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]));
}

/* ------------------------------------------------------------------ */
/* Answers → display values                                            */
/* ------------------------------------------------------------------ */

export function formatAnswerValue(value: AnswerValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/** "Annual household income:" → "Annual household income". */
export function humanizeFieldId(fieldId: string): string {
  const cleaned = fieldId.replace(/[_]+/g, ' ').replace(/[:\s]+$/g, '').trim();
  if (!cleaned) return fieldId;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export interface FilledValue {
  display: string;
  label: string | null;
  section: string | null;
}

/**
 * field_id → what to show in the form card. `answer_saved` events win over
 * the raw answer row when they carry a formatted `display_value`.
 */
export function filledValues(answers: Answer[], events: CaseEvent[]): Map<string, FilledValue> {
  const map = new Map<string, FilledValue>();
  for (const answer of answers) {
    const display = formatAnswerValue(answer.value_json);
    if (display === null) continue;
    map.set(answer.field_id, { display, label: null, section: null });
  }
  for (const event of [...events].sort(compareByTime)) {
    if (event.event_type !== 'answer_saved') continue;
    const meta = event.metadata_json;
    const fieldId = str(meta, 'field_id');
    if (!fieldId) continue;
    const display = str(meta, 'display_value') ?? str(meta, 'value') ?? map.get(fieldId)?.display ?? null;
    if (display === null) continue;
    map.set(fieldId, {
      display,
      label: str(meta, 'label') ?? map.get(fieldId)?.label ?? null,
      section: str(meta, 'section_label') ?? str(meta, 'section') ?? map.get(fieldId)?.section ?? null,
    });
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Sections with fields (progress.sections may carry them)             */
/* ------------------------------------------------------------------ */

export interface SectionField {
  fieldId: string;
  label: string;
  type: string | null;
  /** True when the schema says the person, not AccessForm, must fill this in. */
  leaveBlank: boolean;
}

export interface SectionWithFields {
  key: string;
  label: string;
  answered: number;
  total: number;
  fields: SectionField[];
}

const IDENTIFIER_TYPES: ReadonlySet<string> = new Set(['signature', 'ssn', 'identifier']);

/**
 * Read `fields` off a progress section if the backend attached them. The
 * InterviewSection type does not declare them yet, so this is defensive.
 */
export function sectionsWithFields(sections: unknown): SectionWithFields[] {
  if (!Array.isArray(sections)) return [];
  const out: SectionWithFields[] = [];
  for (const raw of sections) {
    if (typeof raw !== 'object' || raw === null) continue;
    const section = raw as Record<string, unknown>;
    const key = typeof section.key === 'string' ? section.key : '';
    const label = typeof section.label === 'string' ? section.label : key;
    if (!key && !label) continue;
    const fields: SectionField[] = [];
    if (Array.isArray(section.fields)) {
      for (const entry of section.fields) {
        if (typeof entry !== 'object' || entry === null) continue;
        const field = entry as Record<string, unknown>;
        const fieldId =
          (typeof field.field_id === 'string' && field.field_id) ||
          (typeof field.pdf_field_name === 'string' && field.pdf_field_name) ||
          (typeof field.key === 'string' && field.key) ||
          (typeof field.normalized_key === 'string' && field.normalized_key) ||
          '';
        if (!fieldId) continue;
        const type = typeof field.type === 'string' ? field.type : null;
        fields.push({
          fieldId,
          label: (typeof field.label === 'string' && field.label) || humanizeFieldId(fieldId),
          type,
          leaveBlank:
            field.leave_blank === true ||
            field.identifier === true ||
            (type !== null && IDENTIFIER_TYPES.has(type)),
        });
      }
    }
    out.push({
      key: key || label,
      label,
      answered: typeof section.answered_count === 'number' ? section.answered_count : 0,
      total: typeof section.field_count === 'number' ? section.field_count : fields.length,
      fields,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Small formatting helpers shared by the cards                        */
/* ------------------------------------------------------------------ */

export function formatClock(iso: string | number): string {
  const date = new Date(toMillis(iso));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDay(iso: string | number | null | undefined): string {
  if (!iso) return '';
  const date = new Date(toMillis(iso));
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return 'today';
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** "+15555550123" → "••• ••• 0123". Never shows more than the last four digits. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return last4 ? `••• ••• ${last4}` : '•••';
}

export function isAbsoluteUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}
