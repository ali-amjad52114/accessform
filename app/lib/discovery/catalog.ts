/**
 * Program catalog access — the Xano `programs` table first, the verified
 * manifest `spike/catalog.json` when the M1 Xano endpoints are not live.
 *
 * The manifest is not a fixture: every entry was verified by downloading the
 * PDF and reading its AcroForm field list (see docs/PRODUCT_PLAN.md §5). An
 * entry is resolvable only when it is `verified` and its `application_url` is
 * an absolute https URL; a placeholder in parentheses is never served.
 *
 * Also the Xano upsert calls the resolver uses to persist a live discovery.
 * Every Xano call here returns `null` when the endpoint is unreachable or not
 * yet deployed (HTTP 404 "Unable to locate request") so the resolver can fall
 * back honestly instead of failing the caller's turn.
 */

import {
  CATALOG_SUBMISSION_INSTRUCTIONS,
  FORM_KINDS,
  M1_XANO_ENDPOINTS,
  NEED_CATEGORIES,
  ORGANIZATION_KINDS,
  type CatalogEntry,
  type FormKind,
  type Id,
  type NeedCategory,
  type Organization,
  type OrganizationKind,
  type ResolveProgramQuery,
  type ResolveProgramResponse,
  type ResolvedProgram,
  type UpsertCatalogProgramRequest,
  type UpsertOrganizationRequest,
} from '../contract';
import { CATEGORY_REGISTRY_DOMAINS, registrableDomain } from '../adapters/discovery-rules';
import { isBrowser, xanoCredentials } from '../adapters/env';
import { AdapterError } from '../adapters/errors';
import { requestJson } from '../adapters/http';
import { normalizeProgram } from '../adapters/xano';
import { organizationMatches } from '../voice/tool-handlers';

/* ------------------------------------------------------------------ */
/* Small coercions (Xano returns "" for text, numbers for ids)          */
/* ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return typeof value === 'object' && value !== null ? (value as Raw) : {};
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function asId(value: unknown): Id {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function asTimestamp(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  return new Date().toISOString();
}

/** True for `https://host/...`; false for placeholders like "(from ... page)". */
export function isAbsoluteHttps(url: string): boolean {
  return /^https:\/\/[^\s/]+\.[^\s/]+/.test(url.trim());
}

/* ------------------------------------------------------------------ */
/* Normalizers                                                         */
/* ------------------------------------------------------------------ */

export function normalizeOrganization(raw: unknown): Organization {
  const row = asRecord(raw);
  return {
    id: asId(row.id),
    name: asString(row.name),
    kind: asEnum<OrganizationKind>(row.kind, ORGANIZATION_KINDS, 'other'),
    domain: asString(row.domain).toLowerCase(),
    region: asString(row.region),
    website: asString(row.website),
    created_at: asTimestamp(row.created_at),
  };
}

/** A `programs` row with every M1 column populated (defaults for legacy rows). */
export function normalizeResolvedProgram(raw: unknown): ResolvedProgram {
  const row = asRecord(raw);
  const base = normalizeProgram(row);
  const organizationId = asId(row.organization_id);
  return {
    ...base,
    category: asEnum<NeedCategory>(row.category, NEED_CATEGORIES, 'hospital_financial_assistance'),
    form_kind: asEnum<FormKind>(row.form_kind, FORM_KINDS, 'fillable_pdf'),
    organization_id: organizationId === '' || organizationId === '0' ? null : organizationId,
    submission_instructions: asString(row.submission_instructions),
    field_count: asNumber(row.field_count),
    region: asString(row.region),
    page_count: asNumber(row.page_count),
    sha256: asString(row.sha256),
  };
}

/* ------------------------------------------------------------------ */
/* Manifest (spike/catalog.json)                                       */
/* ------------------------------------------------------------------ */

/** Candidate locations relative to the process cwd (app/ for Next, repo root for scripts). */
const MANIFEST_CANDIDATES = [
  'spike/catalog.json',
  '../spike/catalog.json',
  '../../spike/catalog.json',
];

function isCatalogEntry(value: unknown): value is CatalogEntry {
  const row = asRecord(value);
  return (
    typeof row.need === 'string' &&
    typeof row.organization === 'string' &&
    typeof row.application_url === 'string' &&
    typeof row.verified === 'boolean'
  );
}

let manifestCache: CatalogEntry[] | null = null;

/** Every entry of the manifest, or `[]` when it cannot be read (browser, missing file). */
export async function readCatalogManifest(): Promise<CatalogEntry[]> {
  if (manifestCache) return manifestCache;
  if (isBrowser()) return [];
  type ReadFile = (path: string, encoding: 'utf-8') => Promise<string>;
  let readFile: ReadFile;
  try {
    // Dynamic so a client bundle never tries to resolve node:fs.
    const fs = (await import('node:fs/promises')) as unknown as { readFile: ReadFile };
    readFile = fs.readFile;
  } catch {
    return [];
  }
  for (const path of MANIFEST_CANDIDATES) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
      if (Array.isArray(parsed)) {
        manifestCache = parsed.filter(isCatalogEntry);
        return manifestCache;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Region matching                                                     */
/* ------------------------------------------------------------------ */

const REGION_STOPWORDS = new Set([
  'county', 'city', 'of', 'the', 'ca', 'california', 'usa', 'us', 'area', 'region',
  'metro', 'greater', 'downtown', 'in', 'near',
]);

/** Directional/common first words that identify nothing on their own. */
const REGION_GENERIC = new Set([
  'san', 'los', 'santa', 'north', 'south', 'east', 'west', 'new', 'valley', 'bay',
  'park', 'beach', 'lake', 'port', 'mount', 'saint', 'st',
]);

const REGION_ALIASES: Readonly<Record<string, string>> = {
  la: 'los angeles',
  'l.a.': 'los angeles',
  sf: 'san francisco',
  sd: 'san diego',
  oc: 'orange county',
  sac: 'sacramento',
};

export function regionTokens(text: string): string[] {
  let lower = text.toLowerCase().trim();
  for (const [alias, full] of Object.entries(REGION_ALIASES)) {
    if (lower === alias || lower.startsWith(`${alias},`) || lower.startsWith(`${alias} `)) {
      lower = lower.replace(alias, full);
    }
  }
  return lower
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length >= 2 && !REGION_STOPWORDS.has(token));
}

/**
 * How well a caller's location matches a program's region: the number of
 * shared distinctive tokens. "San Diego" vs "San Francisco, CA" is 0 — `san`
 * is generic. "Los Angeles" vs "Los Angeles County, CA" is 1 (`angeles`).
 */
export function regionMatchScore(location: string, region: string): number {
  const a = regionTokens(location);
  const b = new Set(regionTokens(region));
  let score = 0;
  for (const token of a) {
    if (b.has(token) && !REGION_GENERIC.has(token)) score += 1;
  }
  return score;
}

export function regionMatches(location: string | undefined, region: string): boolean {
  if (!location || !region) return false;
  return regionMatchScore(location, region) > 0;
}

/* ------------------------------------------------------------------ */
/* Manifest matching                                                   */
/* ------------------------------------------------------------------ */

export interface CatalogLookupInput {
  category: NeedCategory;
  organization?: string;
  location?: string;
}

export interface ManifestMatch {
  /** The best entry for the request, or null. May have a non-resolvable URL. */
  entry: CatalogEntry | null;
  /** Verified entries in the category that did not match the request. */
  alternatives: CatalogEntry[];
  reason: string;
}

/**
 * Match manifest entries the same way `GET /programs/resolve` does: by
 * category, then the named organization (token match — never another
 * organization's row), else the region.
 */
export function matchCatalogEntries(
  entries: readonly CatalogEntry[],
  input: CatalogLookupInput,
): ManifestMatch {
  const inCategory = entries.filter((entry) => entry.verified && entry.need === input.category);
  const organization = input.organization?.trim();
  const location = input.location?.trim();

  if (organization) {
    const byOrg = inCategory.filter((entry) => organizationMatches(organization, entry.organization));
    if (byOrg.length === 0) {
      return { entry: null, alternatives: inCategory, reason: 'no verified program for that organization' };
    }
    const regional = location ? byOrg.find((entry) => regionMatches(location, entry.region)) : undefined;
    const entry = regional ?? byOrg[0];
    return { entry, alternatives: inCategory.filter((e) => e !== entry), reason: '' };
  }

  if (location) {
    const scored = inCategory
      .map((entry) => ({ entry, score: regionMatchScore(location, entry.region) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.verified_at.localeCompare(a.entry.verified_at));
    if (scored.length === 0) {
      return { entry: null, alternatives: inCategory, reason: 'no verified program for that location' };
    }
    const entry = scored[0].entry;
    return { entry, alternatives: inCategory.filter((e) => e !== entry), reason: '' };
  }

  return { entry: null, alternatives: inCategory, reason: 'no organization or location given' };
}

/** The organization's own domain when the manifest's source is not a registry. */
export function manifestOrganizationDomain(entry: CatalogEntry): string {
  const domain = registrableDomain(entry.source_domain);
  if (!domain) return '';
  const registries = CATEGORY_REGISTRY_DOMAINS[entry.need] ?? [];
  if (registries.some((registry) => domain === registry || domain.endsWith(`.${registry}`))) return '';
  return domain;
}

/**
 * Compact view for the legacy SerpApi adapter: the organization's domain and
 * the verified application URL for `{ category, organization | location }`,
 * or null. Only entries with an absolute https URL are considered.
 */
export async function findCatalogManifestEntry(
  input: CatalogLookupInput,
): Promise<{ entry: CatalogEntry; organization_domain: string; application_url: string } | null> {
  const entries = await readCatalogManifest();
  const match = matchCatalogEntries(entries, input);
  if (!match.entry || !isAbsoluteHttps(match.entry.application_url)) return null;
  return {
    entry: match.entry,
    organization_domain: manifestOrganizationDomain(match.entry),
    application_url: match.entry.application_url,
  };
}

/** Build a `ResolvedProgram` from a manifest entry (id `catalog:<sha256>` until Xano assigns one). */
export function programFromCatalogEntry(entry: CatalogEntry, id?: Id): ResolvedProgram {
  const sourceDomain = entry.source_domain.toLowerCase();
  return {
    id: id ?? `catalog:${entry.sha256}`,
    hospital_id: '',
    name: entry.program,
    policy_url: entry.policy_url,
    application_url: entry.application_url,
    source_domain: sourceDomain,
    effective_date: null,
    retrieved_at: `${entry.verified_at}T00:00:00.000Z`,
    verified: entry.verified && isAbsoluteHttps(entry.application_url),
    category: entry.need,
    form_kind: entry.form_kind,
    organization_id: null,
    submission_instructions: CATALOG_SUBMISSION_INSTRUCTIONS[registrableDomain(sourceDomain)] ?? '',
    field_count: entry.field_count,
    region: entry.region,
    page_count: entry.pages,
    sha256: entry.sha256,
  };
}

/** `UpsertCatalogProgramRequest` for a manifest entry (the seed mapping, §6). */
export function catalogRequestForEntry(entry: CatalogEntry): UpsertCatalogProgramRequest {
  const sourceDomain = entry.source_domain.toLowerCase();
  return {
    organization_name: entry.organization,
    organization_kind: entry.kind,
    organization_domain: manifestOrganizationDomain(entry) || registrableDomain(sourceDomain),
    name: entry.program,
    category: entry.need,
    form_kind: entry.form_kind,
    application_url: entry.application_url,
    policy_url: entry.policy_url,
    source_domain: sourceDomain,
    region: entry.region,
    submission_instructions: CATALOG_SUBMISSION_INSTRUCTIONS[registrableDomain(sourceDomain)] ?? '',
    field_count: entry.field_count,
    page_count: entry.pages,
    sha256: entry.sha256,
    verified: true,
    retrieved_at: `${entry.verified_at}T00:00:00.000Z`,
  };
}

/* ------------------------------------------------------------------ */
/* Xano                                                                */
/* ------------------------------------------------------------------ */

/** Set once a call answers 404 so later calls in the process skip the round trip. */
const notDeployed = new Set<string>();

function xanoUrl(path: string): string | null {
  const credentials = xanoCredentials();
  if (!credentials) return null;
  return `${credentials.baseUrl}${path}`;
}

function xanoHeaders(): Record<string, string> {
  const credentials = xanoCredentials();
  return credentials?.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {};
}

function warn(message: string): void {
  if (typeof console !== 'undefined') console.warn(`[accessform] catalog: ${message}`);
}

async function xanoCall<T>(
  operation: string,
  path: string,
  init: { method?: string; json?: unknown; query?: Record<string, string | undefined> },
): Promise<T | null> {
  const url = xanoUrl(path);
  if (!url) return null;
  if (notDeployed.has(path)) return null;
  try {
    return await requestJson<T>('xano', operation, url, {
      method: init.method ?? 'GET',
      json: init.json,
      query: init.query,
      headers: xanoHeaders(),
    });
  } catch (error) {
    if (error instanceof AdapterError && error.status === 404) {
      notDeployed.add(path);
      warn(`${init.method ?? 'GET'} ${path} is not deployed yet (404); using the manifest`);
    } else {
      warn(`${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

/** `GET /programs/resolve`, normalized; null when unreachable or not deployed. */
export async function xanoResolveProgram(
  query: ResolveProgramQuery,
): Promise<ResolveProgramResponse | null> {
  const raw = await xanoCall<unknown>('resolveProgram', M1_XANO_ENDPOINTS.resolveProgram.path, {
    query: {
      category: query.category,
      location: query.location || undefined,
      organization: query.organization || undefined,
    },
  });
  if (raw === null) return null;
  const row = asRecord(raw);
  const program = row.program ? normalizeResolvedProgram(row.program) : null;
  return {
    found: Boolean(row.found) && program !== null,
    program,
    organization: row.organization ? normalizeOrganization(row.organization) : null,
    alternatives: Array.isArray(row.alternatives) ? row.alternatives.map(normalizeResolvedProgram) : [],
    reason: asString(row.reason),
  };
}

/** `POST /organizations`; null when unreachable or not deployed. */
export async function xanoUpsertOrganization(
  request: UpsertOrganizationRequest,
): Promise<Organization | null> {
  const raw = await xanoCall<unknown>(
    'upsertOrganization',
    M1_XANO_ENDPOINTS.upsertOrganization.path,
    { method: 'POST', json: { region: '', website: '', ...request } },
  );
  if (raw === null) return null;
  const row = asRecord(raw);
  return normalizeOrganization(row.organization ?? raw);
}

/** `POST /programs/catalog` (optionally linking a case); null when unreachable or not deployed. */
export async function xanoUpsertCatalogProgram(
  request: UpsertCatalogProgramRequest & { case_id?: Id },
): Promise<ResolvedProgram | null> {
  const raw = await xanoCall<unknown>(
    'upsertCatalogProgram',
    M1_XANO_ENDPOINTS.upsertCatalogProgram.path,
    { method: 'POST', json: request },
  );
  if (raw === null) return null;
  const row = asRecord(raw);
  const program = normalizeResolvedProgram(row.program ?? raw);
  return program.id ? program : null;
}
