'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Button, Input, MetaChip, PanelCaption, PasswordInput, Select, StatusBadge } from '@/components/ui';
import { isValidOpenAIBaseUrl } from '@/lib/validateUrl';
import type { AnyTone } from '@/components/ui';
import { Toggle } from './Toggle';
import { SettingsRow } from './SettingsRow';
import type { AppSettings } from './types';

interface AIProvidersSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
}

/**
 * The CLIs Tars can drive. Claude Code is first because its own options - key,
 * default model, verbose, Chrome sharing, status line - are that row's
 * expansion; they are Claude's flags, not the app's settings.
 */
const CLI_BINARIES = [
  { name: 'Claude Code', binary: 'claude' },
  { name: 'Codex', binary: 'codex' },
  { name: 'Gemini', binary: 'gemini' },
  { name: 'Qwen Code', binary: 'qwen-code' },
  { name: 'OpenCode', binary: 'opencode' },
  { name: 'Pi', binary: 'pi' },
  { name: 'MiniMax', binary: 'minimax' },
];

interface CLIProviderStatus {
  name: string;
  binary: string;
  version: string | null;
  loading: boolean;
}

/** 12px mark: lit when the provider can actually run, flat when it cannot. */
const Mark = ({ on }: { on: boolean }) => (
  <span className={`w-3 h-3 shrink-0 ${on ? 'bg-primary' : 'bg-border-accent'}`} />
);

/**
 * The label half of a provider row: mark, name, and the status word beside it -
 * `ready`, `not installed`, `key set`, `no key`. The word carries the status
 * colour and nothing else: no fill, no pill.
 */
const ProviderLabel = ({ name, status, tone, on }: {
  name: string;
  status: string;
  tone: AnyTone;
  on: boolean;
}) => (
  <span className="inline-flex items-center gap-2 min-w-0">
    <Mark on={on} />
    <span className="truncate">{name}</span>
    <StatusBadge tone={tone} className="font-mono shrink-0">{status}</StatusBadge>
  </span>
);

/** Everything a row hides behind `configure`, on its own raised surface. */
const ConfigureArea = ({ children }: { children: ReactNode }) => (
  <div className="bg-secondary divide-y divide-border">{children}</div>
);

const ConfigureButton = ({ open, onClick }: { open: boolean; onClick: () => void }) => (
  <Button size="sm" variant="ghost" aria-expanded={open} onClick={onClick}>
    configure
  </Button>
);

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

export const AIProvidersSection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings }: AIProvidersSectionProps) => {
  // One row at a time is open: the keys and model lists are reference material,
  // not a form you fill top to bottom.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cliProviders, setCliProviders] = useState<CLIProviderStatus[]>(
    CLI_BINARIES.map((cli) => ({ ...cli, version: null, loading: true })),
  );

  // The one field here that isn't a key: reject and explain rather than
  // silently persisting something that will 404 the moment an agent starts.
  const [customUrlInvalid, setCustomUrlInvalid] = useState(false);
  const handleCustomUrlBlur = () => {
    const value = appSettings.customOpenAIBaseUrl || '';
    const invalid = value.trim().length > 0 && !isValidOpenAIBaseUrl(value);
    setCustomUrlInvalid(invalid);
    if (!invalid) onSaveAppSettings({ customOpenAIBaseUrl: value });
  };

  // Ollama has no key to gate on: whether it's usable is whether the local
  // server answers, so this is a live check, not a settings read.
  const [ollamaStatus, setOllamaStatus] = useState<{ checking: boolean; reachable: boolean }>({ checking: true, reachable: false });
  const checkOllama = useCallback(async () => {
    setOllamaStatus({ checking: true, reachable: false });
    const result = await window.electronAPI?.ollama?.test().catch(() => undefined);
    setOllamaStatus({ checking: false, reachable: !!result?.reachable });
  }, []);
  useEffect(() => { checkOllama(); }, [checkOllama]);

  useEffect(() => {
    const detect = async () => {
      const results = await Promise.all(
        CLI_BINARIES.map(async (cli) => {
          try {
            const result = await window.electronAPI?.shell?.version(cli.binary);
            const version = result?.success && result.output && !result.output.includes('not found') && !result.output.includes('command not found')
              ? result.output.trim().split('\n')[0]
              : null;
            return { ...cli, version, loading: false };
          } catch {
            return { ...cli, version: null, loading: false };
          }
        })
      );
      setCliProviders(results);
    };
    detect();
  }, []);

  const toggleExpanded = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  // Same fields the provider cards carried, one entry per provider. The key
  // handlers are unchanged: type into local settings, persist on blur.
  const apiProviders = [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      detail: 'openrouter · one key, 300+ models',
      note: 'The fallback every other provider uses when it has no key of its own.',
      docsUrl: 'https://openrouter.ai/keys',
      placeholder: 'sk-or-v1-...',
      enabled: !!appSettings.openRouterEnabled,
      onToggle: () => onSaveAppSettings({ openRouterEnabled: !appSettings.openRouterEnabled }),
      apiKey: appSettings.openRouterApiKey || '',
      onKeyChange: (v: string) => onUpdateLocalSettings({ openRouterApiKey: v }),
      onKeyBlur: () => onSaveAppSettings({ openRouterApiKey: appSettings.openRouterApiKey }),
      models: ['deepseek/deepseek-r1', 'moonshotai/kimi-k2', 'xiaomi/mimo-v2-pro', 'qwen/qwq-32b', 'openai/gpt-4.1', 'google/gemini-2.5-pro', '300+ more…'],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      detail: 'deepseek · anthropic-compatible',
      note: 'Direct via api.deepseek.com. Falls back to OpenRouter with no key.',
      docsUrl: 'https://platform.deepseek.com/api_keys',
      placeholder: 'sk-...',
      enabled: !!appSettings.deepSeekEnabled,
      onToggle: () => onSaveAppSettings({ deepSeekEnabled: !appSettings.deepSeekEnabled }),
      apiKey: appSettings.deepSeekApiKey || '',
      onKeyChange: (v: string) => onUpdateLocalSettings({ deepSeekApiKey: v }),
      onKeyBlur: () => onSaveAppSettings({ deepSeekApiKey: appSettings.deepSeekApiKey }),
      models: ['deepseek/deepseek-r1', 'deepseek/deepseek-chat', 'deepseek/deepseek-r1-distill-llama-70b'],
    },
    {
      id: 'moonshot',
      name: 'MoonshotAI (Kimi)',
      detail: 'moonshot · anthropic-compatible',
      note: 'Direct via api.moonshot.ai. Falls back to OpenRouter with no key.',
      docsUrl: 'https://platform.moonshot.cn/console/api-keys',
      placeholder: 'sk-...',
      enabled: !!appSettings.moonshotEnabled,
      onToggle: () => onSaveAppSettings({ moonshotEnabled: !appSettings.moonshotEnabled }),
      apiKey: appSettings.moonshotApiKey || '',
      onKeyChange: (v: string) => onUpdateLocalSettings({ moonshotApiKey: v }),
      onKeyBlur: () => onSaveAppSettings({ moonshotApiKey: appSettings.moonshotApiKey }),
      models: ['moonshotai/kimi-k2', 'moonshotai/moonlight-16k', 'moonshotai/kimi-vl-a3b-thinking'],
    },
    {
      id: 'mimo',
      name: 'MiMo (Xiaomi)',
      detail: 'mimo · routes via openrouter',
      note: 'No Anthropic-compatible endpoint: requests always use your OpenRouter key.',
      docsUrl: 'https://platform.xiaomimimo.com',
      placeholder: 'sk-...',
      enabled: !!appSettings.mimoEnabled,
      onToggle: () => onSaveAppSettings({ mimoEnabled: !appSettings.mimoEnabled }),
      apiKey: appSettings.mimoApiKey || '',
      onKeyChange: (v: string) => onUpdateLocalSettings({ mimoApiKey: v }),
      onKeyBlur: () => onSaveAppSettings({ mimoApiKey: appSettings.mimoApiKey }),
      models: ['xiaomi/mimo-v2-pro', 'xiaomi/mimo-v2-flash', 'xiaomi/mimo-v2-omni'],
    },
    {
      id: 'qwen',
      name: 'Qwen (Alibaba)',
      detail: 'qwen · routes via openrouter',
      note: 'No Anthropic-compatible endpoint: requests always use your OpenRouter key.',
      docsUrl: 'https://dashscope.console.aliyun.com/apiKey',
      placeholder: 'sk-...',
      enabled: !!appSettings.qwenEnabled,
      onToggle: () => onSaveAppSettings({ qwenEnabled: !appSettings.qwenEnabled }),
      apiKey: appSettings.qwenApiKey || '',
      onKeyChange: (v: string) => onUpdateLocalSettings({ qwenApiKey: v }),
      onKeyBlur: () => onSaveAppSettings({ qwenApiKey: appSettings.qwenApiKey }),
      models: ['qwen/qwq-32b', 'qwen/qwen-2.5-72b-instruct', 'qwen/qwen-2.5-coder-32b-instruct', 'qwen/qwen3-235b-a22b'],
    },
    {
      id: 'zhipu',
      name: 'Zai (GLM)',
      detail: 'zhipu · anthropic-compatible',
      note: 'Direct via open.bigmodel.cn. Falls back to OpenRouter with no key.',
      docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
      placeholder: '...',
      enabled: !!appSettings.zhipuEnabled,
      onToggle: () => onSaveAppSettings({ zhipuEnabled: !appSettings.zhipuEnabled }),
      apiKey: appSettings.zhipuApiKey || '',
      onKeyChange: (v: string) => onUpdateLocalSettings({ zhipuApiKey: v }),
      onKeyBlur: () => onSaveAppSettings({ zhipuApiKey: appSettings.zhipuApiKey }),
      models: ['zhipuai/glm-4.6', 'zhipuai/glm-4.5', 'zhipuai/glm-4-plus', 'zhipuai/glm-4-air', 'zhipuai/glm-4-flash'],
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      detail: 'minimax · anthropic-compatible',
      note: 'Direct via api.minimax.io. Falls back to OpenRouter with no key.',
      docsUrl: 'https://www.minimax.chat/platform',
      placeholder: '...',
      enabled: !!appSettings.minimaxEnabled,
      onToggle: () => onSaveAppSettings({ minimaxEnabled: !appSettings.minimaxEnabled }),
      apiKey: appSettings.minimaxApiKey || '',
      onKeyChange: (v: string) => onUpdateLocalSettings({ minimaxApiKey: v }),
      onKeyBlur: () => onSaveAppSettings({ minimaxApiKey: appSettings.minimaxApiKey }),
      models: ['minimax/minimax-m2', 'minimax/minimax-m1', 'minimax/minimax-01'],
    },
    {
      id: 'venice',
      name: 'Venice AI',
      detail: 'venice · openai-compatible only',
      note: 'No Anthropic-compatible endpoint and not on OpenRouter: Tars translates locally, no fallback.',
      docsUrl: 'https://venice.ai/api',
      placeholder: 'vn_...',
      enabled: !!appSettings.veniceEnabled,
      onToggle: () => onSaveAppSettings({ veniceEnabled: !appSettings.veniceEnabled }),
      apiKey: appSettings.veniceApiKey || '',
      onKeyChange: (v: string) => onUpdateLocalSettings({ veniceApiKey: v }),
      onKeyBlur: () => onSaveAppSettings({ veniceApiKey: appSettings.veniceApiKey }),
      models: ['llama-3.3-70b', 'venice-uncensored-1-2', 'deepseek-v3.2', 'qwen3-235b-a22b-instruct-2507'],
    },
    {
      id: 'ollama-cloud',
      name: 'Ollama Cloud',
      detail: 'ollama-cloud · anthropic-compatible, bearer auth',
      note: 'Direct via ollama.com. Its endpoint wants a Bearer token rather than the usual key header - Tars sends it that way automatically.',
      docsUrl: 'https://ollama.com/settings/keys',
      placeholder: '...',
      enabled: !!appSettings.ollamaCloudEnabled,
      onToggle: () => onSaveAppSettings({ ollamaCloudEnabled: !appSettings.ollamaCloudEnabled }),
      apiKey: appSettings.ollamaCloudApiKey || '',
      onKeyChange: (v: string) => onUpdateLocalSettings({ ollamaCloudApiKey: v }),
      onKeyBlur: () => onSaveAppSettings({ ollamaCloudApiKey: appSettings.ollamaCloudApiKey }),
      models: ['gpt-oss:120b', 'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro'],
    },
  ];

  return (
    <>
      <div className="px-4 pt-4 pb-2">
        <PanelCaption>INSTALLED CLIs</PanelCaption>
      </div>

      {cliProviders.map((cli) => {
        const isClaude = cli.binary === 'claude';
        const ready = !!cli.version;
        const open = expanded === cli.binary;
        return (
          <div key={cli.binary}>
            <SettingsRow
              label={
                <ProviderLabel
                  name={cli.name}
                  status={cli.loading ? 'checking' : ready ? 'ready' : 'not installed'}
                  tone={cli.loading ? 'idle' : ready ? 'running' : 'idle'}
                  on={ready}
                />
              }
              description={
                <span className="font-mono">
                  {cli.version ? `${cli.binary} · ${cli.version}` : cli.binary}
                </span>
              }
              control={isClaude ? <ConfigureButton open={open} onClick={() => toggleExpanded(cli.binary)} /> : undefined}
            />

            {isClaude && open && (
              <ConfigureArea>
                <SettingsRow
                  label="API key"
                  description="Most users rely on the system variable. Set this only to override it."
                  control={
                    <PasswordInput
                      width="control"
                      value={appSettings.anthropicApiKey || ''}
                      onChange={(e) => onUpdateLocalSettings({ anthropicApiKey: e.target.value })}
                      onBlur={() => onSaveAppSettings({ anthropicApiKey: appSettings.anthropicApiKey })}
                      placeholder="Uses system env ANTHROPIC_API_KEY"
                    />
                  }
                />
                <SettingsRow
                  label="Default model"
                  description="The model a new Claude agent starts on."
                  control={
                    <Select
                      width="control"
                      value={appSettings.defaultClaudeModel || 'sonnet'}
                      onChange={(e) => onSaveAppSettings({ defaultClaudeModel: e.target.value })}
                    >
                      <option value="sonnet">Sonnet - Daily coding</option>
                      <option value="opus">Opus - Complex reasoning</option>
                      <option value="haiku">Haiku - Fast &amp; efficient</option>
                    </Select>
                  }
                />
                <SettingsRow
                  label="Verbose mode"
                  description="Starts agents with --verbose for detailed output."
                  control={
                    <Toggle
                      enabled={!!appSettings.verboseModeEnabled}
                      onChange={() => onSaveAppSettings({ verboseModeEnabled: !appSettings.verboseModeEnabled })}
                    />
                  }
                />
                <SettingsRow
                  label="Chrome browser sharing"
                  description={
                    <>
                      Shares your logged-in Chrome via --chrome. Needs Claude Code 2.0.73+ and the{' '}
                      <a
                        href="https://chromewebstore.google.com/detail/claude-in-chrome/ofnckddkabkmfmjkfgiofpofhpgjdlda"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-foreground"
                      >
                        Claude in Chrome
                      </a>{' '}
                      extension.
                    </>
                  }
                  control={
                    <Toggle
                      enabled={!!appSettings.chromeEnabled}
                      onChange={() => onSaveAppSettings({ chromeEnabled: !appSettings.chromeEnabled })}
                    />
                  }
                />
                <SettingsRow
                  label="Status line"
                  description="Model, context, branch, session time and tokens, live inside the CLI."
                  control={
                    <Toggle
                      enabled={appSettings.statusLineEnabled === true}
                      onChange={() => onSaveAppSettings({ statusLineEnabled: !appSettings.statusLineEnabled })}
                    />
                  }
                />
              </ConfigureArea>
            )}
          </div>
        );
      })}

      <div className="px-4 pt-4 pb-2">
        <PanelCaption>LOCAL</PanelCaption>
      </div>

      <div>
        <SettingsRow
          label={
            <ProviderLabel
              name="Ollama"
              status={ollamaStatus.checking ? 'checking' : ollamaStatus.reachable ? 'ready' : 'not running'}
              tone={ollamaStatus.checking ? 'idle' : ollamaStatus.reachable ? 'running' : 'idle'}
              on={ollamaStatus.reachable}
            />
          }
          description={<span className="font-mono">{appSettings.ollamaBaseUrl || OLLAMA_DEFAULT_BASE_URL}</span>}
          control={<ConfigureButton open={expanded === 'ollama'} onClick={() => toggleExpanded('ollama')} />}
        />

        {expanded === 'ollama' && (
          <ConfigureArea>
            <SettingsRow
              label="Base URL"
              description="No API key: Ollama is a local server, not a hosted vendor. Needs v0.14+ for its native Anthropic-compatible endpoint."
              control={
                <Input
                  width="control"
                  value={appSettings.ollamaBaseUrl ?? ''}
                  onChange={(e) => onUpdateLocalSettings({ ollamaBaseUrl: e.target.value })}
                  onBlur={() => onSaveAppSettings({ ollamaBaseUrl: appSettings.ollamaBaseUrl })}
                  placeholder={OLLAMA_DEFAULT_BASE_URL}
                />
              }
            />
            <SettingsRow
              label="Connection"
              description="Checks whether the server answers, not whether any particular model is pulled."
              control={
                <Button size="sm" variant="ghost" onClick={checkOllama} disabled={ollamaStatus.checking}>
                  {ollamaStatus.checking ? 'checking…' : 'test connection'}
                </Button>
              }
            />
            <div className="px-4 py-3 flex flex-wrap items-center gap-1.5">
              {['llama3.3', 'qwen2.5-coder', 'deepseek-r1', 'gpt-oss'].map((m) => (
                <MetaChip key={m}>{m}</MetaChip>
              ))}
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">whatever you&apos;ve pulled works too</span>
            </div>
          </ConfigureArea>
        )}
      </div>

      <div className="px-4 pt-4 pb-2">
        <PanelCaption>API PROVIDERS</PanelCaption>
      </div>

      {apiProviders.map((p) => {
        const hasKey = p.apiKey.trim().length > 0;
        const open = expanded === p.id;
        return (
          <div key={p.id}>
            <SettingsRow
              label={
                <ProviderLabel
                  name={p.name}
                  status={hasKey ? 'key set' : 'no key'}
                  tone={hasKey ? 'running' : 'idle'}
                  on={hasKey}
                />
              }
              description={<span className="font-mono">{p.detail}</span>}
              control={<ConfigureButton open={open} onClick={() => toggleExpanded(p.id)} />}
              secondaryControl={<Toggle enabled={p.enabled} onChange={p.onToggle} />}
            />

            {open && (
              <ConfigureArea>
                <SettingsRow
                  label="API key"
                  description={p.note}
                  control={
                    <PasswordInput
                      width="control"
                      value={p.apiKey}
                      onChange={(e) => p.onKeyChange(e.target.value)}
                      onBlur={p.onKeyBlur}
                      placeholder={p.placeholder}
                    />
                  }
                />
                <div className="px-4 py-3 flex flex-wrap items-center gap-1.5">
                  {p.models.map((m) => (
                    <MetaChip key={m}>{m}</MetaChip>
                  ))}
                  <a
                    href={p.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto font-mono text-[10.5px] text-muted-foreground hover:text-foreground underline"
                  >
                    get a key
                  </a>
                </div>
              </ConfigureArea>
            )}
          </div>
        );
      })}

      <div className="px-4 pt-4 pb-2">
        <PanelCaption>CUSTOM</PanelCaption>
      </div>

      <div>
        {(() => {
          const hasBaseUrl = !!appSettings.customOpenAIBaseUrl?.trim();
          const hasModel = !!appSettings.customOpenAIModel?.trim();
          const ready = hasBaseUrl && hasModel;
          const open = expanded === 'custom-openai';
          return (
            <>
              <SettingsRow
                label={
                  <ProviderLabel
                    name="Custom (OpenAI-compatible)"
                    status={ready ? 'configured' : hasBaseUrl ? 'no model set' : 'not configured'}
                    tone={ready ? 'running' : 'idle'}
                    on={ready}
                  />
                }
                description={<span className="font-mono">{appSettings.customOpenAIBaseUrl || 'no base url set'}</span>}
                control={<ConfigureButton open={open} onClick={() => toggleExpanded('custom-openai')} />}
                secondaryControl={
                  <Toggle
                    enabled={!!appSettings.customOpenAIEnabled}
                    onChange={() => onSaveAppSettings({ customOpenAIEnabled: !appSettings.customOpenAIEnabled })}
                  />
                }
              />
              {open && (
                <ConfigureArea>
                  <SettingsRow
                    label="Base URL"
                    description={
                      customUrlInvalid
                        ? <span className="text-danger">Must be a full http:// or https:// URL, e.g. https://api.example.com/v1</span>
                        : 'Any OpenAI-compatible /chat/completions endpoint - vLLM, LM Studio, a hosted vendor with no Anthropic support.'
                    }
                    control={
                      <Input
                        width="control"
                        value={appSettings.customOpenAIBaseUrl ?? ''}
                        onChange={(e) => { onUpdateLocalSettings({ customOpenAIBaseUrl: e.target.value }); setCustomUrlInvalid(false); }}
                        onBlur={handleCustomUrlBlur}
                        placeholder="https://api.example.com/v1"
                      />
                    }
                  />
                  <SettingsRow
                    label="API key"
                    description="Leave blank if the endpoint needs none."
                    control={
                      <PasswordInput
                        width="control"
                        value={appSettings.customOpenAIApiKey || ''}
                        onChange={(e) => onUpdateLocalSettings({ customOpenAIApiKey: e.target.value })}
                        onBlur={() => onSaveAppSettings({ customOpenAIApiKey: appSettings.customOpenAIApiKey })}
                        placeholder="sk-... (optional)"
                      />
                    }
                  />
                  <SettingsRow
                    label="Model"
                    description="The exact model id this endpoint expects. No catalogue to pick from - type it as the vendor documents it."
                    control={
                      <Input
                        width="control"
                        value={appSettings.customOpenAIModel || ''}
                        onChange={(e) => onUpdateLocalSettings({ customOpenAIModel: e.target.value })}
                        onBlur={() => onSaveAppSettings({ customOpenAIModel: appSettings.customOpenAIModel })}
                        placeholder="llama-3.1-70b-instruct"
                      />
                    }
                  />
                </ConfigureArea>
              )}
            </>
          );
        })()}
      </div>

      {/* What used to be a four-paragraph card explaining routing. One line is
          the whole rule; the per-provider detail lines say the rest. */}
      <div className="px-4 py-3">
        <p className="bg-bg-tertiary px-3 py-2 text-[11px] text-muted-foreground">
          Every provider runs on the Claude CLI with its base URL pointed at that provider - its own
          key when you set one, the OpenRouter key otherwise.
        </p>
      </div>
    </>
  );
};
