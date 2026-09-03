import { Phone } from 'lucide-react';
import { SiteHeader } from '../components/SiteHeader';
import { WhatHappensCard } from '../components/WhatHappensCard';
import { StartConversationButton } from '../components/conversation/StartConversationButton';

/** The AccessForm phone number (Twilio, routed to the Vapi assistant). */
const ACCESSFORM_PHONE_E164 = '+19452772309';
const ACCESSFORM_PHONE_DISPLAY = '+1 (945) 277-2309';

/** One example per launch-catalog need: hospital bill, paratransit, disability accommodation. */
const EXAMPLE_UTTERANCES = [
  'I got a hospital bill I can’t pay.',
  'I can’t walk far and I need to get to my doctor.',
  'I’m a college student with ADHD and I need accommodations.',
] as const;

export default function StartPage() {
  return (
    <div className="af-page">
      <SiteHeader aside="Voice · Official forms" />

      <main className="af-container" id="main">
        <div className="af-hero">
          <div>
            <h1 className="af-hero__headline">
              Paperwork
              <br className="af-hero__break" /> shouldn&apos;t require sight.
            </h1>

            <p className="af-hero__lead">
              Tell AccessForm what is going on, in your own words. It finds the
              official program for your situation, turns its form into a
              conversation, fills the real document, and texts you what is
              still missing.
            </p>

            <div className="af-hero__actions">
              <a className="af-btn af-btn--primary" href={`tel:${ACCESSFORM_PHONE_E164}`}>
                <Phone
                  className="af-btn__icon"
                  size={24}
                  strokeWidth={2.5}
                  aria-hidden="true"
                />
                <span className="af-btn__stack">
                  <span>Call AccessForm</span>
                  <span className="af-btn__sub">{ACCESSFORM_PHONE_DISPLAY}</span>
                </span>
              </a>
              <StartConversationButton
                className="af-btn af-btn--secondary"
                label="Start in browser"
              />
            </div>

            <p className="af-hero__try" id="example-utterance-label">
              Try saying:
            </p>
            <ul className="af-hero__examples" aria-labelledby="example-utterance-label">
              {EXAMPLE_UTTERANCES.map((example) => (
                <li className="af-hero__quote" key={example}>
                  &ldquo;{example}&rdquo;
                </li>
              ))}
            </ul>
          </div>

          <WhatHappensCard />
        </div>
      </main>
    </div>
  );
}
