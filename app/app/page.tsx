import Link from 'next/link';
import { Mic, Phone } from 'lucide-react';
import { SiteHeader } from '../components/SiteHeader';
import { WhatHappensCard } from '../components/WhatHappensCard';

export default function StartPage() {
  return (
    <div className="af-page">
      <SiteHeader aside="Healthcare · Financial Assistance" />

      <main className="af-container" id="main">
        <div className="af-hero">
          <div>
            <h1 className="af-hero__headline">
              Hospital paperwork
              <br className="af-hero__break" /> shouldn&apos;t require sight.
            </h1>

            <p className="af-hero__lead">
              Tell us what you need. AccessForm finds the current official
              assistance application and turns the paperwork into a
              conversation.
            </p>

            <div className="af-hero__actions">
              <Link className="af-btn af-btn--primary" href="/live">
                <Phone
                  className="af-btn__icon"
                  size={24}
                  strokeWidth={2.5}
                  aria-hidden="true"
                />
                Call AccessForm
              </Link>
              <Link className="af-btn af-btn--secondary" href="/live">
                <Mic
                  className="af-btn__icon"
                  size={24}
                  strokeWidth={2.5}
                  aria-hidden="true"
                />
                Start in browser
              </Link>
            </div>

            <p className="af-hero__try" id="example-utterance-label">
              Try saying:
            </p>
            <blockquote
              className="af-hero__quote"
              aria-labelledby="example-utterance-label"
            >
              &ldquo;I received a hospital bill that I can&apos;t afford.&rdquo;
            </blockquote>
          </div>

          <WhatHappensCard />
        </div>
      </main>
    </div>
  );
}
