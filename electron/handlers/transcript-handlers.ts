import { ipcMain } from 'electron';
import { agents } from '../core/agent-manager';
import { getProvider } from '../providers';
import { readAgentTranscript, type AgentTranscript } from '../services/agent-transcript';

/**
 * The agent panels' real history.
 *
 * Everything about locating and reading the file is in
 * services/agent-transcript.ts. What lives here is the one thing that needs
 * the app's own registries: which agent this is, and whether the CLI it runs
 * writes a transcript at all.
 */
export function registerTranscriptHandlers(): void {
  ipcMain.handle('agent:transcript', async (
    _event,
    params: { agentId?: string; before?: string; limit?: number },
  ): Promise<AgentTranscript> => {
    const agentId = typeof params?.agentId === 'string' ? params.agentId : '';
    const agent = agents.get(agentId);
    if (!agent) {
      return { available: false, reason: 'no-session', detail: 'This agent no longer exists.' };
    }

    // Only the claude binary writes ~/.claude/projects/**.jsonl. Fifteen of
    // the twenty providers run it; codex, gemini, grok, opencode, pi and amp
    // each keep their own history somewhere else, or keep none. Saying so is
    // the point: a named absence is worth more to a reader than an empty list
    // that looks like a conversation nobody has had yet.
    const provider = getProvider(agent.provider);
    if (provider.binaryName !== 'claude') {
      return {
        available: false,
        reason: 'unsupported-provider',
        detail: `${provider.displayName} does not write a transcript Tars can read.`,
      };
    }

    return readAgentTranscript({
      // The session that is live now, or the last one worth reopening. An
      // agent sitting idle between tasks has only the second, and its history
      // is exactly what someone opening the panel wants to see.
      sessionId: agent.currentSessionId || agent.resumableSessionId,
      projectPath: agent.projectPath,
      worktreePath: agent.worktreePath,
      before: typeof params?.before === 'string' ? params.before : undefined,
      limit: typeof params?.limit === 'number' ? params.limit : undefined,
    });
  });
}
