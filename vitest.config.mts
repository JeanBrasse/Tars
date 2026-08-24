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
