/**
 * Fixture SerpApi adapter.
 *
 * Serves the one cached live discovery run. Costs zero credits and needs zero
 * network, and it re-applies the domain allowlist rather than trusting the
 * cached `verified` flags.
 */

import type { DiscoverProgramInput, DiscoveryResult, SerpAdapter } from '../contract';
import {
  pickApplicationUrl,
  pickPolicyUrl,
  rankSources,
  verifySources,
} from '../adapters/discovery-rules';
import { CACHED_DISCOVERY } from './discovery-cache';
import { delay, FIXTURE_LATENCY } from './latency';

/**
 * Normalize the cached payload: re-verify every URL against the allowlist, then
 * re-pick the policy and application URLs with the same rules the live adapter
 * uses. This is why the returned `application_url` is the attachment that was
 * verified live rather than the raw first search hit.
 */
function normalize(input: DiscoverProgramInput): DiscoveryResult {
  const allResults = verifySources(CACHED_DISCOVERY.all_results);
  const verified = rankSources(allResults.filter((source) => source.verified));

  return {
    hospital: input.hospital || CACHED_DISCOVERY.hospital,
    intent: input.intent || CACHED_DISCOVERY.intent,
    retrieved_at: CACHED_DISCOVERY.retrieved_at,
    searches_used: 0,
    verified_sources: verified,
    all_results: allResults,
    policy_url: pickPolicyUrl(verified) || CACHED_DISCOVERY.policy_url,
    application_url: pickApplicationUrl(verified),
    from_cache: true,
  };
}

export class FixtureSerpAdapter implements SerpAdapter {
  async discoverProgram(input: DiscoverProgramInput): Promise<DiscoveryResult> {
    await delay(FIXTURE_LATENCY.serpDiscovery);
    return normalize(input);
  }
}

export const fixtureSerpAdapter: SerpAdapter = new FixtureSerpAdapter();

/** Synchronous access for callers that already know they are in fixture mode. */
export function cachedDiscovery(
  input: DiscoverProgramInput = {
    hospital: CACHED_DISCOVERY.hospital,
    intent: CACHED_DISCOVERY.intent,
  },
): DiscoveryResult {
  return normalize(input);
}
