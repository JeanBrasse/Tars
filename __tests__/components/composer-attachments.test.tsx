import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from '../../src/components/Overseer/Composer';
import type { OverseerAttachment } from '../../src/types/electron';

/**
 * The composer's attachment row.
 *
 * This is asserted here rather than left to the screenshot suite because the
 * attach control is about 1300 pixels on a 1.6M pixel page, which is under the
 * 0.002 diff ratio the visual baselines run at. A whole control can therefore
 * appear or vanish without a single surface failing, so the thing that proves
 * it renders has to be a test that looks at the markup.
 */

const files: OverseerAttachment[] = [
  { name: 'brief.pdf', path: '/root/.hermes/uploads/brief.pdf', isImage: false },
  { name: 'shot.png', path: '/root/.hermes/images/x_shot.png', isImage: true },
];

function render(props: Partial<Parameters<typeof Composer>[0]> = {}): string {
  return renderToStaticMarkup(
    <Composer
      value=""
      onChange={() => {}}
      onSend={() => {}}
      disabled={false}
      placeholder="Ask about any project."
      {...props}
    />,
  );
}

describe('Composer attachments', () => {
  it('offers the attach control when the page can handle it', () => {
    expect(render({ onAttach: () => {} })).toContain('attach');
  });

  it('leaves the control out entirely when the page cannot', () => {
    // Not merely disabled: a composer with nowhere to send a file should not
    // advertise that it takes them.
    expect(render()).not.toContain('attach');
  });

  it('says what it is doing while a file is going up', () => {
    const html = render({ onAttach: () => {}, attaching: true });
    expect(html).toContain('uploading');
    expect(html).toContain('disabled');
  });

  it('shows a chip per staged file, naming it', () => {
    const html = render({ onAttach: () => {}, attachments: files });
    expect(html).toContain('brief.pdf');
    expect(html).toContain('shot.png');
  });

  it('keeps the gateway path reachable without putting it in the chip', () => {
    const html = render({ onAttach: () => {}, attachments: files });
    // The path is what Hermes is actually given, so it has to be readable
    // somewhere; the chip itself stays the short name.
    expect(html).toContain('title="/root/.hermes/uploads/brief.pdf"');
    expect(html).toContain('>brief.pdf<');
  });

  it('offers to remove a staged file but only in the composer', () => {
    const staged = render({ onAttach: () => {}, attachments: files, onRemoveAttachment: () => {} });
    expect(staged).toContain('Remove brief.pdf');
    // Without the callback there is no remove button: a sent file cannot be
    // unsent, and the same component renders both cases.
    expect(render({ onAttach: () => {}, attachments: files })).not.toContain('Remove brief.pdf');
  });

  it('renders nothing extra when nothing is staged', () => {
    const html = render({ onAttach: () => {} });
    expect(html).not.toContain('Remove');
  });
});
