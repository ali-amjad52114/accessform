/**
 * Minimal fetch helpers shared by the live adapters.
 *
 * Deliberately dependency-free: Node 20+ / the Next.js server runtime both ship
 * `fetch`, `FormData`, `Blob` and `AbortController` globally.
 */

import { AdapterError, type IntegrationName } from './errors';

export const DEFAULT_TIMEOUT_MS = 60_000;
/** Nutrient /build and /accessibility/autotag are slow on a 395 KB PDF. */
export const LONG_TIMEOUT_MS = 120_000;

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body. Mutually exclusive with `body`. */
  json?: unknown;
  /** Raw body (FormData, string, …). Mutually exclusive with `json`. */
  body?: BodyInit;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
}

function buildUrl(
  url: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return url;
  return url + (url.includes('?') ? '&' : '?') + qs;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Perform an HTTP request, throwing `AdapterError` on transport failure,
 * timeout, or a non-2xx status.
 */
export async function request(
  integration: IntegrationName,
  operation: string,
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const {
    method = 'GET',
    headers = {},
    json,
    body,
    query,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const finalHeaders: Record<string, string> = { ...headers };
  let finalBody: BodyInit | undefined = body;

  if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(json);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(buildUrl(url, query), {
      method,
      headers: finalHeaders,
      body: finalBody,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    const aborted =
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError');
    throw new AdapterError(
      integration,
      operation,
      aborted ? `timed out after ${timeoutMs}ms` : 'network request failed',
      { detail: error instanceof Error ? error.message : String(error), cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new AdapterError(
      integration,
      operation,
      `HTTP ${response.status} ${response.statusText}`,
      { status: response.status, detail },
    );
  }

  return response;
}

export async function requestJson<T>(
  integration: IntegrationName,
  operation: string,
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await request(integration, operation, url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new AdapterError(integration, operation, 'response was not valid JSON', {
      cause: error,
    });
  }
}

export async function requestBytes(
  integration: IntegrationName,
  operation: string,
  url: string,
  options: RequestOptions = {},
): Promise<Uint8Array> {
  const response = await request(integration, operation, url, options);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/** Download a remote file (e.g. the official Cedars PDF) as bytes. */
export async function fetchBytes(
  integration: IntegrationName,
  operation: string,
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  return requestBytes(integration, operation, url, { timeoutMs });
}

/**
 * Deterministic 128-bit FNV-1a content hash, hex encoded.
 * Used for `documents.version_hash`; no node:crypto import so the helper stays
 * usable from every runtime.
 */
export function contentHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9dc5811c;
  let h4 = 0x93010001;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (b + i), 0x01000193) >>> 0;
    h3 = Math.imul(h3 ^ (b ^ (i & 0xff)), 0x01000193) >>> 0;
    h4 = Math.imul(h4 ^ (b + (i >>> 8)), 0x01000193) >>> 0;
  }
  const part = (n: number): string => n.toString(16).padStart(8, '0');
  return `${part(h1)}${part(h2)}${part(h3)}${part(h4)}`;
}

/** `Uint8Array` -> `Blob`, for multipart uploads. */
export function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  // Copy into a plain ArrayBuffer so the Blob never captures a larger pooled
  // Node Buffer backing store.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type });
}
