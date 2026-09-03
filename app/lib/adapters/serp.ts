/**
 * SerpApi adapter — official-source discovery.
 *
 * CREDIT DISCIPLINE. The account is on the free plan (~229 searches left) and
 * `SERPAPI_RUN_BUDGET` caps what one process may spend. So:
 *
 *   - The legacy `discoverProgram()` serves the cached result by default and
 *     spends NOTHING, in demo mode and in live mode alike.
 *   - A live search happens only when the caller explicitly passes
 *     `{ refresh: true }` AND demo mode is off AND a key is present.
 *   - `serpOrganicSearch()` — used by the M1 resolver — counts every query
 *     against the run budget and refuses once it is spent.
 *
 * Queries are templated from `{ category, organization, location }` and the
 * allowlist is built per request (`discovery-rules.ts`). Nothing here names an
 * organization.
 *
 * Server-side only: `SERPAPI_API_KEY` must never reach the browser.
 */

import {
  NEED_CATEGORIES,
  SERPAPI_RUN_BUDGET,
  type DiscoveredSource,
  type DiscoverProgramInput,
  type DiscoveryResult,
  type NeedCategory,
  type SerpAdapter,
} from '../contract';
import { findCatalogManifestEntry } from '../discovery/catalog';
import { cachedDiscovery, fixtureSerpAdapter } from '../fixtures/serp';
import {
  buildDiscoveryQueries,
  cleanUrl,
  discoveryPolicyFor,
  hostOf,
  inferOrganizationDomain,
  isAllowedDomain,
  pickApplicationUrl,
  pickPolicyUrl,
  rankSources,
  verifySources,
  type DiscoveryPolicy,
} from './discovery-rules';
import { isBrowser, isDemoMode, serpApiKey } from './env';
import { AdapterError, withFallback } from './errors';
import { requestJson } from './http';

const SERPAPI_SEARCH_URL = 'https://serpapi.com/search';
const SERPAPI_ACCOUNT_URL = 'https://serpapi.com/account';
/** Politeness gap between queries, matching clients/discovery.py. */
const QUERY_GAP_MS = 300;

export interface DiscoverOptions {
  /**
   * Spend SerpApi credits on a fresh search. Ignored in demo mode and when no
   * key is configured. Defaults to `false` — always.
   */
  refresh?: boolean;
}

interface SerpOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
}

interface SerpSearchResponse {
  error?: string;
  organic_results?: SerpOrganicResult[];
}

interface SerpAccountResponse {
  plan_name?: string;
  total_searches_left?: number;
  plan_searches_left?: number;
}

/* ------------------------------------------------------------------ */
/* Run budget + shared search                                          */
/* ------------------------------------------------------------------ */

/** One organic result, before any allowlist decision. */
export interface SerpHit {
  query: string;
  title: string;
  url: string;
  snippet: string;
  source_domain: string;
}

const budget = { used: 0, limit: SERPAPI_RUN_BUDGET as number };

/** Credits spent by this process and the cap it will not exceed. */
export function getSerpBudget(): { used: number; limit: number; remaining: number } {
  return { used: budget.used, limit: budget.limit, remaining: Math.max(0, budget.limit - budget.used) };
}

/** Test hook: lower the cap for a run (never raises it above the contract's). */
export function setSerpBudgetLimit(limit: number): void {
  budget.limit = Math.max(0, Math.min(SERPAPI_RUN_BUDGET, limit));
}

/**
 * One Google organic search through SerpApi. Throws `AdapterError` when there
 * is no key, demo mode is on, the run budget is spent, or SerpApi errors.
 * Every call that reaches SerpApi counts against the budget, even on error.
 */
export async function serpOrganicSearch(
  query: string,
  options: { num?: number } = {},
): Promise<SerpHit[]> {
  const key = serpApiKey();
  if (isDemoMode() || !key) {
    throw new AdapterError('serpapi', 'search', 'live search not permitted (demo mode or no key)');
  }
  if (budget.used >= budget.limit) {
    throw new AdapterError(
      'serpapi',
      'search',
      `run budget of ${budget.limit} searches is spent`,
    );
  }
  budget.used += 1;
  const payload = await requestJson<SerpSearchResponse>('serpapi', 'search', SERPAPI_SEARCH_URL, {
    query: { engine: 'google', q: query, num: options.num ?? 10, api_key: key },
  });
  if (payload.error) {
    throw new AdapterError('serpapi', 'search', payload.error);
  }
  const hits: SerpHit[] = [];
  for (const result of payload.organic_results ?? []) {
    const url = cleanUrl(result.link);
    if (!url) continue;
    hits.push({
      query,
      title: result.title ?? '',
      url,
      snippet: result.snippet ?? '',
      source_domain: hostOf(url),
    });
  }
  return hits;
}

/** Pause between consecutive queries. */
export async function queryGap(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, QUERY_GAP_MS));
}

/* ------------------------------------------------------------------ */
/* Cache file                                                          */
/* ------------------------------------------------------------------ */

/**
 * Candidate locations for `cache/discovered_program.json`, relative to the
 * process cwd. Next dev/build runs from `app/`, scripts may run from the repo
 * root.
 */
const CACHE_CANDIDATES = [
  'cache/discovered_program.json',
  '../cache/discovered_program.json',
  '../../cache/discovered_program.json',
];

interface NodeFsLike {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf-8'): Promise<void>;
}

async function nodeFs(): Promise<NodeFsLike | null> {
  if (isBrowser()) return null;
  try {
    // Dynamic so a client bundle never tries to resolve node:fs.
    const mod = (await import('node:fs/promises')) as unknown as NodeFsLike;
    return mod;
  } catch {
    return null;
  }
}

function isDiscoveryResult(value: unknown): value is DiscoveryResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DiscoveryResult>;
  return (
    Array.isArray(candidate.all_results) &&
    Array.isArray(candidate.verified_sources) &&
    typeof candidate.hospital === 'string'
  );
}

/** Read the on-disk cache, or `null` when unavailable/unparseable. */
async function readCacheFile(): Promise<{ path: string; result: DiscoveryResult } | null> {
  const fs = await nodeFs();
  if (!fs) return null;
  for (const path of CACHE_CANDIDATES) {
    try {
      const text = await fs.readFile(path, 'utf-8');
      const parsed: unknown = JSON.parse(text);
      if (isDiscoveryResult(parsed)) return { path, result: parsed };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function writeCacheFile(result: DiscoveryResult): Promise<void> {
  const fs = await nodeFs();
  if (!fs) return;
  const existing = await readCacheFile();
  const path = existing ? existing.path : CACHE_CANDIDATES[0];
  try {
    await fs.writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  } catch {
    // A read-only filesystem must not fail discovery.
  }
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/** Legacy `intent` strings map onto the M1 category enum. */
export function categoryForIntent(intent: string | undefined): NeedCategory {
  const value = (intent ?? '').trim().toLowerCase();
  if ((NEED_CATEGORIES as readonly string[]).includes(value)) return value as NeedCategory;
  if (value.includes('financial') || value.includes('charity') || value.includes('bill')) {
    return 'hospital_financial_assistance';
  }
  if (value.includes('paratransit') || value.includes('transit')) return 'paratransit';
  if (value.includes('accommodation') || value.includes('dsps')) return 'disability_accommodation';
  return 'other';
}

/**
 * Build the per-request policy for the legacy input shape: the organization's
 * own domain comes from the catalog when it has this organization, otherwise
 * it is inferred from the result set; the catalog's verified application URL
 * is preferred when present.
 */
async function policyForLegacyInput(
  input: DiscoverProgramInput,
  results: readonly DiscoveredSource[],
): Promise<DiscoveryPolicy> {
  const category = categoryForIntent(input.intent);
  const manifest = await findCatalogManifestEntry({
    category,
    organization: input.hospital,
    location: input.location,
  });
  const organizationDomain =
    manifest?.organization_domain ||
    inferOrganizationDomain(
      input.hospital,
      results.map((source) => source.url),
    );
  return discoveryPolicyFor({
    category,
    organization_domain: organizationDomain || undefined,
    preferred_application_url: manifest?.application_url,
  });
}

/**
 * Apply the allowlist and re-pick the policy/application URLs. Used on both
 * cached and freshly-searched results so they behave identically.
 */
async function normalize(
  input: DiscoverProgramInput,
  raw: DiscoveryResult,
  overrides: { searchesUsed: number; fromCache: boolean; retrievedAt?: string },
): Promise<DiscoveryResult> {
  const policy = await policyForLegacyInput(input, raw.all_results);
  const allResults = verifySources(raw.all_results, policy);
  const verified = rankSources(
    allResults.filter((source) => source.verified),
    policy,
  );

  return {
    hospital: raw.hospital || input.hospital,
    intent: input.intent || raw.intent,
    retrieved_at: overrides.retrievedAt ?? raw.retrieved_at,
    searches_used: overrides.searchesUsed,
    verified_sources: verified,
    all_results: allResults,
    policy_url: pickPolicyUrl(verified, policy) || raw.policy_url || '',
    application_url: pickApplicationUrl(verified, policy),
    from_cache: overrides.fromCache,
  };
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export class LiveSerpAdapter implements SerpAdapter {
  private readonly fallback: SerpAdapter;

  constructor(fallback: SerpAdapter = fixtureSerpAdapter) {
    this.fallback = fallback;
  }

  /**
   * Returns the cached official program for the organization in `input`.
   * Free unless `refresh` is set.
   */
  async discoverProgram(
    input: DiscoverProgramInput,
    options: DiscoverOptions = {},
  ): Promise<DiscoveryResult> {
    if (!options.refresh) {
      return this.fromCache(input);
    }

    const key = serpApiKey();
    if (isDemoMode() || !key) {
      // Refresh requested but not permitted — never silently spend credits.
      return this.fromCache(input);
    }

    return withFallback(
      'serpapi',
      'discoverProgram',
      () => this.liveSearch(input),
      () => this.fromCache(input),
    );
  }

  /** Cache-only path: the on-disk file, else the inlined fixture. */
  private async fromCache(input: DiscoverProgramInput): Promise<DiscoveryResult> {
    const cached = await readCacheFile();
    if (cached) {
      return normalize(input, cached.result, { searchesUsed: 0, fromCache: true });
    }
    return this.fallback.discoverProgram(input);
  }

  /** Spends one credit per templated query (two or three per request). */
  private async liveSearch(input: DiscoverProgramInput): Promise<DiscoveryResult> {
    const queries = buildDiscoveryQueries({
      category: categoryForIntent(input.intent),
      organization: input.hospital,
      location: input.location,
    });
    const hits: DiscoveredSource[] = [];
    let searchesUsed = 0;
    let anySucceeded = false;

    for (const [index, query] of queries.entries()) {
      if (index > 0) await queryGap();
      try {
        const results = await serpOrganicSearch(query);
        searchesUsed += 1;
        anySucceeded = true;
        for (const hit of results) {
          hits.push({
            query,
            title: hit.title,
            url: hit.url,
            source_domain: hit.source_domain,
            verified: false, // recomputed by normalize() under the per-request policy
          });
        }
      } catch (error) {
        // One bad query must not kill discovery — the others may still verify.
        if (error instanceof AdapterError && !error.message.includes('not permitted')) {
          searchesUsed += 1;
        }
        if (typeof console !== 'undefined') {
          console.warn(
            `[accessform] serpapi query failed: ${query} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    if (!anySucceeded) {
      throw new AdapterError('serpapi', 'discoverProgram', 'every query failed');
    }

    const retrievedAt = new Date().toISOString();
    const result = await normalize(
      input,
      {
        hospital: input.hospital,
        intent: input.intent,
        retrieved_at: retrievedAt,
        searches_used: searchesUsed,
        verified_sources: [],
        all_results: hits,
        policy_url: '',
        application_url: '',
        from_cache: false,
      },
      { searchesUsed, fromCache: false, retrievedAt },
    );

    if (result.verified_sources.length === 0) {
      // Nothing official found. Never fill an unverified form — use the cache.
      throw new AdapterError(
        'serpapi',
        'discoverProgram',
        'no results on the official domain allowlist',
      );
    }

    await writeCacheFile(result);
    return result;
  }

  /** Plan and remaining-search info. Does NOT consume a credit. */
  async searchesLeft(): Promise<number | null> {
    const key = serpApiKey();
    if (!key) return null;
    try {
      const account = await requestJson<SerpAccountResponse>(
        'serpapi',
        'account',
        SERPAPI_ACCOUNT_URL,
        { query: { api_key: key } },
      );
      return account.total_searches_left ?? account.plan_searches_left ?? null;
    } catch {
      return null;
    }
  }
}

/** Synchronous cached discovery, for callers that cannot await a file read. */
export { cachedDiscovery };

/** Re-exported so callers of the adapter can test a URL under the default policy. */
export { isAllowedDomain };

export function createSerpAdapter(): SerpAdapter {
  return new LiveSerpAdapter();
}
