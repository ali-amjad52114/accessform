/**
 * Document engine facade.
 *
 * Every place that turns the official application PDF into a filled, flattened
 * document goes through this module — `app/api/document/_lib/generate.ts` and
 * `lib/adapters/nutrient.ts` both call `fillAndFlatten` / `processAccessibility`
 * instead of talking to a PDF library or to Nutrient themselves.
 *
 * Two engines:
 *   - 'local'    pdf-lib, in-process. No network, no credit, no watermark.
 *                Fills by exact AcroForm name, flattens, and keeps the source
 *                document's existing structure tree / MarkInfo / Lang intact.
 *   - 'nutrient' the paid Document Web Services API (POST /build, then
 *                POST /accessibility/autotag). Kept behind the DOCUMENT_ENGINE
 *                flag for when the account has credit again.
 *
 * Engine selection (`resolveEngine`):
 *   DOCUMENT_ENGINE=nutrient  AND  NUTRIENT_DWS_PROCESSOR_API present -> 'nutrient'
 *   anything else                                                     -> 'local'
 *
 * SERVER-SIDE ONLY: the Nutrient keys are read from process.env.
 */

import type { AccessibilityStatus, InstantJson } from '../contract';
import { localFillAndFlatten, localProcessAccessibility } from './local-engine';
import { nutrientFillAndFlatten, nutrientProcessAccessibility } from './nutrient-engine';

export type DocumentEngine = 'nutrient' | 'local';

/** The only env var that picks the engine. Unset / anything else means 'local'. */
export const DOCUMENT_ENGINE_ENV = 'DOCUMENT_ENGINE' as const;

export interface FillResult {
  pdfBytes: Uint8Array;
  /** The engine that actually produced `pdfBytes` (after any fallback). */
  engine: DocumentEngine;
  fieldsWritten: number;
  /** Instant JSON field names that did not land on the document. */
  fieldsSkipped: string[];
  /**
   * Non-fatal problem worth surfacing (e.g. "Nutrient /build returned 402;
   * filled locally instead"). Never a claim of success.
   */
  note?: string | null;
}

export interface AccessibilityResult {
  pdfBytes: Uint8Array;
  /**
   * 'processed'  a Nutrient autotag pass ran and succeeded.
   * 'preserved'  no pass ran; the official source's own tagging was verified
   *              intact after filling (local engine).
   * 'failed'     the pass did not run / did not complete, or the tagging was lost.
   */
  status: AccessibilityStatus;
  engine: DocumentEngine;
  /** Human explanation for anything other than success, else null. */
  note: string | null;
}

function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 'local' unless DOCUMENT_ENGINE is explicitly "nutrient" AND the /build key
 * is present. A stray "nutrient" without a key must never take the product
 * offline, so it silently resolves to 'local'.
 */
export function resolveEngine(): DocumentEngine {
  const requested = readEnv(DOCUMENT_ENGINE_ENV)?.toLowerCase();
  if (requested === 'nutrient' && readEnv('NUTRIENT_DWS_PROCESSOR_API')) {
    return 'nutrient';
  }
  return 'local';
}

/**
 * Apply Instant JSON to the AcroForm and flatten the result.
 *
 * The Nutrient engine falls back to the local engine on HTTP 401/402/403 (the
 * result's `engine` says 'local' and `note` explains why). Any other Nutrient
 * failure throws a `NutrientError` so the caller's own fallback logic runs.
 * The local engine never throws for an unknown field name — it lands in
 * `fieldsSkipped`.
 */
export async function fillAndFlatten(
  sourcePdf: Uint8Array,
  instantJson: InstantJson,
  engine: DocumentEngine = resolveEngine(),
): Promise<FillResult> {
  if (engine === 'nutrient') {
    return nutrientFillAndFlatten(sourcePdf, instantJson);
  }
  return localFillAndFlatten(sourcePdf, instantJson);
}

/**
 * Accessibility step for an already-filled document.
 *
 * Nutrient: POST /accessibility/autotag -> 'processed', or 'failed' with a
 * note (HTTP 402 = out of credit). Never throws.
 * Local: verifies the source's structure tree survived flattening and
 * returns the same bytes with 'preserved', or 'failed' if it did not.
 */
export async function processAccessibility(
  filledPdf: Uint8Array,
  engine: DocumentEngine = resolveEngine(),
): Promise<AccessibilityResult> {
  if (engine === 'nutrient') {
    return nutrientProcessAccessibility(filledPdf);
  }
  return localProcessAccessibility(filledPdf);
}

export { NutrientError, isNutrientAuthOrCreditError } from './nutrient-engine';
export { inspectTagging, type TaggingInspection } from './local-engine';
