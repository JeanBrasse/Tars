import React, { useState, useEffect, useCallback } from 'react';
import { Cpu } from 'lucide-react';
import type { AgentPersonaValues } from './types';
import type { AgentProvider } from '@/types/electron';
import type { AgentEffort } from '@/types/agent';
import { PROVIDER_REGISTRY } from '@/lib/providers';
import { ProviderIconRenderer } from '@/components/ProviderBadge';
import { PanelCaption, Select, StatusSquare } from '@/components/ui';

interface TasmaniaModel {
  name: string;
  filename: string;
  path: string;
  sizeBytes: number;
  repo: string | null;
  quantization: string | null;
  parameters: string | null;
  architecture: string | null;
}

/** Model definition from provider */
interface ProviderModel {
  id: string;
  name: string;
  description: string;
}

/** Model definitions per provider - derived from shared registry */
const PROVIDER_MODELS: Record<string, ProviderModel[]> = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => [p.id, p.models]),
);

/** Default model per provider - derived from shared registry */
const PROVIDER_DEFAULT_MODEL: Record<string, string> = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => [p.id, p.defaultModel]),
);

/** The effort ladder, moved here from the Task step. */
const EFFORT_LEVELS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/* ── Live model catalogue ──────────────────────────────── */

/**
 * Model lists come from the models.dev catalogue in the main process, so a
 * model released today shows up without a release of Tars and without the
 * user having to hold an API key for that provider. The static registry stays
 * as the offline floor.
 */
async function fetchProviderModels(providerId: string): Promise<ProviderModel[] | null> {
  try {
    const res = await window.electronAPI?.models?.list(providerId);
    if (!res?.models?.length) return null;
    return res.models.map(m => ({
      id: m.id,
      name: m.name || m.id,
      description: [
        m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : '',
        m.cost?.input != null ? `$${m.cost.input}/M in` : '',
        m.releaseDate || '',
      ].filter(Boolean).join(' · '),
    }));
  } catch {
    return null;
  }
}

/** The closed value of the model select says everything: name, context, price. */
function modelLine(m: ProviderModel): string {
  return m.description ? `${m.name} · ${m.description}` : m.name;
}

/** CLI binary entry detected from settings */
interface DetectedCli {
  key: string;
  label: string;
  path: string;
}

interface StepModelProps {
  provider: AgentProvider;
  onProviderChange: (provider: AgentProvider) => void;
  model: string;
  onModelChange: (model: string) => void;
  localModel: string;
  onLocalModelChange: (model: string) => void;
  cliPath: string;
  onCliPathChange: (path: string) => void;
  tasmaniaEnabled: boolean;
  installedProviders?: Record<string, boolean>;
  /**
   * The effort ladder now lives on this step, beside the model it modifies.
   * Optional until the modal shell hands it down - the chips read `medium`
   * and stay inert rather than lying about a value nobody stores.
   */
  effort?: AgentEffort;
  onEffortChange?: (effort: AgentEffort) => void;
  /** @deprecated The persona editor is gone; the name is a field on the Task step. */
  agentPersonaRef?: React.MutableRefObject<AgentPersonaValues>;
  /** @deprecated Only the persona editor read this. */
  projectPath?: string;
}

const StepModel = React.memo(function StepModel({
  provider,
  onProviderChange,
  model,
  onModelChange,
  localModel,
  onLocalModelChange,
  cliPath,
  onCliPathChange,
  tasmaniaEnabled,
  installedProviders,
  effort = 'medium',
  onEffortChange,
}: StepModelProps) {
  // Dynamic models state
  const [dynamicModels, setDynamicModels] = useState<ProviderModel[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  // Detected CLIs for the path selector
  const [detectedClis, setDetectedClis] = useState<DetectedCli[]>([]);

  // Tasmania state for local provider
  const [tasmaniaStatus, setTasmaniaStatus] = useState<{
    status: string; modelName: string | null; endpoint: string | null;
  } | null>(null);
  const [tasmaniaModels, setTasmaniaModels] = useState<TasmaniaModel[]>([]);
  const [loadingTasmania, setLoadingTasmania] = useState(false);

  // Detect installed CLIs for the path selector
  useEffect(() => {
    window.electronAPI?.cliPaths?.detect().then((paths) => {
      if (!paths) return;
      const cliMap: { key: string; label: string }[] = [
        { key: 'claude', label: 'Claude' },
        { key: 'codex', label: 'Codex' },
        { key: 'gemini', label: 'Gemini' },
        { key: 'grok', label: 'Grok' },
        { key: 'opencode', label: 'OpenCode' },
        { key: 'pi', label: 'Pi' },
        { key: 'qwencode', label: 'Qwen Code' },
        { key: 'minimax', label: 'MiniMax' },
      ];
      const detected: DetectedCli[] = [];
      for (const { key, label } of cliMap) {
        const p = (paths as Record<string, string>)[key];
        if (p) detected.push({ key, label, path: p });
      }
      setDetectedClis(detected);
    });
  }, []);

  // The catalogue covers every provider, so this runs on each switch.
  const loadDynamicModels = useCallback(async () => {
    setLoadingModels(true);
    const models = await fetchProviderModels(provider);
    setDynamicModels(models);
    setLoadingModels(false);
  }, [provider]);

  useEffect(() => {
    loadDynamicModels();
  }, [loadDynamicModels]);

  // Resolved model list: dynamic if available, else hardcoded fallback
  const resolvedModels = dynamicModels || PROVIDER_MODELS[provider] || PROVIDER_MODELS.claude;

  // The catalogue used to be a button the user had to press. It refreshes on
  // every provider switch already, so all that is left to say is what it found.
  const catalogueNote = loadingModels
    ? 'catalogue · loading'
    : dynamicModels
      ? `catalogue · ${dynamicModels.length} models from models.dev`
      : `catalogue · offline, ${resolvedModels.length} built-in models`;

  // Fetch Tasmania status when switching to local provider
  useEffect(() => {
    if (provider !== 'local' || !tasmaniaEnabled) return;
    let cancelled = false;
    setLoadingTasmania(true);

    Promise.all([
      window.electronAPI?.tasmania?.getStatus(),
      window.electronAPI?.tasmania?.getModels(),
    ]).then(([status, modelsResult]) => {
      if (cancelled) return;
      if (status) setTasmaniaStatus(status);
      if (modelsResult?.models) {
        setTasmaniaModels(modelsResult.models);
        if (!localModel && status?.modelName) {
          onLocalModelChange(status.modelName);
        }
      }
    }).finally(() => {
      if (!cancelled) setLoadingTasmania(false);
    });

    return () => { cancelled = true; };
  }, [provider, tasmaniaEnabled]);

  return (
    <div className="space-y-5">
      {/* Provider Selector */}
      <div>
        <PanelCaption className="mb-2">PROVIDER</PanelCaption>
        <div className="grid gap-2 grid-cols-4">
          {PROVIDER_REGISTRY.filter((p) => p.id === provider || (p.id !== 'opencode' && p.id !== 'pi' && p.id !== 'local')).map(({ id, label, icon, requiresCli }) => {
            const installed = installedProviders?.[id] === true;
            const disabledReason = !installed
              ? requiresCli ? 'Not installed' : 'Add API key in Settings > AI Providers'
              : null;
            const selected = provider === id;
            return (
              <button
                key={id}
                disabled={!installed}
                onClick={() => {
                  if (!installed) return;
                  onProviderChange(id);
                  onModelChange(PROVIDER_DEFAULT_MODEL[id]);
                }}
                title={disabledReason || undefined}
                className={`
                  h-[52px] px-2.5 border transition-colors text-left flex flex-col justify-center gap-0.5
                  ${!installed
                    ? 'opacity-40 cursor-not-allowed border-border'
                    : selected
                      ? 'border-primary bg-secondary'
                      : 'border-border hover:bg-secondary'
                  }
                `}
              >
                <div className="flex items-center gap-1.5">
                  <ProviderIconRenderer icon={icon} className="w-4 h-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground truncate">{label}</span>
                </div>
                {/* One mono status line - no provider ever gets its own colour. */}
                <span className="font-mono text-[10px] text-muted-foreground truncate">
                  {installed ? (
                    <>
                      <span className="text-status-running">ready</span>
                      {` · ${requiresCli ? 'cli' : 'api'}`}
                    </>
                  ) : requiresCli ? 'not installed' : 'no api key'}
                </span>
              </button>
            );
          })}
          {tasmaniaEnabled && (
            <button
              onClick={() => onProviderChange('local')}
              className={`
                h-[52px] px-2.5 border transition-colors text-left flex flex-col justify-center gap-0.5
                ${provider === 'local'
                  ? 'border-primary bg-secondary'
                  : 'border-border hover:bg-secondary'
                }
              `}
            >
              <div className="flex items-center gap-1.5">
                <Cpu className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">Local</span>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground truncate">
                {tasmaniaStatus?.status === 'running'
                  ? <><span className="text-status-running">ready</span>{' · tasmania'}</>
                  : 'tasmania'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Model Selection - dynamic dropdown based on provider */}
      {provider !== 'local' ? (
        <div>
          <PanelCaption className="mb-2">MODEL</PanelCaption>
          <Select
            className="font-mono"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {resolvedModels.map((m) => (
              <option key={m.id} value={m.id}>
                {modelLine(m)}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div>
          <PanelCaption className="mb-2">LOCAL MODEL</PanelCaption>
          {loadingTasmania ? (
            <p className="font-mono text-[11px] text-muted-foreground">connecting to tasmania…</p>
          ) : tasmaniaStatus?.status !== 'running' ? (
            <div className="border border-border bg-bg-tertiary p-3 space-y-1">
              <div className="flex items-center gap-2">
                <StatusSquare tone="waiting" />
                <span className="text-xs font-medium text-foreground">Tasmania not running</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Start Tasmania and load a model first. Go to Settings &gt; Tasmania to configure.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {tasmaniaStatus.modelName && (
                <div className="flex items-center gap-2 h-8 px-2.5 bg-bg-tertiary">
                  <StatusSquare tone="running" />
                  <span className="font-mono text-[11px] text-foreground truncate">{tasmaniaStatus.modelName}</span>
                  <span className="font-mono text-[11px] text-muted-foreground ml-auto">loaded</span>
                </div>
              )}
              {tasmaniaModels.length > 0 && (
                <div>
                  <Select
                    className="font-mono"
                    value={localModel}
                    onChange={(e) => onLocalModelChange(e.target.value)}
                  >
                    {tasmaniaModels.map((m) => (
                      <option key={m.path} value={m.name}>
                        {m.name}{m.quantization ? ` · ${m.quantization}` : ''}{m.parameters ? ` · ${m.parameters}` : ''}
                      </option>
                    ))}
                  </Select>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Select the model to use. The currently loaded model will be used if available.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Effort - the ladder belongs beside the model it modifies */}
      <div>
        <PanelCaption className="mb-2">EFFORT</PanelCaption>
        <div className="flex gap-2">
          {EFFORT_LEVELS.map((level) => (
            <button
              key={level}
              onClick={() => onEffortChange?.(level)}
              className={`h-[26px] px-2.5 font-mono text-[11px] border transition-colors cursor-pointer
                ${effort === level
                  ? 'border-primary bg-secondary text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
                }`}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      {/* What the catalogue found - a readout, not a control */}
      <div className="h-8 px-2.5 flex items-center bg-bg-tertiary font-mono text-[11px] text-muted-foreground">
        {catalogueNote}
      </div>

      {/* CLI Path Override */}
      {detectedClis.length > 0 && (
        <div>
          <PanelCaption className="mb-2">CLI BINARY</PanelCaption>
          <Select
            className="font-mono"
            value={cliPath}
            onChange={(e) => onCliPathChange(e.target.value)}
          >
            <option value="">Default (provider default)</option>
            {detectedClis.map((cli) => (
              <option key={cli.key} value={cli.path}>
                {cli.label} · {cli.path}
              </option>
            ))}
          </Select>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Override which CLI binary runs this agent. Defaults to the selected provider&apos;s CLI.
          </p>
        </div>
      )}
    </div>
  );
});

export default StepModel;
