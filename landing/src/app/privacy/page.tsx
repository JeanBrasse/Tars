import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

const title = 'Tars Privacy Policy';
const description = 'What the Tars desktop app and its website keep, and what leaves your machine, to whom.';

export const metadata: Metadata = { title, description, openGraph: { title, description, type: 'website' } };

export default function Privacy() {
  return <LegalPage doc="privacy" />;
}
