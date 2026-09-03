/**
 * The deterministic Jane script.
 *
 * This is what runs when `NEXT_PUBLIC_DEMO_MODE=true`, when there is no
 * microphone, or when the Vapi credentials are missing — the demo must never
 * depend on live telephony. Every spoken line, every tool call and every saved
 * answer below mirrors what the real assistant does, in the same order, with
 * the same field ids, so the two paths render identically on /live.
 *
 * The tool sequence is the M1 product spine (docs/M1_CONTRACT.md §4):
 * create_case → resolve_need → discover_program → (get_next_question →
 * save_answer)* → validate_case → finalize_document → send_summary.
 * Cedars-Sinai is the first catalog entry and the regression fixture, not a
 * product assumption: the opening line is need-agnostic.
 *
 * Values are never written here by hand: `save` beats pull from
 * `SCRIPTED_ANSWER_BY_FIELD_ID`, which is derived from `DEMO_ANSWERS`.
 */

import {
  DEMO_CASE_ID,
  DEMO_HOSPITAL,
  type M1VoiceToolName,
  type VoiceSpeaker,
  type VoiceState,
} from '../contract';

export type ScriptBeat =
  | { kind: 'say'; speaker: VoiceSpeaker; text: string }
  | { kind: 'save'; fieldId: string }
  | { kind: 'tool'; name: M1VoiceToolName; args: Record<string, unknown> }
  | { kind: 'state'; state: VoiceState };

const say = (speaker: VoiceSpeaker, text: string): ScriptBeat => ({ kind: 'say', speaker, text });
const agent = (text: string): ScriptBeat => say('agent', text);
const patient = (text: string): ScriptBeat => say('patient', text);
const save = (fieldId: string): ScriptBeat => ({ kind: 'save', fieldId });
const tool = (name: M1VoiceToolName, args: Record<string, unknown> = {}): ScriptBeat => ({
  kind: 'tool',
  name,
  args,
});

/** "Thinking" beat + tool call, the way the live assistant does it. */
const call = (name: M1VoiceToolName, args: Record<string, unknown> = {}): ScriptBeat[] => [
  { kind: 'state', state: 'thinking' },
  tool(name, args),
];

/** What Jane says first — the situation in her own words. */
export const SCRIPTED_SITUATION =
  'I received a Cedars-Sinai bill for $7,800 and I can’t afford it. I’m in Los Angeles.';

export const SCRIPTED_LOCATION = 'Los Angeles, CA';

/** The line the assistant opens with, on the phone and in the browser. Need-agnostic. */
export const FIRST_MESSAGE =
  'This is AccessForm. Tell me what is going on — a bill you cannot pay, a ride you need, help at school, a form someone sent you — and where you are. I will find the official program for it and help you fill in its form by voice. Take your time.';

export const SIMULATION_SCRIPT: readonly ScriptBeat[] = [
  { kind: 'state', state: 'speaking' },
  agent(FIRST_MESSAGE),

  { kind: 'state', state: 'listening' },
  patient(SCRIPTED_SITUATION),

  ...call('create_case', {
    situation_text: SCRIPTED_SITUATION,
    location: SCRIPTED_LOCATION,
  }),
  ...call('resolve_need', {
    case_id: DEMO_CASE_ID,
    situation_text: SCRIPTED_SITUATION,
  }),

  { kind: 'state', state: 'speaking' },
  agent(
    'I’m sorry you’re dealing with that. That sounds like hospital financial assistance — Cedars-Sinai has a program for it, and I can help you fill in their official application right now. Let me find the current form first.',
  ),

  ...call('discover_program', {
    case_id: DEMO_CASE_ID,
    category: 'hospital_financial_assistance',
    organization: DEMO_HOSPITAL.name,
    location: SCRIPTED_LOCATION,
  }),

  { kind: 'state', state: 'speaking' },
  agent(
    'I found it — the current application, published on the state’s HCAI site. I’ll ask you the questions it asks and fill it in as we go. If you’d rather not answer something, say “not now” and I’ll note it and move on.',
  ),

  ...call('get_next_question', { case_id: DEMO_CASE_ID }),
  { kind: 'state', state: 'speaking' },
  agent('Can I start with your full name, as it appears on the bill?'),

  { kind: 'state', state: 'listening' },
  patient('Jane Doe.'),
  save('Patient name'),

  { kind: 'state', state: 'speaking' },
  agent('Thank you, Jane. And your date of birth?'),
  { kind: 'state', state: 'listening' },
  patient('January fifteenth, nineteen fifty-eight.'),
  save('Date of birth'),

  { kind: 'state', state: 'speaking' },
  agent('What is your home address?'),
  { kind: 'state', state: 'listening' },
  patient('1234 Beverly Boulevard, apartment 5, Los Angeles, California, 90048.'),
  save('Home address'),
  save('City'),
  save('State'),
  save('ZIP code'),

  { kind: 'state', state: 'speaking' },
  agent('And a phone number where the hospital can reach you?'),
  { kind: 'state', state: 'listening' },
  patient('It’s (323) 555-0142. Calling is easiest — I don’t read letters well any more.'),
  save('Home phone number'),
  save('Preferred method of contact'),

  ...call('get_next_question', { case_id: DEMO_CASE_ID }),
  { kind: 'state', state: 'speaking' },
  agent(
    'Noted — I’ll put the phone down as how they should reach you. Now two household questions. Are you single, married, widowed, or divorced?',
  ),
  { kind: 'state', state: 'listening' },
  patient('Single.'),
  save('Marital status:'),

  { kind: 'state', state: 'speaking' },
  agent('And do you live alone, or is there anyone else in your household?'),
  { kind: 'state', state: 'listening' },
  patient('Just me.'),
  save('as reported on your taxes'),

  ...call('get_next_question', { case_id: DEMO_CASE_ID }),
  { kind: 'state', state: 'speaking' },
  agent('A household of one — that is exactly what the form asks for. Do you have health coverage right now?'),
  { kind: 'state', state: 'listening' },
  patient('I have Medicare.'),
  save('Insurer'),
  save('Policyholder'),
  save('Are you eligible for any health insurance coverage?'),

  { kind: 'state', state: 'speaking' },
  agent(
    'The form also asks about Medi-Cal. Have you applied for it, or has anyone at the hospital checked whether you qualify?',
  ),
  { kind: 'state', state: 'listening' },
  patient('No, neither of those.'),
  save('Have you applied for MediCalMedicaid'),
  save('Have you been screened for MediCalMedicaid eligibility'),

  ...call('get_next_question', { case_id: DEMO_CASE_ID }),
  { kind: 'state', state: 'speaking' },
  agent(
    'Next is the income section. I’ll say why they ask: the hospital uses your income and household size to work out how much of the bill you may not have to pay. It stays with your application.',
  ),
  agent('Are you working at the moment, or retired?'),
  { kind: 'state', state: 'listening' },
  patient('I retired six years ago.'),
  save('Employment status'),

  { kind: 'state', state: 'speaking' },
  agent('And about how much money comes in each month?'),
  { kind: 'state', state: 'listening' },
  patient('I receive about $2,050 each month from Social Security.'),
  save('Gross income'),

  { kind: 'state', state: 'speaking' },
  agent('Thanks. Is Social Security your only source of income?'),
  { kind: 'state', state: 'listening' },
  patient('Yes, that’s all of it.'),
  save('Annual household income:'),

  { kind: 'state', state: 'speaking' },
  agent(
    'That comes to $24,600 for the year, and I’ve saved it. Now what you spend in a typical month — rent or mortgage first?',
  ),
  { kind: 'state', state: 'listening' },
  patient('Rent is $950.'),
  save('Rent or mortgage'),

  { kind: 'state', state: 'speaking' },
  agent('Utilities and telephone?'),
  { kind: 'state', state: 'listening' },
  patient('About $180.'),
  save('Utilities and telephone'),

  { kind: 'state', state: 'speaking' },
  agent('Groceries and food?'),
  { kind: 'state', state: 'listening' },
  patient('Around $320.'),
  save('Food'),

  { kind: 'state', state: 'speaking' },
  agent('Medications, and any medical or dental costs?'),
  { kind: 'state', state: 'listening' },
  patient('About $230 a month.'),
  save('Medical and dental'),

  { kind: 'state', state: 'speaking' },
  agent('Getting around — rides, the bus, or a car?'),
  { kind: 'state', state: 'listening' },
  patient('A hundred and ten dollars, mostly rides.'),
  save('Transportation and auto (insurance, gas, repairs, lease)'),

  { kind: 'state', state: 'speaking' },
  agent('And clothing and laundry?'),
  { kind: 'state', state: 'listening' },
  patient('Sixty dollars, near enough.'),
  save('Clothing and laundry'),
  save('Total monthly expenses'),

  { kind: 'state', state: 'speaking' },
  agent(
    'That adds up to $1,850 a month. And the Cedars-Sinai bill you mentioned — is $7,800 the whole amount you still owe them?',
  ),
  { kind: 'state', state: 'listening' },
  patient('That’s the whole bill.'),
  save('Outstanding medical debt at Cedars-Sinai or Huntington Health'),

  ...call('get_next_question', { case_id: DEMO_CASE_ID }),
  { kind: 'state', state: 'speaking' },
  agent(
    'That was the last question on the form. One more thing it asks for: proof of your Social Security income — usually the award letter, or a bank statement showing the deposit. Do you have one you can add?',
  ),
  { kind: 'state', state: 'listening' },
  patient('Not right now. My niece would have to help me find it.'),

  { kind: 'state', state: 'speaking' },
  agent(
    'That is completely fine. I’ll mark it as still needed, so you know exactly what to add later. Nothing is being sent anywhere yet.',
  ),
  ...call('validate_case', { case_id: DEMO_CASE_ID }),

  { kind: 'state', state: 'speaking' },
  agent('Let me fill in the official form now.'),
  ...call('finalize_document', { case_id: DEMO_CASE_ID }),

  { kind: 'state', state: 'speaking' },
  agent(
    'Done. Your application is filled in and ready for you to review: 26 of 26 questions answered, on the current official form, and it has been processed so a screen reader can read it.',
  ),
  agent(
    'Two things are still needed before it can go to Cedars-Sinai: proof of your Social Security income, and your signature. I cannot sign for you, and I have not sent anything to the hospital — Cedars-Sinai decides, not me.',
  ),
  agent(
    'I can text you a link to the filled form, with the two things still needed and what to do next. Would you like that?',
  ),
  { kind: 'state', state: 'listening' },
  patient('Yes, please.'),
  ...call('send_summary', { case_id: DEMO_CASE_ID, channel: 'sms' }),

  { kind: 'state', state: 'speaking' },
  agent(
    'This is a demo run, so no text goes out — on a real call it would be on its way now. Everything is written down on your review screen. Take care, Jane.',
  ),
  { kind: 'state', state: 'ended' },
];

/**
 * Deterministic pacing: spoken beats take roughly reading time, tool and save
 * beats take a beat. No randomness — the demo runs the same way every time.
 */
export function beatDelayMs(beat: ScriptBeat): number {
  switch (beat.kind) {
    case 'say':
      return Math.max(800, Math.min(7000, beat.text.length * 28));
    case 'tool':
      return 1000;
    case 'save':
      return 300;
    case 'state':
      return 160;
  }
}

/** Total run time of the script at speed factor 1, in milliseconds. */
export function scriptDurationMs(): number {
  return SIMULATION_SCRIPT.reduce((total, beat) => total + beatDelayMs(beat), 0);
}
