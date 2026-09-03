/**
 * Domain allowlist and source-ranking rules for official-source discovery.
 *
 * Shared by the live SerpApi adapter and the cached fixture so both enforce the
 * same rule: a result that is not on the allowlist is surfaced but is NEVER
 * marked verified. AccessForm must not fill an unverified form.
 *
 * Mirrors `clients/discovery.py`, which produced the cached result.
 */

import {
  CEDARS_APPLICATION_PDF_URL,
  OFFICIAL_SOURCE_DOMAINS,
  type DiscoveredSource,
} from '../contract';

/**
 * SerpApi occasionally returns URLs containing literal `=` instead of `=`.
 * Undo that before anything parses the URL.
 */
export function cleanUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  if (!raw.includes('\\u00')) return raw;
  return raw.replace(/\\u00([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** Lowercased hostname with a leading `www.` stripped. */
export function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}

/** True when the URL's host is on, or a subdomain of, the official allowlist. */
export function isAllowedDomain(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return OFFICIAL_SOURCE_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/** Allowlist index; `Number.MAX_SAFE_INTEGER` for anything unofficial. */
function allowlistRank(url: string): number {
  const host = hostOf(url);
  for (let i = 0; i < OFFICIAL_SOURCE_DOMAINS.length; i += 1) {
    const domain = OFFICIAL_SOURCE_DOMAINS[i];
    if (host === domain || host.endsWith(`.${domain}`)) return i;
  }
  return Number.MAX_SAFE_INTEGER;
}

/** Official domains first, in allowlist priority order. Stable within a rank. */
export function rankSources(sources: readonly DiscoveredSource[]): DiscoveredSource[] {
  return sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => {
      const rankDelta = allowlistRank(a.source.url) - allowlistRank(b.source.url);
      return rankDelta !== 0 ? rankDelta : a.index - b.index;
    })
    .map((entry) => entry.source);
}

/**
 * Re-apply the allowlist to a set of results. Never trusts an incoming
 * `verified` flag — it is recomputed from the URL every time.
 */
export function verifySources(
  sources: readonly DiscoveredSource[],
): DiscoveredSource[] {
  return sources.map((source) => {
    const url = cleanUrl(source.url);
    return {
      ...source,
      url,
      source_domain: hostOf(url),
      verified: isAllowedDomain(url),
    };
  });
}

/**
 * The human-readable program page: prefer HCAI's hospital page, then
 * cedars-sinai.org. Attachment PDFs are never a policy URL.
 */
export function pickPolicyUrl(verified: readonly DiscoveredSource[]): string {
  const hcai = verified.find((source) => source.source_domain === 'hcai.ca.gov');
  if (hcai) return hcai.url;
  const cedars = verified.find((source) =>
    source.source_domain.endsWith('cedars-sinai.org'),
  );
  return cedars ? cedars.url : '';
}

/**
 * The fillable application itself, not the policy or the instructions.
 *
 * `CEDARS_APPLICATION_PDF_URL` wins whenever an official HCAI attachment is in
 * the result set. That specific attachment is the one verified live — 394,890
 * bytes with 101 AcroForm fields — and it is what the whole fill pipeline is
 * built against. Search results have surfaced sibling attachment ids that are
 * not fillable, so preferring the proven document is deliberate.
 */
export function pickApplicationUrl(verified: readonly DiscoveredSource[]): string {
  if (verified.some((source) => source.url === CEDARS_APPLICATION_PDF_URL)) {
    return CEDARS_APPLICATION_PDF_URL;
  }

  const hdcAttachment = verified.find((source) =>
    source.source_domain.endsWith('api.hdc.hcai.ca.gov'),
  );
  if (hdcAttachment) return CEDARS_APPLICATION_PDF_URL;

  const titled = verified.find((source) => {
    const title = (source.title ?? '').toLowerCase();
    return title.includes('application') && !title.includes('instruction');
  });
  return titled ? titled.url : '';
}
