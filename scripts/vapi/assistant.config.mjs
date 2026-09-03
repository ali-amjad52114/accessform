/**
 * The AccessForm Vapi assistant — single source of truth for provisioning.
 *
 * Keep in sync with the app:
 *   - ASSISTANT_NAME  === ACCESSFORM_ASSISTANT_NAME in app/lib/voice/assistant.ts
 *   - FIRST_MESSAGE   === FIRST_MESSAGE in app/lib/voice/script.ts
 *   - FIELD_KEYS      === normalizedKey values in app/lib/voice/form-plan.ts
 * `provision-assistant.mjs` checks the last one against the TypeScript file
 * before it touches the Vapi account.
 */

import { serverBaseUrl } from './env.mjs';

export const ASSISTANT_NAME = 'AccessForm Financial Assistance Intake';

export const FIRST_MESSAGE =
  'This is AccessForm. I can help you prepare a hospital financial assistance application, by voice. Take your time — what is going on with your bill?';

/** The 26 answerable fields on the official Cedars-Sinai application. */
export const FIELD_KEYS = [
  'patient_name',
  'date_of_birth',
  'home_address',
  'city',
  'state',
  'zip_code',
  'home_phone_number',
  'preferred_contact_method',
  'marital_status',
  'household_size',
  'insurer',
  'policyholder',
  'applied_for_medicaid',
  'screened_for_medicaid',
  'eligible_for_coverage',
  'employment_status',
  'gross_monthly_income',
  'annual_household_income',
  'rent_or_mortgage',
  'utilities_and_telephone',
  'food',
  'medical_and_dental',
  'transportation_and_auto',
  'clothing_and_laundry',
  'total_monthly_expenses',
  'outstanding_medical_debt',
];

export const SYSTEM_PROMPT = `You are AccessForm, a voice assistant that helps one person prepare — never submit — the Cedars-Sinai Medical Center financial assistance application.

WHO YOU ARE TALKING TO
The caller may be blind or have low vision, may be older, and may be frightened by a bill they cannot pay. Speak calmly, warmly and plainly. Short sentences. No jargon, no acronyms you have not explained. Never rush them, and never talk over them.

HOW TO ASK
- Ask ONE question at a time, then stop and wait for the answer.
- Never read a PDF field label out loud. Ask the human version: "Do you live alone?" — not "Household size as reported on your taxes".
- Repeat each answer back in a few words so they can correct you.
- When you ask for something sensitive — income, benefits, debt, health coverage — say in one short sentence why the form asks for it. For income: "The hospital uses your income and household size to work out how much of the bill you may not have to pay."
- If they say "I don't know", "not now", or they hesitate: accept it immediately, tell them you will mark it as still needed, and move on. Never ask the same thing twice.
- If they sound upset or lost, stop asking questions and check they are all right first.
- Say money the way people say it: "two thousand and fifty dollars a month".
- If they ask you to slow down, repeat, or go back, do it without comment.

THE ORDER OF THE CONVERSATION — the eight steps shown on their screen
1. Program found — listen to the problem, get the hospital and the amount of the bill, then call create_case, then discover_program.
2. Current form — tell them you have the current official application, published by the state of California (HCAI). Do not name a form you have not discovered.
3. Personal information — full name, date of birth, home address, city, state, ZIP, phone number, how they prefer to be contacted.
4. Household — marital status, and whether anyone else lives with them.
5. Insurance — what coverage they have, whether they have applied for Medi-Cal, and whether anyone has screened them for it.
6. Income — working or retired, money coming in each month, the yearly total, then the monthly costs (rent, utilities, food, medical, transport, clothing) and the outstanding Cedars-Sinai bill.
7. Documents — ask whether they have proof of their income, such as a Social Security award letter or a bank statement. Accept "I don't have it" without any pressure.
8. Review — call validate_case, then finalize_document, then tell them exactly what is still missing.

USING YOUR TOOLS
- create_case as soon as you know the hospital and the bill amount. Remember the case_id it returns and pass it to every later tool call.
- discover_program before you describe the form.
- save_answer immediately after each answer — one call per answer, never batched. field_id must be one of the listed keys. value is what they told you, as plain text; write money without a dollar sign, for example 2,050.
- get_case_progress whenever you are unsure what to ask next; it returns the next question.
- validate_case before you start to wrap up; it returns what is still missing.
- finalize_document once the questions are done, to fill in the official PDF.
- If a tool fails, say plainly that it has not been saved yet and carry on. Never invent a case id, a web address, or a saved answer.

WHAT YOU MUST NEVER SAY
- Never say the application is approved, eligible, qualified, accepted, submitted, sent, filed, or signed. None of those things have happened.
- Never predict whether they will receive assistance, or how much. Cedars-Sinai decides that, not you.
- Never offer to sign anything for them. AccessForm cannot sign.
- If they ask "will I get it?", say honestly that you cannot know, that the hospital makes that decision, and that your job is to make sure their application is complete and correct.
- You may say: "This application appears complete based on the published requirements", and "it is ready for you to review".

HOW TO END THE CALL
Before you say goodbye, always state exactly what is still needed, in plain words:
1. proof of Social Security income — the award letter, or a bank statement showing the deposit;
2. their signature on the application.
Then say that nothing has been sent to Cedars-Sinai, that the filled-in application is ready for them to review on the review screen, and that the hospital decides approval. Thank them, and let them end the call.`;

/** JSON Schema for the six tools in specs/API_INTEGRATIONS.md section 4. */
export function buildTools(baseUrl = serverBaseUrl()) {
  const server = { url: `${baseUrl}/api/voice/tools` };

  return [
    {
      type: 'function',
      function: {
        name: 'create_case',
        description:
          'Open a case in the system of record. Call this once, as soon as you know which hospital the bill is from and how much it is for.',
        parameters: {
          type: 'object',
          properties: {
            patient_display_name: {
              type: 'string',
              description: 'The name the caller gives, e.g. "Jane Doe".',
            },
            hospital_name: {
              type: 'string',
              description: 'The hospital named by the caller, e.g. "Cedars-Sinai Medical Center".',
            },
            bill_amount: {
              type: 'number',
              description: 'The outstanding hospital bill in US dollars, e.g. 7800.',
            },
          },
          required: ['patient_display_name', 'hospital_name', 'bill_amount'],
        },
      },
      server,
      messages: [
        { type: 'request-start', content: 'Let me open a case for you.' },
        {
          type: 'request-failed',
          content: 'I could not open the case just then. I will keep going and we can try again.',
        },
      ],
    },
    {
      type: 'function',
      function: {
        name: 'discover_program',
        description:
          'Find the hospital financial assistance program and its current official application form from official sources. Call this before describing the form.',
        parameters: {
          type: 'object',
          properties: {
            case_id: { type: 'string', description: 'The case id returned by create_case.' },
            hospital: { type: 'string', description: 'e.g. "Cedars-Sinai Medical Center".' },
            intent: {
              type: 'string',
              enum: ['financial_assistance'],
              description: 'Always "financial_assistance" for this product.',
            },
            location: { type: 'string', description: 'e.g. "California".' },
          },
          required: ['hospital', 'intent'],
        },
      },
      server,
      messages: [
        {
          type: 'request-start',
          content: 'Let me find the current official form.',
        },
        {
          type: 'request-response-delayed',
          content: 'Still checking the official sources.',
          timingMilliseconds: 4000,
        },
      ],
    },
    {
      type: 'function',
      function: {
        name: 'save_answer',
        description:
          'Save one answer to the application. Call this immediately after each answer the caller gives — one call per answer, never batched.',
        parameters: {
          type: 'object',
          properties: {
            case_id: { type: 'string', description: 'The case id returned by create_case.' },
            field_id: {
              type: 'string',
              enum: FIELD_KEYS,
              description: 'Which question on the application this answer belongs to.',
            },
            value: {
              type: 'string',
              description:
                'The answer as plain text. Write money without a dollar sign, e.g. "2,050". Write dates as MM/DD/YYYY.',
            },
          },
          required: ['case_id', 'field_id', 'value'],
        },
      },
      server,
      messages: [
        {
          type: 'request-failed',
          content: 'That one has not saved yet. I will note it and we can come back to it.',
        },
      ],
    },
    {
      type: 'function',
      function: {
        name: 'get_case_progress',
        description:
          'Ask the system of record how complete the application is and what to ask next. Use this whenever you are unsure which question comes next.',
        parameters: {
          type: 'object',
          properties: {
            case_id: { type: 'string', description: 'The case id returned by create_case.' },
          },
          required: ['case_id'],
        },
      },
      server,
    },
    {
      type: 'function',
      function: {
        name: 'validate_case',
        description:
          'Check the application against the published requirements and return everything that is still missing. Call this before you begin to wrap up.',
        parameters: {
          type: 'object',
          properties: {
            case_id: { type: 'string', description: 'The case id returned by create_case.' },
          },
          required: ['case_id'],
        },
      },
      server,
      messages: [
        {
          type: 'request-start',
          content: 'Let me check what the application still needs.',
        },
      ],
    },
    {
      type: 'function',
      function: {
        name: 'finalize_document',
        description:
          'Fill the official PDF with the saved answers and run accessibility processing, so the caller can review it. Does NOT submit anything to the hospital.',
        parameters: {
          type: 'object',
          properties: {
            case_id: { type: 'string', description: 'The case id returned by create_case.' },
            source_url: {
              type: 'string',
              description: 'Optional. The official application URL returned by discover_program.',
            },
          },
          required: ['case_id'],
        },
      },
      server,
      messages: [
        {
          type: 'request-start',
          content: 'I am filling in the official form now.',
        },
        {
          type: 'request-response-delayed',
          content: 'Still working on the document.',
          timingMilliseconds: 5000,
        },
        {
          type: 'request-failed',
          content:
            'The document did not finish just then. Your answers are saved, and it can be produced again from the review screen.',
        },
      ],
    },
  ];
}

/** The complete create/update payload. */
export function buildAssistantPayload(baseUrl = serverBaseUrl()) {
  return {
    name: ASSISTANT_NAME,
    firstMessage: FIRST_MESSAGE,
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.3,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }],
      tools: buildTools(baseUrl),
    },
    voice: { provider: 'vapi', voiceId: 'Clara' },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
    server: { url: `${baseUrl}/api/voice/webhook` },
    serverMessages: ['tool-calls', 'status-update', 'end-of-call-report'],
    clientMessages: [
      'transcript',
      'tool-calls',
      'status-update',
      'speech-update',
      'conversation-update',
    ],
    // A caller who needs time to find a document must not be hung up on.
    silenceTimeoutSeconds: 60,
    maxDurationSeconds: 1800,
    endCallMessage:
      'Your application is ready for you to review. Nothing has been sent to Cedars-Sinai. Take care.',
  };
}
