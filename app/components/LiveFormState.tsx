import { Check } from 'lucide-react';

export interface LiveFieldSnapshot {
  /** Normalized key shown to the reader, e.g. "annual_household_income". */
  key: string;
  /** Human label for the same field, announced to screen readers. */
  label: string;
  /** Display form of the value (currency carries its "$" here). */
  display: string;
  /** True once Xano has acknowledged the write. */
  saved: boolean;
  /** The form section the field belongs to, when known ("Household"). */
  section?: string | null;
}

/**
 * Bottom of the right card on /live: the last structured answer written to
 * Xano, with the section of the form it belongs to. Announced politely so a
 * screen-reader user hears each save, and the saved/pending distinction is a
 * word plus an icon, never a colour.
 */
export function LiveFormState({ field }: { field: LiveFieldSnapshot | null }) {
  return (
    <div className="af-formstate">
      <span className="af-formstate__label" id="live-form-state-label">
        Live form state
      </span>
      <div
        className="af-formstate__row"
        aria-live="polite"
        aria-atomic="true"
        aria-labelledby="live-form-state-label"
      >
        {field === null ? (
          <span className="af-formstate__key">
            No answers saved yet. The first one appears here.
          </span>
        ) : (
          <>
            <span className="af-formstate__key">
              {field.section ? (
                <span className="af-formstate__section">
                  <span className="af-sr-only">Section: </span>
                  {field.section}
                </span>
              ) : null}
              {field.key}
              <span className="af-sr-only">{` (${field.label})`}</span>
            </span>
            <span className="af-formstate__value">{field.display}</span>
            <span className="af-formstate__saved">
              {field.saved ? 'saved to Xano' : 'saving to Xano…'}
              {field.saved ? (
                <Check size={18} strokeWidth={3} aria-hidden="true" />
              ) : null}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
