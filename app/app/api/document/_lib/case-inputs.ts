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

export interface CaseInputs {
  caseId: string;
  bundle: CaseBundle | null;
  answers: readonly Answer[];
  sourceUrl: string;
  /** True when the inputs came from the demo constants, not Xano. */
  demo: boolean;
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
  };
}
