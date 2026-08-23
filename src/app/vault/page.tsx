'use client';

import VaultView from '@/components/VaultView';
import { PageHeader } from '@/components/ui';

export default function VaultPage() {
  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] flex flex-col">
      <PageHeader
        title="Vault"
        subtitle="Agent reports and working documents. Long-term memory lives in Brain."
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        <VaultView embedded />
      </div>
    </div>
  );
}
