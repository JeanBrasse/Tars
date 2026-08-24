import { ipcMain } from 'electron';
import {
  askOverseer,
  getOverseerHistory,
  buildFleetSnapshot,
  confirmPendingAction,
  pauseOverseerWatch,
  resumeOverseerWatch,
  isOverseerWatchPaused,
  isOverseerBusy,
  getOverseerSettings,
  setOverseerSettings,
  applyOverseerModel,
  OverseerAction,
  OverseerSettings,
} from '../services/overseer';
import { AUTO_ACTION_RULES } from '../services/overseer-auto';
import { usableHermesConnection } from '../services/hermes-config';
import { fetchHermesModelOptions } from '../services/hermes-client';

/**
 * IPC surface for the Chat · Overseer page. Mirrors the shape of
 * hermes-handlers.ts: thin handlers, all the logic lives in the service
 * (electron/services/overseer.ts).
 */
export function registerOverseerHandlers(): void {
  ipcMain.handle('overseer:send', async (_event, message: string) => {
    if (typeof message !== 'string' || !message.trim()) {
      return { ok: false, reason: 'error', error: 'Message is empty.' };
    }
    return askOverseer(message.trim());
  });

  ipcMain.handle('overseer:history', async () => ({
    messages: getOverseerHistory(),
    busy: isOverseerBusy(),
  }));

  ipcMain.handle('overseer:fleet', async () => buildFleetSnapshot());

  ipcMain.handle('overseer:confirmAction', async (_event, params: { action: OverseerAction; approve: boolean }) => {
    return confirmPendingAction(params.action, params.approve);
  });

  ipcMain.handle('overseer:pause', async () => {
    pauseOverseerWatch();
    return { success: true, paused: true };
  });

  ipcMain.handle('overseer:resume', async () => {
    resumeOverseerWatch();
    return { success: true, paused: false };
  });

  ipcMain.handle('overseer:watchStatus', async () => ({ paused: isOverseerWatchPaused() }));

  ipcMain.handle('overseer:settings', async () => getOverseerSettings());

  /** The rules that can be turned on, described in the words that decide it. */
  ipcMain.handle('overseer:autoActions', async () =>
    AUTO_ACTION_RULES.map(r => ({ id: r.id, label: r.label, description: r.description })));

  ipcMain.handle('overseer:setSettings', async (_event, patch: Partial<OverseerSettings>) => {
    const settings = setOverseerSettings(patch ?? {});
    // Choosing a model has to reach the gateway, not just this file: the
    // overseer runs on whatever the gateway's main slot is set to.
    if ((patch?.provider || patch?.model) && settings.provider && settings.model) {
      const applied = await applyOverseerModel(settings.provider, settings.model);
      if (!applied.success) return { success: false, settings, error: applied.error };
    }
    return { success: true, settings };
  });

  /**
   * The models the gateway can actually run. Asked of the gateway rather than
   * compiled in, because which providers it has credentials for is a property
   * of that install, not of Tars.
   */
  ipcMain.handle('overseer:modelOptions', async () => {
    const conn = usableHermesConnection();
    if (!conn) return { success: false, error: 'Hermes is not configured. Set it up in Settings.' };
    return fetchHermesModelOptions(conn);
  });
}
