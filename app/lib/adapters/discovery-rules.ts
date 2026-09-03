/**
 * Domain allowlist, query templates and source-ranking rules for official
 * source discovery.
 *
 * Everything here is parameterized by `{ category, organization, location }`.
 * No organization name, domain or URL is hardcoded: the only literals are
 * official-authority suffixes (`.gov`, `.edu`), per-category registries that
 * publish organizations' own forms (HCAI for hospital financial assistance),
 * and a small list of regional transit agencies whose paratransit forms live
 * on `.org`/`.com` domains. A named organization's own domain is allowed only
 * when it is that organization's domain.
 *
 * Shared by the live SerpApi adapter, the M1 program resolver and the cached
 * fixture so all of them enforce the same rule: a result that is not on the
 * allowlist for THIS request is surfaced but NEVER marked verified.
 */

import {
  NEED_CATEGORY_LABELS,
  OFFICIAL_TLD_SUFFIXES,
  type DiscoveredSource,
  type NeedCategory,
} from '../contract';

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

/** What counts as an official source for one discovery request. */
export interface DiscoveryPolicy {
  /** Registrable domains (and their subdomains) that are official for this request. */
  domains: readonly string[];
  /** Suffixes that are official whatever the organization (`.gov`, `.edu`). */
  suffixes: readonly string[];
  /**
   * The subset of `domains` that are authority registries for the category
   * (HCAI for hospital financial assistance): official pages about the
   * organization, published on its behalf. Peer agencies are never registries.
   */
  registries: readonly string[];
  /** The named organization's own registrable domain, when known. Also in `domains`. */
  organization_domain?: string;
  /**
   * A URL already verified by bytes for this organization (catalog). When it
   * appears among the verified sources it wins over any title heuristic.
   */
  preferred_application_url?: string;
}

/**
 * Official registries per category: bodies that publish the organization's
 * own application on the organization's behalf. Results here are official for
 * the category, but the OpenAI verdict still has to confirm the organization.
 */
export const CATEGORY_REGISTRY_DOMAINS: Readonly<Record<NeedCategory, readonly string[]>> = {
  hospital_financial_assistance: ['hcai.ca.gov'],
  paratransit: [],
  disability_accommodation: [],
  scholarship_financial_aid: [],
  benefits: [],
  appointment: [],
  other: [],
};

/**
 * Regional transit agencies whose ADA paratransit applications are published
 * on non-`.gov` domains. Category authority list, not a product boundary:
 * live discovery still has to verify the bytes and the organization.
 */
export const KNOWN_TRANSIT_AGENCY_DOMAINS: readonly string[] = [
  'accessla.org',
  'sfmta.com',
  'sdmts.com',
  'vta.org',
  'actransit.org',
  'octa.net',
  'sacrt.com',
  'samtrans.com',
  'metro.net',
  'omnitrans.org',
  'riversidetransit.com',
  'goldengate.org',
  'eastbayparatransit.org',
  'mst.org',
];

/** Hosts that aggregate or republish forms and must never be treated as an organization's own domain. */
const AGGREGATOR_DOMAINS: readonly string[] = [
  'findhelp.org',
  'dollarfor.org',
  'careroute.ai',
  'yelp.com',
  'facebook.com',
  'wikipedia.org',
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'pdffiller.com',
  'signnow.com',
  'formsbank.com',
  'templateroller.com',
  'scribd.com',
  'youtube.com',
  'x.com',
  'twitter.com',
  'instagram.com',
];

/** Words that never identify an organization on their own. */
const GENERIC_ORG_WORDS = new Set([
  'medical', 'center', 'centre', 'hospital', 'health', 'healthcare', 'system',
  'the', 'of', 'and', 'inc', 'foundation', 'clinic', 'group', 'services',
  'service', 'transit', 'transportation', 'authority', 'agency', 'district',
  'county', 'city', 'college', 'community', 'university', 'school', 'regional',
  'care', 'help', 'find', 'info', 'news', 'san', 'los', 'santa', 'north',
  'south', 'east', 'west', 'new', 'valley', 'bay', 'paratransit', 'access',
]);

export function organizationTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length >= 3 && !GENERIC_ORG_WORDS.has(token));
}

/**
 * Build the allowlist for one request. `.gov`/`.edu` always; the category's
 * registries; the named organization's own domain when it is known. Known
 * transit agencies are added only for a REGIONAL paratransit request (no
 * organization domain known) — once the organization is known, peer agencies
 * are not official sources for it.
 */
export function discoveryPolicyFor(input: {
  category: NeedCategory;
  organization_domain?: string;
  preferred_application_url?: string;
}): DiscoveryPolicy {
  const registries = CATEGORY_REGISTRY_DOMAINS[input.category] ?? [];
  const domains = new Set<string>(registries);
  const organizationDomain = input.organization_domain
    ? registrableDomain(input.organization_domain)
    : '';
  if (organizationDomain) {
    domains.add(organizationDomain);
  } else if (input.category === 'paratransit') {
    for (const domain of KNOWN_TRANSIT_AGENCY_DOMAINS) domains.add(domain);
  }
  return {
    domains: Array.from(domains),
    suffixes: OFFICIAL_TLD_SUFFIXES,
    registries,
    organization_domain: organizationDomain || undefined,
    preferred_application_url: input.preferred_application_url,
  };
}

/** The policy used when a caller passes none: official suffixes and registries only. */
export const DEFAULT_DISCOVERY_POLICY: DiscoveryPolicy = {
  domains: Array.from(
    new Set(Object.values(CATEGORY_REGISTRY_DOMAINS).flat()),
  ),
  suffixes: OFFICIAL_TLD_SUFFIXES,
  registries: Array.from(
    new Set(Object.values(CATEGORY_REGISTRY_DOMAINS).flat()),
  ),
};

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

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

/** Second-level suffixes where the registrable domain has three labels. */
const MULTI_LABEL_SUFFIXES = ['ca.gov', 'ca.us', 'co.uk', 'org.uk', 'ac.uk', 'edu.au', 'gov.au'];

/**
 * Registrable domain of a host: `api.hdc.hcai.ca.gov` -> `hcai.ca.gov`,
 * `www.sfmta.com` -> `sfmta.com`. Accepts a bare host or a URL.
 */
export function registrableDomain(hostOrUrl: string): string {
  const host = hostOrUrl.includes('://') ? hostOf(hostOrUrl) : hostOrUrl.toLowerCase().replace(/^www\./, '');
  if (!host) return '';
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.includes(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** True when the URL's host is official under `policy`. */
export function isAllowedDomain(
  url: string,
  policy: DiscoveryPolicy = DEFAULT_DISCOVERY_POLICY,
): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (policy.suffixes.some((suffix) => host.endsWith(suffix))) return true;
  return policy.domains.some((domain) => hostMatchesDomain(host, domain));
}

/** Lower is more trusted: organization's own domain, then registries, then suffixes. */
function allowlistRank(url: string, policy: DiscoveryPolicy): number {
  const host = hostOf(url);
  if (!host) return Number.MAX_SAFE_INTEGER;
  if (policy.organization_domain && hostMatchesDomain(host, policy.organization_domain)) return 0;
  const index = policy.domains.findIndex((domain) => hostMatchesDomain(host, domain));
  if (index >= 0) return 1 + index;
  const suffixIndex = policy.suffixes.findIndex((suffix) => host.endsWith(suffix));
  if (suffixIndex >= 0) return 100 + suffixIndex;
  return Number.MAX_SAFE_INTEGER;
}

/** Official domains first, in allowlist priority order. Stable within a rank. */
export function rankSources(
  sources: readonly DiscoveredSource[],
  policy: DiscoveryPolicy = DEFAULT_DISCOVERY_POLICY,
): DiscoveredSource[] {
  return sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => {
      const rankDelta = allowlistRank(a.source.url, policy) - allowlistRank(b.source.url, policy);
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
  policy: DiscoveryPolicy = DEFAULT_DISCOVERY_POLICY,
): DiscoveredSource[] {
  return sources.map((source) => {
    const url = cleanUrl(source.url);
    return {
      ...source,
      url,
      source_domain: hostOf(url),
      verified: isAllowedDomain(url, policy),
    };
  });
}

/** True when the URL looks like a document rather than a web page. */
export function looksLikePdf(url: string, title = ''): boolean {
  const lower = url.toLowerCase();
  if (/\.pdf(\?|#|$)/.test(lower)) return true;
  if (/\/attachment\?|\/extract\/|\/download\//.test(lower)) return true;
  return /\bpdf\b/i.test(title);
}

/**
 * The human-readable program page: a registry page about the organization
 * (HCAI) when one exists, else the organization's own page, else an official
 * `.gov`/`.edu` page. Never a peer agency's page; never an attachment PDF.
 */
export function pickPolicyUrl(
  verified: readonly DiscoveredSource[],
  policy: DiscoveryPolicy = DEFAULT_DISCOVERY_POLICY,
): string {
  const pages = verified.filter((source) => !looksLikePdf(source.url, source.title));
  const registry = pages.find((source) =>
    policy.registries.some((domain) => hostMatchesDomain(source.source_domain, domain)),
  );
  if (registry) return registry.url;
  const own = policy.organization_domain
    ? pages.find((source) => hostMatchesDomain(source.source_domain, policy.organization_domain!))
    : undefined;
  if (own) return own.url;
  if (policy.organization_domain) return '';
  const suffix = pages.find((source) =>
    policy.suffixes.some((s) => source.source_domain.endsWith(s)),
  );
  return suffix ? suffix.url : '';
}

/* ------------------------------------------------------------------ */
/* Following an official page to its document                          */
/* ------------------------------------------------------------------ */

export interface DocumentLink {
  url: string;
  text: string;
  score: number;
}

const LINK_POSITIVE: readonly [RegExp, number][] = [
  [/\bapplication\b/i, 3],
  [/\bapply\b/i, 2],
  [/\beligibility\b/i, 1],
  [/\bpart\s*a\b/i, 2],
  [/\bform\b/i, 1],
  [/\benglish\b/i, 1],
  [/\bregular\s*print\b/i, 1],
];

const LINK_NEGATIVE: readonly [RegExp, number][] = [
  [/\binstruction/i, 2],
  [/\bpolicy\b/i, 2],
  [/\bpart\s*b\b/i, 3],
  [/\bverification\b/i, 2],
  [/\bphysician|professional|provider\b/i, 2],
  [/\blarge\s*print\b/i, 1],
  [/\bspanish|espa[nñ]ol|chinese|vietnamese|tagalog|korean|russian|arabic|armenian|farsi|japanese|khmer|hmong|punjabi\b/i, 3],
  [/\bbrochure|guide|handbook|faq|newsletter|minutes|agenda\b/i, 2],
  [/\bsummary\b/i, 1],
];

function scoreLink(url: string, text: string): number {
  const haystack = `${text} ${decodeURIComponent(url.split('/').pop() ?? '')}`;
  let score = 0;
  for (const [pattern, weight] of LINK_POSITIVE) if (pattern.test(haystack)) score += weight;
  for (const [pattern, weight] of LINK_NEGATIVE) if (pattern.test(haystack)) score -= weight;
  return score;
}

/**
 * Document links on an official page, allowlisted under `policy`, ranked so
 * the applicant's English application comes first (instructions, "Part B"
 * professional verifications, translations and large-print twins rank lower).
 * Regex-based on purpose: no HTML parser dependency, server-side only.
 */
export function extractDocumentLinks(
  html: string,
  baseUrl: string,
  policy: DiscoveryPolicy,
): DocumentLink[] {
  const links = new Map<string, DocumentLink>();
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[1].replace(/&amp;/g, '&').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;
    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!url.startsWith('https://')) continue;
    const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!looksLikePdf(url, text)) continue;
    if (!isAllowedDomain(url, policy)) continue;
    const score = scoreLink(url, text);
    const existing = links.get(url);
    if (!existing || existing.score < score) links.set(url, { url, text, score });
  }
  return Array.from(links.values()).sort((a, b) => b.score - a.score);
}

/**
 * The application itself, not the policy or the instructions.
 *
 * A `preferred_application_url` (one whose bytes were already verified for
 * this organization, e.g. from the catalog) wins whenever it is present, or
 * whenever the results include a document from the same official host — search
 * results surface sibling attachment ids that are not fillable, so the proven
 * document is preferred over a raw hit. Otherwise: a document-looking URL whose
 * title says "application" and not "instruction".
 */
export function pickApplicationUrl(
  verified: readonly DiscoveredSource[],
  policy: DiscoveryPolicy = DEFAULT_DISCOVERY_POLICY,
): string {
  const preferred = policy.preferred_application_url ?? '';
  if (preferred) {
    if (verified.some((source) => source.url === preferred)) return preferred;
    const preferredHost = hostOf(preferred);
    if (
      preferredHost &&
      verified.some(
        (source) => source.source_domain === preferredHost && looksLikePdf(source.url, source.title),
      )
    ) {
      return preferred;
    }
  }

  const isApplication = (source: DiscoveredSource): boolean => {
    const title = (source.title ?? '').toLowerCase();
    return title.includes('application') && !title.includes('instruction');
  };
  const document = verified.find((source) => isApplication(source) && looksLikePdf(source.url, source.title));
  if (document) return document.url;
  const titled = verified.find(isApplication);
  return titled ? titled.url : '';
}

/* ------------------------------------------------------------------ */
/* Organization domain inference                                       */
/* ------------------------------------------------------------------ */

/**
 * Derive the named organization's own registrable domain from search hits:
 * the most frequent non-aggregator domain whose label contains a distinctive
 * token of the organization's name. `''` when nothing qualifies. This is a
 * gate for the allowlist, never a verdict — the OpenAI check and the byte
 * verification still run.
 */
export function inferOrganizationDomain(
  organization: string,
  urls: readonly string[],
): string {
  const tokens = organizationTokens(organization);
  if (tokens.length === 0) return '';
  const counts = new Map<string, number>();
  for (const url of urls) {
    const domain = registrableDomain(url);
    if (!domain) continue;
    if (AGGREGATOR_DOMAINS.some((bad) => hostMatchesDomain(domain, bad))) continue;
    if (OFFICIAL_TLD_SUFFIXES.some((suffix) => domain.endsWith(suffix))) continue;
    const label = domain.split('.')[0].replace(/[^a-z0-9]/g, '');
    const matches = tokens.some((token) => label.includes(token));
    if (!matches) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [domain, count] of counts) {
    if (count > bestCount) {
      best = domain;
      bestCount = count;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Query templates                                                     */
/* ------------------------------------------------------------------ */

export interface DiscoveryQueryInput {
  category: NeedCategory;
  organization?: string;
  location?: string;
}

function clean(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Two or three search queries per request, templated per category from the
 * organization and the location. Never a literal organization name.
 */
export function buildDiscoveryQueries(input: DiscoveryQueryInput): string[] {
  const org = clean(input.organization);
  const region = clean(input.location);
  const subject = org || region;
  const where = region ? ` ${region}` : '';
  const label = NEED_CATEGORY_LABELS[input.category].toLowerCase();

  let queries: string[];
  switch (input.category) {
    case 'paratransit':
      queries = org
        ? [
            `${org} ADA paratransit eligibility application form pdf`,
            `${org} paratransit application${where}`,
          ]
        : [
            `${region} ADA paratransit eligibility application form pdf`,
            `${region} paratransit eligibility application`,
          ];
      break;
    case 'hospital_financial_assistance':
      queries = org
        ? [
            `${org} financial assistance application HCAI`,
            `${org} financial assistance application pdf${where}`,
          ]
        : [
            `${region} hospital financial assistance application HCAI`,
            `${region} hospital charity care application pdf`,
          ];
      break;
    case 'disability_accommodation':
      queries = org
        ? [
            `${org} DSPS application form pdf`,
            `${org} disability services accommodation application${where}`,
          ]
        : [
            `${region} college DSPS application form pdf`,
            `${region} disability services accommodation application`,
          ];
      break;
    case 'scholarship_financial_aid':
      queries = [
        `${subject} scholarship application form pdf`,
        `${subject} financial aid application${org ? where : ''}`,
      ];
      break;
    case 'benefits':
      queries = [
        `${subject} public benefits application form pdf`,
        `${subject} social services benefits application${org ? where : ''}`,
      ];
      break;
    default:
      queries = [`${subject} ${label} application form pdf`, `${subject} ${label} application${org ? where : ''}`];
  }
  return Array.from(new Set(queries.map(clean).filter((query) => query.length > 0)));
}
