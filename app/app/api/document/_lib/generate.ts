/**
 * Server-side Nutrient document pipeline.
 *
 * Folders prefixed with `_` are ignored by the App Router, so this module is
 * shared code, not a route. It runs ONLY on the server: the three Nutrient
 * server keys are read from process.env and never reach the browser.
 *
 * Pipeline (verified live against api.nutrient.io):
 *   1. GET the official HCAI application PDF (394,890 bytes, 101 AcroForm fields)
 *   2. POST /build   with actions [applyInstantJson, flatten]
 *        - `flatten` is REQUIRED. Without it every value renders blank.
 *        - multipart parts must be named exactly "document" and "instant"
 *   3. POST /accessibility/autotag on the filled bytes
 *
 * Results are cached on disk so repeated demo runs never re-bill the API.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CEDARS_APPLICATION_PDF_URL,
  DEMO_ANSWERS,
  DEMO_CASE_ID,
  DEMO_FILLED_PDF_PATH,
  INSTANT_JSON_FIELD_TYPE,
  INSTANT_JSON_FORMAT,
  NUTRIENT_BUILD_INSTRUCTIONS,
  NUTRIENT_BUILD_PART_DOCUMENT,
  NUTRIENT_BUILD_PART_INSTANT,
  NUTRIENT_ENDPOINTS,
  type Answer,
  type Id,
  type InstantJson,
  type InstantJsonFormFieldValue,
} from '../../../../lib/contract';
import type { GeneratedDocument } from './types';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** In demo mode any live failure degrades to the bundled fixture PDF. */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE !== 'false';

const FETCH_TIMEOUT_MS = 120_000;

/** Where generated PDFs are memoized between runs. Never served directly. */
const CACHE_DIR = path.join(process.cwd(), '.doccache');

/** Shipped fallback: a real, previously generated filled application. */
const FIXTURE_PATH = path.join(
  process.cwd(),
  'public',
  ...DEMO_FILLED_PDF_PATH.replace(/^\//, '').split('/'),
);

/* ------------------------------------------------------------------ */
/* Field mapping                                                       */
/* ------------------------------------------------------------------ */

/**
 * Aliases so a voice answer keyed by `form_schema.normalized_key` still lands
 * on the right AcroForm field. Answers whose `field_id` is already the exact
 * AcroForm name pass through untouched.
 */
const NORMALIZED_KEY_TO_PDF_FIELD: Readonly<Record<string, string>> = {
  patient_name: 'Patient name',
  date_of_birth: 'Date of birth',
  home_address: 'Home address',
  city: 'City',
  state: 'State',
  zip_code: 'ZIP code',
  home_phone_number: 'Home phone number',
  preferred_method_of_contact: 'Preferred method of contact',
  marital_status: 'Marital status:',
  household_size: 'as reported on your taxes',
  employment_status: 'Employment status',
  insurer: 'Insurer',
  policyholder: 'Policyholder',
  applied_for_medi_cal: 'Have you applied for MediCalMedicaid',
  screened_for_medi_cal: 'Have you been screened for MediCalMedicaid eligibility',
  eligible_for_coverage: 'Are you eligible for any health insurance coverage?',
  annual_household_income: 'Annual household income:',
  gross_monthly_income: 'Gross income',
  rent_or_mortgage: 'Rent or mortgage',
  utilities_and_telephone: 'Utilities and telephone',
  food: 'Food',
  medical_and_dental: 'Medical and dental',
  transportation_and_auto: 'Transportation and auto (insurance, gas, repairs, lease)',
  clothing_and_laundry: 'Clothing and laundry',
  total_monthly_expenses: 'Total monthly expenses',
  outstanding_medical_debt: 'Outstanding medical debt at Cedars-Sinai or Huntington Health',
};

export function resolvePdfFieldName(fieldId: string): string {
  return NORMALIZED_KEY_TO_PDF_FIELD[fieldId] ?? fieldId;
}

/**
 * The Cedars form prints "$" next to every currency box, so a value carrying
 * its own dollar sign would render as "$$24,600".
 */
export function formatAnswerValue(value: Answer['value_json']): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value).trim();
  return text.startsWith('$') ? text.slice(1).trim() : text;
}

/** Map saved answers into the exact Instant JSON shape /build accepts. */
export function buildInstantJson(answers: readonly Answer[]): InstantJson {
  const formFieldValues: InstantJsonFormFieldValue[] = [];
  const seen = new Set<string>();

  for (const answer of answers) {
    const name = resolvePdfFieldName(answer.field_id);
    const value = formatAnswerValue(answer.value_json);
    if (!name || value === '' || seen.has(name)) continue;
    seen.add(name);
    formFieldValues.push({ name, type: INSTANT_JSON_FIELD_TYPE, v: 1, value });
  }

  return { formFieldValues, format: INSTANT_JSON_FORMAT };
}

/* ------------------------------------------------------------------ */
/* Nutrient calls                                                      */
/* ------------------------------------------------------------------ */

export class NutrientError extends Error {
  readonly status: number;
  constructor(endpoint: string, status: number, detail: string) {
    super(`${endpoint} -> HTTP ${status}: ${detail.slice(0, 300)}`);
    this.name = 'NutrientError';
    this.status = status;
  }
}

function requireKey(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in the server environment`);
  return value;
}

async function postWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, method: 'POST', signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the official application PDF from HCAI. */
export async function fetchSourcePdf(url: string = CEDARS_APPLICATION_PDF_URL): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) {
      throw new NutrientError(url, response.status, await response.text().catch(() => ''));
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function toBlob(bytes: Uint8Array, type: string): Blob {
  // Copy into a plain ArrayBuffer so the Blob constructor is happy under
  // TypeScript's stricter ArrayBufferLike typing.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

/**
 * POST /build — apply Instant JSON to the AcroForm, then flatten.
 * Auth: NUTRIENT_DWS_PROCESSOR_API.
 */
export async function fillForm(pdfBytes: Uint8Array, instantJson: InstantJson): Promise<Uint8Array> {
  const form = new FormData();
  form.append('instructions', JSON.stringify(NUTRIENT_BUILD_INSTRUCTIONS));
  form.append(
    NUTRIENT_BUILD_PART_DOCUMENT,
    toBlob(pdfBytes, 'application/pdf'),
    'application.pdf',
  );
  form.append(
    NUTRIENT_BUILD_PART_INSTANT,
    new Blob([JSON.stringify(instantJson)], { type: 'application/json' }),
    'instant.json',
  );

  const response = await postWithTimeout(NUTRIENT_ENDPOINTS.build, {
    headers: { Authorization: `Bearer ${requireKey('NUTRIENT_DWS_PROCESSOR_API')}` },
    body: form,
  });

  if (!response.ok) {
    throw new NutrientError('/build', response.status, await response.text().catch(() => ''));
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * POST /accessibility/autotag — PDF/UA tagging pass.
 * Auth: NUTRIENT_ACCESSIBILITY_API.
 */
export async function autotag(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const form = new FormData();
  form.append('file', toBlob(pdfBytes, 'application/pdf'), 'filled.pdf');

  const response = await postWithTimeout(NUTRIENT_ENDPOINTS.accessibilityAutotag, {
    headers: { Authorization: `Bearer ${requireKey('NUTRIENT_ACCESSIBILITY_API')}` },
    body: form,
  });

  if (!response.ok) {
    throw new NutrientError(
      '/accessibility/autotag',
      response.status,
      await response.text().catch(() => ''),
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/* ------------------------------------------------------------------ */
/* Orchestration + cache                                               */
/* ------------------------------------------------------------------ */

export type { DocumentOrigin, GeneratedDocument } from './types';

export interface GeneratedDocumentWithBytes extends GeneratedDocument {
  pdfBytes: Uint8Array;
}

function versionHashFor(caseId: Id, instantJson: InstantJson, sourceUrl: string): string {
  return createHash('sha256')
    .update(caseId)
    .update(sourceUrl)
    .update(JSON.stringify(instantJson.formFieldValues))
    .digest('hex')
    .slice(0, 16);
}

async function readCached(hash: string, suffix: 'tagged' | 'filled'): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(path.join(CACHE_DIR, `${hash}.${suffix}.pdf`));
    return bytes.byteLength > 0 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

async function writeCached(hash: string, suffix: 'tagged' | 'filled', bytes: Uint8Array): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path.join(CACHE_DIR, `${hash}.${suffix}.pdf`), bytes);
  } catch {
    /* a read-only filesystem must not break the demo */
  }
}

async function readFixture(): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(FIXTURE_PATH);
    return bytes.byteLength > 0 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

/** In-flight de-duplication so two viewers do not bill /build twice. */
const inFlight = new Map<string, Promise<GeneratedDocumentWithBytes>>();

export interface FinalizeOptions {
  caseId?: Id;
  answers?: readonly Answer[];
  sourceUrl?: string;
  /** Skip the network entirely and answer from cache/fixture only. */
  cachedOnly?: boolean;
}

/**
 * Fill + tag the official application for a case, memoized on disk.
 * Never throws in demo mode: it degrades to the bundled fixture.
 */
export function finalizeDocument(options: FinalizeOptions = {}): Promise<GeneratedDocumentWithBytes> {
  const caseId = options.caseId ?? DEMO_CASE_ID;
  const answers = options.answers ?? DEMO_ANSWERS;
  const sourceUrl = options.sourceUrl ?? CEDARS_APPLICATION_PDF_URL;
  const instantJson = buildInstantJson(answers);
  const hash = versionHashFor(caseId, instantJson, sourceUrl);
  const key = `${caseId}:${hash}:${options.cachedOnly ? 'cached' : 'live'}`;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const job = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, job);
  return job;

  async function run(): Promise<GeneratedDocumentWithBytes> {
    const base = {
      caseId,
      documentUrl: `/api/document/${encodeURIComponent(caseId)}`,
      sourceUrl,
      versionHash: hash,
      fieldsFilled: instantJson.formFieldValues.length,
    };

    // 1. Fully processed document already on disk — nothing to bill.
    const tagged = await readCached(hash, 'tagged');
    if (tagged) {
      return {
        ...base,
        pdfBytes: tagged,
        byteLength: tagged.byteLength,
        accessibilityStatus: 'processed',
        origin: 'cache',
        note: null,
      };
    }

    // 2. Filled-but-untagged document on disk. /build has already been paid
    //    for, so only the accessibility pass is retried.
    const cachedFilled = await readCached(hash, 'filled');

    if (!options.cachedOnly) {
      try {
        const filled =
          cachedFilled ?? (await fillForm(await fetchSourcePdf(sourceUrl), instantJson));
        if (!cachedFilled) await writeCached(hash, 'filled', filled);

        try {
          const bytes = await autotag(filled);
          await writeCached(hash, 'tagged', bytes);
          return {
            ...base,
            pdfBytes: bytes,
            byteLength: bytes.byteLength,
            accessibilityStatus: 'processed',
            origin: cachedFilled ? 'cache' : 'live',
            note: null,
          };
        } catch (error) {
          // The filled document is real; only the accessibility pass failed.
          // Serve it untagged and say so, in every mode.
          return {
            ...base,
            pdfBytes: filled,
            byteLength: filled.byteLength,
            accessibilityStatus: 'failed',
            origin: cachedFilled ? 'cache' : 'live',
            note:
              error instanceof NutrientError && error.status === 402
                ? 'The Nutrient accessibility pass did not run: this account is out of processing credit.'
                : 'The Nutrient accessibility pass did not complete for this document.',
          };
        }
      } catch (error) {
        if (!DEMO_MODE) throw error;
      }
    }

    // 3. Offline / cached-only path: serve what has already been produced.
    if (cachedFilled) {
      return {
        ...base,
        pdfBytes: cachedFilled,
        byteLength: cachedFilled.byteLength,
        accessibilityStatus: 'pending',
        origin: 'cache',
        note: 'The Nutrient accessibility pass has not run on this document yet.',
      };
    }

    const fixture = DEMO_MODE ? await readFixture() : null;
    if (!fixture) {
      throw new Error(
        `No document available for case ${caseId}: live generation failed and no fixture exists at ${FIXTURE_PATH}`,
      );
    }

    return {
      ...base,
      pdfBytes: fixture,
      byteLength: fixture.byteLength,
      accessibilityStatus: 'pending',
      origin: 'fixture',
      note: 'Showing the bundled copy of the filled application; the live document service was unreachable.',
    };
  }
}

/** Metadata only — safe to await inside a server component render. */
export async function describeDocument(options: FinalizeOptions = {}): Promise<GeneratedDocument> {
  const { pdfBytes: _pdfBytes, ...meta } = await finalizeDocument(options);
  return meta;
}
