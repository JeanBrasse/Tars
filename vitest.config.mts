import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  // Renderer modules use the same @ alias Next resolves, so tests that reach
  // into src/ need it too.
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  test: {
    globals: true,
    environment: 'node',
    // Loaded before each test file's imports, which is the point: constants.ts
    // reads DOROTHY_API_PORT and computes DATA_DIR from the home directory at
    // module load, so anything later is too late. See each file for what it
    // removes, what it keeps, and where HOME now points.
    setupFiles: ['./__tests__/setup/env-isolation.ts', './__tests__/setup/home-isolation.ts'],
    // .tsx too: the overseer's text renderer is asserted through the markup
    // it produces, which needs the component itself.
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: [
        'electron/constants/**',
        'electron/utils/**',
        'electron/services/**',
        'electron/handlers/**',
        'electron/providers/**',
        'mcp-orchestrator/src/utils/**',
        'mcp-orchestrator/src/tools/**',
        'mcp-telegram/src/**',
        'mcp-kanban/src/**',
      ],
    },
  },
});
