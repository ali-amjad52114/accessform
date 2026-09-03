import { Phone } from 'lucide-react';
import { SiteHeader } from '../components/SiteHeader';
import { WhatHappensCard } from '../components/WhatHappensCard';
import { LiveCallWatcher } from '../components/conversation/LiveCallWatcher';
import { StartConversationButton } from '../components/conversation/StartConversationButton';

/** The AccessForm phone number (Twilio, routed to the Vapi assistant). */
const ACCESSFORM_PHONE_E164 = '+19452772309';
const ACCESSFORM_PHONE_DISPLAY = '+1 (945) 277-2309';

/** How callers actually open the conversation. */
const EXAMPLE_UTTERANCES = [
  'I got a bill from Cedars-Sinai for $7,800 and I can’t afford it.',
  'I’m on Social Security and the hospital sent me a bill I can’t pay.',
] as const;

/** The sponsor APIs behind the call, in pipeline order. */
const POWERED_BY = ['Vapi', 'SerpApi', 'Xano', 'Nutrient'] as const;

export default function StartPage() {
  return (
    <div className="af-page">
      <SiteHeader aside="Healthcare · Financial Assistance" />

      <main className="af-container" id="main">
        <div className="af-hero">
          <div>
            <h1 className="af-hero__headline">
              Healthcare access
              <br className="af-hero__break" /> for every ability.
            </h1>

            <p className="af-hero__lead">
              A voice-first AI agent for people with disabilities. No forms to
              read, no screens to navigate &mdash; just a phone call that walks
              you through your hospital&apos;s financial-assistance application
              and texts you the filled form with what is still missing.
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

            <LiveCallWatcher mode="start" />

            <p className="af-powered" aria-label="Powered by">
              <span className="af-powered__label">Powered by</span>
              {POWERED_BY.map((name) => (
                <span className="af-powered__chip" key={name}>{name}</span>
              ))}
            </p>

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
