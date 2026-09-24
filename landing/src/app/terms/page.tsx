import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

const title = 'Tars Terms of Use';
const description = 'The terms of use of Tars, free and open-source desktop software published by Cooper Labs.';

export const metadata: Metadata = { title, description, openGraph: { title, description, type: 'website' } };

export default function Terms() {
  return <LegalPage doc="terms" />;
}
