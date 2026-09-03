/**
 * Nutrient document engine — the paid Document Web Services HTTP calls.
 *
 * This is the ONE place the product talks to api.nutrient.io for filling and
 * tagging. The calls are lifted verbatim from `app/api/document/_lib/generate.ts`
 * and `lib/adapters/nutrient.ts` (same endpoints, same multipart part names,
 * same instructions), which now import from here.
 *
 * VERIFIED FACTS — do not "fix" them:
 *   NUTRIENT_DWS_PROCESSOR_API  -> POST https://api.nutrient.io/build
 *   NUTRIENT_ACCESSIBILITY_API  -> POST https://api.nutrient.io/accessibility/autotag
 *   Each key is locked to exactly one path (wrong path 403, wrong key 401).
 *   /build needs actions [applyInstantJson, flatten] — without `flatten` every
 *   value renders blank. Parts must be named exactly "document" and "instant".
 *
 * Failure semantics required by the engine facade:
 *   - /build 401/402/403 (no credit / bad key)  -> fall back to the LOCAL engine
 *     and say so in `note`; the result's `engine` is 'local'.
 *   - /build any other failure                  -> throw NutrientError.
 *   - /accessibility/autotag any failure        -> status 'failed' + note; never
 *     throw, never claim 'processed'. (402 = account out of credit.)
 *
 * SERVER-SIDE ONLY — keys come from process.env and never reach the browser.
 */

import {
  NUTRIENT_BUILD_INSTRUCTIONS,
  NUTRIENT_BUILD_PART_DOCUMENT,
  NUTRIENT_BUILD_PART_INSTANT,
  NUTRIENT_ENDPOINTS,
  type InstantJson,
} from '../contract';
import { nutrientKeys } from '../adapters/env';
import { recordFallback } from '../adapters/errors';
import type { AccessibilityResult, FillResult } from './engine';
import { localFillAndFlatten } from './local-engine';

/** /build and /accessibility/autotag are slow on a 395 KB PDF. */
const FETCH_TIMEOUT_MS = 120_000;

const PDF_MIME = 'application/pdf';
const JSON_MIME = 'application/json';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Same shape as the NutrientError generate.ts has always thrown. */
export class NutrientError extends Error {
  readonly endpoint: string;
  /** HTTP status, or 0 when the request never got a response (missing key, timeout). */
  readonly status: number;
  constructor(endpoint: string, status: number, detail: string) {
    super(`${endpoint} -> HTTP ${status}: ${detail.slice(0, 300)}`);
    this.name = 'NutrientError';
    this.endpoint = endpoint;
    this.status = status;
  }
}

/** 401 wrong key, 402 out of credit, 403 key locked to another path. */
export function isNutrientAuthOrCreditError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 402 || status === 403;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function requireKey(name: 'NUTRIENT_DWS_PROCESSOR_API' | 'NUTRIENT_ACCESSIBILITY_API'): string {
  const keys = nutrientKeys();
  const value = name === 'NUTRIENT_DWS_PROCESSOR_API' ? keys.processor : keys.accessibility;
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

function toBlob(bytes: Uint8Array, type: string): Blob {
  // Copy into a plain ArrayBuffer so the Blob never captures a larger pooled
  // Node Buffer backing store (and TypeScript's ArrayBufferLike typing is happy).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

/**
 * POST /build — apply Instant JSON to the AcroForm, then flatten.
 * Auth: NUTRIENT_DWS_PROCESSOR_API. Throws NutrientError on any non-2xx.
 */
export async function nutrientFillForm(
  pdfBytes: Uint8Array,
  instantJson: InstantJson,
): Promise<Uint8Array> {
  const form = new FormData();
  form.append('instructions', JSON.stringify(NUTRIENT_BUILD_INSTRUCTIONS));
  form.append(NUTRIENT_BUILD_PART_DOCUMENT, toBlob(pdfBytes, PDF_MIME), 'application.pdf');
  form.append(
    NUTRIENT_BUILD_PART_INSTANT,
    new Blob([JSON.stringify(instantJson)], { type: JSON_MIME }),
    'instant.json',
  );

  const response = await postWithTimeout(NUTRIENT_ENDPOINTS.build, {
    headers: { Authorization: `Bearer ${requireKey('NUTRIENT_DWS_PROCESSOR_API')}` },
    body: form,
  });

  if (!response.ok) {
    throw new NutrientError('/build', response.status, await response.text().catch(() => ''));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new NutrientError('/build', response.status, 'build returned an empty document');
  }
  return bytes;
}

/**
 * POST /accessibility/autotag — PDF/UA tagging pass.
 * Auth: NUTRIENT_ACCESSIBILITY_API. Throws NutrientError on any non-2xx.
 */
export async function nutrientAutotag(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const form = new FormData();
  form.append('file', toBlob(pdfBytes, PDF_MIME), 'filled.pdf');

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
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new NutrientError('/accessibility/autotag', response.status, 'autotag returned no document');
  }
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Engine-shaped wrappers                                              */
/* ------------------------------------------------------------------ */

function isMissingKeyError(error: unknown): boolean {
  return error instanceof Error && /is not set in the server environment/.test(error.message);
}

/**
 * Fill via /build. On 401/402/403 — or a missing processor key — the local
 * engine produces the document instead and the result says so.
 */
export async function nutrientFillAndFlatten(
  sourcePdf: Uint8Array,
  instantJson: InstantJson,
): Promise<FillResult> {
  try {
    const pdfBytes = await nutrientFillForm(sourcePdf, instantJson);
    return {
      pdfBytes,
      engine: 'nutrient',
      fieldsWritten: instantJson.formFieldValues.length,
      fieldsSkipped: [],
      note: null,
    };
  } catch (error) {
    if (!isNutrientAuthOrCreditError(error) && !isMissingKeyError(error)) throw error;

    const reason = describe(error);
    recordFallback({
      integration: 'nutrient',
      operation: 'build',
      reason,
      at: new Date().toISOString(),
    });
    if (typeof console !== 'undefined') {
      console.warn(`[accessform] nutrient /build unavailable; filled with the local engine. ${reason}`);
    }

    const local = await localFillAndFlatten(sourcePdf, instantJson);
    const status = error instanceof NutrientError ? error.status : 0;
    return {
      ...local,
      note:
        status === 402
          ? 'Nutrient /build returned 402 (account out of processing credit); the document was filled by the local engine instead.'
          : `Nutrient /build was unavailable (${reason}); the document was filled by the local engine instead.`,
    };
  }
}

/**
 * Autotag via /accessibility/autotag. Never throws: any failure returns the
 * untouched bytes with status 'failed' so nothing can claim the pass ran.
 */
export async function nutrientProcessAccessibility(
  filledPdf: Uint8Array,
): Promise<AccessibilityResult> {
  try {
    const pdfBytes = await nutrientAutotag(filledPdf);
    return { pdfBytes, status: 'processed', engine: 'nutrient', note: null };
  } catch (error) {
    const reason = describe(error);
    recordFallback({
      integration: 'nutrient',
      operation: 'autotag',
      reason,
      at: new Date().toISOString(),
    });
    if (typeof console !== 'undefined') {
      console.warn(`[accessform] nutrient.autotag failed; document kept UNTAGGED. ${reason}`);
    }
    const copy = new Uint8Array(filledPdf.byteLength);
    copy.set(filledPdf);
    return {
      pdfBytes: copy,
      status: 'failed',
      engine: 'nutrient',
      note:
        error instanceof NutrientError && error.status === 402
          ? 'The Nutrient accessibility pass did not run: this account is out of processing credit.'
          : `The Nutrient accessibility pass did not complete for this document. ${reason}`,
    };
  }
}
