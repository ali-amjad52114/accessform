'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import DocumentViewer, { type ViewerMode } from '../../components/viewer/DocumentViewer';
import type { GeneratedDocument } from '../api/document/_lib/types';
import {
  SAFE_COPY,
  type AccessibilityStatus,
  type Delivery,
  type DeliveryStatus,
  type CompletenessSummary,
  type FormKind,
  type Program,
  type Requirement,
} from '../../lib/contract';

import { eligibilityCopy, notSubmittedCopy } from '../../components/safe-copy';
import styles from './review.module.css';

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'] as const;

function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

interface AccessibilityLine {
  icon: string;
  text: string;
  /** Nothing further is expected for this document. */
  done: boolean;
  /** Sentence for the read-aloud summary, or null when there is nothing to claim. */
  summary: string | null;
}

/**
 * Honest, non-committal wording for every accessibility state. Only
 * `processed` may say that processing ran; `preserved` means no pass ran and
 * the official document's own tagging was kept intact.
 */
function accessibilityLine(status: AccessibilityStatus): AccessibilityLine {
  switch (status) {
    case 'processed':
      return {
        icon: '✓',
        text: 'Accessibility processed by Nutrient',
        done: true,
        summary: 'The document has been through Nutrient accessibility processing.',
      };
    case 'preserved':
      return {
        icon: '✓',
        text: "Official document's accessibility tagging preserved",
        done: true,
        summary:
          "No accessibility pass ran; the official document's own accessibility tagging was preserved.",
      };
    case 'processing':
      return { icon: '…', text: 'Accessibility processing is running', done: false, summary: null };
    case 'pending':
      return { icon: '○', text: 'Accessibility processing has not run yet', done: false, summary: null };
    case 'failed':
      return { icon: '!', text: 'Accessibility processing did not complete', done: false, summary: null };
    case 'not_applicable':
      return { icon: '–', text: 'Accessibility processing does not apply', done: false, summary: null };
  }
}

/** Approved sentence for each requirement we know about. */
function missingSentence(requirement: Requirement): string {
  if (requirement.key === 'proof_of_social_security_income') return SAFE_COPY.missingProofOfIncome;
  if (requirement.key === 'applicant_signature' || requirement.type === 'signature') {
    return SAFE_COPY.missingSignature;
  }
  return `${requirement.label} is still required before submission.`;
}

/** Last four digits only; the full number is never rendered. */
function maskPhone(to: string): string {
  const digits = to.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

function whenText(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const DELIVERY_STATUS_WORD: Readonly<Record<DeliveryStatus, string>> = {
  sent: 'Sent by text',
  queued: 'Text queued',
  failed: 'Text not sent',
  skipped: 'Text not sent',
};

/* ------------------------------------------------------------------ */
/* Delivery endpoint (app/api/delivery/send — owned by the delivery agent)  */
/* ------------------------------------------------------------------ */

/**
 * What POST /api/delivery/send answers. A dry run returns the exact text
 * and what the trial guard WOULD do; a real send returns the literal
 * `status` of the deliveries row (never inferred here). Errors are
 * `{ error, message? }` with a 4xx/5xx status.
 */
interface DeliverySendResponse {
  dry_run?: boolean;
  sent?: boolean;
  status?: DeliveryStatus;
  delivery_id?: string;
  to_masked?: string;
  message?: string;
  trial_guard?: string;
  trial_guard_note?: string;
  note?: string;
  error?: string;
}

type DeliverySendResult =
  | { ok: true; body: DeliverySendResponse }
  | { ok: false; error: string };

async function postDeliverySend(input: {
  case_id: string;
  dry_run: boolean;
  to?: string;
}): Promise<DeliverySendResult> {
  let response: Response;
  try {
    response = await fetch('/api/delivery/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, error: 'Could not reach the delivery service.' };
  }
  let body: DeliverySendResponse | null = null;
  try {
    body = (await response.json()) as DeliverySendResponse;
  } catch {
    body = null;
  }
  /* A failed send is a 502 with the row's status in the body: that is a result, not a transport error. */
  if (body && typeof body.status === 'string' && body.dry_run === false) {
    return { ok: true, body };
  }
  if (!response.ok || !body) {
    const detail = body?.error ? `${body.error}${body.note ? ` — ${body.note}` : ''}` : '';
    return {
      ok: false,
      error: detail || `The delivery service answered ${response.status}.`,
    };
  }
  return { ok: true, body };
}

/** A send attempt as this screen shows it: status word, masked number, when. */
interface DeliveryView {
  status: DeliveryStatus;
  toMasked: string;
  error: string;
  when: string;
}

function viewOfDelivery(delivery: Delivery): DeliveryView {
  return {
    status: delivery.status,
    toMasked: maskPhone(delivery.to),
    error: delivery.error,
    when: delivery.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export interface ReviewClientProps {
  caseId: string;
  patientDisplayName: string;
  programName: string;
  organizationName: string | null;
  program: Program | null;
  formKind: FormKind | null;
  completeness: CompletenessSummary;
  completedRequirements: Requirement[];
  missingRequirements: Requirement[];
  documentUrl: string;
  initialDocument: GeneratedDocument;
  /** Every send attempt for the case, oldest first (from Xano). */
  deliveries: Delivery[];
  /** True when the case has a caller phone number on file. */
  hasCallerPhone: boolean;
  demoMode: boolean;
}

type SendPhase =
  | { kind: 'idle' }
  | { kind: 'previewing' }
  | { kind: 'preview'; message: string; toMasked: string | null; guardNote: string }
  | { kind: 'sending'; message: string; toMasked: string | null; guardNote: string }
  | { kind: 'result'; view: DeliveryView }
  | { kind: 'error'; error: string };

export default function ReviewClient({
  caseId,
  patientDisplayName,
  programName,
  organizationName,
  program,
  formKind,
  completeness,
  completedRequirements,
  missingRequirements,
  documentUrl,
  initialDocument,
  deliveries,
  hasCallerPhone,
  demoMode,
}: ReviewClientProps) {
  const [documentMeta, setDocumentMeta] = useState<GeneratedDocument>(initialDocument);
  const [viewerMode, setViewerMode] = useState<ViewerMode>('loading');
  const [showHowToAdd, setShowHowToAdd] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [sendPhase, setSendPhase] = useState<SendPhase>({ kind: 'idle' });
  const [toNumber, setToNumber] = useState('');
  const [localDeliveries, setLocalDeliveries] = useState<DeliveryView[]>(() =>
    deliveries.map(viewOfDelivery),
  );

  const documentRef = useRef<HTMLDivElement | null>(null);
  const disclosureRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  const access = accessibilityLine(documentMeta.accessibilityStatus);
  const notSubmitted = notSubmittedCopy(organizationName);
  const eligibility = eligibilityCopy(organizationName);
  const fillable = formKind === null || formKind === 'fillable_pdf';

  /* The warm alert is about evidence AccessForm still needs from the caller. A
     signature is a different kind of gap — AccessForm never signs for anyone —
     so it stays visible in the checklist instead of diluting the alert. */
  const alertRequirements = missingRequirements.filter((r) => r.type !== 'signature');
  const selfServeRequirements = missingRequirements.filter((r) => r.type === 'signature');
  const alertItems = alertRequirements.length > 0 ? alertRequirements : missingRequirements;
  const checklistPending =
    alertRequirements.length > 0 ? selfServeRequirements : ([] as Requirement[]);

  /* The most recent send attempt, and whether any attempt actually went out. */
  const sentDelivery = [...localDeliveries].reverse().find((d) => d.status === 'sent') ?? null;
  const latestDelivery = localDeliveries.length > 0 ? localDeliveries[localDeliveries.length - 1] : null;

  /* Refresh the document facts once the live pipeline has settled, so the
     accessibility line never claims more than actually happened. */
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/document/${encodeURIComponent(caseId)}/status`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) return;
        const fresh = (await response.json()) as GeneratedDocument;
        if (!controller.signal.aborted && fresh && typeof fresh.accessibilityStatus === 'string') {
          setDocumentMeta(fresh);
        }
      } catch {
        /* keep the server-rendered facts */
      }
    })();

    return () => controller.abort();
  }, [caseId]);

  /* Stop any narration if the screen goes away mid-sentence. */
  useEffect(
    () => () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    },
    [],
  );

  const focusDocument = useCallback(() => {
    const node = documentRef.current?.querySelector<HTMLElement>('#application-document');
    node?.focus();
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setAnnouncement(
      `Moved to the filled ${programName}. ${completeness.requiredFieldsComplete} of ${completeness.requiredFieldsTotal} required fields are complete.`,
    );
  }, [programName, completeness.requiredFieldsComplete, completeness.requiredFieldsTotal]);

  const toggleHowToAdd = useCallback(() => {
    setShowHowToAdd((open) => {
      const next = !open;
      if (next) window.setTimeout(() => disclosureRef.current?.focus(), 0);
      return next;
    });
  }, []);

  const summaryText = [
    `${programName} for ${patientDisplayName}, case ${caseId}.`,
    `${completeness.requiredFieldsComplete} of ${completeness.requiredFieldsTotal} required fields are complete.`,
    SAFE_COPY.completenessBasis,
    access.summary ?? '',
    missingRequirements.length > 0
      ? `${countWord(missingRequirements.length)} ${missingRequirements.length === 1 ? 'item is' : 'items are'} still needed. ${missingRequirements.map(missingSentence).join(' ')}`
      : '',
    sentDelivery ? `A text with the link was sent to ${sentDelivery.toMasked}.` : '',
    notSubmitted,
    eligibility,
  ]
    .filter(Boolean)
    .join(' ');

  const toggleSpeech = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setAnnouncement('Read aloud is not available in this browser.');
      return;
    }
    const synth = window.speechSynthesis;
    if (synth.speaking || speaking) {
      synth.cancel();
      setSpeaking(false);
      setAnnouncement('Stopped reading the summary.');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(summaryText);
    utterance.rate = 0.95;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(utterance);
    setSpeaking(true);
    setAnnouncement('Reading the summary aloud.');
  }, [speaking, summaryText]);

  /* Step 1: a dry run. Nothing is sent; the exact text comes back for review. */
  const previewText = useCallback(async () => {
    setSendPhase({ kind: 'previewing' });
    const to = toNumber.trim() || undefined;
    const result = await postDeliverySend({ case_id: caseId, dry_run: true, to });
    if (!result.ok || typeof result.body.message !== 'string') {
      const error = result.ok ? 'Could not prepare the text.' : result.error;
      setSendPhase({ kind: 'error', error });
      setAnnouncement(error);
      return;
    }
    setSendPhase({
      kind: 'preview',
      message: result.body.message,
      toMasked: result.body.to_masked ?? null,
      guardNote: result.body.trial_guard_note ?? '',
    });
    setAnnouncement('Text prepared. Review it, then confirm to send.');
    window.setTimeout(() => previewRef.current?.focus(), 0);
  }, [caseId, toNumber]);

  /* Step 2: only after the person confirms. The status shown is the row's literal status. */
  const confirmSend = useCallback(async () => {
    if (sendPhase.kind !== 'preview') return;
    setSendPhase({ ...sendPhase, kind: 'sending' });
    const to = toNumber.trim() || undefined;
    const result = await postDeliverySend({ case_id: caseId, dry_run: false, to });
    if (!result.ok) {
      setSendPhase({ kind: 'error', error: result.error });
      setAnnouncement(result.error);
      return;
    }
    const view: DeliveryView = {
      status: result.body.status ?? 'failed',
      toMasked: result.body.to_masked ?? (sendPhase.toMasked ?? '***'),
      error: result.body.error ?? '',
      when: new Date().toISOString(),
    };
    setLocalDeliveries((current) => [...current, view]);
    setSendPhase({ kind: 'result', view });
    setAnnouncement(
      view.status === 'sent'
        ? `Text sent to ${view.toMasked}.`
        : `The text was not sent. ${result.body.note ?? view.error}`.trim(),
    );
  }, [caseId, sendPhase, toNumber]);

  const cancelSend = useCallback(() => {
    setSendPhase({ kind: 'idle' });
    setAnnouncement('Text cancelled. Nothing was sent.');
  }, []);

  const circumference = 2 * Math.PI * 54;
  const dash = (Math.max(0, Math.min(100, completeness.percent)) / 100) * circumference;

  const sendBusy = sendPhase.kind === 'previewing' || sendPhase.kind === 'sending';

  return (
    <>
      <p aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </p>

      <div className={styles.grid}>
        <section className={styles.documentCard} aria-labelledby="document-heading" ref={documentRef}>
          <h2 id="document-heading">{fillable ? 'Your filled form' : 'The official form'}</h2>
          <p className={styles.documentMeta}>
            {fillable
              ? `${documentMeta.fieldsFilled} answers written into the official ${programName}.`
              : `This form cannot be filled automatically yet. The official ${programName} is shown so you can complete it yourself; your answers are listed below.`}
          </p>
          <DocumentViewer
            documentUrl={documentUrl}
            title={`${programName} for ${patientDisplayName}${fillable ? ', filled' : ''}`}
            onModeChange={setViewerMode}
          />
          <p className={styles.visuallyHidden} aria-live="polite">
            {viewerMode === 'sdk'
              ? 'Document loaded in the Nutrient viewer.'
              : viewerMode === 'embedded'
                ? 'Document loaded in the browser PDF view.'
                : ''}
          </p>
        </section>

        <aside className={styles.panel} aria-labelledby="completeness-heading">
          <h2 id="completeness-heading">Completeness</h2>

          <div className={styles.ringWrap}>
            <svg
              className={styles.ring}
              width="150"
              height="150"
              viewBox="0 0 128 128"
              role="img"
              aria-label={`${completeness.percent} percent of the form is complete`}
            >
              <circle className={styles.ringTrack} cx="64" cy="64" r="54" />
              <circle
                className={styles.ringValue}
                cx="64"
                cy="64"
                r="54"
                strokeDasharray={`${dash} ${circumference - dash}`}
              />
              <text className={styles.ringLabel} x="64" y="64">
                {completeness.percent}%
              </text>
            </svg>
          </div>

          <p className={styles.fieldCount}>
            {completeness.requiredFieldsComplete} / {completeness.requiredFieldsTotal} required fields
          </p>

          <h3 className={styles.visuallyHidden}>What is complete</h3>
          <ul className={styles.checklist}>
            {completedRequirements.map((requirement) => (
              <li className={styles.checkItem} key={requirement.id}>
                <span className={`${styles.checkIcon} ${styles.iconComplete}`} aria-hidden="true">
                  ✓
                </span>
                <span className={styles.checkLabel}>{requirement.label}</span>
                <span className={styles.checkState}>Complete</span>
              </li>
            ))}
            <li className={styles.checkItem}>
              <span
                className={`${styles.checkIcon} ${access.done ? styles.iconComplete : styles.iconMissing}`}
                aria-hidden="true"
              >
                {access.icon}
              </span>
              <span className={styles.checkLabel}>{access.text}</span>
              <span className={styles.checkState}>{access.done ? 'Done' : 'Not yet'}</span>
            </li>
            {checklistPending.map((requirement) => (
              <li className={styles.checkItem} key={requirement.id}>
                <span className={`${styles.checkIcon} ${styles.iconMissing}`} aria-hidden="true">
                  !
                </span>
                <span className={styles.checkLabel}>{requirement.label}</span>
                <span className={styles.checkState}>Still needed</span>
              </li>
            ))}
          </ul>

          {alertItems.length > 0 && (
            <div className={styles.warning} role="alert">
              <h3 className={styles.warningTitle}>
                <span aria-hidden="true">⚠</span>
                {alertItems.length === 1
                  ? SAFE_COPY.missingWarningTitle
                  : `${countWord(alertItems.length)} things left`}
              </h3>
              <ul className={styles.warningList}>
                {alertItems.map((requirement) => (
                  <li key={requirement.id}>{missingSentence(requirement)}</li>
                ))}
              </ul>
            </div>
          )}

          <div className={styles.actions}>
            <button type="button" className={styles.primaryButton} onClick={focusDocument}>
              Review the form
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={toggleHowToAdd}
              aria-expanded={showHowToAdd}
              aria-controls="add-missing-document"
            >
              Add missing document
            </button>
            <button type="button" className={styles.secondaryButton} onClick={toggleSpeech}>
              {speaking ? 'Stop reading' : 'Read summary aloud'}
            </button>
          </div>

          {showHowToAdd && (
            <div
              className={styles.disclosure}
              id="add-missing-document"
              ref={disclosureRef}
              tabIndex={-1}
            >
              <h3>What to attach</h3>
              <ul>
                {missingRequirements.map((requirement) => (
                  <li key={requirement.id}>
                    <strong>{requirement.label}</strong>
                    {requirement.type === 'signature'
                      ? ' — you add this yourself; AccessForm never signs on your behalf.'
                      : ` — attach this to the form before it goes to ${organizationName ?? 'the organization'}.`}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- Delivery by text ---- */}
          <section className={styles.delivery} aria-labelledby="delivery-heading">
            <h3 id="delivery-heading" className={styles.deliveryHeading}>
              By text
            </h3>

            {sentDelivery ? (
              <p className={styles.deliveryLine}>
                <span className={`${styles.checkIcon} ${styles.iconComplete}`} aria-hidden="true">
                  ✓
                </span>
                {DELIVERY_STATUS_WORD.sent} to {sentDelivery.toMasked}
                {sentDelivery.when ? ` · ${whenText(sentDelivery.when)}` : ''}
              </p>
            ) : latestDelivery ? (
              <p className={styles.deliveryLine}>
                <span className={`${styles.checkIcon} ${styles.iconMissing}`} aria-hidden="true">
                  !
                </span>
                {DELIVERY_STATUS_WORD[latestDelivery.status]}
                {latestDelivery.error ? ` — ${latestDelivery.error}` : ''}
              </p>
            ) : (
              <p className={styles.deliveryLine}>
                Not texted yet. The text carries a link to this page, what is still needed, and
                the next step — never your answers.
              </p>
            )}

            {sendPhase.kind === 'preview' || sendPhase.kind === 'sending' ? (
              <div
                className={styles.deliveryPreview}
                ref={previewRef}
                tabIndex={-1}
                aria-labelledby="delivery-preview-heading"
              >
                <h4 id="delivery-preview-heading" className={styles.deliveryPreviewHeading}>
                  {sendPhase.toMasked
                    ? `Send this text to ${sendPhase.toMasked}?`
                    : 'Send this text?'}
                </h4>
                <pre className={styles.deliveryMessage}>{sendPhase.message}</pre>
                {sendPhase.guardNote ? (
                  <p className={styles.deliveryHint} role="status">
                    <span aria-hidden="true">! </span>
                    {sendPhase.guardNote}
                  </p>
                ) : null}
                <div className={styles.deliveryActions}>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => void confirmSend()}
                    disabled={sendPhase.kind === 'sending'}
                  >
                    {sendPhase.kind === 'sending' ? 'Sending…' : 'Yes, send the text'}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={cancelSend}
                    disabled={sendPhase.kind === 'sending'}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                {!hasCallerPhone || sentDelivery ? (
                  <label className={styles.deliveryField}>
                    <span>{sentDelivery ? 'Send again to a different mobile number' : 'Mobile number'}</span>
                    <input
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      className={styles.deliveryInput}
                      value={toNumber}
                      onChange={(event) => setToNumber(event.target.value)}
                      placeholder="+1 555 000 0000"
                      disabled={sendBusy}
                    />
                  </label>
                ) : null}
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void previewText()}
                  disabled={sendBusy || demoMode}
                  aria-describedby="delivery-hint"
                >
                  {sendPhase.kind === 'previewing'
                    ? 'Preparing the text…'
                    : sentDelivery
                      ? 'Text the link again'
                      : 'Text me the link'}
                </button>
                <p id="delivery-hint" className={styles.deliveryHint}>
                  {demoMode
                    ? 'Demo mode: texting is off. Nothing is sent.'
                    : 'You will see the exact text first. Nothing is sent until you confirm.'}
                </p>
              </>
            )}

            {sendPhase.kind === 'result' ? (
              <p className={styles.deliveryLine} role="status">
                <span
                  className={`${styles.checkIcon} ${sendPhase.view.status === 'sent' ? styles.iconComplete : styles.iconMissing}`}
                  aria-hidden="true"
                >
                  {sendPhase.view.status === 'sent' ? '✓' : '!'}
                </span>
                {DELIVERY_STATUS_WORD[sendPhase.view.status]}
                {sendPhase.view.status === 'sent' ? ` to ${sendPhase.view.toMasked}` : ''}
                {sendPhase.view.status !== 'sent' && sendPhase.view.error
                  ? ` — ${sendPhase.view.error}`
                  : ''}
              </p>
            ) : null}
            {sendPhase.kind === 'error' ? (
              <p className={styles.deliveryLine} role="alert">
                <span className={`${styles.checkIcon} ${styles.iconMissing}`} aria-hidden="true">
                  !
                </span>
                {sendPhase.error}
              </p>
            ) : null}
          </section>

          <details className={styles.details}>
            <summary className={styles.detailsSummary}>Where this form came from</summary>
            <dl className={styles.detailsBody}>
              <div>
                <dt>Official form</dt>
                <dd>
                  <a
                    className={styles.sourceLink}
                    href={documentMeta.sourceUrl || program?.application_url || '#'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {program?.source_domain || 'official source'} — official application
                  </a>
                </dd>
              </div>
              {program && (
                <>
                  {program.policy_url ? (
                    <div>
                      <dt>Program policy</dt>
                      <dd>
                        <a className={styles.sourceLink} href={program.policy_url} target="_blank" rel="noreferrer">
                          {program.policy_url}
                        </a>
                      </dd>
                    </div>
                  ) : null}
                  {program.submission_instructions ? (
                    <div>
                      <dt>How to hand it in</dt>
                      <dd>{program.submission_instructions}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Retrieved</dt>
                    <dd>
                      <time dateTime={program.retrieved_at}>
                        {Number.isNaN(new Date(program.retrieved_at).getTime())
                          ? program.retrieved_at
                          : `${new Date(program.retrieved_at).toISOString().replace('T', ' ').slice(0, 19)} UTC`}
                      </time>
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt>Document version</dt>
                <dd>{documentMeta.versionHash}</dd>
              </div>
              {documentMeta.note && (
                <div>
                  <dt>Note</dt>
                  <dd>{documentMeta.note}</dd>
                </div>
              )}
            </dl>
          </details>

          <p className={styles.disclaimer}>
            {SAFE_COPY.completenessBasis} {notSubmitted} {eligibility}
          </p>
        </aside>
      </div>
    </>
  );
}
