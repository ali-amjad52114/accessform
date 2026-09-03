/**
 * Need resolver — the caller's own words -> { category, organization?, location? }.
 *
 * `gpt-4o-mini` with a strict JSON schema whose `category` enum is
 * `NEED_CATEGORIES`. The organization is only ever what the caller NAMED;
 * "a hospital in LA" is not an organization. One clarifying question is
 * attached when the resolver is unsure, or when the category needs a place
 * and none was given (discovery is regional).
 *
 * Contract: docs/M1_CONTRACT.md §3.1. Never throws — an OpenAI failure
 * degrades to `{ category: 'other', confidence: 0, clarifying_question }`.
 */

import {
  NEED_CATEGORIES,
  NEED_CATEGORY_LABELS,
  NEED_CONFIDENCE_FLOOR,
  OPENAI_CLASSIFIER_MODEL,
  type NeedCategory,
  type NeedResolution,
  type ResolveNeedInput,
} from '../contract';
import { completeStrictJson, NULLABLE_STRING, type JsonSchema } from './openai-json';

/** The exact sentence returned when the model cannot be consulted. */
export const NEED_FALLBACK_QUESTION =
  'Could you tell me a little more about what you need help with?';

/** Asked when the category is regional and the caller gave no place. */
export const LOCATION_QUESTION = 'Which city or county do you live in?';

/**
 * Categories whose official program depends on where the caller is. When the
 * caller named an organization the place is still useful but not blocking.
 */
const LOCATION_REQUIRED: ReadonlySet<NeedCategory> = new Set<NeedCategory>([
  'paratransit',
  'benefits',
  'hospital_financial_assistance',
  'disability_accommodation',
  'scholarship_financial_aid',
]);

interface ModelOutput {
  category: NeedCategory;
  organization: string | null;
  location: string | null;
  confidence: number;
  clarifying_question: string | null;
}

const NEED_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: [...NEED_CATEGORIES] },
    organization: NULLABLE_STRING,
    location: NULLABLE_STRING,
    confidence: { type: 'number' },
    clarifying_question: NULLABLE_STRING,
  },
  required: ['category', 'organization', 'location', 'confidence', 'clarifying_question'],
};

const SYSTEM_PROMPT = [
  'You classify what a caller with a disability needs help with, from their own words, for a phone assistant that finds official application forms.',
  'Return JSON only, matching the schema.',
  '',
  'Categories:',
  ...NEED_CATEGORIES.map((category) => `- ${category}: ${describe(category)}`),
  '',
  'Rules:',
  '- organization: ONLY an organization the caller explicitly named (a hospital, transit agency, college, school, or agency). If they named one informally (a nickname or short form), give its full official name when unambiguous. If they did not name one, return null. Never guess one from the city or the need.',
  '- location: the city, county, or region the caller said they are in or that the organization is in, if stated. Otherwise null. Never guess.',
  '- confidence: 0 to 1, how sure you are of the category.',
  '- clarifying_question: one short spoken question, only when the category is genuinely unclear (confidence below 0.6). Otherwise null. Never ask for a Social Security, account, or ID number.',
  '- Never say approved, eligible, qualified, submitted, or signed.',
].join('\n');

function describe(category: NeedCategory): string {
  switch (category) {
    case 'hospital_financial_assistance':
      return 'a hospital or medical bill they cannot pay; charity care; financial assistance from a hospital';
    case 'paratransit':
      return 'door-to-door or ADA paratransit rides because a disability or age makes fixed-route transit hard; getting to appointments';
    case 'disability_accommodation':
      return 'accommodations for a disability at a college, school, or workplace (DSPS, Section 504, ADA accommodations)';
    case 'scholarship_financial_aid':
      return 'a scholarship, grant, or financial aid for education';
    case 'benefits':
      return 'public benefits such as CalFresh/SNAP, Medi-Cal, disability benefits, housing or utility assistance';
    case 'appointment':
      return 'booking or changing an appointment';
    case 'other':
      return 'anything that does not fit the above, or too little information';
  }
}

function clamp01(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, number));
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fallback(location?: string): NeedResolution {
  return {
    category: 'other',
    ...(location ? { location } : {}),
    confidence: 0,
    clarifying_question: NEED_FALLBACK_QUESTION,
  };
}

/**
 * Resolve the caller's need. `input.location`, when given, is authoritative
 * over anything the model extracts.
 */
export async function resolveNeed(input: ResolveNeedInput): Promise<NeedResolution> {
  const situation = cleanText(input.situation_text) ?? '';
  const givenLocation = cleanText(input.location);
  if (!situation) return fallback(givenLocation);

  let output: ModelOutput;
  try {
    output = await completeStrictJson<ModelOutput>({
      model: OPENAI_CLASSIFIER_MODEL,
      name: 'need_resolution',
      schema: NEED_SCHEMA,
      system: SYSTEM_PROMPT,
      user: [
        `Caller said: "${situation}"`,
        givenLocation ? `Known location: ${givenLocation}` : 'Known location: none',
      ].join('\n'),
      maxTokens: 300,
    });
  } catch (error) {
    if (typeof console !== 'undefined') {
      console.warn(
        `[accessform] resolveNeed: OpenAI unavailable — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return fallback(givenLocation);
  }

  const category = (NEED_CATEGORIES as readonly string[]).includes(output.category)
    ? output.category
    : 'other';
  const confidence = clamp01(output.confidence);
  const organization = cleanText(output.organization);
  const location = givenLocation ?? cleanText(output.location);
  let clarifying = cleanText(output.clarifying_question);

  if (confidence < NEED_CONFIDENCE_FLOOR && !clarifying) {
    clarifying = NEED_FALLBACK_QUESTION;
  }
  // Discovery is regional: when the caller named no organization and the
  // category needs a place, ask exactly one question — where they are.
  if (!clarifying && !location && !organization && LOCATION_REQUIRED.has(category)) {
    clarifying = LOCATION_QUESTION;
  }

  return {
    category,
    ...(organization ? { organization } : {}),
    ...(location ? { location } : {}),
    confidence,
    ...(clarifying ? { clarifying_question: clarifying } : {}),
  };
}

/** Spoken label for a category, for tool results. */
export function needCategoryLabel(category: NeedCategory): string {
  return NEED_CATEGORY_LABELS[category];
}
