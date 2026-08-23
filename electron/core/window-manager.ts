import { BrowserWindow, protocol, app, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getAppBasePath } from '../utils';
import { DATA_DIR, MIME_TYPES, dataPath } from '../constants';

// Global reference to the main window
let mainWindow: BrowserWindow | null = null;

/**
 * Get the main window instance
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Set the main window instance
 */
export function setMainWindow(window: BrowserWindow | null) {
  mainWindow = window;
}

/**
 * Create the main application window
 */
export function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    title: 'Tars',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#121212',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // No renderer of ours ever needs to reach out on its own.
      webviewTag: false,
    },
  });

  hardenWindow(mainWindow);

  // Load the Next.js app
  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    mainWindow.loadURL(process.env.DOROTHY_DEV_URL || 'http://localhost:3000');
    if (!process.env.DOROTHY_E2E) {
      mainWindow.webContents.openDevTools();
    }
  } else {
    // In production, use the custom app:// protocol to properly serve static files
    // This fixes issues with absolute paths like /logo.png not resolving correctly
    mainWindow.loadURL('app://-/index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle loading errors
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Failed to load:', validatedURL, errorCode, errorDescription);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Page loaded successfully');
  });
}

/**
 * Register custom protocol for serving static files
 * This must be called before app.whenReady()
 */
export function registerProtocolSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    {
      scheme: 'local-file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Setup the custom app:// protocol handler for serving static files
 * This should be called after app.whenReady() and before loading the window
 */
/**
 * Nothing may navigate this window away from the app, and nothing may open a
 * second one.
 *
 * The renderer holds the whole electronAPI bridge. A link in a vault note, a
 * redirect from injected content or a window.open would otherwise land remote
 * content in a renderer that can spawn PTYs and read the filesystem. External
 * links go to the user's browser, where they belong.
 */
export function hardenWindow(window: BrowserWindow): void {
  const isOurs = (url: string) =>
    url.startsWith('app://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');

  window.webContents.on('will-navigate', (event, url) => {
    if (isOurs(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', event => event.preventDefault());
}

/** Roots local-file:// may read from: the user's own project and app data. */
function isUnderAllowedRoot(filePath: string): boolean {
  const roots = [
    DATA_DIR,
    path.join(os.homedir(), '.claude'),
    ...listKnownProjectRoots(),
  ];
  return roots.some(root => {
    const resolved = path.resolve(root);
    return filePath === resolved || filePath.startsWith(resolved + path.sep);
  });
}

/** Project folders the user added, read fresh so a new project works at once. */
function listKnownProjectRoots(): string[] {
  try {
    const file = dataPath('projects.json');
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function setupProtocolHandler() {
  // Serve local files via local-file:// protocol (for vault image previews etc.)
  // URLs are encoded as: local-file://host/path where host is empty
  // e.g. local-file:///Users/charlie/Desktop/photo.png
  protocol.handle('local-file', async (request) => {
    try {
      // Parse as URL to properly decode path components
      const url = new URL(request.url);
      const filePath = path.resolve(decodeURIComponent(url.pathname));

      // Confined to the directories the app actually shows files from.
      // Unrestricted, this served ~/.ssh/id_rsa and ~/.aws/credentials to
      // anything that could put a URL in the renderer.
      if (!isUnderAllowedRoot(filePath)) {
        console.error('local-file:// refused, outside the allowed roots:', filePath);
        return new Response('Forbidden', { status: 403 });
      }

      if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
        return new Response(await fs.promises.readFile(filePath), {
          headers: { 'Content-Type': mimeType },
        });
      }
      console.error('local-file:// not found:', filePath);
    } catch (err) {
      console.error('local-file:// error:', err, request.url);
    }
    return new Response('Not Found', { status: 404 });
  });

  const isDev = process.env.NODE_ENV === 'development';
  if (!isDev) {
    const basePath = getAppBasePath();
    console.log('Registering app:// protocol with basePath:', basePath);

    protocol.handle('app', async (request) => {
      let urlPath = request.url.replace('app://', '');

      // Remove the host part (e.g., "localhost" or "-")
      const slashIndex = urlPath.indexOf('/');
      if (slashIndex !== -1) {
        urlPath = urlPath.substring(slashIndex);
      } else {
        urlPath = '/';
      }

      // Default to index.html for directory requests
      if (urlPath === '/' || urlPath === '') {
        urlPath = '/index.html';
      }

      // Handle page routes (e.g., /agents/, /settings/) - serve their index.html
      if (urlPath.endsWith('/')) {
        urlPath = urlPath + 'index.html';
      }

      // Remove leading slash for path.join
      const relativePath = urlPath.startsWith('/') ? urlPath.substring(1) : urlPath;
      const filePath = path.join(basePath, relativePath);


      // Check if file exists
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

        return new Response(await fs.promises.readFile(filePath), {
          headers: { 'Content-Type': mimeType },
        });
      }

      // If it's a page route without .html, try adding index.html
      const htmlPath = path.join(basePath, relativePath, 'index.html');
      if (fs.existsSync(htmlPath)) {
        return new Response(await fs.promises.readFile(htmlPath), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      console.error(`File not found: ${filePath}`);
      return new Response('Not Found', { status: 404 });
    });
  }
}
