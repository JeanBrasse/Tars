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

  {
    // Two rules from eslint-plugin-react-hooks 7's React Compiler set, which
    // arrived with a transitive bump and lit up 59 errors across files nobody
    // had touched. Neither applies here.
    //
    // `set-state-in-effect` says "calling setState SYNCHRONOUSLY within an
    // effect", and every one of its 54 reports is on a line like
    // `void loadHistory()`: an async loader that sets state once its promise
    // resolves, which is neither synchronous nor a cascading render. The rule
    // cannot see through the async boundary, and that pattern is how every
    // page in this app loads over IPC.
    //
    // `preserve-manual-memoization` reports "Compilation Skipped", which only
    // means anything when the React Compiler is compiling. next.config.ts does
    // not enable it.
    //
    // The rest of the set is on and was worth having: `refs` found eleven ref
    // writes during render and `immutability` found a function referenced
    // above its own declaration. Those are fixed, not silenced.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },

  {
    // Tests stub what they are not testing: a fake PTY, a window that only has
    // the one method under test, a dependency bag with three of its twelve
    // members. Typing every stub in full makes the test longer and more
    // brittle without making the product any safer, so `any` is allowed here
    // and nowhere else. Production code has none.
    files: ["__tests__/**/*.ts", "e2e/**/*.ts", "e2e/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  {
    // A CommonJS script shipped as a resource and run by node directly, not
    // bundled and not compiled. `require` is how it loads, and rewriting it as
    // ESM would stop it running.
    files: ["electron/resources/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
