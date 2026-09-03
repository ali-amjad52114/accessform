import { VOICE_STATE_LABELS, type VoiceState } from '../lib/contract';

/**
 * The voice indicator. The animated orb is decorative; the state is always
 * spelled out in text underneath and announced politely so the call state is
 * understandable without audio, colour or motion.
 */
export function VoiceOrb({ state }: { state: VoiceState }) {
  return (
    <div className={`af-orb af-orb--${state}`}>
      <span className="af-orb__ring" aria-hidden="true">
        <span className="af-orb__mid">
          <span className="af-orb__core" />
        </span>
      </span>
      <p className="af-orb__state" aria-live="polite" aria-atomic="true">
        <span className="af-sr-only">Voice status: </span>
        {VOICE_STATE_LABELS[state]}
      </p>
    </div>
  );
}
