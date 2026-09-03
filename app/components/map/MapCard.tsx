'use client';

/**
 * MapCard — the nearby organizations the caller was offered.
 *
 * Reads one `organizations_found` event's `metadata_json` (written by
 * lib/discovery/nearby.ts) and shows the same numbered list the agent read
 * aloud, with an OpenStreetMap map beside it.
 *
 * Accessibility decisions, on purpose:
 * - The ordered list is the content. The map is decorative and carries
 *   `aria-hidden`, because a Leaflet canvas of unlabelled tiles tells a screen
 *   reader nothing the list does not already say better.
 * - Nothing is below 18px, and focus rings are visible.
 * - `prefers-reduced-motion` turns off Leaflet's zoom/pan/fade animations.
 * - When no place has coordinates, the map is not rendered at all and the list
 *   stands alone. It is never replaced by an empty grey box.
 *
 * Leaflet is imported dynamically inside the effect: its module body touches
 * `document`, so a static import would break server rendering. Only the
 * stylesheet is imported statically.
 *
 * This component states what is nearby. It never says a place is verified,
 * approved, or that it has a program — only discover_program can speak to that.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Map as LeafletMap } from 'leaflet';

import 'leaflet/dist/leaflet.css';
import styles from './MapCard.module.css';

/** One place, as `organizations_found.metadata_json.organizations[n]`. */
export interface MapCardOrganization {
  index: number;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  distance_miles: number | null;
  place_id: string;
  website: string | null;
}

export interface MapCardProps {
  /**
   * The event's `metadata_json`, passed straight through. Loosely typed
   * because it arrives from the case feed as `Record<string, unknown> | null`.
   */
  data: Record<string, unknown> | null | undefined;
  /** The organization the case actually went with, if one was chosen. */
  selectedName?: string | null;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseOrganizations(data: MapCardProps['data']): MapCardOrganization[] {
  if (!data || typeof data !== 'object') return [];
  const raw = (data as Record<string, unknown>).organizations;
  if (!Array.isArray(raw)) return [];
  const organizations: MapCardOrganization[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = readString(row, 'name');
    if (!name) continue;
    organizations.push({
      index: readNumber(row, 'index') ?? organizations.length + 1,
      name,
      address: readString(row, 'address'),
      latitude: readNumber(row, 'latitude'),
      longitude: readNumber(row, 'longitude'),
      distance_miles: readNumber(row, 'distance_miles'),
      place_id: readString(row, 'place_id'),
      website: readString(row, 'website') || null,
    });
  }
  return organizations;
}

function sameName(a: string, b: string | null | undefined): boolean {
  if (!b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** "1.4 miles from the first one" — never presented as a travel distance. */
function describeDistance(organization: MapCardOrganization): string | null {
  if (organization.index === 1) return null;
  if (organization.distance_miles === null) return null;
  const miles = organization.distance_miles;
  return `${miles} ${miles === 1 ? 'mile' : 'miles'} from number 1, in a straight line`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function MapCard({ data, selectedName }: MapCardProps): React.ReactElement | null {
  const headingId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const organizations = useMemo(() => parseOrganizations(data), [data]);
  const location = data && typeof data === 'object' ? readString(data as Record<string, unknown>, 'location') : '';

  const plotted = useMemo(
    () => organizations.filter((organization) => organization.latitude !== null && organization.longitude !== null),
    [organizations],
  );

  useEffect(() => {
    if (plotted.length === 0) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let map: LeafletMap | null = null;

    void (async () => {
      const L = await import('leaflet');
      if (cancelled || !containerRef.current) return;

      const still = prefersReducedMotion();
      map = L.map(containerRef.current, {
        zoomAnimation: !still,
        fadeAnimation: !still,
        markerZoomAnimation: !still,
        scrollWheelZoom: false,
        attributionControl: true,
      });
      mapRef.current = map;

      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);

      const points: [number, number][] = [];
      for (const organization of plotted) {
        const latLng: [number, number] = [organization.latitude as number, organization.longitude as number];
        points.push(latLng);
        const selected = sameName(organization.name, selectedName);
        L.marker(latLng, {
          keyboard: false,
          // The list is the accessible copy of this; the map is aria-hidden.
          icon: L.divIcon({
            className: '',
            html: `<span class="${styles.afPin}${selected ? ` ${styles.afPinSelected}` : ''}">${organization.index}</span>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          }),
        }).addTo(map);
      }

      if (points.length === 1) {
        map.setView(points[0], 13, { animate: !still });
      } else {
        map.fitBounds(L.latLngBounds(points).pad(0.2), { animate: !still });
      }
      if (!cancelled) setMapReady(true);
    })();

    return () => {
      cancelled = true;
      if (map) map.remove();
      else if (mapRef.current) mapRef.current.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [plotted, selectedName]);

  if (organizations.length === 0) return null;

  const showMap = plotted.length > 0;

  return (
    <section className={styles.afCard} aria-labelledby={headingId}>
      <h2 className={styles.afHeading} id={headingId}>
        {organizations.length === 1 ? 'One place nearby' : `${organizations.length} places nearby`}
      </h2>
      <p className={styles.afSubheading}>
        {location
          ? `Found near ${location}. These are places nearby, not verified programs.`
          : 'These are places nearby, not verified programs.'}
      </p>

      <div className={`${styles.afBody}${showMap ? ` ${styles.afBodyWithMap}` : ''}`}>
        {showMap ? <div aria-hidden="true" className={styles.afMap} ref={containerRef} /> : null}

        <ol className={styles.afList}>
          {organizations.map((organization) => {
            const selected = sameName(organization.name, selectedName);
            const distance = describeDistance(organization);
            return (
              <li
                className={`${styles.afItem}${selected ? ` ${styles.afItemSelected}` : ''}`}
                key={organization.place_id || `${organization.index}-${organization.name}`}
              >
                <span aria-hidden="true" className={styles.afNumber}>
                  {organization.index}
                </span>
                <div>
                  <p className={styles.afName}>
                    {organization.index}. {organization.name}
                  </p>
                  {organization.address ? <p className={styles.afAddress}>{organization.address}</p> : null}
                  {distance ? <p className={styles.afDistance}>{distance}</p> : null}
                  {selected ? <span className={styles.afSelectedTag}>Chosen for this case</span> : null}
                  {organization.website ? (
                    <a
                      className={styles.afLink}
                      href={organization.website}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      Website for {organization.name}
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {showMap && !mapReady ? <p className={styles.afNote}>Loading the map. The list above is complete without it.</p> : null}
      {!showMap ? (
        <p className={styles.afEmpty}>No map for these places — the list above is the whole result.</p>
      ) : null}
    </section>
  );
}
