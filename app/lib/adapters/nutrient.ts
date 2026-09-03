/**
 * Nutrient Document Web Services adapter.
 *
 * VERIFIED FACTS this file encodes — do not "fix" them:
 *
 *   NUTRIENT_DWS_PROCESSOR_API    -> POST https://api.nutrient.io/build
 *   NUTRIENT_DATA_EXTRACTION_API  -> POST https://api.nutrient.io/extraction/parse
 *   NUTRIENT_ACCESSIBILITY_API    -> POST https://api.nutrient.io/accessibility/autotag
 *
 * Each key is locked to exactly one path: the wrong path returns 403, the wrong
 * key returns 401. The base URL is not configurable and there are no
 * `NUTRIENT_*_URL` env vars.
 *
 * Form filling and the accessibility step go through `lib/document/engine.ts`,
 * which picks the engine from `DOCUMENT_ENGINE`:
 *   local    (default) pdf-lib fill + flatten; the official document's own
 *                      tagging is preserved -> accessibility_status 'preserved'.
 *   nutrient (opt-in)  POST /build with Instant JSON (`flatten` REQUIRED) and
 *                      POST /accessibility/autotag -> 'processed', or 'failed'
 *                      on HTTP 402 when the account is out of credit.
 *
 * SERVER-SIDE ONLY. These three keys must never reach the browser; the
 * browser-safe `pdf_pub_live_` viewer key is a different credential and 401s on
 * this REST API.
 *
 * Mirrors `clients/nutrient.py`, which is proven working against the live
 * account.
 */

import {
  CEDARS_APPLICATION_PDF_URL,
  INSTANT_JSON_FIELD_TYPE,
  INSTANT_JSON_FORMAT,
  NUTRIENT_ENDPOINTS,
  type AccessibilityStatus,
  type Answer,
  type CaseBundle,
  type ExtractedElement,
  type ExtractedForm,
  type ExtractFormInput,
  type FillFormInput,
  type FilledDocument,
  type FinalizeDocumentInput,
  type FinalizedDocument,
  type InstantJson,
  type InstantJsonFormFieldValue,
  type NutrientAdapter,
  type PdfFormFieldDescriptor,
  type TaggedDocument,
  type XanoAdapter,
} from '../contract';
import { buildPublicDocumentUrl } from '../../app/api/document/_lib/public-url';
import {
  fillAndFlatten,
  processAccessibility,
  resolveEngine,
  type DocumentEngine,
} from '../document/engine';
import { CEDARS_FORM_FIELDS } from '../fixtures/cedars-fields';
import { FixtureNutrientAdapter, fixtureNutrientAdapter } from '../fixtures/nutrient';
import { documentEngine, hasAllNutrientKeys, isBrowser, nutrientKeys } from './env';
import { AdapterError, recordFallback, withFallback } from './errors';
import { bytesToBlob, contentHash, fetchBytes, LONG_TIMEOUT_MS, request } from './http';
import { createXanoAdapter } from './xano';

const PDF_MIME = 'application/pdf';

/* ------------------------------------------------------------------ */
/* Accessibility status copy                                           */
/* ------------------------------------------------------------------ */

export interface AccessibilityEventCopy {
  event_type: string;
  message: string;
}

/**
 * The one place that turns an `AccessibilityStatus` into feed copy. Only
 * `processed` may claim that processing ran; `preserved` says exactly what
 * happened (the official document's own tagging was kept); everything else
 * stays honest about the pass not having completed.
 */
export function accessibilityEventFor(status: AccessibilityStatus): AccessibilityEventCopy {
  switch (status) {
    case 'processed':
      return { event_type: 'accessibility_processed', message: 'Accessibility processing complete' };
    case 'preserved':
      return {
        event_type: 'accessibility_preserved',
        message: "Official document's accessibility tagging preserved",
      };
    case 'failed':
      return { event_type: 'accessibility_failed', message: 'Accessibility processing unavailable' };
    case 'processing':
      return { event_type: 'accessibility_processing', message: 'Accessibility processing running' };
    case 'pending':
      return { event_type: 'accessibility_pending', message: 'Accessibility processing not yet run' };
    case 'not_applicable':
      return {
        event_type: 'accessibility_not_applicable',
        message: 'Accessibility processing does not apply',
      };
  }
}

/** Extraction request body, matching the proven Python client. */
const EXTRACTION_INSTRUCTIONS = {
  mode: 'understand',
  output: { format: 'spatial' },
} as const;

/* ------------------------------------------------------------------ */
/* Instant JSON                                                        */
/* ------------------------------------------------------------------ */

const REAL_FIELD_IDS = new Set(CEDARS_FORM_FIELDS.map((field) => field.field_id));

/**
 * Format an answer for the PDF.
 *
 * Currency fields already print "$" on the Cedars form, so a leading dollar
 * sign is stripped — "$24,600" would render as "$$24,600".
 */
export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value).trim();
  return text.startsWith('$') ? text.slice(1).trim() : text;
}

export interface BuildInstantJsonOptions {
  /**
   * Drop values whose field name is not a real AcroForm field on the official
   * document. Defaults to true — Nutrient rejects unknown field names.
   */
  restrictToKnownFields?: boolean;
}

/** Turn saved answers into the Instant JSON payload /build expects. */
export function buildInstantJson(
  answers: readonly Answer[],
  options: BuildInstantJsonOptions = {},
): InstantJson {
  const restrict = options.restrictToKnownFields ?? true;
  const formFieldValues: InstantJsonFormFieldValue[] = [];

  for (const answer of answers) {
    const value = formatFieldValue(answer.value_json);
    if (value === '') continue;
    if (restrict && !REAL_FIELD_IDS.has(answer.field_id)) continue;
    formFieldValues.push({
      name: answer.field_id,
      type: INSTANT_JSON_FIELD_TYPE,
      v: 1,
      value,
    });
  }

  return { formFieldValues, format: INSTANT_JSON_FORMAT };
}

/* ------------------------------------------------------------------ */
/* Extraction response parsing                                         */
/* ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return typeof value === 'object' && value !== null ? (value as Raw) : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Page number for an element.
 *
 * Verified live: `/extraction/parse` returns `page` as an OBJECT
 * `{ pageIndex, pageNumber, width, height }`, not a number. `pageNumber` is
 * 1-based; `pageIndex` is 0-based.
 */
function pageNumberOf(raw: unknown): number {
  const direct = num(raw);
  if (direct !== null) return direct;
  const page = asRecord(raw);
  const numbered = num(page.pageNumber);
  if (numbered !== null) return numbered;
  const indexed = num(page.pageIndex);
  return indexed !== null ? indexed + 1 : 0;
}

/**
 * Cell texts of a table element.
 *
 * Verified live: a `type: "table"` element carries its content in `cells`, and
 * its own `text` is empty. The whole monthly-expenses section of the Cedars form
 * is a table, so dropping cells loses every expense figure.
 */
function cellsOf(raw: unknown): Raw[] {
  const cells = asRecord(raw).cells;
  return Array.isArray(cells) ? cells.map(asRecord) : [];
}

function cellText(cell: Raw): string {
  return typeof cell.text === 'string' ? cell.text.trim() : '';
}

function parseElement(raw: unknown, index: number): ExtractedElement | null {
  const row = asRecord(raw);
  const cells = cellsOf(row);
  const ownText =
    typeof row.text === 'string'
      ? row.text
      : typeof row.content === 'string'
        ? row.content
        : '';
  // A table's readable content is the concatenation of its cells.
  const text =
    ownText ||
    (cells.length > 0 ? cells.map(cellText).filter(Boolean).join(' │ ') : '');
  // `role` ("Header", "Title", …) is more useful than the generic `type`
  // ("paragraph", "picture") when it is present.
  const role = typeof row.role === 'string' ? row.role : '';
  const type = role || (typeof row.type === 'string' ? row.type : 'unknown');
  if (!text && type === 'unknown') return null;

  // Verified live: bounds are `{ x, y, width, height }`.
  const boundsRaw = asRecord(row.bounds ?? row.boundingBox ?? row.bbox);
  const left = num(boundsRaw.left ?? boundsRaw.x);
  const top = num(boundsRaw.top ?? boundsRaw.y);
  const width = num(boundsRaw.width);
  const height = num(boundsRaw.height);

  return {
    type,
    text,
    page: pageNumberOf(row.page ?? row.pageIndex),
    bounds:
      left !== null && top !== null && width !== null && height !== null
        ? { left, top, width, height }
        : null,
    confidence: num(row.confidence),
    readingOrder: num(row.readingOrder ?? row.reading_order) ?? index,
  };
}

/**
 * Elements can live at several depths depending on the output format.
 * Verified live: `spatial` output puts them at `output.elements`.
 */
function collectElements(payload: unknown): ExtractedElement[] {
  const root = asRecord(payload);
  const output = asRecord(root.output);
  const data = asRecord(root.data);
  const candidates: unknown[] = [];

  const push = (value: unknown): void => {
    if (Array.isArray(value)) candidates.push(...value);
  };

  push(output.elements);
  push(root.elements);
  push(root.content);
  push(data.elements);
  for (const page of Array.isArray(root.pages) ? root.pages : []) {
    const pageRow = asRecord(page);
    push(pageRow.elements);
    push(pageRow.content);
  }

  const elements: ExtractedElement[] = [];
  candidates.forEach((candidate, index) => {
    const element = parseElement(candidate, index);
    if (!element) return;
    elements.push(element);

    // Emit each table cell as its own element too, so a caller can read the
    // monthly-expenses grid cell by cell instead of as one blob.
    const cells = cellsOf(candidate);
    if (cells.length === 0) return;
    cells.forEach((cell, cellIndex) => {
      const text = cellText(cell);
      if (!text) return;
      const bounds = asRecord(cell.bounds);
      const left = num(bounds.left ?? bounds.x);
      const top = num(bounds.top ?? bounds.y);
      const width = num(bounds.width);
      const height = num(bounds.height);
      elements.push({
        type: 'table-cell',
        text,
        page: element.page,
        bounds:
          left !== null && top !== null && width !== null && height !== null
            ? { left, top, width, height }
            : element.bounds,
        confidence: num(cell.confidence) ?? element.confidence,
        readingOrder: (element.readingOrder ?? index) + (cellIndex + 1) / 1000,
      });
    });
  });
  return elements;
}

function countPages(payload: unknown, elements: readonly ExtractedElement[]): number {
  const root = asRecord(payload);
  // Verified live: `metrics.pagesProcessed`.
  const processed = num(asRecord(root.metrics).pagesProcessed);
  if (processed !== null && processed > 0) return processed;
  const declared = num(root.pageCount ?? root.page_count);
  if (declared !== null && declared > 0) return declared;
  const languagePages = asRecord(asRecord(root.output).languageDetection).pages;
  if (Array.isArray(languagePages) && languagePages.length > 0) return languagePages.length;
  if (Array.isArray(root.pages) && root.pages.length > 0) return root.pages.length;
  const maxPage = elements.reduce((max, element) => Math.max(max, element.page), 0);
  return maxPage > 0 ? maxPage : 1;
}

/**
 * Field descriptors from an extraction response, falling back to the known
 * 101-field map of the official document.
 */
function collectFields(payload: unknown): PdfFormFieldDescriptor[] {
  const root = asRecord(payload);
  const output = asRecord(root.output);
  const raw = Array.isArray(output.formFields)
    ? output.formFields
    : Array.isArray(root.formFields)
      ? root.formFields
      : Array.isArray(root.fields)
        ? root.fields
        : [];

  const fields: PdfFormFieldDescriptor[] = [];
  for (const entry of raw) {
    const row = asRecord(entry);
    const fieldId =
      typeof row.name === 'string'
        ? row.name
        : typeof row.field_id === 'string'
          ? row.field_id
          : '';
    if (!fieldId) continue;
    const type = row.type === 'button' || row.type === 'choice' ? 'button' : 'text';
    const states = Array.isArray(row.states)
      ? row.states.filter((state): state is string => typeof state === 'string')
      : [];
    fields.push({ field_id: fieldId, type, states });
  }

  if (fields.length > 0) return fields;
  // /extraction/parse returns spatial content, not the AcroForm dictionary.
  // The verified field map is the authoritative source for field names.
  return CEDARS_FORM_FIELDS.map((field) => ({ ...field, states: field.states.slice() }));
}

/* ------------------------------------------------------------------ */
/* Generated-document store                                            */
/* ------------------------------------------------------------------ */

/** In-memory cache of generated PDFs, keyed by version hash. */
const generatedDocuments = new Map<string, Uint8Array>();

/** Retrieve a generated PDF by version hash (for a document route handler). */
export function getGeneratedDocument(versionHash: string): Uint8Array | undefined {
  return generatedDocuments.get(versionHash);
}

/** Where `finalizeDocument` writes the produced PDF so /review can load it. */
export const GENERATED_DIR = 'public/generated';

async function writeGeneratedFile(
  fileName: string,
  bytes: Uint8Array,
): Promise<string | null> {
  if (isBrowser()) return null;
  try {
    const fs = await import('node:fs/promises');
    const candidates = [GENERATED_DIR, `app/${GENERATED_DIR}`];
    for (const dir of candidates) {
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(`${dir}/${fileName}`, bytes);
        return `/generated/${fileName}`;
      } catch {
        // Try the next candidate directory.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export interface LiveNutrientAdapterOptions {
  /**
   * Nutrient keys are optional: with `DOCUMENT_ENGINE=local` the fill and
   * accessibility step run on pdf-lib and need none of them. Only
   * `extractFormStructure` still talks to Nutrient directly.
   */
  processorKey?: string;
  extractionKey?: string;
  accessibilityKey?: string;
  /** Override `DOCUMENT_ENGINE` for this adapter instance. */
  engine?: DocumentEngine;
  xano?: XanoAdapter;
  fallback?: NutrientAdapter;
}

export class LiveNutrientAdapter implements NutrientAdapter {
  private readonly extractionKey: string | undefined;
  private readonly engine: DocumentEngine | undefined;
  private readonly xano: XanoAdapter;
  private readonly fallback: NutrientAdapter;

  constructor(options: LiveNutrientAdapterOptions = {}) {
    this.extractionKey = options.extractionKey;
    this.engine = options.engine;
    this.xano = options.xano ?? createXanoAdapter();
    this.fallback = options.fallback ?? fixtureNutrientAdapter;
  }

  /** Engine for this call: explicit option, else `DOCUMENT_ENGINE`. */
  private resolveEngine(): DocumentEngine {
    return this.engine ?? resolveEngine();
  }

  /** Resolve `pdfBytes` / `pdfUrl` into bytes. */
  private async sourceBytes(input: {
    pdfBytes?: Uint8Array;
    pdfUrl?: string;
  }): Promise<{ bytes: Uint8Array; url: string }> {
    if (input.pdfBytes && input.pdfBytes.byteLength > 0) {
      return { bytes: input.pdfBytes, url: input.pdfUrl ?? '' };
    }
    const url = input.pdfUrl ?? CEDARS_APPLICATION_PDF_URL;
    const bytes = await fetchBytes('nutrient', 'fetchSourcePdf', url, LONG_TIMEOUT_MS);
    if (bytes.byteLength === 0) {
      throw new AdapterError('nutrient', 'fetchSourcePdf', 'source PDF was empty', {
        detail: url,
      });
    }
    return { bytes, url };
  }

  /* --- POST /extraction/parse --------------------------------------- */

  async extractFormStructure(input: ExtractFormInput): Promise<ExtractedForm> {
    return withFallback(
      'nutrient',
      'extractFormStructure',
      async () => {
        if (!this.extractionKey) {
          throw new AdapterError(
            'nutrient',
            'extractFormStructure',
            'NUTRIENT_DATA_EXTRACTION_API is not set; using the verified field map',
          );
        }
        const { bytes, url } = await this.sourceBytes(input);

        const form = new FormData();
        form.append('file', bytesToBlob(bytes, PDF_MIME), 'application.pdf');
        form.append('instructions', JSON.stringify(EXTRACTION_INSTRUCTIONS));

        const response = await request(
          'nutrient',
          'extractionParse',
          NUTRIENT_ENDPOINTS.extractionParse,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.extractionKey}` },
            body: form,
            timeoutMs: LONG_TIMEOUT_MS,
          },
        );

        const payload: unknown = await response.json();
        const elements = collectElements(payload);
        return {
          sourceUrl: url || CEDARS_APPLICATION_PDF_URL,
          pageCount: countPages(payload, elements),
          elements,
          fields: collectFields(payload),
        };
      },
      () => this.fallback.extractFormStructure(input),
    );
  }

  /* --- Fill + flatten (engine) --------------------------------------- */

  /**
   * Fill and flatten through the configured engine. `local` runs pdf-lib on
   * this server; `nutrient` POSTs /build (and falls back to local inside the
   * engine on 401/402/403). Only a hard failure of both degrades to the fixture.
   */
  async fillForm(input: FillFormInput): Promise<FilledDocument> {
    const { engine: _engine, ...filled } = await this.fillFormWithEngine(input);
    return filled;
  }

  /**
   * `fillForm` plus the engine that actually produced the bytes — `local`
   * after a Nutrient 401/402/403 fallback, or `fixture` when even the local
   * engine failed and the placeholder answered. Recorded on the event feed so
   * nothing is labelled Nutrient output that Nutrient did not produce.
   */
  private async fillFormWithEngine(
    input: FillFormInput,
  ): Promise<FilledDocument & { engine: DocumentEngine | 'fixture' }> {
    return withFallback<FilledDocument & { engine: DocumentEngine | 'fixture' }>(
      'nutrient',
      'fillForm',
      async () => {
        const { bytes } = await this.sourceBytes(input);
        const result = await fillAndFlatten(bytes, input.instantJson, this.resolveEngine());

        if (result.pdfBytes.byteLength === 0) {
          throw new AdapterError(
            'nutrient',
            'fillForm',
            `${result.engine} engine returned an empty document`,
          );
        }

        return {
          pdfBytes: result.pdfBytes,
          byteLength: result.pdfBytes.byteLength,
          versionHash: contentHash(result.pdfBytes),
          engine: result.engine,
        };
      },
      async () => ({ ...(await this.fallback.fillForm(input)), engine: 'fixture' as const }),
    );
  }

  /* --- Accessibility step (engine) ----------------------------------- */

  /**
   * Note the deliberate asymmetry with the other two calls: this one does NOT
   * fall back to the fixture.
   *
   * The fixture reports `accessibilityStatus: 'processed'`, and 'processed' is
   * the one value the UI is allowed to describe as "accessibility processed".
   * Claiming that after a failed live call would be a false accessibility
   * claim about a real document. So the status is whatever the engine
   * reports — `processed` (Nutrient autotag ran), `preserved` (local engine
   * kept the official document's own tagging), or `failed` — and an exception
   * becomes `failed` with the untouched bytes.
   */
  async autotag(pdfBytes: Uint8Array): Promise<TaggedDocument> {
    try {
      const result = await processAccessibility(pdfBytes, this.resolveEngine());

      if (result.pdfBytes.byteLength === 0) {
        throw new AdapterError('nutrient', 'autotag', 'accessibility step returned no document');
      }
      if (result.status === 'failed' && typeof console !== 'undefined') {
        console.warn(
          `[accessform] accessibility step did not complete (${result.engine}). ${result.note ?? ''}`.trim(),
        );
      }

      return {
        pdfBytes: result.pdfBytes,
        byteLength: result.pdfBytes.byteLength,
        accessibilityStatus: result.status,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordFallback({
        integration: 'nutrient',
        operation: 'autotag',
        reason,
        at: new Date().toISOString(),
      });
      if (typeof console !== 'undefined') {
        console.warn(
          `[accessform] accessibility step threw; document kept as filled. ${reason}`,
        );
      }
      const copy = new Uint8Array(pdfBytes.byteLength);
      copy.set(pdfBytes);
      return {
        pdfBytes: copy,
        byteLength: copy.byteLength,
        accessibilityStatus: 'failed',
      };
    }
  }

  /* --- The `finalize_document` voice tool ---------------------------- */

  async finalizeDocument(input: FinalizeDocumentInput): Promise<FinalizedDocument> {
    const bundle: CaseBundle = await this.xano.getCase(input.case_id);
    const sourceUrl =
      input.source_url ?? bundle.program?.application_url ?? CEDARS_APPLICATION_PDF_URL;

    const instantJson = buildInstantJson(bundle.answers);
    const fieldsFilled = instantJson.formFieldValues.length;
    const requestedEngine = this.resolveEngine();

    const filled = await this.fillFormWithEngine({ pdfUrl: sourceUrl, instantJson });
    // What actually filled the document, after any fallback inside the engine.
    const engine = filled.engine;
    const tagged = await this.autotag(filled.pdfBytes);

    const versionHash = contentHash(tagged.pdfBytes);
    generatedDocuments.set(versionHash, tagged.pdfBytes);

    const fileName = `case-${encodeURIComponent(input.case_id)}-${versionHash.slice(0, 12)}.pdf`;
    const writtenPath = await writeGeneratedFile(fileName, tagged.pdfBytes);
    // The URL the viewer loads is the same-origin API route: it is served in
    // every mode (Next only serves `public/` files that existed at build time,
    // so a file written now answers 404 under `next start`), it never falls
    // back to the bundled fixture, and it regenerates byte-identical output
    // from the same answers with the same engine. The file on disk is the
    // immutable artifact recorded on the Xano row whenever it could be written.
    const documentUrl = buildPublicDocumentUrl(input.case_id).url;
    const generatedUrl = writtenPath ?? documentUrl;

    const document = await this.xano.saveDocument(input.case_id, {
      type: 'filled_application',
      source_url: sourceUrl,
      generated_url: generatedUrl,
      accessibility_status: tagged.accessibilityStatus,
      version_hash: versionHash,
    });

    await this.xano.appendEvent(input.case_id, {
      actor: 'nutrient',
      event_type: 'document_generated',
      message: 'Completed PDF generated',
      metadata_json: {
        fields_filled: fieldsFilled,
        bytes: filled.byteLength,
        engine,
        requested_engine: requestedEngine,
      },
    });
    // The feed copy is derived from the real status: only 'processed' claims
    // that an accessibility pass ran.
    const accessCopy = accessibilityEventFor(tagged.accessibilityStatus);
    await this.xano.appendEvent(input.case_id, {
      actor: 'nutrient',
      event_type: accessCopy.event_type,
      message: accessCopy.message,
      metadata_json: { accessibility_status: tagged.accessibilityStatus, engine },
    });

    return {
      caseId: input.case_id,
      documentUrl,
      accessibilityStatus: tagged.accessibilityStatus,
      versionHash,
      fieldsFilled,
      document,
    };
  }
}

/**
 * Live document adapter. With `DOCUMENT_ENGINE=local` (the default) it works
 * with zero Nutrient keys — the fill runs on pdf-lib and `extractFormStructure`
 * answers from the verified field map. With `DOCUMENT_ENGINE=nutrient` all
 * three server keys are still required, otherwise the fixture answers.
 * Never throws for missing configuration.
 */
export function createNutrientAdapter(xano?: XanoAdapter): NutrientAdapter {
  const keys = nutrientKeys();
  if (documentEngine() === 'nutrient' && !hasAllNutrientKeys()) {
    // Bind the fixture to the caller's store so finalizeDocument still persists.
    return xano ? new FixtureNutrientAdapter(xano) : fixtureNutrientAdapter;
  }
  return new LiveNutrientAdapter({
    processorKey: keys.processor,
    extractionKey: keys.extraction,
    accessibilityKey: keys.accessibility,
    xano,
  });
}
