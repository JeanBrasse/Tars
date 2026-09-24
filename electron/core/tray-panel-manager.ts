import { BrowserWindow, screen } from 'electron';
import { hardenWindow, isDevBuild, resolveDevUrl } from './window-manager';
import * as path from 'path';

let trayPanel: BrowserWindow | null = null;

const PANEL_WIDTH = 800;
const PANEL_HEIGHT = 540;

export function createTrayPanel(): BrowserWindow {
  if (trayPanel && !trayPanel.isDestroyed()) {
    return trayPanel;
  }

  trayPanel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Matches --background in the dark theme, which is the launch default.
    // This was the retired cream (#F0E8D5), so the tray panel flashed a light
    // rectangle before the renderer painted over it.
    backgroundColor: '#121212',
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hardenWindow(trayPanel);

  // The main window's rule (window-manager.ts, isDevBuild and resolveDevUrl):
  // the build decides, not NODE_ENV, which the launching shell sets. This
  // window carries the same preload bridge, and read NODE_ENV until the
  // Audit's table on a3d7c125 (#4): a shipped build launched from a shell with
  // NODE_ENV=development loaded whatever answered on localhost:3000.
  if (isDevBuild()) {
    trayPanel.loadURL(`${resolveDevUrl().replace(/\/+$/, '')}/tray-panel`);
  } else {
    trayPanel.loadURL('app://-/tray-panel/index.html');
  }

  trayPanel.on('blur', () => {
    hideTrayPanel();
  });

  trayPanel.on('closed', () => {
    trayPanel = null;
  });

  return trayPanel;
}

export function toggleTrayPanel(trayBounds: Electron.Rectangle): void {
  if (trayPanel && !trayPanel.isDestroyed() && trayPanel.isVisible()) {
    hideTrayPanel();
    return;
  }

  if (!trayPanel || trayPanel.isDestroyed()) {
    createTrayPanel();
  }

  // Position below the tray icon, centered horizontally
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  });

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - PANEL_WIDTH / 2);
  const y = trayBounds.y + trayBounds.height + 4;

  // Clamp to screen bounds
  const clampedX = Math.max(
    display.workArea.x,
    Math.min(x, display.workArea.x + display.workArea.width - PANEL_WIDTH)
  );

  trayPanel!.setPosition(clampedX, y);
  trayPanel!.show();
}

export function hideTrayPanel(): void {
  if (trayPanel && !trayPanel.isDestroyed()) {
    trayPanel.hide();
  }
}

export function destroyTrayPanel(): void {
  if (trayPanel && !trayPanel.isDestroyed()) {
    trayPanel.destroy();
    trayPanel = null;
  }
}
