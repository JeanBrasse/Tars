import {
  Brain,
  Settings,
  GitCommit,
  Bell,
  Send,
  Shield,
  Sparkles,
  Monitor,
  Terminal,
  Twitter,
  Cloud,
  Plug,
  Zap,
} from 'lucide-react';
import { SlackIcon } from './SlackIcon';
import { TasmaniaIcon } from './TasmaniaIcon';
import type { SettingsSection } from './types';

/** A leaf is one sub-page: its own title and its own one-line subtitle in the page header. */
export interface SettingsLeaf {
  id: SettingsSection;
  label: string;
  /** Sentence shown under the sub-page title. One line, no trailing context. */
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface SettingsGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: SettingsLeaf[];
}

/**
 * Seventeen flat entries meant scrolling a list to find anything, and five of
 * them were a single vendor. Same seventeen screens, six doors.
 */
export const SECTION_GROUPS: SettingsGroup[] = [
  {
    id: 'general',
    label: 'General',
    icon: Settings,
    children: [
      { id: 'general', label: 'Preferences', description: 'How Tars behaves before anything else.', icon: Settings },
      { id: 'terminal', label: 'Terminal', description: 'Type size and theme for every terminal Tars opens.', icon: Terminal },
      { id: 'notifications', label: 'Notifications', description: 'What Tars tells you about, and when it stays quiet.', icon: Bell },
      { id: 'system', label: 'System', description: 'Updates, the machine, and what it already provides.', icon: Monitor },
    ],
  },
  {
    id: 'ai',
    label: 'AI & Providers',
    icon: Zap,
    children: [
      { id: 'ai-providers', label: 'Providers', description: 'Every CLI and API Tars can run. They are all equal here.', icon: Zap },
      { id: 'cli', label: 'CLI Paths', description: 'Where each command line tool lives on this machine.', icon: Terminal },
      { id: 'permissions', label: 'Permissions', description: 'How far an agent may go before it asks you.', icon: Shield },
    ],
  },
  {
    id: 'hermes',
    label: 'Hermes',
    icon: Send,
    children: [
      { id: 'hermes', label: 'Connection', description: 'Where your Hermes gateway lives.', icon: Send },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: Plug,
    children: [
      { id: 'telegram', label: 'Telegram', description: 'Reach your agents from a Telegram chat.', icon: Send },
      { id: 'slack', label: 'Slack', description: 'Reach your agents from a Slack workspace.', icon: SlackIcon },
      { id: 'socialdata', label: 'X (Twitter)', description: 'Read and post on X with your own keys.', icon: Twitter },
      { id: 'google-workspace', label: 'Google Workspace', description: 'Gmail, Calendar and Drive, through your own account.', icon: Cloud },
    ],
  },
  {
    id: 'extensions',
    label: 'Extensions',
    icon: Sparkles,
    children: [
      { id: 'skills', label: 'Skills & Plugins', description: 'Everything installed on top of the agents you already have.', icon: Sparkles },
      { id: 'mcp', label: 'Custom MCP', description: 'Servers Tars did not install, listed as they are.', icon: Plug },
      { id: 'tasmania', label: 'Tasmania', description: 'The Tasmania server, and where it runs from.', icon: TasmaniaIcon },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: GitCommit,
    children: [
      { id: 'git', label: 'Git', description: 'How Tars commits, branches and worktrees on your behalf.', icon: GitCommit },
      { id: 'memory', label: 'Memory Backends', description: 'Where memory goes once it leaves the files on disk.', icon: Brain },
    ],
  },
];

/** Flat view of the same sections, for deep-links and the mobile picker. */
export const SECTIONS: SettingsLeaf[] = SECTION_GROUPS.flatMap(g => g.children);

export const DEFAULT_APP_SETTINGS = {
  notificationsEnabled: true,
  notifyOnWaiting: true,
  notifyOnComplete: true,
  notifyOnStop: true,
  notifyOnError: true,
  telegramEnabled: false,
  telegramBotToken: '',
  telegramChatId: '',
  telegramAuthToken: '',
  telegramAuthorizedChatIds: [] as string[],
  telegramRequireMention: false,
  slackEnabled: false,
  slackBotToken: '',
  slackAppToken: '',
  slackSigningSecret: '',
  slackChannelId: '',
  socialDataEnabled: false,
  socialDataApiKey: '',
  xPostingEnabled: false,
  xApiKey: '',
  xApiSecret: '',
  xAccessToken: '',
  xAccessTokenSecret: '',
  tasmaniaEnabled: false,
  tasmaniaServerPath: '',
  gwsEnabled: false,
  gwsSkillsInstalled: false,
  verboseModeEnabled: false,
  chromeEnabled: false,
  autoCheckUpdates: true,
  autoStartAgentsOnLaunch: true,
  opencodeEnabled: false,
  opencodeDefaultModel: '',
  openRouterEnabled: false,
  openRouterApiKey: '',
  deepSeekEnabled: false,
  deepSeekApiKey: '',
  mimoEnabled: false,
  mimoApiKey: '',
  moonshotEnabled: false,
  moonshotApiKey: '',
  qwenEnabled: false,
  qwenApiKey: '',
  zhipuEnabled: false,
  zhipuApiKey: '',
  minimaxEnabled: false,
  minimaxApiKey: '',
  nvidiaEnabled: false,
  nvidiaApiKey: '',
  nousPortalEnabled: false,
  nousPortalApiKey: '',
  defaultProvider: 'claude',
  obsidianVaultPaths: [] as string[],
  terminalFontSize: 11,
  terminalTheme: 'dark' as const,
  statusLineEnabled: false,
  hermesGatewayUrl: '',
  hermesGatewayToken: '',
  memoryGbrainEnabled: false,
  memoryGbrainMcpUrl: '',
  memoryGbrainAuthToken: '',
  memoryHonchoEnabled: false,
  memoryHonchoMcpUrl: 'https://mcp.honcho.dev',
  memoryHonchoApiKey: '',
  favoriteProjects: [] as string[],
  hiddenProjects: [] as string[],
  cliPaths: {
    claude: '',
    codex: '',
    gemini: '',
    grok: '',
    qwencode: '',
    opencode: '',
    pi: '',
    gws: '',
    gcloud: '',
    gh: '',
    node: '',
    minimax: '',
    additionalPaths: [],
  },
};
