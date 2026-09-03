/**
 * The scripted Jane conversation.
 *
 * Every agent line here obeys the voice policy: one question at a time, never
 * the raw PDF label read aloud, an explanation when the question is sensitive,
 * "I don't know" always allowed, and no claim of approval or eligibility. The
 * closing lines state exactly what is still outstanding.
 *
 * `SPOKEN_ANSWERS` maps each AcroForm field to what Jane actually says, while
 * the value written to Xano stays the clean form value in `DEMO_ANSWERS`.
 */

import { DEMO_ANSWERS, type AnswerValue } from '../contract';

/** What Jane says out loud, keyed by exact AcroForm field name. */
export const SPOKEN_ANSWERS: Readonly<Record<string, string>> = {
  'Patient name': 'It’s Jane Doe. D-O-E.',
  'Date of birth': 'January fifteenth, nineteen fifty-eight.',
  'Home address': 'Twelve thirty-four Beverly Boulevard, apartment five.',
  City: 'Los Angeles.',
  State: 'California.',
  'ZIP code': 'Nine oh oh four eight.',
  'Home phone number': 'Three two three, five five five, oh one four two.',
  'Preferred method of contact':
    'The home phone, please. I don’t really read email anymore.',
  'Marital status:': 'Single. My husband passed a long time ago — I live on my own now.',
  'as reported on your taxes': 'Just me. One.',
  'Employment status': 'I’m retired. I stopped working about six years ago.',
  Insurer: 'I have Medicare.',
  Policyholder: 'It’s in my own name.',
  'Have you applied for MediCalMedicaid': 'No, I haven’t.',
  'Have you been screened for MediCalMedicaid eligibility':
    'No, nobody’s ever asked me about that.',
  'Are you eligible for any health insurance coverage?':
    'Yes, I suppose so — I do have the Medicare.',
  'Annual household income:':
    'That sounds about right. It’s the same every month.',
  'Gross income':
    'Yes, that’s all of it. Two thousand and fifty dollars from Social Security.',
  'Rent or mortgage': 'Rent is nine hundred and fifty.',
  'Utilities and telephone': 'Around a hundred and eighty for the lights and the phone.',
  Food: 'Maybe three hundred and twenty on groceries.',
  'Medical and dental': 'Two hundred and thirty, mostly prescriptions.',
  'Transportation and auto (insurance, gas, repairs, lease)':
    'I don’t drive anymore. About a hundred and ten for rides and the bus.',
  'Clothing and laundry': 'Sixty dollars or so.',
  'Total monthly expenses': 'Yes, that sounds about right.',
  'Outstanding medical debt at Cedars-Sinai or Huntington Health':
    'Seven thousand eight hundred dollars. That’s the one I can’t pay.',
};

/** Extra agent lines said between sections, keyed by the field they precede. */
export const SECTION_INTROS: Readonly<Record<string, string>> = {
  'Marital status:':
    'That’s the contact details done. Next the form asks about your household. There are only three questions here.',
  Insurer:
    'Now a few about insurance. If you’re not sure about any of these, "I don’t know" is a fine answer — we can leave it blank.',
  'Annual household income:':
    'This next part is about money coming in. Cedars-Sinai needs it to work out how much of the bill they can reduce — it isn’t a credit check.',
  'Rent or mortgage':
    'Last section. The form asks what you spend each month. Rough numbers are fine.',
};

export interface ScriptedTurn {
  speaker: 'agent' | 'patient';
  text: string;
}

/** Opening exchange, before the case exists. */
export const OPENING: ScriptedTurn[] = [
  {
    speaker: 'agent',
    text:
      'Hello, this is AccessForm. I can help you prepare a financial assistance application for your hospital bill. Which hospital is the bill from?',
  },
  { speaker: 'patient', text: 'Cedars-Sinai. Here in Los Angeles.' },
  { speaker: 'agent', text: 'And roughly how much is the bill?' },
  {
    speaker: 'patient',
    text: 'Seven thousand eight hundred dollars. I can’t pay that on Social Security.',
  },
  {
    speaker: 'agent',
    text:
      'Thank you. I’m going to find the official Cedars-Sinai application now. One moment.',
  },
];

/** Said after discovery + extraction succeed. */
export const AFTER_DISCOVERY: ScriptedTurn[] = [
  {
    speaker: 'agent',
    text:
      'I found the Cedars-Sinai financial assistance application on the state HCAI site, and I have the form open. I’ll read you one question at a time and fill it in as we go. If you’d rather not answer something, just say so.',
  },
  { speaker: 'patient', text: 'All right. That’s easier than the paper one.' },
];

/** The documents section — this is where the missing evidence surfaces. */
export const DOCUMENTS_SECTION: ScriptedTurn[] = [
  {
    speaker: 'agent',
    text:
      'That’s all the questions. The last thing the form asks for is proof of your Social Security income — usually the annual benefit letter. Do you have that to hand?',
  },
  {
    speaker: 'patient',
    text: 'No, I don’t know where that letter is. I’m not sure I ever kept it.',
  },
  {
    speaker: 'agent',
    text:
      'That’s all right — we don’t need it today. I’ll mark it as still needed so it’s clear what to attach later. You can request a new benefit letter from Social Security, and it’s free.',
  },
  { speaker: 'patient', text: 'Thank you. That’s good to know.' },
  {
    speaker: 'agent',
    text: 'Let me check the whole application over now.',
  },
];

/** Closing lines. States exactly what remains — no approval language. */
export const CLOSING: ScriptedTurn[] = [
  {
    speaker: 'agent',
    text:
      'Your application is filled in and ready for you to review. Based on the requirements Cedars-Sinai publishes, it looks complete.',
  },
  {
    speaker: 'agent',
    text:
      'Two things are still outstanding. First, proof of your Social Security income needs to be attached. Second, the form needs your signature — I can’t sign it for you.',
  },
  {
    speaker: 'patient',
    text: 'So it’s not sent yet?',
  },
  {
    speaker: 'agent',
    text:
      'Not yet. Nothing has been sent to Cedars-Sinai, and I can’t tell you whether you qualify — the hospital decides that. Everything is on the review page, and the document has been made screen-reader friendly so you can go through it yourself.',
  },
  { speaker: 'patient', text: 'All right. Thank you.' },
  {
    speaker: 'agent',
    text:
      'You’re welcome, Jane. The review page is open whenever you’re ready. Take care.',
  },
];

/** Answer values keyed by field id, taken straight from the demo fixture. */
export const ANSWER_VALUES: Readonly<Record<string, AnswerValue>> =
  Object.fromEntries(DEMO_ANSWERS.map((answer) => [answer.field_id, answer.value_json]));

/**
 * Rough speaking time for a line, so the transcript unrolls at a human pace
 * instead of dumping instantly. ~14 characters per second, clamped.
 */
export function speakingTimeMs(text: string): number {
  return Math.max(700, Math.min(6_000, Math.round(text.length * 70)));
}
