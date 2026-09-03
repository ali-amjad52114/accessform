/**
 * Nearby organizations — "which places of this kind are near the caller?"
 *
 * This runs BEFORE discovery, for the caller who has a need but has not named
 * an organization ("I got a hospital bill I can't pay" — which hospital?). It
 * returns a short numbered list the agent can read out so the caller can pick
 * one by number; the name they pick is then passed to `discover_program`.
 *
 * It is a LOCATOR, not a verifier. Nothing here decides that an organization
 * has a program, publishes a form, or that any form is official — Google Maps
 * knows where places are, not what they publish. Only `resolveProgram()` and
 * the allowlist in `discovery-rules.ts` can call a source verified.
 *
 * CREDIT DISCIPLINE. One SerpApi credit per uncached lookup, counted against
 * the same shared run budget as organic discovery. Two caches stand in front
 * of it:
 *   1. an in-process map, keyed `category|normalized location`;
 *   2. `app/.nearbycache/<sha256>.json`, which survives restarts (modelled on
 *      the `.formcache` used by lib/forms/understand-form.ts).
 * Demo mode and a missing key never reach the network — they return
 * `found: false` with a reason, never fixture places.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { serpMapsSearch, type SerpMapsPlace } from '../adapters/serp';
import { isDemoMode } from '../adapters/env';
import type { Id, NeedCategory } from '../contract';
import { getXanoAdapter } from '../voice/xano-bridge';

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/** One place, as the voice tool and the map card consume it. */
export interface NearbyOrganization {
  /** 1-based position in the spoken list. The caller picks by this number. */
  index: number;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  /** Straight-line miles from the first result. `null` when unknown. */
  distance_miles: number | null;
  place_id: string;
  website: string | null;
}

export interface NearbyResult {
  found: boolean;
  category: NeedCategory;
  location: string;
  count: number;
  organizations: NearbyOrganization[];
  /** Present when `found` is false — a sentence the agent can say aloud. */
  reason?: string;
  /** SerpApi credits this call spent (0 on any cache hit). */
  searches_used: number;
  from_cache: boolean;
}

export interface FindNearbyOrganizationsInput {
  category: NeedCategory;
  /** What the caller said about where they are: a city, county or ZIP. */
  location: string;
  /** When present (and demo mode is off), the lookup writes a feed event. */
  case_id?: Id;
}

/* ------------------------------------------------------------------ */
/* Category → what to look for                                         */
/* ------------------------------------------------------------------ */

/**
 * The Maps search phrase per need category, and the plural noun used in the
 * spoken/feed message. `null` means "no place to look for": those categories
 * return `found: false` WITHOUT spending a credit.
 */
const CATEGORY_PLACES: Readonly<
  Record<NeedCategory, { phrase: string; kind: string } | null>
> = {
  hospital_financial_assistance: { phrase: 'hospital', kind: 'hospitals' },
  paratransit: { phrase: 'paratransit eligibility office', kind: 'paratransit offices' },
  disability_accommodation: {
    phrase: 'college disability services office',
    kind: 'disability services offices',
  },
  scholarship_financial_aid: {
    phrase: 'college financial aid office',
    kind: 'financial aid offices',
  },
  benefits: { phrase: 'county social services office', kind: 'social services offices' },
  appointment: null,
  other: null,
};

/** The Maps phrase for a category, or `null` when the category has no place. */
export function nearbyPhraseFor(category: NeedCategory): string | null {
  return CATEGORY_PLACES[category]?.phrase ?? null;
}

/* ------------------------------------------------------------------ */
/* Distance                                                            */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_MILES = 3958.7613;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle ("straight-line") distance in miles.
 *
 * LIMITATION, stated plainly because the number is read to a caller who may be
 * choosing based on it: this is a straight line over the ground, NOT a driving
 * or transit distance, and it is measured from the FIRST result — we only know
 * the caller's town or ZIP, never their coordinates, so there is no true
 * origin to measure from. Read it as "how far these places are from each
 * other", never as "how far you have to travel".
 */
export function straightLineMiles(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Places -> numbered organizations, distances relative to the first one. */
export function toOrganizations(places: readonly SerpMapsPlace[]): NearbyOrganization[] {
  const origin = places.find((place) => place.gps_coordinates)?.gps_coordinates ?? null;
  return places.map((place, position) => {
    const coordinates = place.gps_coordinates;
    const distance =
      origin && coordinates ? straightLineMiles(origin, coordinates) : null;
    return {
      index: position + 1,
      name: place.title,
      address: place.address,
      latitude: coordinates ? coordinates.latitude : null,
      longitude: coordinates ? coordinates.longitude : null,
      distance_miles: distance === null ? null : Math.round(distance * 10) / 10,
      place_id: place.place_id,
      website: place.website ?? null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Caches                                                              */
/* ------------------------------------------------------------------ */

export const NEARBYCACHE_DIR_NAME = '.nearbycache' as const;
export const NEARBYCACHE_VERSION = 1 as const;

interface NearbyCacheFile {
  version: number;
  key: string;
  category: NeedCategory;
  location: string;
  built_at: string;
  organizations: NearbyOrganization[];
}

/** Lowercased, whitespace- and punctuation-normalized location. */
export function normalizeLocation(location: string): string {
  return location
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `category|normalized location` — the key both caches share. */
export function nearbyCacheKey(category: NeedCategory, location: string): string {
  return `${category}|${normalizeLocation(location)}`;
}

/** Survives only this process. Cleared by a restart, unlike the file cache. */
const memoryCache = new Map<string, NearbyOrganization[]>();

/** Test hook: forget everything this process has looked up. */
export function clearNearbyMemoryCache(): void {
  memoryCache.clear();
}

export function nearbyCacheDir(override?: string): string {
  return override ?? path.join(process.cwd(), NEARBYCACHE_DIR_NAME);
}

function cacheFilePath(key: string, dir: string): string {
  return path.join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
}

async function readFileCache(key: string, dir: string): Promise<NearbyOrganization[] | null> {
  try {
    const raw = await readFile(cacheFilePath(key, dir), 'utf8');
    const parsed = JSON.parse(raw) as NearbyCacheFile;
    if (parsed.version !== NEARBYCACHE_VERSION || parsed.key !== key) return null;
    if (!Array.isArray(parsed.organizations) || parsed.organizations.length === 0) return null;
    return parsed.organizations;
  } catch {
    return null;
  }
}

async function writeFileCache(entry: NearbyCacheFile, dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(cacheFilePath(entry.key, dir), JSON.stringify(entry, null, 2), 'utf8');
  } catch (error) {
    // A read-only filesystem must not fail the lookup.
    console.warn(
      `[accessform] nearby: cache not written — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Feed events                                                         */
/* ------------------------------------------------------------------ */

async function appendCaseEvent(
  caseId: Id | undefined,
  event: { event_type: string; message: string; metadata_json: Record<string, unknown> },
): Promise<void> {
  if (!caseId || isDemoMode()) return;
  try {
    await getXanoAdapter().appendEvent(caseId, {
      actor: 'serpapi',
      event_type: event.event_type,
      message: event.message,
      metadata_json: event.metadata_json,
    });
  } catch (error) {
    console.warn(
      `[accessform] nearby: event ${event.event_type} not written — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* The lookup                                                          */
/* ------------------------------------------------------------------ */

export interface FindNearbyOptions {
  /** Override the cache directory (default: <cwd>/.nearbycache). */
  cacheDir?: string;
}

/**
 * Up to five organizations of the right kind near the caller.
 *
 * Never throws: an unusable category, a missing location, a refused search and
 * a SerpApi failure all come back as `found: false` with a reason the agent
 * can say out loud.
 */
export async function findNearbyOrganizations(
  input: FindNearbyOrganizationsInput,
  options: FindNearbyOptions = {},
): Promise<NearbyResult> {
  const category = input.category;
  const location = (input.location ?? '').replace(/\s+/g, ' ').trim();

  const base = { category, location, count: 0, organizations: [] as NearbyOrganization[] };

  const place = CATEGORY_PLACES[category];
  if (!place) {
    // No credit spent: there is no kind of place that matches this need.
    return {
      ...base,
      found: false,
      reason: 'That kind of need is not tied to a place I can look up nearby.',
      searches_used: 0,
      from_cache: false,
    };
  }
  if (!location) {
    return {
      ...base,
      found: false,
      reason: 'I need to know where the caller is before I can look for places nearby.',
      searches_used: 0,
      from_cache: false,
    };
  }

  const key = nearbyCacheKey(category, location);
  const dir = nearbyCacheDir(options.cacheDir);

  const cached = memoryCache.get(key) ?? (await readFileCache(key, dir));
  if (cached && cached.length > 0) {
    memoryCache.set(key, cached);
    await recordFound(input.case_id, cached, category, location, place.kind);
    return {
      category,
      location,
      found: true,
      count: cached.length,
      organizations: cached,
      searches_used: 0,
      from_cache: true,
    };
  }

  let places: SerpMapsPlace[];
  try {
    places = await serpMapsSearch({ query: place.phrase, location });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[accessform] nearby: maps search failed — ${detail}`);
    const reason = `I could not look up ${place.kind} near ${location} just now.`;
    await appendCaseEvent(input.case_id, {
      event_type: 'organizations_not_found',
      message: `No nearby ${place.kind} found near ${location}`,
      metadata_json: { category, location, organizations: [], reason: detail },
    });
    return { ...base, found: false, reason, searches_used: 0, from_cache: false };
  }

  const organizations = toOrganizations(places);
  if (organizations.length === 0) {
    await appendCaseEvent(input.case_id, {
      event_type: 'organizations_not_found',
      message: `No nearby ${place.kind} found near ${location}`,
      metadata_json: {
        category,
        location,
        organizations: [],
        reason: 'the search returned no places',
      },
    });
    return {
      ...base,
      found: false,
      reason: `I could not find any ${place.kind} near ${location}.`,
      searches_used: 1,
      from_cache: false,
    };
  }

  memoryCache.set(key, organizations);
  await writeFileCache(
    {
      version: NEARBYCACHE_VERSION,
      key,
      category,
      location,
      built_at: new Date().toISOString(),
      organizations,
    },
    dir,
  );
  await recordFound(input.case_id, organizations, category, location, place.kind);

  return {
    category,
    location,
    found: true,
    count: organizations.length,
    organizations,
    searches_used: 1,
    from_cache: false,
  };
}

async function recordFound(
  caseId: Id | undefined,
  organizations: readonly NearbyOrganization[],
  category: NeedCategory,
  location: string,
  kind: string,
): Promise<void> {
  await appendCaseEvent(caseId, {
    event_type: 'organizations_found',
    message: `${organizations.length} nearby ${kind} found near ${location}`,
    metadata_json: {
      category,
      location,
      organizations: organizations.map((organization) => ({
        index: organization.index,
        name: organization.name,
        address: organization.address,
        latitude: organization.latitude,
        longitude: organization.longitude,
        distance_miles: organization.distance_miles,
        place_id: organization.place_id,
        website: organization.website,
      })),
    },
  });
}
