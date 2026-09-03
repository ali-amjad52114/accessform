import type { ReactNode } from 'react';

interface CardProps {
  /** Rendered as an <h2>; the section is labelled by it. */
  title: string;
  titleId: string;
  children: ReactNode;
  className?: string;
  /** Optional live-region behaviour for the whole card. */
  ariaLive?: 'off' | 'polite';
}

export function Card({
  title,
  titleId,
  children,
  className,
  ariaLive,
}: CardProps) {
  return (
    <section
      className={className ? `af-card ${className}` : 'af-card'}
      aria-labelledby={titleId}
      aria-live={ariaLive}
    >
      <h2 className="af-card__title" id={titleId}>
        {title}
      </h2>
      {children}
    </section>
  );
}
