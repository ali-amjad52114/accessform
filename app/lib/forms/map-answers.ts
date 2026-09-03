/**
 * Answer mapper — lib/forms/map-answers.ts (M1_MODULES.mapAnswers).
 *
 *   form_schema rows + saved answers  ->  { values: [{ pdf_field_name, value }], unmapped }
 *
 * The deterministic part does most of the work: an answer whose `field_id`
 * is a schema `field_id` / `normalized_key` / `pdf_field_name` lands on that
 * field directly, with the value normalised for its type (money without "$",
 * dates MM/DD/YYYY, option fields snapped to the exact export value).
 *
 * gpt-4o is consulted only where judgment is needed, always with strict JSON
 * whose enums are built from the schema at call time:
 *   - an option field whose answer does not match any export value
 *     ("I'm retired" -> "Retired"), enum = that field's options + ""
 *   - an answer saved under a key that is not on the schema
 *     ("mobility_aid": "I use a walker" -> checkbox "Walker"), enum = every
 *     eligible pdf_field_name + ""
 * Everything the model returns is post-filtered against the schema again;
 * whatever cannot be placed is listed in `unmapped`, never dropped silently.
 *
 * Never emitted: signature fields, forbidden identifiers (SSN, account,
 * policy, license numbers), two values for one field (last write wins by
 * `Answer.updated_at`).
 *
 * Character combs (see extract-fields.ts): a value aimed at a comb leader is
 * spread one character per box across the `<key>__box_<n>` follower rows.
 *
 * SERVER-SIDE ONLY.
 */

import {
  INSTANT_JSON_FIELD_TYPE,
  INSTANT_JSON_FORMAT,
  type Answer,
  type FormSchemaField,
  type InstantJson,
  type MapAnswersInput,
  type MappedAnswers,
  type MappedValue,
} from '../contract';
import { enumProperty, hasOpenAiKey, openaiStrictJson, type JsonSchema } from './openai-json';
import { COMB_BOX_KEY_INFIX, isForbiddenField } from './understand-form';

/* ------------------------------------------------------------------ */
/* Value normalisation                                                 */
/* ------------------------------------------------------------------ */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function plausibleDate(month: number, day: number, year: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100;
}

/** "1958-01-15", "1/15/58", "January 15, 1958", "15 Jan 1958" -> "01/15/1958". Unknown shapes pass through. */
export function normalizeDate(text: string): string {
  const raw = text.trim();
  if (!raw) return '';
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  if (match) {
    const [, y, m, d] = match;
    if (plausibleDate(Number(m), Number(d), Number(y))) return `${pad2(Number(m))}/${pad2(Number(d))}/${y}`;
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(raw);
  if (match) {
    const [, m, d, yRaw] = match;
    let year = Number(yRaw);
    if (yRaw.length === 2) year += year <= 30 ? 2000 : 1900;
    if (plausibleDate(Number(m), Number(d), year)) return `${pad2(Number(m))}/${pad2(Number(d))}/${year}`;
  }
  match = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(raw);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    if (month && plausibleDate(month, Number(match[2]), Number(match[3]))) {
      return `${pad2(month)}/${pad2(Number(match[2]))}/${match[3]}`;
    }
  }
  match = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/i.exec(raw);
  if (match) {
    const month = MONTHS[match[2].toLowerCase()];
    if (month && plausibleDate(month, Number(match[1]), Number(match[3]))) {
      return `${pad2(month)}/${pad2(Number(match[1]))}/${match[3]}`;
    }
  }
  return raw;
}

/** "$2,050.00" -> "2,050.00"; "2050 dollars" -> "2050". The forms print their own "$". */
export function normalizeCurrency(text: string): string {
  let value = text.trim();
  value = value.replace(/\b(usd|dollars?)\b/gi, '').replace(/\$/g, '').trim();
  value = value.replace(/^\s*(about|around|approximately|roughly)\s+/i, '');
  // "2,050" stays; "2 050" -> "2050"; a stray trailing "." goes.
  value = value.replace(/(\d)\s+(\d)/g, '$1$2').replace(/\.$/, '');
  return value.trim();
}

export function normalizeNumber(text: string): string {
  const value = text.trim();
  const match = /-?\d[\d,]*(\.\d+)?/.exec(value);
  return match ? match[0].replace(/,/g, '') : value;
}

const YES_WORDS = new Set(['yes', 'y', 'true', 'on', 'checked', '1', 'yeah', 'yep', 'correct']);
const NO_WORDS = new Set(['no', 'n', 'false', 'off', 'unchecked', '0', 'nope', 'none']);

function looksYes(text: string): boolean {
  return YES_WORDS.has(text.trim().toLowerCase());
}
function looksNo(text: string): boolean {
  return NO_WORDS.has(text.trim().toLowerCase());
}

/** Comparison key: lowercase, punctuation-free, trailing "_2"/" 3" export suffix removed. */
function optionKey(text: string): string {
  return text
    .trim()
    .replace(/^\//, '')
    .replace(/[_ ]\d{1,2}$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The export value to write for `text`, or null when no option matches. */
export function matchOption(text: string, options: readonly string[]): string | null {
  const wanted = text.trim().replace(/^\//, '');
  if (!wanted) return null;
  const exact = options.find((option) => option === wanted);
  if (exact) return exact;
  const key = optionKey(wanted);
  const loose = options.find((option) => optionKey(option) === key);
  if (loose) return loose;
  // "yes" against ["Yes_2", "No_2"], "no" against ["No"], booleans against a single on-state.
  if (looksYes(wanted)) {
    const yes = options.find((option) => optionKey(option) === 'yes' || optionKey(option) === 'on');
    if (yes) return yes;
    if (options.length === 1) return options[0];
  }
  if (looksNo(wanted)) {
    const no = options.find((option) => optionKey(option) === 'no');
    if (no) return no;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Schema index                                                        */
/* ------------------------------------------------------------------ */

function pdfNameOf(field: FormSchemaField): string {
  return field.pdf_field_name || field.pdf_mapping || field.field_id;
}

function isCombBox(field: FormSchemaField): boolean {
  return (field.normalized_key ?? '').includes(COMB_BOX_KEY_INFIX);
}

/** Fields an answer may land on. Signature fields, forbidden identifiers and comb boxes never. */
export function eligibleFields(schema: readonly FormSchemaField[]): FormSchemaField[] {
  return schema.filter(
    (field) =>
      field.type !== 'signature' &&
      !isForbiddenField(field.field_id, field.label) &&
      !isForbiddenField(pdfNameOf(field)) &&
      !isCombBox(field),
  );
}

interface SchemaIndex {
  eligible: FormSchemaField[];
  byFieldId: Map<string, FormSchemaField>;
  byKey: Map<string, FormSchemaField>;
  byPdfName: Map<string, FormSchemaField>;
  byLower: Map<string, FormSchemaField>;
  /** comb leader key -> boxes by index (1 = the leader itself). */
  combs: Map<string, Map<number, string>>;
}

function indexSchema(schema: readonly FormSchemaField[]): SchemaIndex {
  const eligible = eligibleFields(schema);
  const byFieldId = new Map<string, FormSchemaField>();
  const byKey = new Map<string, FormSchemaField>();
  const byPdfName = new Map<string, FormSchemaField>();
  const byLower = new Map<string, FormSchemaField>();
  for (const field of eligible) {
    byFieldId.set(field.field_id, field);
    if (field.normalized_key) byKey.set(field.normalized_key, field);
    byPdfName.set(pdfNameOf(field), field);
    for (const alias of [field.field_id, field.normalized_key ?? '', pdfNameOf(field)]) {
      const lower = alias.trim().toLowerCase();
      if (lower && !byLower.has(lower)) byLower.set(lower, field);
    }
  }
  const combs = new Map<string, Map<number, string>>();
  for (const field of schema) {
    const key = field.normalized_key ?? '';
    const at = key.indexOf(COMB_BOX_KEY_INFIX);
    if (at < 0) continue;
    const leaderKey = key.slice(0, at);
    const index = Number(key.slice(at + COMB_BOX_KEY_INFIX.length));
    if (!Number.isFinite(index) || index < 2) continue;
    const boxes = combs.get(leaderKey) ?? new Map<number, string>();
    boxes.set(index, pdfNameOf(field));
    combs.set(leaderKey, boxes);
  }
  return { eligible, byFieldId, byKey, byPdfName, byLower, combs };
}

function resolveDirect(index: SchemaIndex, fieldIdOrKey: string): FormSchemaField | null {
  const wanted = fieldIdOrKey.trim();
  return (
    index.byFieldId.get(wanted) ??
    index.byKey.get(wanted) ??
    index.byPdfName.get(wanted) ??
    index.byLower.get(wanted.toLowerCase()) ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* Typing a value for a field                                          */
/* ------------------------------------------------------------------ */

function answerText(answer: Answer): string {
  const value = answer.value_json;
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value).trim();
}

/**
 * Deterministic typing. Returns the string to write, or null when the field
 * has options and the text matches none of them (the model gets a turn).
 */
export function typeValue(field: FormSchemaField, text: string): string | null {
  const options = field.options ?? [];
  if (field.type === 'checkbox') {
    const on = options[0] ?? 'Yes';
    if (looksNo(text)) return 'Off';
    if (looksYes(text)) return on;
    return matchOption(text, options) ?? null;
  }
  if (options.length > 0) return matchOption(text, options);
  switch (field.type) {
    case 'currency':
      return normalizeCurrency(text);
    case 'date':
      return normalizeDate(text);
    case 'number':
      return normalizeNumber(text);
    default:
      return text;
  }
}

/* ------------------------------------------------------------------ */
/* Model calls                                                         */
/* ------------------------------------------------------------------ */

interface OptionPick {
  value: string;
}

/** One option field, one answer: pick the export value or "" for no match. */
async function pickOption(field: FormSchemaField, text: string): Promise<string | null> {
  const options = field.options ?? [];
  if (options.length === 0) return null;
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: {
      value: enumProperty([...options, ''], 'The export value that matches the answer, or "" when none does.'),
    },
  };
  const result = await openaiStrictJson<OptionPick>({
    system:
      'You map a caller\'s spoken answer onto the exact export value of one form field. Pick the option the caller meant. Pick "" when the answer does not fit any option. Never guess between two plausible options.',
    user: `Field label: ${field.label}\nQuestion asked: ${field.conversational_prompt || '(none)'}\nOptions: ${options.map((o) => JSON.stringify(o)).join(', ')}\nCaller's answer: ${JSON.stringify(text)}`,
    schemaName: 'option_pick',
    schema,
    maxTokens: 100,
  });
  const chosen = result.value;
  return chosen && options.includes(chosen) ? chosen : null;
}

interface Placement {
  answer_field_id: string;
  pdf_field_name: string;
  value: string;
}

interface PlacementResponse {
  placements: Placement[];
}

/**
 * Answers saved under keys that are not on the schema: one call, enum =
 * every eligible pdf_field_name not already written. Returns raw
 * placements; the caller re-validates every one of them.
 */
async function placeFreeAnswers(
  index: SchemaIndex,
  answers: readonly { field_id: string; text: string }[],
  taken: ReadonlySet<string>,
): Promise<Placement[]> {
  const candidates = index.eligible.filter((field) => !taken.has(pdfNameOf(field)));
  if (candidates.length === 0 || answers.length === 0) return [];
  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['placements'],
    properties: {
      placements: {
        type: 'array',
        description: 'One entry per answer. Use pdf_field_name "" when the answer fits no field.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['answer_field_id', 'pdf_field_name', 'value'],
          properties: {
            answer_field_id: enumProperty(
              answers.map((a) => a.field_id),
              'The key the answer was saved under, copied verbatim.',
            ),
            pdf_field_name: enumProperty(
              [...candidates.map(pdfNameOf), ''],
              'The exact form field to write, or "" for no fit.',
            ),
            value: {
              type: 'string',
              description:
                'What to write: for option fields exactly one of that field\'s options; money without "$"; dates MM/DD/YYYY; for checkboxes the on value when the answer says yes.',
            },
          },
        },
      },
    },
  };
  const fieldLines = candidates
    .map((field) => {
      const options = field.options ?? [];
      return `${JSON.stringify(pdfNameOf(field))} | ${field.label} | key=${field.normalized_key} | ${field.type}${options.length ? ` | options: ${options.map((o) => JSON.stringify(o)).join(', ')}` : ''}`;
    })
    .join('\n');
  const answerLines = answers.map((a) => `${JSON.stringify(a.field_id)}: ${JSON.stringify(a.text)}`).join('\n');
  const result = await openaiStrictJson<PlacementResponse>({
    system:
      'You place a caller\'s saved answers onto the exact fields of an official form. Each answer goes to at most ONE field, the one whose label or key clearly means the same thing. When an answer describes a device or condition that the form lists as a checkbox, choose that checkbox and write its on value. Prefer the applicant\'s own field over spouse / other-member copies (names with _1, _2, _3). Use "" when nothing clearly fits — never force a placement.',
    user: `Form fields (pdf_field_name | label | key | type | options):\n${fieldLines}\n\nAnswers to place:\n${answerLines}`,
    schemaName: 'answer_placements',
    schema,
    maxTokens: 2000,
  });
  return Array.isArray(result.placements) ? result.placements : [];
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface MapAnswersOptions {
  /** Progress lines for scripts. */
  log?: (line: string) => void;
  /** Set false to run fully deterministic (anything needing judgment lands in `unmapped`). */
  useModel?: boolean;
}

/** Last write wins by `updated_at`, then by position. */
function latestAnswers(answers: readonly Answer[]): Answer[] {
  const byField = new Map<string, Answer>();
  answers.forEach((answer) => {
    const key = answer.field_id.trim();
    const existing = byField.get(key);
    if (!existing || Date.parse(answer.updated_at) >= Date.parse(existing.updated_at)) {
      byField.set(key, answer);
    }
  });
  return Array.from(byField.values());
}

/** Spread a value over a comb: leader gets char 1, `<key>__box_n` gets char n. */
function expandComb(index: SchemaIndex, field: FormSchemaField, value: string): MappedValue[] {
  const boxes = index.combs.get(field.normalized_key ?? '');
  if (!boxes) return [{ pdf_field_name: pdfNameOf(field), value }];
  const chars = Array.from(value);
  const out: MappedValue[] = [{ pdf_field_name: pdfNameOf(field), value: chars[0] ?? '' }];
  const size = Math.max(...boxes.keys());
  for (let n = 2; n <= size; n += 1) {
    const name = boxes.get(n);
    const char = chars[n - 1];
    if (!name || char === undefined) continue;
    out.push({ pdf_field_name: name, value: char });
  }
  return out;
}

/**
 * M1_MODULES.mapAnswers. Never throws for a bad answer — it lands in
 * `unmapped`. Throws only when the schema itself is empty.
 */
export async function mapAnswers(
  input: MapAnswersInput,
  options: MapAnswersOptions = {},
): Promise<MappedAnswers> {
  const log = options.log ?? (() => undefined);
  const useModel = options.useModel ?? hasOpenAiKey();
  const index = indexSchema(input.schema);
  if (index.eligible.length === 0) {
    throw new Error('mapAnswers: the form schema has no fillable fields');
  }

  const values = new Map<string, string>(); // pdf_field_name -> value
  const unmapped: string[] = [];
  const needsOptionPick: Array<{ answer: Answer; field: FormSchemaField; text: string }> = [];
  const free: Array<{ field_id: string; text: string }> = [];

  const write = (field: FormSchemaField, value: string): void => {
    for (const entry of expandComb(index, field, value)) values.set(entry.pdf_field_name, entry.value);
  };

  for (const answer of latestAnswers(input.answers)) {
    const text = answerText(answer);
    if (text === '') continue; // a blank is not an answer; nothing to place
    const field = resolveDirect(index, answer.field_id);
    if (!field) {
      free.push({ field_id: answer.field_id, text });
      continue;
    }
    const typed = typeValue(field, text);
    if (typed === null) {
      needsOptionPick.push({ answer, field, text });
      continue;
    }
    write(field, typed);
  }

  // Option fields whose answer matched nothing: one call per field.
  for (const pending of needsOptionPick) {
    let chosen: string | null = null;
    if (useModel) {
      try {
        chosen = await pickOption(pending.field, pending.text);
      } catch (error) {
        log(`map-answers: option pick failed for ${pending.field.field_id}: ${(error as Error).message}`);
      }
    }
    if (chosen) {
      write(pending.field, chosen);
      log(`map-answers: "${pending.text}" -> ${pending.field.field_id} = ${chosen}`);
    } else {
      unmapped.push(pending.answer.field_id);
    }
  }

  // Answers saved under unknown keys: one call, enum = the remaining fields.
  if (free.length > 0) {
    let placements: Placement[] = [];
    if (useModel) {
      try {
        placements = await placeFreeAnswers(index, free, new Set(values.keys()));
      } catch (error) {
        log(`map-answers: placement call failed: ${(error as Error).message}`);
      }
    }
    const placed = new Set<string>();
    for (const placement of placements) {
      const source = free.find((a) => a.field_id === placement.answer_field_id);
      if (!source || placed.has(source.field_id)) continue;
      const field = placement.pdf_field_name ? index.byPdfName.get(placement.pdf_field_name) : undefined;
      if (!field || values.has(pdfNameOf(field))) continue;
      const typed = typeValue(field, placement.value || source.text);
      if (typed === null || typed === '') continue;
      write(field, typed);
      placed.add(source.field_id);
      log(`map-answers: ${JSON.stringify(source.field_id)} -> ${field.field_id} = ${typed}`);
    }
    for (const entry of free) {
      if (!placed.has(entry.field_id)) unmapped.push(entry.field_id);
    }
  }

  return {
    values: Array.from(values.entries()).map(([pdf_field_name, value]) => ({ pdf_field_name, value })),
    unmapped,
  };
}

/** The Instant JSON `fillAndFlatten()` takes, straight from a mapping. Blank values are left out. */
export function toInstantJson(mapped: MappedAnswers): InstantJson {
  return {
    formFieldValues: mapped.values
      .filter((entry) => entry.value !== '')
      .map((entry) => ({
        name: entry.pdf_field_name,
        type: INSTANT_JSON_FIELD_TYPE,
        v: 1,
        value: entry.value,
      })),
    format: INSTANT_JSON_FORMAT,
  };
}
