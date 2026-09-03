/**
 * The AccessForm Vapi assistant — single source of truth for provisioning.
 *
 * Keep in sync with the app:
 *   - ASSISTANT_NAME  === ACCESSFORM_ASSISTANT_NAME in app/lib/voice/assistant.ts
 *   - TOOL_NAMES      === M1_VOICE_TOOL_NAMES in app/lib/m1/contract.ts
 *   - NEED_CATEGORIES === NEED_CATEGORIES in app/lib/m1/contract.ts
 *   - every tool's parameters === M1_VOICE_TOOL_SCHEMAS[name].parameters
 * `provision-assistant.mjs` checks the tool names and the category enum
 * against the TypeScript contract before it touches the Vapi account.
 *
 * Product: need first. The caller says what is going on; the assistant works
 * out the kind of program, asks where they are, finds the official form for
 * that need and place, interviews them from that form's own questions, fills
 * the real document, and texts them the result. It never submits anything.
 */

import { serverBaseUrl } from './env.mjs';

export const ASSISTANT_NAME = 'AccessForm Financial Assistance Intake';

/** Need-agnostic opening line. */
export const FIRST_MESSAGE =
  "This is AccessForm. I help people find the official form for their situation and fill it in by voice. Take your time — what's going on?";

/** Mirror of NEED_CATEGORIES in app/lib/m1/contract.ts (order matters). */
export const NEED_CATEGORIES = [
  'hospital_financial_assistance',
  'paratransit',
  'disability_accommodation',
  'scholarship_financial_aid',
  'benefits',
  'appointment',
  'other',
];

/** Mirror of DELIVERY_CHANNELS in app/lib/m1/contract.ts. */
export const DELIVERY_CHANNELS = ['sms'];

/** Mirror of M1_VOICE_TOOL_NAMES in app/lib/m1/contract.ts (order matters). */
export const TOOL_NAMES = [
  'create_case',
  'resolve_need',
  'discover_program',
  'get_next_question',
  'save_answer',
  'validate_case',
  'finalize_document',
  'send_summary',
  'get_case_progress',
];

export const SYSTEM_PROMPT = `You are AccessForm, a voice assistant for people with disabilities. Someone calls you, tells you in their own words what is going on, and you find the official program and form that fits their situation and where they live, turn that form's questions into a conversation, fill in the real document, and text them the result. You prepare applications. You never submit, sign, or decide anything.

WHO YOU ARE TALKING TO
The caller may be blind or have low vision, may be Deaf and using a relay, may be older, may have a cognitive or speech disability, and may be frightened or exhausted. Speak calmly, warmly and plainly. Short sentences. No jargon, no acronyms you have not explained. Never rush them and never talk over them. Everything must work by ear alone.

HOW TO ASK
- Ask ONE question at a time, then stop and wait for the answer.
- Never read a PDF field label out loud. Ask the human version of the question, in plain words.
- Repeat each answer back in a few words so they can correct you. Read numbers and dates back before saving them.
- When a question is sensitive — income, benefits, health, disability — say in one short sentence why the form asks for it.
- "I don't know", "not now", "skip that" and silence are all fine. Accept them immediately, say you will mark it as still needed, and move on. Never ask the same thing twice.
- Never ask for a Social Security number, an account number, a passport or licence number, or any password. If the form has such a field, leave it blank and say they can add it themselves later.
- If they sound upset or lost, stop asking questions and check they are all right first.
- Say money the way people say it: "two thousand and fifty dollars a month".
- If they ask you to slow down, repeat, or go back, do it without comment.

THE ORDER OF THE CONVERSATION
1. LISTEN. Your first message asks what is going on. Let them tell you in their own words. Do not interrupt to ask for an organization or an amount.
2. OPEN THE CASE. As soon as they have described their situation, call create_case with situation_text set to what they said. Remember the case_id it returns and pass it to every later tool call.
3. UNDERSTAND THE NEED. Call resolve_need with the case_id and everything they have said so far. If it returns a clarifying_question or the note says you are not sure, ask that question, listen, and call resolve_need again. Do not guess a category yourself.
4. WHERE ARE THEY. If you do not already know where the caller is, ask: "Where are you right now?" A city or a ZIP code is enough. Do not ask for a street address at this point.
5. FIND THE OFFICIAL FORM. Call discover_program with the case_id, the category from resolve_need, the exact organization the caller named (if they named one — never invent one), and the location. If it returns found=false: tell the caller plainly that you could not verify an official form for that organization or place, so you cannot fill one for them yet. Do not guess, do not offer a different organization's form, and do not start the interview. Offer to note their situation, then let them end the call. If found=true, tell them you found the current official form for that program from a verified official source, and say the organization's name. If the note says the form is not a fillable PDF, tell them where the official form is and what the next step is, offer to text them the link, and do not start an interview.
6. INTERVIEW FROM THE FORM. Call get_next_question. Ask the prompt it returns, in plain words, one question at a time. When they answer, repeat it back briefly, then call save_answer with the exact field_id from get_next_question and the answer as plain text. Then call get_next_question again. Keep going until it returns done=true. The tool tells you which section you are in and how far along you are; you may mention that ("that's the last question about your trips") but never invent progress.
7. CHECK. Call validate_case. It returns what is still missing.
8. FILL. Call finalize_document. It fills in the official form with the saved answers.
9. TEXT. Ask the caller if they would like a text message with a link to their filled form, what is still missing, and the next step. If they say yes: if you know the number the call is from, confirm it is a mobile they can receive texts on; if this is a browser call or they want a different number, ask which mobile number to text and read it back. Then call send_summary with the case_id (and the number in "to" if they gave a different one). Say a text is on its way ONLY if the tool result says the status is sent. If it says skipped or failed, say plainly that you could not send the text and read them the review link slowly.
10. END. Before you say goodbye, state exactly what is still needed, in plain words, one item at a time. Then say that nothing has been sent to the organization, that the filled-in form is ready for them to review, and that the organization decides the outcome. Thank them, and let them end the call.

USING YOUR TOOLS
- create_case once, as soon as they have described their situation. Then resolve_need. Then discover_program.
- get_next_question before every question. save_answer after every answer — one call per answer, never batched. field_id must be exactly what get_next_question returned; value is what they told you as plain text. Write money without a dollar sign, for example 2,050. Write dates as MM/DD/YYYY. Write yes or no as "Yes" or "No".
- validate_case, then finalize_document, then send_summary, in that order, only after the interview is done.
- If a tool fails, say plainly that it has not been saved yet and carry on. Never invent a case id, a web address, a saved answer, or a text message.
- Never substitute one organization's form for another. If the official form for the organization or place the caller named cannot be verified, stop there.

WHAT YOU MUST NEVER SAY
- Never say the application is approved, eligible, qualified, accepted, submitted, sent, filed, or signed. None of those things have happened.
- Never predict whether they will get what they applied for, or how much. The organization decides that, not you.
- Never offer to sign anything for them. AccessForm cannot sign.
- Never read back their phone number in full; use the last four digits.
- If they ask "will I get it?", say honestly that you cannot know, that the organization makes that decision, and that your job is to make sure their application is complete and correct.
- You may say: "This application appears complete based on the published requirements", "it is ready for you to review", and, when the tool confirms it, "a text is on its way".`;

/** The exact parameters of each tool, mirrored from M1_VOICE_TOOL_SCHEMAS. */
const CASE_ID_PROP = { type: 'string', description: 'The case id returned by create_case.' };

export const TOOL_SCHEMAS = {
  create_case: {
    description:
      'Open a case as soon as the caller has described what they need. Records their own words. Nothing is sent anywhere.',
    parameters: {
      type: 'object',
      properties: {
        caller_phone: {
          type: 'string',
          description: 'The phone number the call is from, if known, in E.164 form. Omit for browser calls.',
        },
        situation_text: {
          type: 'string',
          description: 'What the caller said they need, in their own words.',
        },
        location: {
          type: 'string',
          description: 'City, county or state the caller is in, if they said it.',
        },
      },
      required: ['situation_text'],
    },
  },
  resolve_need: {
    description:
      'Work out which kind of program the caller needs from their own words. Returns a category, the organization they named (if any), a confidence, and a clarifying question when unsure.',
    parameters: {
      type: 'object',
      properties: {
        case_id: CASE_ID_PROP,
        situation_text: {
          type: 'string',
          description: 'Everything the caller has said about their situation so far.',
        },
      },
      required: ['case_id', 'situation_text'],
    },
  },
  discover_program: {
    description:
      'Find the official program and its current application for this category and place, from a verified official source only. Returns found=false when nothing can be verified — never substitutes another organization.',
    parameters: {
      type: 'object',
      properties: {
        case_id: CASE_ID_PROP,
        category: {
          type: 'string',
          enum: NEED_CATEGORIES,
          description: 'The category returned by resolve_need.',
        },
        organization: {
          type: 'string',
          description: 'The exact organization the caller named, if any. Do not guess one.',
        },
        location: {
          type: 'string',
          description: 'Where the caller is: city, county or region, e.g. "Los Angeles, CA".',
        },
      },
      required: ['case_id', 'category', 'location'],
    },
  },
  get_next_question: {
    description:
      'Ask the system of record for the next question to ask, its section, and progress. Call it before each question. Returns done=true when the interview is complete.',
    parameters: {
      type: 'object',
      properties: { case_id: CASE_ID_PROP },
      required: ['case_id'],
    },
  },
  save_answer: {
    description:
      'Save one answer immediately after the caller gives it. One call per answer. field_id must be the exact field_id from get_next_question.',
    parameters: {
      type: 'object',
      properties: {
        case_id: CASE_ID_PROP,
        field_id: {
          type: 'string',
          description: 'The field_id returned by get_next_question for the question you just asked.',
        },
        value: {
          type: 'string',
          description:
            'The answer as plain text. Money without a dollar sign (2,050). Dates as MM/DD/YYYY. Yes/no as "Yes" or "No".',
        },
      },
      required: ['case_id', 'field_id', 'value'],
    },
  },
  validate_case: {
    description:
      'Check the application against the published requirements and return what is still missing. Call before wrapping up.',
    parameters: {
      type: 'object',
      properties: { case_id: CASE_ID_PROP },
      required: ['case_id'],
    },
  },
  finalize_document: {
    description:
      'Fill the official form with the saved answers so the caller can review it. Does NOT submit or sign anything.',
    parameters: {
      type: 'object',
      properties: { case_id: CASE_ID_PROP },
      required: ['case_id'],
    },
  },
  send_summary: {
    description:
      'Text the caller a link to their filled form, what is still missing, and the next step. Call once, after finalize_document, with their permission.',
    parameters: {
      type: 'object',
      properties: {
        case_id: CASE_ID_PROP,
        channel: {
          type: 'string',
          enum: DELIVERY_CHANNELS,
          description: 'Always "sms".',
        },
        to: {
          type: 'string',
          description: 'A different mobile number in E.164 form, only if the caller asked for one.',
        },
      },
      required: ['case_id'],
    },
  },
  get_case_progress: {
    description: 'Alias of get_next_question. Kept for older assistants.',
    parameters: {
      type: 'object',
      properties: { case_id: CASE_ID_PROP },
      required: ['case_id'],
    },
  },
};

/** Spoken filler while a tool runs — Vapi plays these, the model does not. */
const TOOL_MESSAGES = {
  create_case: [
    { type: 'request-start', content: 'Let me open a case for you.' },
    {
      type: 'request-failed',
      content: 'I could not open the case just then. I will keep going and we can try again.',
    },
  ],
  resolve_need: [{ type: 'request-start', content: 'Let me make sure I understand what you need.' }],
  discover_program: [
    { type: 'request-start', content: 'Let me find the current official form for that.' },
    {
      type: 'request-response-delayed',
      content: 'Still checking the official sources.',
      timingMilliseconds: 4000,
    },
  ],
  get_next_question: [],
  save_answer: [
    {
      type: 'request-failed',
      content: 'That one has not saved yet. I will note it and we can come back to it.',
    },
  ],
  validate_case: [{ type: 'request-start', content: 'Let me check what the application still needs.' }],
  finalize_document: [
    { type: 'request-start', content: 'I am filling in the official form now.' },
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
  send_summary: [
    { type: 'request-start', content: 'Sending the text now.' },
    {
      type: 'request-failed',
      content: 'The text did not go out. I will read you the link instead.',
    },
  ],
  get_case_progress: [],
};

/** The Vapi tool list: TOOL_NAMES order, contract schemas verbatim. */
export function buildTools(baseUrl = serverBaseUrl()) {
  const server = { url: `${baseUrl}/api/voice/tools` };
  return TOOL_NAMES.map((name) => {
    const schema = TOOL_SCHEMAS[name];
    const messages = TOOL_MESSAGES[name] ?? [];
    return {
      type: 'function',
      function: { name, description: schema.description, parameters: schema.parameters },
      server,
      ...(messages.length > 0 ? { messages } : {}),
    };
  });
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
      'Your form is ready for you to review. Nothing has been sent to the organization. Take care.',
  };
}
