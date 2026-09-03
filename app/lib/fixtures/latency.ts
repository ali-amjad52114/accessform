/**
 * Fixture timing.
 *
 * The fixtures exist so the demo works with zero network, but a fixture that
 * resolves instantly hides every loading state and makes the recorded demo look
 * fake. Each fixture call therefore takes a plausible amount of time, scaled by
 * a single knob so tests can run at full speed.
 */

let scale = 1;

/**
 * Multiply every fixture delay. `0` makes fixtures resolve on the next tick —
 * use it in tests. Values are clamped to `[0, 10]`.
 */
export function setFixtureLatencyScale(next: number): void {
  scale = Math.max(0, Math.min(10, next));
}

export function getFixtureLatencyScale(): number {
  return scale;
}

/** Sleep for `ms` scaled milliseconds. */
export function delay(ms: number): Promise<void> {
  const scaled = Math.round(ms * scale);
  if (scaled <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, scaled));
}

/**
 * Plausible round-trip times, measured against the real services during the
 * integration spike. Keep these honest — the demo's pacing depends on them.
 */
export const FIXTURE_LATENCY = {
  /** Xano CRUD on a small row. */
  xanoRead: 140,
  xanoWrite: 220,
  /** Xano recomputes completeness across answers + requirements. */
  xanoValidate: 380,
  /** Three SerpApi searches plus ranking. */
  serpDiscovery: 1_600,
  /** POST /extraction/parse over a 395 KB, 4-page PDF. */
  nutrientExtract: 2_400,
  /** POST /build with applyInstantJson + flatten. */
  nutrientFill: 1_900,
  /** POST /accessibility/autotag. */
  nutrientAutotag: 2_100,
  /** Vapi control-plane list calls. */
  vapiControl: 260,
} as const;
