import React from 'react';
import { Cpu } from 'lucide-react';
import { PROVIDER_REGISTRY, type ProviderIconDef } from '@/lib/providers';

/** Render the correct icon for any provider icon definition */
export function ProviderIconRenderer({ icon, className = 'w-3.5 h-3.5' }: { icon: ProviderIconDef; className?: string }) {
  if (icon.type === 'image') {
    return <img src={icon.src} alt="" className={`${className} object-contain`} />;
  }
  if (icon.type === 'svg-gemini') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={`${className} !text-black`}>
        <path d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z" />
      </svg>
    );
  }
  if (icon.type === 'svg-grok') {
    // Official xAI Grok mark - black rounded square with the white glyph.
    return (
      <svg viewBox="0 0 512 509.641" fill="currentColor" className={className}>
        <path d="M115.612 0h280.776C459.975 0 512 52.026 512 115.612v278.416c0 63.587-52.025 115.613-115.612 115.613H115.612C52.026 509.641 0 457.615 0 394.028V115.612C0 52.026 52.026 0 115.612 0z" />
        <path fill="#fff" d="M213.235 306.019l178.976-180.002v.169l51.695-51.763c-.924 1.32-1.86 2.605-2.785 3.89-39.281 54.164-58.46 80.649-43.07 146.922l-.09-.101c10.61 45.11-.744 95.137-37.398 131.836-46.216 46.306-120.167 56.611-181.063 14.928l42.462-19.675c38.863 15.278 81.392 8.57 111.947-22.03 30.566-30.6 37.432-75.159 22.065-112.252-2.92-7.025-11.67-8.795-17.792-4.263l-124.947 92.341zm-25.786 22.437l-.033.034L68.094 435.217c7.565-10.429 16.957-20.294 26.327-30.149 26.428-27.803 52.653-55.359 36.654-94.302-21.422-52.112-8.952-113.177 30.724-152.898 41.243-41.254 101.98-51.661 152.706-30.758 11.23 4.172 21.016 10.114 28.638 15.639l-42.359 19.584c-39.44-16.563-84.629-5.299-112.207 22.313-37.298 37.308-44.84 102.003-1.128 143.81z" />
      </svg>
    );
  }
  if (icon.type === 'svg-openrouter') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M4 12h4l2-4 4 8 2-4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon.type === 'svg-deepseek') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-2.09c-1.67-.44-3-1.7-3.5-3.41h2.09c.43 1.08 1.46 1.8 2.66 1.8 1.58 0 2.87-1.29 2.87-2.87S13.83 7.06 12.25 7.06c-1.2 0-2.23.72-2.66 1.8H7.5c.5-1.71 1.83-2.97 3.5-3.41V3.5h2v1.95c2.47.49 4.25 2.68 4.25 5.3 0 2.61-1.78 4.81-4.25 5.3v2.45h-2z" />
      </svg>
    );
  }
  if (icon.type === 'svg-moonshot') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 2a9.94 9.94 0 0 0-6.38 2.31C8.07 3.47 11.18 4.64 13.5 7c2.37 2.37 3.53 5.49 2.69 7.93A9.94 9.94 0 0 0 22 12c0-5.52-4.48-10-10-10zM2 12c0 5.52 4.48 10 10 10a9.94 9.94 0 0 0 6.38-2.31c-2.45.84-5.56-.33-7.88-2.69C8.13 14.63 6.97 11.51 7.81 9.07A9.94 9.94 0 0 0 2 12z" />
      </svg>
    );
  }
  if (icon.type === 'svg-mimo') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M3 6h4v12H3V6zm7 0h4v12h-4V6zm7 0h4v12h-4V6z" opacity="0.8" />
        <path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H5z" />
      </svg>
    );
  }
  if (icon.type === 'svg-qwen') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon.type === 'svg-zai') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M4 6h16v2H7.5l10 8H4v-2h12.5l-10-8H4V6z" />
      </svg>
    );
  }
  if (icon.type === 'svg-minimax') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M3 12l4-8h2l-3 6h4l-3 6h-2l4-8H5l4-8H7L3 12zm10 0l4-8h2l-3 6h4l-3 6h-2l4-8h-4l4-8h-2l-4 8z" />
      </svg>
    );
  }
  if (icon.type === 'svg-nvidia') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M9 4v9.3a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4V4h-2v9.3a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V4H9zM3 4v16h2V4H3z" />
      </svg>
    );
  }
  if (icon.type === 'svg-nous') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
      </svg>
    );
  }
  if (icon.type === 'svg-ollama') {
    // Two overlapping circles: the local-server "linked to this machine"
    // mark, distinct from Tasmania's cpu glyph since Ollama isn't Tars-managed.
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
        <circle cx="9" cy="12" r="6" />
        <circle cx="15" cy="12" r="6" />
      </svg>
    );
  }
  if (icon.type === 'svg-venice') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M3 4h3.2l5.8 14 5.8-14H21l-8 16h-2L3 4z" />
      </svg>
    );
  }
  if (icon.type === 'cpu') {
    return <Cpu className={className} />;
  }
  if (icon.type === 'text') {
    return <span className={`font-bold text-[9px] leading-none`}>{icon.content}</span>;
  }
  return null;
}

/** Build a lookup from provider id -> registry entry */
const PROVIDER_MAP = new Map(PROVIDER_REGISTRY.map((p) => [p.id, p]));

interface ProviderBadgeProps {
  provider: string;
  className?: string;
}

export default function ProviderBadge({ provider, className = '' }: ProviderBadgeProps) {
  const def = PROVIDER_MAP.get(provider as import('@/types/electron').AgentProvider);
  if (!def) return null;

  return (
    <span
      title={def.label}
      className={`relative inline-flex items-center justify-center w-6 h-6 bg-secondary ${className}`}
    >
      <ProviderIconRenderer icon={def.icon} />
      <svg
        className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 text-success"
        viewBox="0 0 16 16"
        fill="none"
      >
        <circle cx="8" cy="8" r="8" fill="currentColor" />
        <path d="M4.5 8.5L7 11L11.5 5.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

// Re-export for backward compatibility
function GeminiLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={`${className} !text-black`}>
      <path d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z" />
    </svg>
  );
}

/**
 * Legacy PROVIDER_CONFIG for backward compatibility (used by TerminalDialog).
 * New code should use PROVIDER_REGISTRY from @/lib/providers instead.
 */
const PROVIDER_CONFIG: Record<string, {
  label: string;
  icon: string | React.FC<{ className?: string }>;
}> = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => {
    let icon: string | React.FC<{ className?: string }>;
    if (p.icon.type === 'image') {
      icon = p.icon.src;
    } else {
      // Wrap SVG icon types into a component
      icon = ({ className }: { className?: string }) => (
        <ProviderIconRenderer icon={p.icon} className={className} />
      );
    }
    return [p.id, { label: p.label, icon }];
  }),
);

export { PROVIDER_CONFIG, GeminiLogo };
