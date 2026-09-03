/**
 * SerpApi adapter — official-source discovery.
 *
 * CREDIT DISCIPLINE. The account is on the free plan with roughly 234 searches
 * left, and the demo runs discovery on every rehearsal. So:
 *
 *   - `discoverProgram()` serves the cached result by default and spends
 *     NOTHING. This is true in demo mode and in live mode.
 *   - A live search happens only when the caller explicitly passes
 *     `{ refresh: true }` AND demo mode is off AND a key is present.
 *   - Even then, three queries cost three credits, and the fresh result is
 *     written back to the on-disk cache so the next run is free again.
 *
 * The cache is read from `cache/discovered_program.json` at the repo root when
 * the filesystem is reachable; otherwise the same payload, inlined at build
 * time in `fixtures/discovery-cache.ts`, is used. Both go through the same
 * allowlist verification, so an unofficial domain is never marked verified.
 *
 * Server-side only: `SERPAPI_API_KEY` must never reach the browser.
 */

import {
  DISCOVERY_QUERIES,
  type DiscoveredSource,
  type DiscoverProgramInput,
  type DiscoveryResult,
  type SerpAdapter,
} from '../contract';
import { cachedDiscovery, fixtureSerpAdapter } from '../fixtures/serp';
import {
  cleanUrl,
  hostOf,
  isAllowedDomain,
  pickApplicationUrl,
  pickPolicyUrl,
  rankSources,
  verifySources,
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

/**
 * Apply the allowlist and re-pick the policy/application URLs. Used on both
 * cached and freshly-searched results so they behave identically.
 */
function normalize(
  input: DiscoverProgramInput,
  raw: DiscoveryResult,
  overrides: { searchesUsed: number; fromCache: boolean; retrievedAt?: string },
): DiscoveryResult {
  const allResults = verifySources(raw.all_results);
  const verified = rankSources(allResults.filter((source) => source.verified));

  return {
    hospital: input.hospital || raw.hospital,
    intent: input.intent || raw.intent,
    retrieved_at: overrides.retrievedAt ?? raw.retrieved_at,
    searches_used: overrides.searchesUsed,
    verified_sources: verified,
    all_results: allResults,
    policy_url: pickPolicyUrl(verified) || raw.policy_url || '',
    application_url: pickApplicationUrl(verified),
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
   * Returns the official Cedars-Sinai program. Free unless `refresh` is set.
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
      () => this.liveSearch(input, key),
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

  /** Spends one credit per query in `DISCOVERY_QUERIES`. */
  private async liveSearch(
    input: DiscoverProgramInput,
    apiKey: string,
  ): Promise<DiscoveryResult> {
    const hits: DiscoveredSource[] = [];
    let searchesUsed = 0;
    let anySucceeded = false;

    for (const [index, query] of DISCOVERY_QUERIES.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, QUERY_GAP_MS));
      }
      try {
        const payload = await requestJson<SerpSearchResponse>(
          'serpapi',
          'search',
          SERPAPI_SEARCH_URL,
          {
            query: { engine: 'google', q: query, num: 10, api_key: apiKey },
          },
        );
        searchesUsed += 1;
        if (payload.error) {
          throw new AdapterError('serpapi', 'search', payload.error);
        }
        anySucceeded = true;

        for (const result of payload.organic_results ?? []) {
          const url = cleanUrl(result.link);
          if (!url) continue;
          hits.push({
            query,
            title: result.title ?? '',
            url,
            source_domain: hostOf(url),
            verified: isAllowedDomain(url),
          });
        }
      } catch (error) {
        // One bad query must not kill discovery — the others may still verify.
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

    const verified = hits.filter((hit) => hit.verified);
    if (verified.length === 0) {
      // Nothing official found. Never fill an unverified form — use the cache.
      throw new AdapterError(
        'serpapi',
        'discoverProgram',
        'no results on the official domain allowlist',
      );
    }

    const result = normalize(
      input,
      {
        hospital: input.hospital,
        intent: input.intent,
        retrieved_at: new Date().toISOString(),
        searches_used: searchesUsed,
        verified_sources: verified,
        all_results: hits,
        policy_url: '',
        application_url: '',
        from_cache: false,
      },
      {
        searchesUsed,
        fromCache: false,
        retrievedAt: new Date().toISOString(),
      },
    );

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

export function createSerpAdapter(): SerpAdapter {
  return new LiveSerpAdapter();
}
