/**
 * Regenerate lib/forms/fixtures/cedars-form-schema.json from the cached
 * understandForm() output for the official Cedars-Sinai application.
 *
 *   cd app && npx tsx lib/forms/scripts/understand-catalog.ts --only=cedars   # fills .formcache
 *   cd app && npx tsx lib/forms/scripts/write-cedars-fixture.ts
 *
 * The fixture is the full 101-row schema exactly as understandForm() built
 * it, with ONE curated overlay: the spoken prompt and "why" of the 26
 * interview questions are the human-reviewed lines the Cedars demo has
 * always used (the model's versions are correct but plainer). Everything
 * else — sections, order, options, required flags, skips — is the model's.
 * The script refuses to write when the 26-field regression does not hold.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CEDARS_REGRESSION_FIELDS } from '../cedars-regression';
import { FORMCACHE_VERSION, formCacheDir, type UnderstoodField } from '../understand-form';

const CEDARS_SHA256 = '63954187b80911aab9addba8dab3fe87581d9bf229b2a99b2d594ca9c5ca8387';

/** Human-reviewed prompts for the 26 questions (from the original lib/voice/form-plan.ts). */
const CURATED: Readonly<Record<string, { prompt: string; why: string }>> = {
  'Patient name': {
    prompt: 'Can I start with your full name, as it appears on your hospital bill?',
    why: 'The hospital matches your application to your account by name.',
  },
  'Date of birth': {
    prompt: 'And what is your date of birth?',
    why: 'Cedars-Sinai uses your date of birth to be sure they have the right patient record.',
  },
  'Home address': { prompt: 'What is your street address, including an apartment number if you have one?', why: '' },
  City: { prompt: 'Which city is that in?', why: '' },
  State: { prompt: 'And which state?', why: '' },
  'ZIP code': { prompt: 'What is your ZIP code?', why: '' },
  'Home phone number': { prompt: 'What phone number should the hospital use to reach you?', why: '' },
  'Preferred method of contact': { prompt: 'Would you rather they reach you by phone, or by mail?', why: '' },
  'Marital status:': {
    prompt: 'The form asks about marital status — are you single, married, widowed, or divorced?',
    why: 'It affects how the hospital counts your household.',
  },
  'as reported on your taxes': {
    prompt: 'Do you live alone, or is anyone else in your household?',
    why: 'The discount is worked out against household size, so living alone can help you.',
  },
  'Employment status': { prompt: 'Are you working at the moment, or retired?', why: '' },
  Insurer: { prompt: 'Do you have health coverage right now — Medicare, Medi-Cal, or a private plan?', why: '' },
  Policyholder: { prompt: 'Is that coverage in your own name?', why: '' },
  'Have you applied for MediCalMedicaid': {
    prompt: 'Have you applied for Medi-Cal at any point?',
    why: 'Cedars-Sinai has to ask this before they can apply their own discount.',
  },
  'Have you been screened for MediCalMedicaid eligibility': {
    prompt: 'Has anyone at the hospital checked whether you qualify for Medi-Cal?',
    why: '',
  },
  'Are you eligible for any health insurance coverage?': {
    prompt: 'And you are covered by Medicare today — is that right?',
    why: '',
  },
  'Annual household income:': {
    prompt: 'Is that your only source of income for the year?',
    why: 'The form asks for a yearly total, so I add up the monthly amounts for you.',
  },
  'Gross income': {
    prompt: 'About how much money comes in each month, before anything is taken out?',
    why: 'The hospital needs your income to work out how much of the bill you may not have to pay. It stays with your application.',
  },
  'Outstanding medical debt at Cedars-Sinai or Huntington Health': {
    prompt: 'And the Cedars-Sinai bill you mentioned — is that the full amount you still owe them?',
    why: '',
  },
  'Rent or mortgage': {
    prompt: 'How much do you pay for rent or your mortgage each month?',
    why: 'The form asks what you spend each month, so the hospital can see what is left over.',
  },
  'Utilities and telephone': { prompt: 'Roughly what do your utilities and phone come to each month?', why: '' },
  Food: { prompt: 'And about how much on groceries and food?', why: '' },
  'Medical and dental': {
    prompt: 'What do you spend on medications and medical or dental costs in a month?',
    why: '',
  },
  'Transportation and auto (insurance, gas, repairs, lease)': {
    prompt: 'How about getting around — rides, bus fare, or a car?',
    why: '',
  },
  'Clothing and laundry': { prompt: 'And clothing and laundry?', why: '' },
  'Total monthly expenses': { prompt: 'Let me add those up and read the total back to you.', why: '' },
};

interface CacheFile {
  version: number;
  sha256: string;
  sha16: string;
  page_count: number;
  field_count: number;
  built_at: string;
  fields: Array<Omit<UnderstoodField, 'id' | 'program_id'>>;
}

function main(): void {
  const cachePath = path.join(formCacheDir(), `${CEDARS_SHA256}.json`);
  const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as CacheFile;
  if (cache.version !== FORMCACHE_VERSION || cache.sha256 !== CEDARS_SHA256) {
    throw new Error(`unexpected cache file at ${cachePath}`);
  }

  const problems: string[] = [];
  const byId = new Map(cache.fields.map((f) => [f.field_id, f]));
  const expected = new Set(CEDARS_REGRESSION_FIELDS.map((f) => f.field_id));
  for (const want of CEDARS_REGRESSION_FIELDS) {
    const got = byId.get(want.field_id);
    if (!got) problems.push(`missing ${want.field_id}`);
    else {
      if (!got.required) problems.push(`not required: ${want.field_id}`);
      if (got.section !== want.section) problems.push(`section ${want.field_id}: ${got.section} != ${want.section}`);
    }
  }
  for (const field of cache.fields) {
    if (field.required && !expected.has(field.field_id)) problems.push(`extra required: ${field.field_id}`);
  }
  if (problems.length > 0) {
    console.error('Cedars regression does not hold; fixture NOT written:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const fields = cache.fields.map((field) => {
    const curated = CURATED[field.field_id];
    return curated ? { ...field, conversational_prompt: curated.prompt, why: curated.why } : field;
  });
  const out = {
    source: 'understandForm() on the official Cedars-Sinai Financial Assistance Application (HCAI), prompts of the 26 interview questions human-reviewed',
    sha256: cache.sha256,
    sha16: cache.sha16,
    page_count: cache.page_count,
    field_count: cache.field_count,
    built_at: cache.built_at,
    fields,
  };
  const target = path.join(process.cwd(), 'lib', 'forms', 'fixtures', 'cedars-form-schema.json');
  writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`wrote ${target}: ${fields.length} rows, ${fields.filter((f) => f.required).length} required`);
}

main();
