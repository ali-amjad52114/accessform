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
 * Form filling works through /build with Instant JSON. The `flatten` action is
 * REQUIRED — without it every value renders blank. The multipart parts must be
 * named exactly "document" (the PDF) and "instant" (the JSON).
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
  DEMO_FILLED_PDF_PATH,
  INSTANT_JSON_FIELD_TYPE,
  INSTANT_JSON_FORMAT,
  NUTRIENT_BUILD_INSTRUCTIONS,
  NUTRIENT_BUILD_PART_DOCUMENT,
  NUTRIENT_BUILD_PART_INSTANT,
  NUTRIENT_ENDPOINTS,
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
import { CEDARS_FORM_FIELDS } from '../fixtures/cedars-fields';
import { FixtureNutrientAdapter, fixtureNutrientAdapter } from '../fixtures/nutrient';
import { isBrowser, nutrientKeys } from './env';
import { AdapterError, recordFallback, withFallback } from './errors';
import {
  bytesToBlob,
  contentHash,
  fetchBytes,
  LONG_TIMEOUT_MS,
  request,
  requestBytes,
} from './http';
import { createXanoAdapter } from './xano';

const PDF_MIME = 'application/pdf';
const JSON_MIME = 'application/json';

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
  processorKey: string;
  extractionKey: string;
  accessibilityKey: string;
  xano?: XanoAdapter;
  fallback?: NutrientAdapter;
}

export class LiveNutrientAdapter implements NutrientAdapter {
  private readonly processorKey: string;
  private readonly extractionKey: string;
  private readonly accessibilityKey: string;
  private readonly xano: XanoAdapter;
  private readonly fallback: NutrientAdapter;

  constructor(options: LiveNutrientAdapterOptions) {
    this.processorKey = options.processorKey;
    this.extractionKey = options.extractionKey;
    this.accessibilityKey = options.accessibilityKey;
    this.xano = options.xano ?? createXanoAdapter();
    this.fallback = options.fallback ?? fixtureNutrientAdapter;
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

  /* --- POST /build (applyInstantJson + flatten) ---------------------- */

  async fillForm(input: FillFormInput): Promise<FilledDocument> {
    return withFallback(
      'nutrient',
      'fillForm',
      async () => {
        const { bytes } = await this.sourceBytes(input);

        const form = new FormData();
        // The exact instruction shape proven to fill the Cedars AcroForm.
        // `flatten` is required or every value renders blank.
        form.append('instructions', JSON.stringify(NUTRIENT_BUILD_INSTRUCTIONS));
        form.append(
          NUTRIENT_BUILD_PART_DOCUMENT,
          bytesToBlob(bytes, PDF_MIME),
          'document.pdf',
        );
        form.append(
          NUTRIENT_BUILD_PART_INSTANT,
          new Blob([JSON.stringify(input.instantJson)], { type: JSON_MIME }),
          'instant.json',
        );

        const pdfBytes = await requestBytes(
          'nutrient',
          'build',
          NUTRIENT_ENDPOINTS.build,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.processorKey}` },
            body: form,
            timeoutMs: LONG_TIMEOUT_MS,
          },
        );

        if (pdfBytes.byteLength === 0) {
          throw new AdapterError('nutrient', 'build', 'build returned an empty document');
        }

        return {
          pdfBytes,
          byteLength: pdfBytes.byteLength,
          versionHash: contentHash(pdfBytes),
        };
      },
      () => this.fallback.fillForm(input),
    );
  }

  /* --- POST /accessibility/autotag ----------------------------------- */

  /**
   * Note the deliberate asymmetry with the other two calls: this one does NOT
   * fall back to the fixture.
   *
   * The fixture reports `accessibilityStatus: 'processed'`, and 'processed' is
   * the one value the UI is allowed to describe as "accessibility processed".
   * Claiming that after a failed live call would be a false accessibility
   * claim about a real document. So a live failure returns the untouched bytes
   * with status `'failed'` — the document is still produced and /review still
   * renders, but nothing may say the accessibility pass ran.
   */
  async autotag(pdfBytes: Uint8Array): Promise<TaggedDocument> {
    try {
      const form = new FormData();
      form.append('file', bytesToBlob(pdfBytes, PDF_MIME), 'document.pdf');

      const tagged = await requestBytes(
        'nutrient',
        'accessibilityAutotag',
        NUTRIENT_ENDPOINTS.accessibilityAutotag,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.accessibilityKey}` },
          body: form,
          timeoutMs: LONG_TIMEOUT_MS,
        },
      );

      if (tagged.byteLength === 0) {
        throw new AdapterError('nutrient', 'autotag', 'autotag returned no document');
      }

      return {
        pdfBytes: tagged,
        byteLength: tagged.byteLength,
        accessibilityStatus: 'processed',
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
          `[accessform] nutrient.autotag failed; document kept UNTAGGED. ${reason}`,
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

    const filled = await this.fillForm({ pdfUrl: sourceUrl, instantJson });
    const tagged = await this.autotag(filled.pdfBytes);

    const versionHash = contentHash(tagged.pdfBytes);
    generatedDocuments.set(versionHash, tagged.pdfBytes);

    const fileName = `case-${encodeURIComponent(input.case_id)}-${versionHash.slice(0, 12)}.pdf`;
    const writtenPath = await writeGeneratedFile(fileName, tagged.pdfBytes);
    // If nothing could be written, /review still has a real document to show.
    const documentUrl = writtenPath ?? DEMO_FILLED_PDF_PATH;

    const document = await this.xano.saveDocument(input.case_id, {
      type: 'filled_application',
      source_url: sourceUrl,
      generated_url: documentUrl,
      accessibility_status: tagged.accessibilityStatus,
      version_hash: versionHash,
    });

    await this.xano.appendEvent(input.case_id, {
      actor: 'nutrient',
      event_type: 'document_generated',
      message: 'Completed PDF generated',
      metadata_json: { fields_filled: fieldsFilled, bytes: filled.byteLength },
    });
    // Only claim the accessibility pass ran when it actually did.
    await this.xano.appendEvent(input.case_id, {
      actor: 'nutrient',
      event_type:
        tagged.accessibilityStatus === 'processed'
          ? 'accessibility_processed'
          : 'accessibility_failed',
      message:
        tagged.accessibilityStatus === 'processed'
          ? 'Accessibility processing complete'
          : 'Accessibility processing unavailable',
      metadata_json: { accessibility_status: tagged.accessibilityStatus },
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
 * Live Nutrient client when all three server keys are present, otherwise the
 * fixture. Never throws for missing configuration.
 */
export function createNutrientAdapter(xano?: XanoAdapter): NutrientAdapter {
  const keys = nutrientKeys();
  if (!keys.processor || !keys.extraction || !keys.accessibility) {
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
