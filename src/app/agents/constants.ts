import type { AgentStatus } from '@/types/electron';
import type { StatusTone } from '@/components/ui/StatusBadge';

// Status is ink only — the status token colours the raw status word.
// No background fill, no pill: consumers render the status key itself.
export const STATUS_COLORS: Record<AgentStatus['status'], { text: string }> = {
  idle: { text: 'text-status-idle' },
  running: { text: 'text-status-running' },
  completed: { text: 'text-status-idle' },
  error: { text: 'text-status-error' },
  waiting: { text: 'text-status-waiting' },
};

/**
 * Folds the runtime status set onto the design's four-word vocabulary (R6).
 * `completed` is a real runtime state but not a design status — it reads as idle.
 */
export const statusTone = (status: AgentStatus['status']): StatusTone =>
  status === 'completed' ? 'idle' : status;

export const CHARACTER_FACES: Record<string, string> = {
  robot: '🤖',
  ninja: '🥷',
  wizard: '🧙',
  astronaut: '👨‍🚀',
  knight: '⚔️',
  pirate: '🏴‍☠️',
  alien: '👽',
  viking: '🪓',
  frog: '🐸',
};

export const ORCHESTRATOR_PROMPT = `You are the Super Agent - an orchestrator that manages other agents using MCP tools.

AVAILABLE MCP TOOLS (from "claude-mgr-orchestrator"):
- list_agents: List all agents with status, project, ID
- get_agent_output: Read agent's terminal output (use to see responses!)
- start_agent: Start agent with a prompt (auto-sends to running agents too)
- send_message: Send message to agent (auto-starts idle agents)
- stop_agent: Stop a running agent
- create_agent: Create a new agent
- remove_agent: Delete an agent

WORKFLOW - When asked to talk to an agent:
1. Use start_agent or send_message with your question (both auto-handle idle/running states)
2. Wait 5-10 seconds for the agent to process
3. Use get_agent_output to read their response
4. Report the response back to the user

IMPORTANT:
- ALWAYS check get_agent_output after sending a message to see the response
- Keep responses concise
- NEVER explore codebases - you only manage agents

Say hello and list the current agents.`;

export const isSuperAgentCheck = (agent: AgentStatus) => {
  const name = agent.name?.toLowerCase() || '';
  return name.includes('super agent') || name.includes('orchestrator');
};

export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  grok: 'Grok',
  local: 'Local',
};

export const getStatusPriority = (status: string) => {
  if (status === 'running') return 0;
  if (status === 'waiting') return 1;
  return 2;
};
