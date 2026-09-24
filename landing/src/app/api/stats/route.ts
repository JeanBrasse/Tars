import { NextResponse } from 'next/server';
import { downloadCount } from '@/lib/downloads';

// GitHub's count of .dmg downloads, read and cached by the server, so no
// visitor's browser asks GitHub. `total` is null when GitHub did not answer;
// the page shows nothing then, as it does at 0.
export async function GET() {
  return NextResponse.json({ total: await downloadCount() });
}
