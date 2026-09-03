/**
 * Public, signed links to a case's filled document.
 *
 *   ${PUBLIC_BASE_URL}/api/document/<caseId>?t=<token>
 *
 * The token is an HMAC-SHA256 over "<caseId>.<expiry>" (72 h), truncated to
 * 120 bits and base64url-encoded, so a link stays short enough for one SMS
 * and cannot be forged or reused for another case. When PUBLIC_BASE_URL is
 * set, the document route must refuse requests without a valid token (see
 * `requireDocumentToken`). When it is not set (plain local dev) there is no
 * public link to protect and the gate is open.
 *
 * Server-only: uses node:crypto. Never import from a client component.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { serverSecret, isDemoMode } from '../../../../lib/adapters/env';
import { PUBLIC_BASE_URL_ENV, type Id } from '../../../../lib/contract';

export const DOCUMENT_TOKEN_PARAM = 't' as const;
export const DOCUMENT_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
const SIGNATURE_BYTES = 15; // 120 bits -> 20 base64url chars

/** Absolute origin for public links, without a trailing slash; undefined when unset. */
export function publicBaseUrl(): string | undefined {
  const raw = serverSecret(PUBLIC_BASE_URL_ENV);
  if (!raw) return undefined;
  const trimmed = raw.replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

/**
 * Signing key derived from an existing secret — M1 adds no new secret env
 * var. `DOCUMENT_LINK_SECRET` wins when someone sets it later.
 */
function signingKey(): Buffer | undefined {
  const source =
    serverSecret('DOCUMENT_LINK_SECRET') ??
    serverSecret('TWILIO_AUTH_TOKEN') ??
    serverSecret('VAPI_PRIVATE_KEY') ??
    serverSecret('OPENAI_API_KEY');
  if (!source) return undefined;
  return createHmac('sha256', 'accessform-document-link').update(source).digest();
}

function signature(key: Buffer, caseId: string, expiresAt: number): string {
  return createHmac('sha256', key)
    .update(`${caseId}.${expiresAt}`)
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString('base64url');
}

/** "<expiry base36 seconds>.<signature>" or undefined when no key exists. */
export function signDocumentToken(caseId: Id, now = Date.now()): string | undefined {
  const key = signingKey();
  if (!key) return undefined;
  const expiresAt = Math.floor((now + DOCUMENT_TOKEN_TTL_MS) / 1000);
  return `${expiresAt.toString(36)}.${signature(key, caseId, expiresAt)}`;
}

export interface DocumentTokenCheck {
  valid: boolean;
  reason: 'ok' | 'missing' | 'malformed' | 'expired' | 'bad_signature' | 'no_key';
  expiresAt?: string;
}

export function verifyDocumentToken(caseId: Id, token: string | null | undefined, now = Date.now()): DocumentTokenCheck {
  if (!token) return { valid: false, reason: 'missing' };
  const key = signingKey();
  if (!key) return { valid: false, reason: 'no_key' };
  const dot = token.indexOf('.');
  if (dot <= 0) return { valid: false, reason: 'malformed' };
  const expiresAt = parseInt(token.slice(0, dot), 36);
  const given = token.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || !given) return { valid: false, reason: 'malformed' };
  const expected = signature(key, caseId, expiresAt);
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' };
  const expiresAtIso = new Date(expiresAt * 1000).toISOString();
  if (expiresAt * 1000 < now) return { valid: false, reason: 'expired', expiresAt: expiresAtIso };
  return { valid: true, reason: 'ok', expiresAt: expiresAtIso };
}

/** Relative path with the token — for same-origin use (the /review viewer). */
export function signedDocumentPath(caseId: Id): string {
  const path = `/api/document/${encodeURIComponent(caseId)}`;
  const token = signDocumentToken(caseId);
  return token ? `${path}?${DOCUMENT_TOKEN_PARAM}=${encodeURIComponent(token)}` : path;
}

export interface PublicDocumentUrl {
  url: string;
  /** True when the URL is absolute (PUBLIC_BASE_URL set); false = relative fallback. */
  absolute: boolean;
  /** True when a token was attached. */
  signed: boolean;
}

/**
 * The link that goes into the SMS. Absolute when PUBLIC_BASE_URL is set;
 * otherwise the relative signed path (callers should treat that as "not
 * deliverable" and say so).
 */
export function buildPublicDocumentUrl(caseId: Id): PublicDocumentUrl {
  const path = signedDocumentPath(caseId);
  const base = publicBaseUrl();
  return { url: base ? base + path : path, absolute: Boolean(base), signed: path.includes(`?${DOCUMENT_TOKEN_PARAM}=`) };
}

/** True when the token gate applies: a public origin exists and we are live. */
export function documentTokenRequired(): boolean {
  return Boolean(publicBaseUrl()) && !isDemoMode();
}

/**
 * For the document route: returns null when the request may proceed, or a
 * 403 JSON Response to return as-is. Applies only when PUBLIC_BASE_URL is set
 * and demo mode is off; otherwise every request passes (local dev, demo).
 *
 *   const denied = requireDocumentToken(request, caseId); if (denied) return denied;
 */
export function requireDocumentToken(request: Request, caseId: Id): Response | null {
  if (!documentTokenRequired()) return null;
  const token = new URL(request.url).searchParams.get(DOCUMENT_TOKEN_PARAM);
  const check = verifyDocumentToken(caseId, token);
  if (check.valid) return null;
  return new Response(
    JSON.stringify({ error: 'document_link_invalid', reason: check.reason, message: 'This document link is missing, invalid or has expired. Ask AccessForm to text a new link.' }),
    { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
