'use client';

import { Button, DialogShell, Label, Textarea } from '../ui';

interface StartPromptModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (prompt: string) => void;
  value: string;
  onChange: (value: string) => void;
  /** Named in the title, so the dialog says what it is about to start. */
  agentName?: string;
}

export function StartPromptModal({
  open,
  onClose,
  onSubmit,
  value,
  onChange,
  agentName = 'agent',
}: StartPromptModalProps) {
  const handleSubmit = () => {
    if (value.trim()) {
      onSubmit(value.trim());
      onChange('');
    }
    onClose();
  };

  // The dialog only mounts once `open` is true, so `autoFocus` puts the caret
  // in the task field without the timeout the old overlay needed. Escape is
  // DialogShell's - it listens on the window and this sits inside it.
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title={`Start ${agentName}`}
      subtitle="It is idle. Give it something to do."
      footerRight={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!value.trim()}>
            Start
          </Button>
        </>
      }
    >
      <Label>TASK</Label>
      <Textarea
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, as it did when this was a single line. Shift+Enter is
          // the newline now that there is room for one.
          if (e.key === 'Enter' && !e.shiftKey && value.trim()) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="e.g., Fix the bug in login.tsx..."
        autoFocus
      />
    </DialogShell>
  );
}
