'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import DocumentViewer, { type ViewerMode } from '../../components/viewer/DocumentViewer';
import type { GeneratedDocument } from '../api/document/_lib/types';
import {
  SAFE_COPY,
  type AccessibilityStatus,
  type CompletenessSummary,
  type Program,
  type Requirement,
} from '../../lib/contract';

import styles from './review.module.css';

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'] as const;

function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** Honest, non-committal wording for every accessibility state. */
function accessibilityLine(status: AccessibilityStatus): { icon: string; text: string; done: boolean } {
  switch (status) {
    case 'processed':
      return { icon: '✓', text: 'Accessibility processed by Nutrient', done: true };
    case 'processing':
      return { icon: '…', text: 'Accessibility processing is running', done: false };
    case 'pending':
      return { icon: '○', text: 'Accessibility processing has not run yet', done: false };
    case 'failed':
      return { icon: '!', text: 'Accessibility processing did not complete', done: false };
    case 'not_applicable':
    default:
      return { icon: '–', text: 'Accessibility processing does not apply', done: false };
  }
}

/** Approved sentence for each requirement we know about. */
function missingSentence(requirement: Requirement): string {
  if (requirement.key === 'proof_of_social_security_income') return SAFE_COPY.missingProofOfIncome;
  if (requirement.key === 'applicant_signature') return SAFE_COPY.missingSignature;
  return `${requirement.label} is still required before submission.`;
}

export interface ReviewClientProps {
  caseId: string;
  patientDisplayName: string;
  programName: string;
  program: Program | null;
  completeness: CompletenessSummary;
  completedRequirements: Requirement[];
  missingRequirements: Requirement[];
  documentUrl: string;
  initialDocument: GeneratedDocument;
}

export default function ReviewClient({
  caseId,
  patientDisplayName,
  programName,
  program,
  completeness,
  completedRequirements,
  missingRequirements,
  documentUrl,
  initialDocument,
}: ReviewClientProps) {
  const [documentMeta, setDocumentMeta] = useState<GeneratedDocument>(initialDocument);
  const [viewerMode, setViewerMode] = useState<ViewerMode>('loading');
  const [showHowToAdd, setShowHowToAdd] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [speaking, setSpeaking] = useState(false);

  const documentRef = useRef<HTMLDivElement | null>(null);
  const disclosureRef = useRef<HTMLDivElement | null>(null);

  const access = accessibilityLine(documentMeta.accessibilityStatus);

  /* The warm alert is about evidence AccessForm still needs from Jane. A
     signature is a different kind of gap — AccessForm never signs for anyone —
     so it stays visible in the checklist instead of diluting the alert. */
  const alertRequirements = missingRequirements.filter((r) => r.type !== 'signature');
  const selfServeRequirements = missingRequirements.filter((r) => r.type === 'signature');
  const alertItems = alertRequirements.length > 0 ? alertRequirements : missingRequirements;
  const checklistPending =
    alertRequirements.length > 0 ? selfServeRequirements : ([] as Requirement[]);

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
    access.done ? 'The document has been through Nutrient accessibility processing.' : '',
    missingRequirements.length > 0
      ? `${countWord(missingRequirements.length)} ${missingRequirements.length === 1 ? 'item is' : 'items are'} still needed. ${missingRequirements.map(missingSentence).join(' ')}`
      : '',
    SAFE_COPY.notSubmitted,
    SAFE_COPY.eligibilityDisclaimer,
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

  const circumference = 2 * Math.PI * 54;
  const dash = (Math.max(0, Math.min(100, completeness.percent)) / 100) * circumference;

  return (
    <>
      <p aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </p>

      <div className={styles.grid}>
        <section className={styles.documentCard} aria-labelledby="document-heading" ref={documentRef}>
          <h2 id="document-heading">Your filled application</h2>
          <p className={styles.documentMeta}>
            {documentMeta.fieldsFilled} answers written into the official {programName}.
          </p>
          <DocumentViewer
            documentUrl={documentUrl}
            title={`${programName} for ${patientDisplayName}, filled`}
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
              aria-label={`${completeness.percent} percent of the application is complete`}
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
              Review application
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
                    {requirement.type === 'attachment'
                      ? ' — your Social Security award letter or a recent benefit statement, attached to the application before it goes to the hospital.'
                      : ' — you add this yourself; AccessForm never signs on your behalf.'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className={styles.details}>
            <summary className={styles.detailsSummary}>Where this form came from</summary>
            <dl className={styles.detailsBody}>
              <div>
                <dt>Application PDF</dt>
                <dd>
                  <a
                    className={styles.sourceLink}
                    href={documentMeta.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {program?.source_domain ?? 'api.hdc.hcai.ca.gov'} — official application
                  </a>
                </dd>
              </div>
              {program && (
                <>
                  <div>
                    <dt>Hospital billing policy</dt>
                    <dd>
                      <a className={styles.sourceLink} href={program.policy_url} target="_blank" rel="noreferrer">
                        {program.policy_url}
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt>Retrieved</dt>
                    <dd>
                      <time dateTime={program.retrieved_at}>
                        {new Date(program.retrieved_at).toISOString().replace('T', ' ').slice(0, 19)} UTC
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
            {SAFE_COPY.completenessBasis} {SAFE_COPY.notSubmitted} {SAFE_COPY.eligibilityDisclaimer}
          </p>
        </aside>
      </div>
    </>
  );
}
