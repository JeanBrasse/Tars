import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // This replaces eslint-config-next's default ignores rather than extending
  // them, so everything we do not want linted has to be listed here.
  globalIgnores([
    // Defaults of eslint-config-next, widened to any depth: the landing page
    // is a second Next app, so its build output is at landing/.next.
    "**/.next/**",
    "**/out/**",
    "build/**",
    "**/next-env.d.ts",

    // Playwright writes a bundled HTML viewer into e2e/report after a run.
    "e2e/report/**",
    "test-results/**",

    // Build output. electron/dist is compiled from electron/, release/ holds
    // packaged .app bundles - linting either reports the same problems twice,
    // once in source and once in a generated copy we never edit.
    "electron/dist/**",
    "release/**",
    "**/*.asar",

    // Agent worktrees. These are checkouts of other branches living inside the
    // repo; their files belong to those branches, not to this one, and they
    // accounted for 1229 of the 1916 errors the lint used to report.
    ".worktrees/**",
    ".claude/worktrees/**",

    // Bundled MCP servers build themselves and carry their own configs.
    "mcp-*/dist/**",
    "mcp-*/node_modules/**",
  ]),
]);

export default eslintConfig;
