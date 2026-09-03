import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The single piece of page chrome AccessForm has: wordmark on the left,
 * one optional status slot on the right. No navigation menu by design.
 */
export function SiteHeader({ aside }: { aside?: ReactNode }) {
  return (
    <header className="af-header">
      <div className="af-container af-header__inner">
        <Link className="af-logo" href="/">
          <span className="af-logo__mark" aria-hidden="true" />
          AccessForm
        </Link>
        {aside ? <div className="af-header__aside">{aside}</div> : null}
      </div>
    </header>
  );
}
