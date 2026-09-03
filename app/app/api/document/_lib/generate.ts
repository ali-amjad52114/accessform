/**
 * Server-side document pipeline.
 *
 * Folders prefixed with `_` are ignored by the App Router, so this module is
 * shared code, not a route. It runs ONLY on the server.
 *
 * Pipeline:
 *   1. GET the official HCAI application PDF (394,890 bytes, 101 AcroForm fields)
 *   2. fillAndFlatten()        — `lib/document/engine.ts` picks the engine:
 *        local    (default)    pdf-lib fill + flatten. No paid API, no watermark.
 *        nutrient (opt-in)     POST /build with [applyInstantJson, flatten].
 *   3. processAccessibility()  — local: verify the official document's own
 *                                tagging survived -> 'preserved';
 *                                nutrient: POST /accessibility/autotag -> 'processed'.
 *
 * Results are cached on disk per engine so repeated demo runs never re-bill
 * the API and a watermarked Nutrient artifact is never served as local output.
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
  type AccessibilityStatus,
  type Answer,
  type Id,
  type InstantJson,
  type InstantJsonFormFieldValue,
} from '../../../../lib/contract';
import {
  fillAndFlatten,
  processAccessibility,
  resolveEngine,
  type AccessibilityResult,
  type DocumentEngine,
  type FillResult,
} from '../../../../lib/document/engine';
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

/** Map saved answers into the exact Instant JSON shape both engines accept. */
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
/* Source fetch + engine calls                                         */
/* ------------------------------------------------------------------ */

/** Kept for callers that still key on an HTTP status from the document layer. */
export class NutrientError extends Error {
  readonly status: number;
  constructor(endpoint: string, status: number, detail: string) {
    super(`${endpoint} -> HTTP ${status}: ${detail.slice(0, 300)}`);
    this.name = 'NutrientError';
    this.status = status;
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

/**
 * Fill + flatten through the configured engine. Returns the bytes only;
 * use `fillFormDetailed` when the engine / skipped-field report matters.
 */
export async function fillForm(
  pdfBytes: Uint8Array,
  instantJson: InstantJson,
  engine: DocumentEngine = resolveEngine(),
): Promise<Uint8Array> {
  return (await fillFormDetailed(pdfBytes, instantJson, engine)).pdfBytes;
}

export async function fillFormDetailed(
  pdfBytes: Uint8Array,
  instantJson: InstantJson,
  engine: DocumentEngine = resolveEngine(),
): Promise<FillResult> {
  const result = await fillAndFlatten(pdfBytes, instantJson, engine);
  if (result.pdfBytes.byteLength === 0) {
    throw new Error(`${result.engine} engine returned an empty document`);
  }
  return result;
}

/**
 * Accessibility step through the configured engine. Resolves with the bytes
 * when the status is `processed` or `preserved`; rejects otherwise so legacy
 * callers keep their "throw means it did not run" contract.
 */
export async function autotag(
  pdfBytes: Uint8Array,
  engine: DocumentEngine = resolveEngine(),
): Promise<Uint8Array> {
  const result = await processAccessibility(pdfBytes, engine);
  if (result.status === 'processed' || result.status === 'preserved') return result.pdfBytes;
  throw new Error(result.note ?? `accessibility step ended with status ${result.status}`);
}

/* ------------------------------------------------------------------ */
/* Orchestration + cache                                               */
/* ------------------------------------------------------------------ */

export type { DocumentOrigin, GeneratedDocument } from './types';

export interface GeneratedDocumentWithBytes extends GeneratedDocument {
  pdfBytes: Uint8Array;
}

type CacheSuffix = 'filled' | 'tagged';

/**
 * The engine is part of the hash: a Nutrient-generated (possibly watermarked)
 * cache entry must never be served when the engine is `local`, and vice versa.
 */
function versionHashFor(
  caseId: Id,
  instantJson: InstantJson,
  sourceUrl: string,
  engine: DocumentEngine,
): string {
  return createHash('sha256')
    .update(caseId)
    .update(sourceUrl)
    .update(engine)
    .update(JSON.stringify(instantJson.formFieldValues))
    .digest('hex')
    .slice(0, 16);
}

function cachePath(hash: string, engine: DocumentEngine, suffix: CacheSuffix): string {
  return path.join(CACHE_DIR, `${hash}.${engine}.${suffix}.pdf`);
}

async function readCached(
  hash: string,
  engine: DocumentEngine,
  suffix: CacheSuffix,
): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(cachePath(hash, engine, suffix));
    return bytes.byteLength > 0 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

async function writeCached(
  hash: string,
  engine: DocumentEngine,
  suffix: CacheSuffix,
  bytes: Uint8Array,
): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(hash, engine, suffix), bytes);
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

/** Honest, short note describing what the accessibility step actually did. */
function accessibilityNote(result: AccessibilityResult): string | null {
  switch (result.status) {
    case 'processed':
      return result.note;
    case 'preserved':
      return (
        result.note ??
        "No accessibility pass ran; the official document's tagging was preserved."
      );
    case 'failed':
      return result.note ?? 'The accessibility pass did not complete for this document.';
    case 'pending':
    case 'processing':
    case 'not_applicable':
      return result.note;
  }
}

/** Notes about the fill itself (engine fallback, unmatched answers). */
function fillNotes(requested: DocumentEngine, fill: FillResult): string[] {
  const notes: string[] = [];
  if (fill.note) {
    notes.push(fill.note);
  } else if (fill.engine !== requested) {
    notes.push(
      `The ${requested} engine was unavailable, so the document was filled with the ${fill.engine} engine.`,
    );
  }
  if (fill.fieldsSkipped.length > 0) {
    notes.push(
      `${fill.fieldsSkipped.length} answer${fill.fieldsSkipped.length === 1 ? '' : 's'} did not match a field on the official form and ${fill.fieldsSkipped.length === 1 ? 'was' : 'were'} left blank.`,
    );
  }
  return notes;
}

function joinNotes(parts: Array<string | null | undefined>): string | null {
  const text = parts.filter((p): p is string => Boolean(p && p.trim())).join(' ');
  return text.length > 0 ? text : null;
}

/** In-flight de-duplication so two viewers do not bill /build twice. */
const inFlight = new Map<string, Promise<GeneratedDocumentWithBytes>>();

export interface FinalizeOptions {
  caseId?: Id;
  answers?: readonly Answer[];
  sourceUrl?: string;
  /** Skip the network entirely and answer from cache/fixture only. */
  cachedOnly?: boolean;
  /** Override `DOCUMENT_ENGINE` for this call. */
  engine?: DocumentEngine;
}

/**
 * Fill + accessibility-step the official application for a case, memoized on
 * disk per engine. Never throws in demo mode: it degrades to the bundled
 * fixture. Outside demo mode the fixture is never served.
 */
export function finalizeDocument(options: FinalizeOptions = {}): Promise<GeneratedDocumentWithBytes> {
  const caseId = options.caseId ?? DEMO_CASE_ID;
  const answers = options.answers ?? DEMO_ANSWERS;
  const sourceUrl = options.sourceUrl ?? CEDARS_APPLICATION_PDF_URL;
  const engine = options.engine ?? resolveEngine();
  const instantJson = buildInstantJson(answers);
  const hash = versionHashFor(caseId, instantJson, sourceUrl, engine);
  const key = `${caseId}:${hash}:${engine}:${options.cachedOnly ? 'cached' : 'live'}`;

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
      engine,
    };

    // 1. A Nutrient-tagged document already on disk — nothing to bill.
    //    Only the nutrient engine ever writes the 'tagged' suffix, and only
    //    after a successful autotag, so 'processed' is the true status here.
    const tagged = await readCached(hash, engine, 'tagged');
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

    // 2. Filled-but-not-yet-accessibility-stepped document on disk. The fill
    //    has already been paid for (or computed), so only the accessibility
    //    step is (re)run. For the local engine that step is offline and cheap
    //    (it verifies the structure tree), so it also runs in cachedOnly mode.
    const cachedFilled = await readCached(hash, engine, 'filled');
    const canRunAccessibilityOffline = engine === 'local';

    if (!options.cachedOnly || (cachedFilled && canRunAccessibilityOffline)) {
      try {
        let fill: FillResult | null = null;
        let filled = cachedFilled;
        if (!filled) {
          fill = await fillFormDetailed(await fetchSourcePdf(sourceUrl), instantJson, engine);
          filled = fill.pdfBytes;
          // A fallback fill (Nutrient unavailable -> local) is not cached under
          // the requested engine's key, so the next request retries Nutrient
          // instead of serving local output labelled as Nutrient's.
          if (fill.engine === engine) await writeCached(hash, engine, 'filled', filled);
        }
        const origin = cachedFilled ? 'cache' : 'live';
        const notesFromFill = fill ? fillNotes(engine, fill) : [];

        const access = await processAccessibility(filled, engine);
        if (access.status === 'processed' && access.engine === 'nutrient') {
          await writeCached(hash, engine, 'tagged', access.pdfBytes);
        }

        return {
          ...base,
          // The engine that actually produced the bytes, after any fallback.
          engine: fill?.engine ?? engine,
          pdfBytes: access.pdfBytes,
          byteLength: access.pdfBytes.byteLength,
          accessibilityStatus: access.status,
          origin,
          note: joinNotes([...notesFromFill, accessibilityNote(access)]),
        };
      } catch (error) {
        if (!DEMO_MODE) throw error;
      }
    }

    // 3. Offline / cached-only path: serve what has already been produced.
    if (cachedFilled) {
      const status: AccessibilityStatus = 'pending';
      return {
        ...base,
        pdfBytes: cachedFilled,
        byteLength: cachedFilled.byteLength,
        accessibilityStatus: status,
        origin: 'cache',
        note: 'The accessibility step has not run on this document yet.',
      };
    }

    const fixture = DEMO_MODE ? await readFixture() : null;
    if (!fixture) {
      throw new Error(
        `No document available for case ${caseId}: live generation failed and no fixture exists at ${FIXTURE_PATH}`,
      );
    }

    const { engine: _engine, ...fixtureBase } = base;
    return {
      ...fixtureBase,
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
