/**
 * Typography for the two-page frontend, loaded through next/font so nothing
 * is fetched from Google at runtime. Each face is exposed as a CSS variable
 * the conversation stylesheet (globals.css, `.af-cv` block) consumes:
 *
 *   --af-font-display  Bricolage Grotesque — headings, card titles
 *   --af-font-body     Source Sans 3       — everything else
 *   --af-font-mono     JetBrains Mono      — small uppercase labels, domains
 *
 * Import `conversationFontClass` and put it on the page root.
 */

import { Bricolage_Grotesque, JetBrains_Mono, Source_Sans_3 } from 'next/font/google';

export const displayFont = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--af-font-display',
  display: 'swap',
});

export const bodyFont = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '600'],
  style: ['normal', 'italic'],
  variable: '--af-font-body',
  display: 'swap',
});

export const monoFont = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--af-font-mono',
  display: 'swap',
});

/** All three variables, ready for a root element's className. */
export const conversationFontClass = [
  displayFont.variable,
  bodyFont.variable,
  monoFont.variable,
].join(' ');
