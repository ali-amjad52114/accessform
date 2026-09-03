import type { Metadata } from 'next';
import { LiveClient } from './LiveClient';

export const metadata: Metadata = {
  title: 'Live call · AccessForm',
  description:
    'The call in progress: application progress, the conversation, and the answers being saved.',
};

export default function LivePage() {
  return <LiveClient />;
}
