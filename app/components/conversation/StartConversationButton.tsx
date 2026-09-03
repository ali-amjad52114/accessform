'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { Mic } from 'lucide-react';
import { createCase, rememberCase } from './case-history';

/**
 * "Start a conversation": creates an empty case, remembers it in this
 * browser's history, and opens the conversation page with the call starting.
 * A failed POST is shown as text right under the button — never a fixture.
 */
export function StartConversationButton({
  className,
  label = 'Start a conversation',
  compact = false,
}: {
  className?: string;
  label?: string;
  /** Sidebar variant: shorter pending text, no icon. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const created = await createCase();
      rememberCase(created.case_id);
      router.push(`/c/${encodeURIComponent(created.case_id)}?start=1`);
    } catch (createError) {
      setError(
        `Could not start a conversation. ${(createError as Error).message} You can still call +1 (945) 277-2309.`,
      );
      setPending(false);
    }
  }, [pending, router]);

  return (
    <div className={compact ? 'af-cv-startwrap af-cv-startwrap--compact' : 'af-cv-startwrap'}>
      <button
        type="button"
        className={className ?? 'af-btn af-btn--primary'}
        onClick={() => void start()}
        disabled={pending}
        aria-disabled={pending}
        aria-busy={pending}
      >
        {compact ? null : (
          <Mic className="af-btn__icon" size={24} strokeWidth={2.5} aria-hidden="true" />
        )}
        {pending ? (compact ? 'Creating…' : 'Creating your conversation…') : label}
      </button>
      {error ? (
        <p className="af-cv-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
