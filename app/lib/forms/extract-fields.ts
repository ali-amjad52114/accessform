/**
 * AcroForm extraction — pdf-lib, in-process, no network.
 *
 * Turns any fillable PDF into a flat list of its real fields, in reading
 * order, with the export values the PDF actually accepts. This list is the
 * only vocabulary the form-understanding model and the answer mapper may
 * use: every `field_id` downstream is one of these names, verbatim.
 *
 * Reading order = page ascending, then top-to-bottom in ~8pt bands, then
 * left-to-right. It is what a sighted person would read, so the model's
 * sections and asking order come out sane even without page text.
 *
 * SERVER-SIDE ONLY (node:crypto for the sha256).
 */

import { createHash } from 'node:crypto';

import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFTextField,
  type PDFField,
} from 'pdf-lib';

/** What the PDF itself says the widget is. Narrower than `FormFieldType`. */
export type ExtractedFieldType = 'text' | 'radio' | 'checkbox' | 'dropdown' | 'signature' | 'button';

export interface ExtractedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractedField {
  /** Fully qualified AcroForm name — the exact string `fillAndFlatten` needs. */
  field_id: string;
  type: ExtractedFieldType;
  /** 1-based page number of the first widget; 0 when the widget is not on any page. */
  page: number;
  rect: ExtractedRect | null;
  /** Export values WITHOUT the leading "/", e.g. ["Single", "Married"]. Empty for text. */
  options: string[];
  /** For checkboxes: the on-state name ("On", "Yes", …). */
  on_value: string | null;
  max_length: number | null;
  multiline: boolean;
  /** 1-based position in reading order across the whole document. */
  reading_index: number;
  /**
   * Character combs: a row of single-character boxes ("Last name_1" …
   * "Last name_20") that together hold ONE answer. `comb_leader` is the
   * field_id of the first box (the leader points at itself), `comb_index`
   * is 1-based within the comb, `comb_size` is set on the leader only.
   * null / 0 for ordinary fields.
   */
  comb_leader: string | null;
  comb_index: number;
  comb_size: number;
}

export interface ExtractedForm {
  /** Full 64-hex sha256 of the PDF bytes. */
  sha256: string;
  /** First 16 hex chars — what `programs.sha256` and spike/catalog.json store. */
  sha16: string;
  page_count: number;
  field_count: number;
  fields: ExtractedField[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function stripSlash(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

function decodeName(value: unknown): string | null {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFName) return value.decodeText();
  return null;
}

/** Walk /T up the /Parent chain to rebuild "parent.child" the way pdf-lib does. */
function fullyQualifiedName(dict: PDFDict, doc: PDFDocument): string | null {
  const parts: string[] = [];
  let current: PDFDict | undefined = dict;
  let guard = 0;
  while (current && guard < 32) {
    guard += 1;
    const partial = decodeName(current.lookup(PDFName.of('T')));
    if (partial !== null) parts.unshift(partial);
    const parent: unknown = current.lookup(PDFName.of('Parent'));
    current = parent instanceof PDFDict ? parent : undefined;
  }
  void doc;
  return parts.length > 0 ? parts.join('.') : null;
}

function rectOf(dict: PDFDict): ExtractedRect | null {
  const rect = dict.lookup(PDFName.of('Rect'));
  if (!(rect instanceof PDFArray) || rect.size() < 4) return null;
  const nums: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const n = rect.lookup(i);
    nums.push(n instanceof PDFNumber ? n.asNumber() : 0);
  }
  const [x1, y1, x2, y2] = nums;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

interface Placement {
  page: number;
  rect: ExtractedRect | null;
}

/**
 * Map every field name to the page + rect of its FIRST widget (in page
 * order). Widgets are found from each page's /Annots so a widget that was
 * never attached to a page simply gets page 0.
 */
function placements(doc: PDFDocument): Map<string, Placement> {
  const map = new Map<string, Placement>();
  const pages = doc.getPages();
  pages.forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i += 1) {
      const entry = annots.get(i);
      const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.lookup(PDFName.of('Subtype'));
      if (subtype instanceof PDFName && subtype.decodeText() !== 'Widget') continue;
      const name = fullyQualifiedName(dict, doc);
      if (!name || map.has(name)) continue;
      map.set(name, { page: pageIndex + 1, rect: rectOf(dict) });
    }
  });
  return map;
}

function typeOf(field: PDFField): ExtractedFieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return 'dropdown';
  if (field instanceof PDFSignature) return 'signature';
  return 'button';
}

function optionsOf(field: PDFField): string[] {
  try {
    if (field instanceof PDFRadioGroup) return field.getOptions().map(stripSlash);
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      return field.getOptions().map(stripSlash);
    }
    if (field instanceof PDFCheckBox) {
      const on = field.acroField.getOnValue();
      return on ? [stripSlash(on.decodeText())] : [];
    }
  } catch {
    /* a malformed /Opt or /AP — treat as no options */
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Extract every terminal AcroForm field. Never throws for an odd widget —
 * it lands with `page: 0` and no rect. Throws only if the bytes are not a
 * PDF pdf-lib can open.
 */
export async function extractFormFields(pdfBytes: Uint8Array): Promise<ExtractedForm> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const sha256 = sha256Hex(pdfBytes);
  const pageCount = doc.getPageCount();

  let fields: PDFField[] = [];
  try {
    fields = doc.getForm().getFields();
  } catch {
    fields = [];
  }

  const where = placements(doc);
  const rows: Omit<ExtractedField, 'reading_index' | 'comb_leader' | 'comb_index' | 'comb_size'>[] = fields.map((field) => {
    const name = field.getName();
    const placement = where.get(name) ?? { page: 0, rect: null };
    const type = typeOf(field);
    let maxLength: number | null = null;
    let multiline = false;
    if (field instanceof PDFTextField) {
      try {
        const max = field.getMaxLength();
        maxLength = typeof max === 'number' ? max : null;
        multiline = field.isMultiline();
      } catch {
        /* keep defaults */
      }
    }
    let onValue: string | null = null;
    if (field instanceof PDFCheckBox) {
      try {
        const on = field.acroField.getOnValue();
        onValue = on ? stripSlash(on.decodeText()) : null;
      } catch {
        onValue = null;
      }
    }
    return {
      field_id: name,
      type,
      page: placement.page,
      rect: placement.rect,
      options: optionsOf(field),
      on_value: onValue,
      max_length: maxLength,
      multiline,
    };
  });

  // Reading order: page, then top-to-bottom in 8pt bands, then left-to-right.
  // Fields with no placement keep their AcroForm order at the end.
  const BAND = 8;
  const keyed = rows.map((row, index) => {
    const top = row.rect ? row.rect.y + row.rect.height : 0;
    return {
      row,
      index,
      page: row.page === 0 ? Number.MAX_SAFE_INTEGER : row.page,
      band: row.rect ? -Math.round(top / BAND) : 0,
      x: row.rect ? row.rect.x : 0,
    };
  });
  keyed.sort((a, b) => a.page - b.page || a.band - b.band || a.x - b.x || a.index - b.index);

  const ordered: ExtractedField[] = keyed.map((entry, i) => ({
    ...entry.row,
    reading_index: i + 1,
    comb_leader: null,
    comb_index: 0,
    comb_size: 0,
  }));
  detectCombs(ordered);

  return {
    sha256,
    sha16: sha256.slice(0, 16),
    page_count: pageCount,
    field_count: ordered.length,
    fields: ordered,
  };
}

/* ------------------------------------------------------------------ */
/* Character combs                                                     */
/* ------------------------------------------------------------------ */

const COMB_SUFFIX = /^(.*?)[ _]?(\d{1,3})$/;
/** A box this narrow (points) holds one character. */
const COMB_MAX_WIDTH = 26;

/**
 * Detect rows of single-character boxes. Two or more text fields on the
 * same page and band, MaxLen 1 or narrower than COMB_MAX_WIDTH, touching
 * each other left-to-right, whose names share a base once a trailing
 * number is removed ("Last name_1", "Last name_2", …) are one comb.
 * Mutates `fields` in place (they are already in reading order).
 */
export function detectCombs(fields: ExtractedField[]): void {
  const isBox = (f: ExtractedField): boolean =>
    f.type === 'text' &&
    f.rect !== null &&
    f.page > 0 &&
    (f.max_length === 1 || f.rect.width <= COMB_MAX_WIDTH) &&
    !f.multiline;
  const baseOf = (name: string): string => {
    const match = COMB_SUFFIX.exec(name);
    return match ? match[1].trim() : name.trim();
  };

  let i = 0;
  while (i < fields.length) {
    const first = fields[i];
    if (!isBox(first)) {
      i += 1;
      continue;
    }
    const group: ExtractedField[] = [first];
    let j = i + 1;
    while (j < fields.length) {
      const prev = group[group.length - 1];
      const next = fields[j];
      if (!isBox(next) || next.page !== prev.page || !next.rect || !prev.rect) break;
      if (baseOf(next.field_id) !== baseOf(first.field_id)) break;
      const sameRow = Math.abs(next.rect.y - prev.rect.y) <= prev.rect.height * 0.5;
      const gap = next.rect.x - (prev.rect.x + prev.rect.width);
      const touching = gap >= -2 && gap <= Math.max(6, prev.rect.width * 0.5);
      if (!sameRow || !touching) break;
      group.push(next);
      j += 1;
    }
    if (group.length >= 2) {
      group.forEach((field, index) => {
        field.comb_leader = first.field_id;
        field.comb_index = index + 1;
        field.comb_size = index === 0 ? group.length : 0;
      });
    }
    i = j > i ? j : i + 1;
  }
}

/** The exact names on the form, in reading order — the only names anyone may emit. */
export function extractedFieldNames(form: ExtractedForm): string[] {
  return form.fields.map((field) => field.field_id);
}
