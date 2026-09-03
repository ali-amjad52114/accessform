/**
 * Live inputs for the document pipeline: the saved answers and the official
 * source URL for one case, read from Xano. The demo constants are used only
 * in demo mode, or when the caller explicitly asks for the demo case.
 */

import {
  CEDARS_APPLICATION_PDF_URL,
  DEMO_ANSWERS,
  DEMO_CASE_BUNDLE,
  DEMO_CASE_ID,
  type Answer,
  type CaseBundle,
} from '../../../../lib/contract';
import { getXanoAdapter, isDemoMode } from '../../../../lib/adapters';
import { INSTANT_JSON_FIELD_TYPE, INSTANT_JSON_FORMAT, type InstantJson } from '../../../../lib/contract';
import { mapAnswers } from '../../../../lib/forms/map-answers';
import { understandForm } from '../../../../lib/forms/understand-form';

export interface CaseInputs {
  caseId: string;
  bundle: CaseBundle | null;
  answers: readonly Answer[];
  sourceUrl: string;
  /** True when the inputs came from the demo constants, not Xano. */
  demo: boolean;
  /** Schema-mapped values (comb boxes expanded); undefined when no schema is known. */
  instantJson?: InstantJson;
}

/**
 * Same mapping the finalize_document voice tool uses, so the PDF a link serves
 * is byte-for-byte the one the caller was told about: full schema (with comb
 * boxes) -> constrained mapper -> Instant JSON.
 */
async function mappedInstantJson(bundle: CaseBundle): Promise<InstantJson | undefined> {
  const program = bundle.program;
  if (!program?.application_url || bundle.answers.length === 0) return undefined;
  try {
    const schema = await understandForm({ program_id: String(program.id), pdf_url: program.application_url });
    if (schema.length === 0) return undefined;
    const mapped = await mapAnswers({ schema, answers: bundle.answers });
    const allowed = new Set(schema.map((field) => field.pdf_field_name ?? field.field_id));
    const values = mapped.values.filter((value) => allowed.has(value.pdf_field_name) && value.value !== '');
    if (values.length === 0) return undefined;
    return {
      formFieldValues: values.map((value) => ({
        name: value.pdf_field_name,
        type: INSTANT_JSON_FIELD_TYPE,
        v: 1,
        value: value.value,
      })),
      format: INSTANT_JSON_FORMAT,
    };
  } catch (error) {
    console.warn('[document] schema mapping unavailable, filling by field id:', (error as Error).message);
    return undefined;
  }
}

export async function loadCaseInputs(caseId: string): Promise<CaseInputs> {
  if (isDemoMode() || caseId === DEMO_CASE_ID) {
    return {
      caseId: DEMO_CASE_ID,
      bundle: DEMO_CASE_BUNDLE,
      answers: DEMO_ANSWERS,
      sourceUrl: DEMO_CASE_BUNDLE.program?.application_url ?? CEDARS_APPLICATION_PDF_URL,
      demo: true,
    };
  }

  const bundle = await getXanoAdapter().getCase(caseId);
  return {
    caseId,
    bundle,
    answers: bundle.answers,
    sourceUrl: bundle.program?.application_url || CEDARS_APPLICATION_PDF_URL,
    demo: false,
    instantJson: await mappedInstantJson(bundle),
  };
}
