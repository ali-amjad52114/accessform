import type { Metadata } from 'next';
import { ConversationClient } from '../../../components/conversation/ConversationClient';
import { conversationFontClass } from '../../../components/conversation/fonts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Conversation · AccessForm',
  description:
    'Your conversation with AccessForm: what it found, the form filling in as you answer, and what is still missing.',
};

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { caseId } = await params;
  const query = await searchParams;
  const autoStart = query.start === '1';

  return (
    <ConversationClient
      caseId={decodeURIComponent(caseId)}
      autoStart={autoStart}
      fontClass={conversationFontClass}
    />
  );
}
