'use client';

import { useState } from 'react';
import type { Delivery, Id } from '../../lib/contract';
import { formatClock } from './timeline-model';

/**
 * "Approve and send": the one irreversible action on the page. A confirmation
 * step, then POST /api/delivery/email, then an honest receipt. The word "sent"
 * appears only when the backend reports the provider accepted the message.
 * Everything else (no provider, no address, failure) is shown as what it is.
 */

interface EmailResult {
  outcome: 'sent' | 'skipped' | 'failed' | 'dry_run';
  to_masked: string | null;
  error: string;
  delivery: Delivery | null;
}

const REASON_COPY: Readonly<Record<string, string>> = {
  no_destination: 'This program has not published an email address for applications. Nothing was emailed. Follow the hand-in instructions on the form instead.',
  no_provider: 'Approval recorded. Email sending is not switched on yet, so nothing was emailed.',
  demo_mode: 'Demo mode: approval noted, nothing was emailed.',
};

function describe(delivery: Delivery): { tone: 'ok' | 'warn'; text: string } {
  const domain = delivery.to.includes('@') ? delivery.to.split('@')[1] : '';
  const when = formatClock(delivery.created_at);
  if (delivery.status === 'sent') {
    return { tone: 'ok', text: `Emailed to ${domain || 'the program'}${when ? ` · ${when}` : ''}` };
  }
  if (delivery.status === 'queued') return { tone: 'warn', text: 'Email queued, waiting for the provider' };
  const reason = REASON_COPY[delivery.error] ?? delivery.error;
  return {
    tone: 'warn',
    text: `${delivery.status === 'skipped' ? 'Not emailed' : 'Email failed'}${reason ? ` · ${reason}` : ''}`,
  };
}

export function ApproveAndSend({
  caseId,
  emailDeliveries,
  organization,
  disabled,
}: {
  caseId: Id;
  /** deliveries rows with channel "email", oldest first. */
  emailDeliveries: Delivery[];
  organization: string | null;
  /** True until the filled form exists. */
  disabled: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<EmailResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const latest = emailDeliveries.length > 0 ? emailDeliveries[emailDeliveries.length - 1] : null;
  const alreadySent = latest?.status === 'sent' || result?.outcome === 'sent';

  const send = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/delivery/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ case_id: caseId, approved_by: 'browser' }),
      });
      const payload = (await response.json()) as EmailResult & { message?: string };
      if (!response.ok) {
        setError(payload.message ?? `The request failed (HTTP ${response.status}).`);
      } else {
        setResult(payload);
      }
    } catch (networkError) {
      setError(`Could not reach AccessForm: ${(networkError as Error).message}`);
    } finally {
      setPending(false);
      setConfirming(false);
    }
  };

  const receipt = result?.delivery ? describe(result.delivery) : latest ? describe(latest) : null;
  const where = organization ? `to ${organization}` : 'to the program';

  return (
    <div className="af-cv-approve" aria-live="polite">
      {receipt ? (
        <p className={`af-cv-receipt af-cv-receipt--${receipt.tone}`} role="status">
          {receipt.text}
        </p>
      ) : null}

      {!alreadySent && !confirming ? (
        <button
          type="button"
          className="af-cv-ctl af-cv-ctl--primary"
          onClick={() => setConfirming(true)}
          disabled={disabled || pending}
          aria-disabled={disabled || pending}
        >
          Approve and send {where}
        </button>
      ) : null}

      {confirming ? (
        <div className="af-cv-confirm" role="group" aria-label="Confirm sending">
          <p>
            This emails your filled application {where}, at the address the program has published. It cannot be
            taken back once it has gone. Anything still missing is listed in the email for you to provide separately.
          </p>
          <div className="af-cv-confirm__row">
            <button type="button" className="af-cv-ctl af-cv-ctl--primary" onClick={() => void send()} disabled={pending} aria-busy={pending}>
              {pending ? 'Sending…' : 'Yes, send it'}
            </button>
            <button type="button" className="af-cv-ctl" onClick={() => setConfirming(false)} disabled={pending}>
              Not yet
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="af-cv-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
