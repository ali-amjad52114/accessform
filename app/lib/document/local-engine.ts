/**
 * Local document engine — pdf-lib, in-process, no network.
 *
 * Fills the official application's AcroForm from Instant JSON and flattens it:
 *   - text fields      set by exact AcroForm name
 *   - radio groups     selected by export value ("Retired" or "/Retired")
 *   - checkboxes       checked / unchecked
 *   - dropdown / list  selected by option value (arrays accepted)
 * then `form.flatten()` burns the values into the page content.
 *
 * Structure preservation: the ORIGINAL document is loaded and mutated in place
 * (never `PDFDocument.create()` + `copyPages`, which drops the catalog). The
 * source's /StructTreeRoot, /MarkInfo and /Lang therefore survive, which is
 * what `inspectTagging` verifies before the engine reports 'preserved'.
 *
 * Radio / checkbox appearances: the official form ships its own /N appearance
 * streams for every on-state, and pdf-lib only regenerates button appearances
 * when a state has none, so the printed glyphs are the form's own — not
 * redrawn. Text fields get a Helvetica appearance generated for them
 * (13 text widgets on the source have no /AP at all, and flatten needs one).
 *
 * Values are written verbatim. The callers already strip a leading "$" from
 * currency answers because the form pre-prints the dollar sign; this engine
 * never adds one.
 */

import {
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
  StandardFonts,
  type PDFField,
  type PDFFont,
  type PDFObject,
} from 'pdf-lib';

import type { InstantJson } from '../contract';
import type { AccessibilityResult, FillResult } from './engine';

/* ------------------------------------------------------------------ */
/* Value normalisation                                                 */
/* ------------------------------------------------------------------ */

/** Instant JSON says `value: string`, but callers also pass arrays/booleans. */
type RawValue = unknown;

/** Export values arrive as "Retired" or "/Retired"; the AcroForm state is "Retired". */
function stripLeadingSlash(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('/') ? trimmed.slice(1).trim() : trimmed;
}

function toText(value: RawValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(', ');
  return String(value);
}

function toChoices(value: RawValue): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(toText).map(stripLeadingSlash).filter(Boolean);
  const single = stripLeadingSlash(toText(value));
  return single ? [single] : [];
}

const CHECKED_WORDS = new Set(['on', 'yes', 'true', 'checked', '1', 'x']);
const UNCHECKED_WORDS = new Set(['off', 'no', 'false', 'unchecked', '0', '']);

/** null = the value is neither a clear yes nor a clear no. */
function toChecked(value: RawValue, onState: string | null): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = stripLeadingSlash(toText(value));
  const lower = text.toLowerCase();
  if (CHECKED_WORDS.has(lower)) return true;
  if (UNCHECKED_WORDS.has(lower)) return false;
  if (onState && text.toLowerCase() === onState.toLowerCase()) return true;
  return null;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Exact match first, then case/whitespace-insensitive. */
function matchOption(wanted: string, options: readonly string[]): string | null {
  if (options.includes(wanted)) return wanted;
  const target = normalise(wanted);
  return options.find((option) => normalise(option) === target) ?? null;
}

/* ------------------------------------------------------------------ */
/* Field writers                                                       */
/* ------------------------------------------------------------------ */

/** Returns true when the value landed; false when it must be reported as skipped. */
function writeField(field: PDFField, value: RawValue, font: PDFFont): boolean {
  if (field instanceof PDFTextField) {
    const text = toText(value);
    try {
      field.setText(text);
      field.updateAppearances(font);
      return true;
    } catch {
      // e.g. exceeds MaxLen, or a glyph Helvetica cannot encode.
      try {
        field.setText('');
        field.updateAppearances(font);
      } catch {
        /* leave the widget as it was */
      }
      return false;
    }
  }

  if (field instanceof PDFRadioGroup) {
    const choice = toChoices(value)[0];
    if (!choice) return false;
    const option = matchOption(choice, field.getOptions());
    if (!option) return false;
    field.select(option);
    return true;
  }

  if (field instanceof PDFCheckBox) {
    const onValue = field.acroField.getOnValue();
    const onState = onValue ? onValue.decodeText() : null;
    const checked = toChecked(value, onState);
    if (checked === null) return false;
    if (checked) field.check();
    else field.uncheck();
    return true;
  }

  if (field instanceof PDFDropdown) {
    const choices = toChoices(value);
    const options = field.getOptions();
    const matched = choices.map((c) => matchOption(c, options)).filter((o): o is string => o !== null);
    if (matched.length === 0) {
      if (choices.length === 1 && field.isEditable()) {
        field.select(choices[0]);
        field.updateAppearances(font);
        return true;
      }
      return false;
    }
    field.select(field.isMultiselect() ? matched : matched[0]);
    field.updateAppearances(font);
    return true;
  }

  if (field instanceof PDFOptionList) {
    const options = field.getOptions();
    const matched = toChoices(value)
      .map((c) => matchOption(c, options))
      .filter((o): o is string => o !== null);
    if (matched.length === 0) return false;
    field.select(field.isMultiselect() ? matched : matched[0]);
    field.updateAppearances(font);
    return true;
  }

  // Signature fields, buttons, anything else: not fillable from Instant JSON.
  return false;
}

/* ------------------------------------------------------------------ */
/* Fill + flatten                                                      */
/* ------------------------------------------------------------------ */

async function loadDocument(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    // Keep the source's Producer / dates; this is the official document.
    updateMetadata: false,
    ignoreEncryption: true,
  });
}

export async function localFillAndFlatten(
  sourcePdf: Uint8Array,
  instantJson: InstantJson,
): Promise<FillResult> {
  const doc = await loadDocument(sourcePdf);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  let fieldsWritten = 0;
  const fieldsSkipped: string[] = [];
  const seen = new Set<string>();

  for (const entry of instantJson.formFieldValues) {
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const field = form.getFieldMaybe(name);
    if (!field) {
      fieldsSkipped.push(name);
      continue;
    }
    if (writeField(field, entry.value as RawValue, font)) fieldsWritten += 1;
    else fieldsSkipped.push(name);
  }

  // Generate appearances for every widget that still lacks one (untouched text
  // fields). Button fields already have their official streams and are left alone.
  form.updateFieldAppearances(font);
  form.flatten({ updateFieldAppearances: false });
  removeDanglingReferences(doc);

  const pdfBytes = await doc.save({ useObjectStreams: false });
  return { pdfBytes, engine: 'local', fieldsWritten, fieldsSkipped, note: null };
}

/* ------------------------------------------------------------------ */
/* Post-flatten cleanup                                                */
/* ------------------------------------------------------------------ */

/**
 * pdf-lib 1.17.1 `PDFForm.removeField` hands the widget's *appearance stream*
 * ref to `page.removeAnnot` instead of the widget ref, so the Kids widgets of
 * radio groups / checkboxes are deleted from the object table but left in the
 * page's /Annots array as dangling references. The tagged structure tree
 * points at the same deleted widgets through /OBJR elements.
 *
 * Both are cleaned here so the flattened file is internally consistent:
 * readers stop warning about undefined objects and the structure tree keeps
 * only real content.
 */
function removeDanglingReferences(doc: PDFDocument): { annots: number; objr: number } {
  const ctx = doc.context;
  const isDeletedRef = (obj: PDFObject | undefined): boolean =>
    obj instanceof PDFRef && ctx.lookup(obj) === undefined;
  const resolve = (obj: PDFObject | undefined): PDFObject | undefined =>
    obj instanceof PDFRef ? ctx.lookup(obj) : obj;

  let annots = 0;
  for (const page of doc.getPages()) {
    const list = page.node.Annots();
    if (!list) continue;
    for (let i = list.size() - 1; i >= 0; i -= 1) {
      if (isDeletedRef(list.get(i))) {
        list.remove(i);
        annots += 1;
      }
    }
  }

  // An /OBJR whose /Obj no longer exists.
  const isDanglingObjr = (obj: PDFObject | undefined): boolean => {
    const dict = resolve(obj);
    if (!(dict instanceof PDFDict)) return false;
    if (dict.get(PDFName.of('Type')) !== PDFName.of('OBJR')) return false;
    return isDeletedRef(dict.get(PDFName.of('Obj')));
  };

  let objr = 0;
  const visited = new Set<PDFObject>();
  const K = PDFName.of('K');
  const visit = (node: PDFObject | undefined): void => {
    const value = resolve(node);
    if (value === undefined || visited.has(value)) return;
    visited.add(value);

    if (value instanceof PDFArray) {
      for (let i = value.size() - 1; i >= 0; i -= 1) {
        const entry = value.get(i);
        if (isDanglingObjr(entry)) {
          value.remove(i);
          objr += 1;
        } else {
          visit(entry);
        }
      }
      return;
    }

    if (value instanceof PDFDict) {
      const kids = value.get(K);
      if (kids === undefined) return;
      if (isDanglingObjr(kids)) {
        value.delete(K);
        objr += 1;
      } else {
        visit(kids);
      }
    }
  };
  visit(doc.catalog.get(PDFName.of('StructTreeRoot')));

  return { annots, objr };
}

/* ------------------------------------------------------------------ */
/* Tagging inspection                                                  */
/* ------------------------------------------------------------------ */

export interface TaggingInspection {
  /** /Root has a /StructTreeRoot. */
  structTreeRoot: boolean;
  /** /Root /MarkInfo /Marked is true. */
  marked: boolean;
  /** /Root /Lang, e.g. "en", or null. */
  lang: string | null;
  /** Remaining AcroForm fields (0 after a successful flatten). */
  formFieldCount: number;
  pageCount: number;
}

/** Read the catalog facts the 'preserved' status depends on. */
export async function inspectTagging(pdfBytes: Uint8Array): Promise<TaggingInspection> {
  const doc = await loadDocument(pdfBytes);
  const catalog = doc.catalog;

  const structTreeRoot = catalog.has(PDFName.of('StructTreeRoot'));

  const markInfo = catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict);
  const markedObj = markInfo?.lookupMaybe(PDFName.of('Marked'), PDFBool);
  const marked = markedObj instanceof PDFBool ? markedObj.asBoolean() : false;

  const langObj = catalog.lookupMaybe(PDFName.of('Lang'), PDFString, PDFHexString);
  const lang = langObj ? langObj.decodeText() : null;

  let formFieldCount = 0;
  try {
    formFieldCount = doc.getForm().getFields().length;
  } catch {
    formFieldCount = 0;
  }

  return { structTreeRoot, marked, lang, formFieldCount, pageCount: doc.getPageCount() };
}

/**
 * No accessibility pass runs locally. The only honest claim is that the
 * official document's own tagging is still there — so verify it.
 */
export async function localProcessAccessibility(
  filledPdf: Uint8Array,
): Promise<AccessibilityResult> {
  let inspection: TaggingInspection;
  try {
    inspection = await inspectTagging(filledPdf);
  } catch (error) {
    return {
      pdfBytes: filledPdf,
      status: 'failed',
      engine: 'local',
      note: `The filled document could not be inspected for accessibility tagging: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (inspection.structTreeRoot && inspection.marked) {
    return { pdfBytes: filledPdf, status: 'preserved', engine: 'local', note: null };
  }

  const missing = [
    !inspection.structTreeRoot ? '/StructTreeRoot' : null,
    !inspection.marked ? '/MarkInfo /Marked' : null,
  ]
    .filter(Boolean)
    .join(' and ');
  return {
    pdfBytes: filledPdf,
    status: 'failed',
    engine: 'local',
    note: `No accessibility pass ran and the official document's tagging was not preserved (${missing} missing after filling).`,
  };
}
