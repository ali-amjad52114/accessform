/**
 * Byte verification for a candidate application document.
 *
 * Downloads the URL, confirms it is a PDF (`%PDF` magic, not a redirect to an
 * HTML page), counts its AcroForm fields and pages with pdf-lib, and hashes
 * the bytes (sha256, first 16 hex — the same convention as spike/catalog.json).
 * Zero fields means the PDF is flat; a non-PDF response is reported as such so
 * the resolver can decide whether it is an `online_form`.
 *
 * Server-side only. Never throws — a failed download is a result.
 */

import { PDFDocument } from 'pdf-lib';

export interface PdfInspection {
  ok: true;
  url: string;
  final_url: string;
  bytes: number;
  field_count: number;
  page_count: number;
  /** First 16 hex chars of sha256(bytes). */
  sha256: string;
  content_type: string;
}

export interface DocumentFailure {
  ok: false;
  url: string;
  final_url: string;
  /** True when the response was reachable and NOT a PDF (e.g. an HTML page). */
  is_html: boolean;
  /** The page body when `is_html` (<= HTML_KEEP_BYTES), so the resolver can follow its document links. */
  html?: string;
  content_type: string;
  status: number;
  reason: string;
}

/** Only this much of an HTML page is kept for link extraction. */
const HTML_KEEP_BYTES = 2 * 1024 * 1024;

export type DocumentInspection = PdfInspection | DocumentFailure;

/** Refuse to buffer anything larger than this (the catalog PDFs are < 3 MB). */
const MAX_BYTES = 25 * 1024 * 1024;

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 of the bytes, first 16 hex chars. */
export async function shortSha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
  return hex(digest).slice(0, 16);
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF');
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<head');
}

/** Count fields and pages in PDF bytes. Throws when pdf-lib cannot parse them. */
export async function countPdfFields(bytes: Uint8Array): Promise<{ field_count: number; page_count: number }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  let fieldCount = 0;
  try {
    fieldCount = doc.getForm().getFields().length;
  } catch {
    fieldCount = 0;
  }
  return { field_count: fieldCount, page_count: doc.getPageCount() };
}

/** Download and inspect one candidate. */
export async function inspectDocument(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<DocumentInspection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/pdf,*/*;q=0.8',
        'User-Agent': 'AccessForm/1.0 (official form verification)',
      },
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      url,
      final_url: url,
      is_html: false,
      content_type: '',
      status: 0,
      reason: aborted ? 'download timed out' : 'download failed',
    };
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const finalUrl = response.url || url;
  if (!response.ok) {
    clearTimeout(timer);
    return {
      ok: false,
      url,
      final_url: finalUrl,
      is_html: contentType.includes('text/html'),
      content_type: contentType,
      status: response.status,
      reason: `HTTP ${response.status}`,
    };
  }

  let bytes: Uint8Array;
  try {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) throw new Error('too large');
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error('too large');
  } catch (error) {
    return {
      ok: false,
      url,
      final_url: finalUrl,
      is_html: false,
      content_type: contentType,
      status: response.status,
      reason: error instanceof Error && error.message === 'too large' ? 'document too large' : 'download failed',
    };
  } finally {
    clearTimeout(timer);
  }

  if (!hasPdfMagic(bytes)) {
    const isHtml = contentType.includes('text/html') || looksLikeHtml(bytes);
    return {
      ok: false,
      url,
      final_url: finalUrl,
      is_html: isHtml,
      ...(isHtml ? { html: new TextDecoder('utf-8').decode(bytes.subarray(0, HTML_KEEP_BYTES)) } : {}),
      content_type: contentType,
      status: response.status,
      reason: 'not a PDF',
    };
  }

  try {
    const counts = await countPdfFields(bytes);
    return {
      ok: true,
      url,
      final_url: finalUrl,
      bytes: bytes.byteLength,
      field_count: counts.field_count,
      page_count: counts.page_count,
      sha256: await shortSha256(bytes),
      content_type: contentType,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      final_url: finalUrl,
      is_html: false,
      content_type: contentType,
      status: response.status,
      reason: `PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
