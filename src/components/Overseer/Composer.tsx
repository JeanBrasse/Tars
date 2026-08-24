'use client';

import { useRef } from 'react';
import { Button } from '@/components/ui';

/**
 * The 80px composer pinned under the thread. Enter sends, Shift+Enter makes
 * a new line - the same convention as every other message box in the app.
 */
export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSend();
    }
  };

  return (
    <div className="h-20 shrink-0 border border-border bg-secondary flex flex-col px-3 py-2.5">
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        className="flex-1 min-h-0 w-full bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground outline-none resize-none disabled:opacity-60"
      />
      <div className="h-[26px] shrink-0 flex items-center justify-end">
        <Button
          size="sm"
          variant="primary"
          className="font-mono shrink-0"
          onClick={onSend}
          disabled={disabled || !value.trim()}
        >
          send
        </Button>
      </div>
    </div>
  );
}
