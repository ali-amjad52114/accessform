/**
 * Fixture Nutrient adapter.
 *
 * Reproduces the three document-layer calls with no network:
 *   extractFormStructure -> the 101 real AcroForm fields + page elements
 *   fillForm             -> a small but genuinely valid PDF byte stream
 *   autotag              -> the same bytes, marked `processed`
 *   finalizeDocument     -> persists against the case and returns the viewer URL
 *
 * The viewer URL is `DEMO_FILLED_PDF_PATH`, a real filled PDF served from
 * `app/public/fixtures/`, so /review shows the actual completed application even
 * when every Nutrient key is missing.
 */

import {
  CEDARS_APPLICATION_FIELD_COUNT,
  CEDARS_APPLICATION_PDF_URL,
  DEMO_FILLED_PDF_PATH,
  type CaseDocument,
  type ExtractedElement,
  type ExtractedForm,
  type ExtractFormInput,
  type FillFormInput,
  type FilledDocument,
  type FinalizeDocumentInput,
  type FinalizedDocument,
  type NutrientAdapter,
  type TaggedDocument,
  type XanoAdapter,
} from '../contract';
import { CEDARS_FORM_FIELDS } from './cedars-fields';
import { delay, FIXTURE_LATENCY } from './latency';
import { fixtureXanoAdapter } from './xano';

/**
 * Page count of the official application. Verified live: `/extraction/parse`
 * reports `metrics.pagesProcessed = 3`.
 */
export const CEDARS_APPLICATION_PAGE_COUNT = 3;

const SECTION_HEADINGS: ReadonlyArray<{ page: number; text: string }> = [
  { page: 1, text: 'Financial Assistance Application' },
  { page: 1, text: 'Patient information' },
  { page: 1, text: 'Household information' },
  { page: 2, text: 'Insurance information' },
  { page: 2, text: 'Income information' },
  { page: 3, text: 'Monthly expenses' },
  { page: 3, text: 'Assets' },
  { page: 3, text: 'Required documentation' },
  { page: 3, text: 'Certification and signature' },
];

function buildElements(): ExtractedElement[] {
  const elements: ExtractedElement[] = [];
  let order = 0;

  for (const heading of SECTION_HEADINGS) {
    order += 1;
    elements.push({
      type: 'heading',
      text: heading.text,
      page: heading.page,
      bounds: { left: 54, top: 54 + order * 18, width: 486, height: 18 },
      confidence: 0.99,
      readingOrder: order,
    });
  }

  for (const field of CEDARS_FORM_FIELDS) {
    order += 1;
    const page = Math.min(
      CEDARS_APPLICATION_PAGE_COUNT,
      1 + Math.floor((order - 1) / 30),
    );
    elements.push({
      type: field.type === 'button' ? 'form-choice' : 'form-field',
      text: field.field_id,
      page,
      bounds: {
        left: 54,
        top: 90 + ((order * 21) % 660),
        width: field.type === 'button' ? 220 : 486,
        height: 16,
      },
      confidence: 0.97,
      readingOrder: order,
    });
  }

  return elements;
}

const ELEMENTS = buildElements();

/**
 * A minimal, genuinely valid PDF 1.7 file. It is not the Cedars application —
 * the real filled document is served from `DEMO_FILLED_PDF_PATH` — but it means
 * `fillForm()` always returns bytes a PDF reader can open, so nothing
 * downstream has to special-case fixture mode.
 */
function buildPlaceholderPdf(caption: string): Uint8Array {
  const safe = caption.replace(/[\\()]/g, '\\$&');
  const stream = `BT /F1 14 Tf 56 720 Td (${safe}) Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

/** Stable hash so repeated fixture runs produce the same `version_hash`. */
function fixtureHash(fieldCount: number): string {
  return `demo-af-001-v1-${String(fieldCount).padStart(2, '0')}`;
}

export class FixtureNutrientAdapter implements NutrientAdapter {
  private readonly xano: XanoAdapter;

  constructor(xano: XanoAdapter = fixtureXanoAdapter) {
    this.xano = xano;
  }

  async extractFormStructure(input: ExtractFormInput): Promise<ExtractedForm> {
    await delay(FIXTURE_LATENCY.nutrientExtract);
    return {
      sourceUrl: input.pdfUrl ?? CEDARS_APPLICATION_PDF_URL,
      pageCount: CEDARS_APPLICATION_PAGE_COUNT,
      elements: ELEMENTS.map((element) => ({ ...element })),
      fields: CEDARS_FORM_FIELDS.map((field) => ({
        ...field,
        states: field.states.slice(),
      })),
    };
  }

  async fillForm(input: FillFormInput): Promise<FilledDocument> {
    await delay(FIXTURE_LATENCY.nutrientFill);
    const count = input.instantJson.formFieldValues.length;
    const pdfBytes = buildPlaceholderPdf(
      `AccessForm demo placeholder - ${count} fields applied`,
    );
    return {
      pdfBytes,
      byteLength: pdfBytes.byteLength,
      versionHash: fixtureHash(count),
    };
  }

  async autotag(pdfBytes: Uint8Array): Promise<TaggedDocument> {
    await delay(FIXTURE_LATENCY.nutrientAutotag);
    const copy = new Uint8Array(pdfBytes.byteLength);
    copy.set(pdfBytes);
    return {
      pdfBytes: copy,
      byteLength: copy.byteLength,
      accessibilityStatus: 'processed',
    };
  }

  async finalizeDocument(input: FinalizeDocumentInput): Promise<FinalizedDocument> {
    const bundle = await this.xano.getCase(input.case_id);
    const fieldsFilled = bundle.answers.filter(
      (answer) => answer.value_json !== null && answer.value_json !== '',
    ).length;

    const filled = await this.fillForm({
      pdfUrl: input.source_url ?? CEDARS_APPLICATION_PDF_URL,
      instantJson: {
        formFieldValues: [],
        format: 'https://pspdfkit.com/instant-json/v1',
      },
    });
    await this.autotag(filled.pdfBytes);

    const document: CaseDocument = await this.xano.saveDocument(input.case_id, {
      type: 'filled_application',
      source_url: input.source_url ?? CEDARS_APPLICATION_PDF_URL,
      generated_url: DEMO_FILLED_PDF_PATH,
      accessibility_status: 'processed',
      version_hash: fixtureHash(fieldsFilled),
    });

    await this.xano.appendEvent(input.case_id, {
      actor: 'nutrient',
      event_type: 'document_generated',
      message: 'Completed PDF generated',
      metadata_json: { fields_filled: fieldsFilled },
    });
    await this.xano.appendEvent(input.case_id, {
      actor: 'nutrient',
      event_type: 'accessibility_processed',
      message: 'Accessibility processing complete',
      metadata_json: { accessibility_status: 'processed' },
    });

    return {
      caseId: input.case_id,
      documentUrl: DEMO_FILLED_PDF_PATH,
      accessibilityStatus: 'processed',
      versionHash: fixtureHash(fieldsFilled),
      fieldsFilled,
      document,
    };
  }
}

export const fixtureNutrientAdapter: NutrientAdapter = new FixtureNutrientAdapter();

/** Field count the extraction fixture reports — matches the live document. */
export const FIXTURE_EXTRACTED_FIELD_COUNT = CEDARS_APPLICATION_FIELD_COUNT;
