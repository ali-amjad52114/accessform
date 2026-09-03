import { TriangleAlert } from 'lucide-react';
import { SAFE_COPY, type Requirement } from '../lib/contract';

const COUNT_WORD = ['no', 'One', 'Two', 'Three', 'Four', 'Five'] as const;

/**
 * mockups/03 titles this "One thing left". That copy is only true when a
 * single item is outstanding, so the count leads and the wording follows it.
 */
function alertTitle(count: number): string {
  if (count === 1) return SAFE_COPY.missingWarningTitle;
  const word = count < COUNT_WORD.length ? COUNT_WORD[count] : String(count);
  return `${word} things left`;
}

/**
 * The missing-evidence warning. Rendered with role="alert" so it is announced
 * immediately (ACCESSIBILITY.md), and carries an icon plus a heading word so
 * it never depends on the amber colour alone.
 */
export function MissingRequirementAlert({
  requirements,
}: {
  requirements: Requirement[];
}) {
  if (requirements.length === 0) return null;

  return (
    <div className="af-alert" role="alert">
      <TriangleAlert
        className="af-alert__icon"
        size={26}
        strokeWidth={2.5}
        aria-hidden="true"
      />
      <div>
        <strong className="af-alert__title">
          {alertTitle(requirements.length)}
        </strong>
        <ul>
          {requirements.map((requirement) => (
            <li key={requirement.id}>Still required: {requirement.label}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
