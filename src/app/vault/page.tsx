'use client';

import VaultView from '@/components/VaultView';

export default function VaultPage() {
  // VaultView draws the header, so "+ Document" sits beside the title rather
  // than on a row of its own underneath it.
  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex flex-col">
      <VaultView embedded subtitle="Agent reports and working documents. Long-term memory lives in Brain." />
    </div>
  );
}
