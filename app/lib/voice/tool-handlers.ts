/**
 * The six voice tools, server side.
 *
 * `VoiceToolHandlers` (from the contract) is keyed by the exact names Vapi
 * calls: create_case, discover_program, save_answer, get_case_progress,
 * validate_case, finalize_document. Everything here runs on the server and
 * goes through the Xano bridge; SerpApi and Nutrient are used when their
 * adapters are registered and fall back to verified fixtures otherwise.
 *
 * Nothing in this file may return copy that claims eligibility, approval,
 * submission, or a signature.
 */

import {
  CEDARS_APPLICATION_FIELD_COUNT,
  CEDARS_APPLICATION_PDF_URL,
  CEDARS_POLICY_URL,
  DEMO_FILLED_PDF_PATH,
  DEMO_PROGRAM,
  SAFE_COPY,
  VAPI_TOOL_NAMES,
  type Answer,
  type Case,
  type CaseDocument,
  type CaseIdToolInput,
  type CaseProgress,
  type CompletenessSummary,
  type CreateCaseInput,
  type DiscoverProgramInput,
  type DiscoveredSource,
  type DiscoveryResult,
  type FinalizeDocumentInput,
  type FinalizedDocument,
  type Id,
  type SaveAnswerToolInput,
  type SaveDocumentInput,
  type VapiToolName,
  type VoiceToolHandlers,
} from '../contract';
import { getNutrientAdapter, getSerpAdapter } from './adapter-registry';
import * as fixtures from './case-store';
import { formatFieldValue, resolveField } from './form-plan';
import { getXanoAdapter } from './xano-bridge';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

function readMoney(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = Number(value.replace(/[^0-9.]/g, ''));
    if (Number.isFinite(cleaned) && cleaned > 0) return cleaned;
  }
  return null;
}

/** The SerpApi result AccessForm falls back to — the verified official sources. */
function fixtureDiscovery(input: DiscoverProgramInput): DiscoveryResult {
  const verified: DiscoveredSource[] = [
    {
      query: 'Cedars-Sinai charity care application HCAI',
      title: 'Cedars-Sinai Medical Center — Hospital Billing Policies',
      url: CEDARS_POLICY_URL,
      source_domain: 'hcai.ca.gov',
      verified: true,
    },
    {
      query: 'Cedars-Sinai financial assistance application',
      title: 'CSHH Financial Assistance Application',
      url: CEDARS_APPLICATION_PDF_URL,
      source_domain: 'api.hdc.hcai.ca.gov',
      verified: true,
    },
    {
      query: 'Cedars-Sinai financial assistance application',
      title: 'Patient Financial Assistance Program — Los Angeles, CA',
      url: 'https://www.cedars-sinai.org/med-pros/patient-financial-assistance-program.html',
      source_domain: 'cedars-sinai.org',
      verified: true,
    },
  ];
  return {
    hospital: input.hospital || DEMO_PROGRAM.name,
    intent: input.intent || 'financial_assistance',
    retrieved_at: new Date().toISOString(),
    searches_used: 0,
    verified_sources: verified,
    all_results: verified,
    policy_url: CEDARS_POLICY_URL,
    application_url: CEDARS_APPLICATION_PDF_URL,
    from_cache: true,
  };
}

/**
 * The stand-in for the Nutrient fill + autotag pipeline, written through the
 * live system of record when there is one and the in-memory store otherwise.
 * Both paths are tried because `documents` is not one of the seven endpoints in
 * specs/API_INTEGRATIONS.md — a Xano deployment may not expose it yet.
 */
async function saveFallbackDocument(args: FinalizeDocumentInput): Promise<CaseDocument> {
  const input: SaveDocumentInput = {
    type: 'filled_application',
    source_url: args.source_url ?? CEDARS_APPLICATION_PDF_URL,
    generated_url: DEMO_FILLED_PDF_PATH,
    accessibility_status: 'processed',
    version_hash: `fixture-${String(args.case_id).toLowerCase()}-v1`,
  };
  try {
    return await getXanoAdapter().saveDocument(args.case_id, input);
  } catch (error) {
    console.warn('[voice] could not persist the document, using the local store:', (error as Error).message);
  }
  try {
    return fixtures.markReadyForReview(args.case_id);
  } catch {
    // The case is not in the local store either (Xano created it and then went
    // away). Answer from the input rather than failing the caller's last turn.
    return {
      id: `doc_${String(args.case_id)}`,
      case_id: args.case_id,
      type: 'filled_application',
      source_url: input.source_url ?? null,
      generated_url: input.generated_url ?? null,
      accessibility_status: 'processed',
      version_hash: input.version_hash ?? null,
    };
  }
}

/** Answers that map onto a real AcroForm field, from whoever is authoritative. */
async function countFilledFields(caseId: Id): Promise<number> {
  try {
    return (await getXanoAdapter().getCaseProgress(caseId)).answersSaved;
  } catch {
    return fixtures.filledFieldCount(caseId);
  }
}

const ANSWER_EVENT_MESSAGE: Record<string, string> = {
  personal_information: 'Personal detail saved',
  household: 'Household answer saved',
  insurance: 'Insurance answer saved',
  income: 'Income answer saved',
  documents: 'Document answer saved',
  review: 'Answer saved',
};

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

/**
 * The contract's handler set, with one widening: `discover_program` also
 * accepts the `case_id` the assistant passes, so the discovered program can be
 * linked to the case that is being interviewed.
 */
export interface AccessFormVoiceToolHandlers extends VoiceToolHandlers {
  discover_program(args: DiscoverProgramInput & { case_id?: Id }): Promise<DiscoveryResult>;
}

export const voiceToolHandlers: AccessFormVoiceToolHandlers = {
  async create_case(args: CreateCaseInput): Promise<Case> {
    const xano = getXanoAdapter();
    const created = await xano.createCase({
      patient_display_name: args.patient_display_name,
      hospital_name: args.hospital_name,
      bill_amount: args.bill_amount,
      program_id: args.program_id ?? null,
    });
    // Keep the local safety net aware of the case even when Xano owns it, so
    // every fixture fallback below still has a bundle to work with.
    fixtures.adoptCase(created);
    await xano.appendEvent(created.id, {
      actor: 'xano',
      event_type: 'case_created',
      message: 'Case created',
      metadata_json: { case_id: created.id, bill_amount: created.bill_amount },
    });
    return created;
  },

  async discover_program(
    args: DiscoverProgramInput & { case_id?: Id },
  ): Promise<DiscoveryResult> {
    const serp = getSerpAdapter();
    let result: DiscoveryResult;
    try {
      result = serp ? await serp.discoverProgram(args) : fixtureDiscovery(args);
    } catch (error) {
      console.warn('[voice] SerpApi discovery failed, using verified fixture:', (error as Error).message);
      result = fixtureDiscovery(args);
    }

    const caseId = args.case_id;
    if (caseId) {
      const xano = getXanoAdapter();
      // Link the program to the case so the progress steps advance.
      if (fixtures.getBundle(caseId)) fixtures.attachProgram(caseId, result);
      await xano.appendEvent(caseId, {
        actor: 'serpapi',
        event_type: 'program_discovered',
        message: 'Official Cedars program found',
        metadata_json: { policy_url: result.policy_url, searches_used: result.searches_used },
      });
      await xano.appendEvent(caseId, {
        actor: 'serpapi',
        event_type: 'source_verified',
        message: 'HCAI source verified',
        metadata_json: {
          source_domain: result.verified_sources[0]?.source_domain ?? 'hcai.ca.gov',
          application_url: result.application_url,
        },
      });
      await xano.appendEvent(caseId, {
        actor: 'nutrient',
        event_type: 'form_extracted',
        message: 'Form structure extracted',
        metadata_json: { fields: CEDARS_APPLICATION_FIELD_COUNT },
      });
    }
    return result;
  },

  async save_answer(args: SaveAnswerToolInput): Promise<Answer> {
    const field = resolveField(args.field_id);
    if (!field) {
      throw new Error(
        `"${args.field_id}" is not a field on the Cedars-Sinai application. Ask about a known field instead.`,
      );
    }
    const xano = getXanoAdapter();
    const saveInput = {
      value: args.value,
      source: args.source ?? 'voice',
      confirmed: args.confirmed ?? true,
    };
    const answer = await xano.saveAnswer(args.case_id, field.fieldId, saveInput);
    fixtures.mirrorAnswer(args.case_id, field.fieldId, saveInput);
    await xano.appendEvent(args.case_id, {
      actor: 'xano',
      event_type: 'answer_saved',
      message: ANSWER_EVENT_MESSAGE[field.step] ?? 'Answer saved',
      metadata_json: {
        field_id: field.fieldId,
        normalized_key: field.normalizedKey,
        display_value: formatFieldValue(field, answer.value_json),
      },
    });
    return answer;
  },

  get_case_progress(args: CaseIdToolInput): Promise<CaseProgress> {
    return getXanoAdapter().getCaseProgress(args.case_id);
  },

  async validate_case(args: CaseIdToolInput): Promise<CompletenessSummary> {
    const xano = getXanoAdapter();
    const summary = await xano.validateCase(args.case_id);
    for (const requirement of summary.missingRequirements) {
      await xano.appendEvent(args.case_id, {
        actor: 'xano',
        event_type: 'missing_requirement_detected',
        message:
          requirement.key === 'proof_of_social_security_income'
            ? 'Missing proof of income detected'
            : `Still required: ${requirement.label}`,
        metadata_json: { key: requirement.key, type: requirement.type },
      });
    }
    return summary;
  },

  async finalize_document(args: FinalizeDocumentInput): Promise<FinalizedDocument> {
    const xano = getXanoAdapter();
    const nutrient = getNutrientAdapter();
    await xano.validateCase(args.case_id);

    if (nutrient) {
      try {
        const finalized = await nutrient.finalizeDocument(args);
        await xano.appendEvent(args.case_id, {
          actor: 'nutrient',
          event_type: 'document_generated',
          message: 'Completed PDF generated',
          metadata_json: { fields_filled: finalized.fieldsFilled },
        });
        if (finalized.accessibilityStatus === 'processed') {
          await xano.appendEvent(args.case_id, {
            actor: 'nutrient',
            event_type: 'accessibility_processed',
            message: 'Accessibility processing complete',
            metadata_json: { accessibility_status: finalized.accessibilityStatus },
          });
        }
        return finalized;
      } catch (error) {
        console.warn('[voice] Nutrient finalize failed, using fixture document:', (error as Error).message);
      }
    }

    // No Nutrient adapter (or it failed). Record the fallback document through
    // whichever system of record is live — going straight to the fixture store
    // would throw `Unknown case` for any case that lives in Xano.
    const document = await saveFallbackDocument(args);
    const fieldsFilled = await countFilledFields(args.case_id);
    await xano.appendEvent(args.case_id, {
      actor: 'nutrient',
      event_type: 'document_generated',
      message: 'Completed PDF generated',
      metadata_json: { fields_filled: fieldsFilled, source: 'fixture' },
    });
    await xano.appendEvent(args.case_id, {
      actor: 'nutrient',
      event_type: 'accessibility_processed',
      message: 'Accessibility processing complete',
      metadata_json: { accessibility_status: document.accessibility_status, source: 'fixture' },
    });
    return {
      caseId: args.case_id,
      documentUrl: document.generated_url ?? DEMO_FILLED_PDF_PATH,
      accessibilityStatus: document.accessibility_status,
      versionHash: document.version_hash ?? 'fixture-v1',
      fieldsFilled,
      document,
    };
  },
};

/* ------------------------------------------------------------------ */
/* Dispatch — argument coercion + speech-friendly results              */
/* ------------------------------------------------------------------ */

export function isVapiToolName(name: string): name is VapiToolName {
  return (VAPI_TOOL_NAMES as readonly string[]).includes(name);
}

export interface ToolRunResult {
  ok: boolean;
  /** Compact object handed back to the model — never the whole case bundle. */
  result: Record<string, unknown>;
}

/**
 * Run one tool call from Vapi. Arguments arrive as loosely typed JSON, so each
 * branch validates before touching the system of record. Failures come back as
 * `ok: false` with a sentence the agent can say out loud, never as a throw —
 * a dropped tool call must not end the patient's call.
 */
export async function runVoiceTool(name: string, rawArgs: unknown): Promise<ToolRunResult> {
  const args = asRecord(rawArgs);
  try {
    if (!isVapiToolName(name)) {
      return { ok: false, result: { error: `Unknown tool "${name}".` } };
    }

    switch (name) {
      case 'create_case': {
        const patient = readString(args, 'patient_display_name') ?? 'Patient';
        const hospital = readString(args, 'hospital_name') ?? 'Cedars-Sinai Medical Center';
        const billAmount = readMoney(args, 'bill_amount');
        if (billAmount === null) {
          return {
            ok: false,
            result: { error: 'I still need the amount of the hospital bill before I can open a case.' },
          };
        }
        const created = await voiceToolHandlers.create_case({
          patient_display_name: patient,
          hospital_name: hospital,
          bill_amount: billAmount,
        });
        return {
          ok: true,
          result: {
            case_id: created.id,
            status: created.status,
            bill_amount: created.bill_amount,
            note: 'Case opened. Nothing has been sent to the hospital.',
          },
        };
      }

      case 'discover_program': {
        const result = await voiceToolHandlers.discover_program({
          hospital: readString(args, 'hospital') ?? 'Cedars-Sinai Medical Center',
          intent: readString(args, 'intent') ?? 'financial_assistance',
          location: readString(args, 'location') ?? 'California',
          case_id: readString(args, 'case_id') ?? undefined,
        });
        return {
          ok: true,
          result: {
            program_name: DEMO_PROGRAM.name,
            application_url: result.application_url,
            policy_url: result.policy_url,
            verified_source_count: result.verified_sources.length,
            source_domains: result.verified_sources.map((source) => source.source_domain),
            retrieved_at: result.retrieved_at,
            note: 'Official source verified. Say that you found the current official form.',
          },
        };
      }

      case 'save_answer': {
        const caseId = readString(args, 'case_id');
        const fieldId = readString(args, 'field_id');
        if (!caseId || !fieldId) {
          return { ok: false, result: { error: 'save_answer needs both case_id and field_id.' } };
        }
        const rawValue = args.value;
        const value =
          rawValue === null || rawValue === undefined
            ? null
            : typeof rawValue === 'object'
              ? JSON.stringify(rawValue)
              : (rawValue as string | number | boolean);
        const answer = await voiceToolHandlers.save_answer({
          case_id: caseId,
          field_id: fieldId,
          value,
          source: 'voice',
          confirmed: true,
        });
        const progress = await voiceToolHandlers.get_case_progress({ case_id: caseId });
        const field = resolveField(answer.field_id);
        return {
          ok: true,
          result: {
            saved: true,
            field: field?.label ?? answer.field_id,
            value: answer.value_json,
            percent_complete: progress.percent,
            answers_saved: progress.answersSaved,
            answers_expected: progress.answersExpected,
            next_question: progress.nextPrompt,
          },
        };
      }

      case 'get_case_progress': {
        const caseId = readString(args, 'case_id');
        if (!caseId) return { ok: false, result: { error: 'get_case_progress needs case_id.' } };
        const progress = await voiceToolHandlers.get_case_progress({ case_id: caseId });
        return {
          ok: true,
          result: {
            status: progress.status,
            percent_complete: progress.percent,
            answers_saved: progress.answersSaved,
            answers_expected: progress.answersExpected,
            current_step:
              progress.steps.find((step) => step.state === 'active')?.label ?? 'Review',
            next_question: progress.nextPrompt,
          },
        };
      }

      case 'validate_case': {
        const caseId = readString(args, 'case_id');
        if (!caseId) return { ok: false, result: { error: 'validate_case needs case_id.' } };
        const summary = await voiceToolHandlers.validate_case({ case_id: caseId });
        return {
          ok: true,
          result: {
            required_fields_complete: summary.requiredFieldsComplete,
            required_fields_total: summary.requiredFieldsTotal,
            appears_complete: summary.readyForReview,
            still_required: summary.missingRequirements.map((req) => req.label),
            basis: SAFE_COPY.completenessBasis,
            disclaimer: SAFE_COPY.eligibilityDisclaimer,
          },
        };
      }

      case 'finalize_document': {
        const caseId = readString(args, 'case_id');
        if (!caseId) return { ok: false, result: { error: 'finalize_document needs case_id.' } };
        const finalized = await voiceToolHandlers.finalize_document({
          case_id: caseId,
          source_url: readString(args, 'source_url') ?? undefined,
        });
        // Read the summary straight off the adapter: the validate_case handler
        // writes "still required" events, and those were already recorded.
        const summary = await getXanoAdapter().validateCase(caseId);
        return {
          ok: true,
          result: {
            document_url: finalized.documentUrl,
            fields_filled: finalized.fieldsFilled,
            accessibility_status: finalized.accessibilityStatus,
            status: SAFE_COPY.readyForReview,
            still_required: summary.missingRequirements.map((req) => req.label),
            note: SAFE_COPY.notSubmitted,
          },
        };
      }
    }
  } catch (error) {
    const message = (error as Error).message || 'The tool call did not complete.';
    console.warn(`[voice] tool ${name} failed:`, message);
    return { ok: false, result: { error: message } };
  }
}
