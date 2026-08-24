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
  OverseerAction,
  OverseerSettings,
} from '../services/overseer';
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

  ipcMain.handle('overseer:setSettings', async (_event, patch: Partial<OverseerSettings>) => {
    const settings = setOverseerSettings(patch ?? {});
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
