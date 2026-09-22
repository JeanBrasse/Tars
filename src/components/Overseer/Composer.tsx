'use client';

import { AttachmentTile, ComposerCard, notSentText } from '@/components/ui';
import type { ComposerNotice } from '@/components/ui';
import type { OverseerAttachment } from '@/types/electron';

/**
 * Hermes's composer: the room's card, with the model and the cadence in the
 * row instead of a recipient. Enter sends, Shift+Enter makes a new line, the
 * field grows to eight lines, and what is attached sits above the text.
 *
 * Frames: `Chat · A · Hermes` and `Chat · A · Composer · states`, in
 * `design/chat-redesign-a.pen`.
 */
export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  controls,
  busy = false,
  error,
  attachError,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  attaching = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  /** Hermes cannot be reached: send and + are off. The field stays open, so
   *  what you write waits for the connection rather than for you to retype it. */
  disabled: boolean;
  placeholder: string;
  /** What the next message runs on, beside the message: the model and the
   *  cadence. */
  controls?: React.ReactNode;
  /** Hermes is answering: what you send now waits for the answer. */
  busy?: boolean;
  /** Why the last send failed. The page puts the words and the files back. */
  error?: string | null;
  /** Files that were picked and did not upload, named. */
  attachError?: string | null;
  /** Files already on the gateway, waiting to be named by the next message. */
  attachments?: OverseerAttachment[];
  onAttach?: () => void;
  onRemoveAttachment?: (path: string) => void;
  attaching?: boolean;
}) {
  // Files on their own are a message: "look at this" with the file attached.
  const hasContent = value.trim().length > 0 || attachments.length > 0;

  // Only while there is something to hold: with an empty field the thread
  // already shows Hermes at work, and a second line saying so is noise.
  const notice: ComposerNotice | null = error
    ? { tone: 'error', emphasis: 'error', text: notSentText(error) }
    : attachError
      ? { tone: 'error', emphasis: 'error', text: `Not attached: ${attachError.trim().replace(/[.\s]+$/, '')}.` }
      : busy && hasContent
        ? { tone: 'running', text: 'Hermes is answering, so this message will wait and go as soon as the answer is in.' }
        : null;

  return (
    <ComposerCard
      value={value}
      onChange={onChange}
      onSubmit={onSend}
      placeholder={placeholder}
      canSubmit={!disabled && hasContent}
      submitLabel={busy ? 'Queue: it goes when Hermes has answered' : 'Send to Hermes'}
      notice={notice}
      attachments={attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {attachments.map(a => (
            <AttachmentTile
              key={a.path}
              name={a.name}
              meta={a.isImage ? 'image, on the gateway' : 'file, on the gateway'}
              isImage={a.isImage}
              // The gateway path is what Hermes was actually given: worth
              // reading, too long and machine-shaped for the tile.
              title={a.path}
              onRemove={onRemoveAttachment ? () => onRemoveAttachment(a.path) : undefined}
            />
          ))}
        </div>
      ) : null}
      controls={controls}
      onAttach={!disabled && !attaching ? onAttach : undefined}
      attachLabel={attaching ? 'Uploading' : 'Attach files'}
    />
  );
}
