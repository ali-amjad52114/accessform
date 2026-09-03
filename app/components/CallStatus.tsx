'use client';

import { useEffect, useRef, useState } from 'react';
import type { VoiceState } from '../lib/contract';

const LABEL: Readonly<Record<VoiceState, string>> = {
  listening: 'Call in progress',
  thinking: 'Call in progress',
  speaking: 'Call in progress',
  paused: 'Call paused',
  ended: 'Call ended',
};

function mmss(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Header status for /live. The clock is aria-hidden so a screen reader is not
 * interrupted every second; the state word itself is plain text and the voice
 * indicator announces changes.
 */
export function CallStatus({ state }: { state: VoiceState }) {
  const [seconds, setSeconds] = useState(0);
  const running = state !== 'ended' && state !== 'paused';
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    const id = window.setInterval(() => {
      if (runningRef.current) setSeconds((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const modifier =
    state === 'ended' ? 'ended' : state === 'paused' ? 'paused' : 'live';

  return (
    <p className={`af-callstatus af-callstatus--${modifier}`}>
      <span className="af-callstatus__dot" aria-hidden="true" />
      {LABEL[state]}
      <span className="af-callstatus__timer" aria-hidden="true">
        {mmss(seconds)}
      </span>
    </p>
  );
}
