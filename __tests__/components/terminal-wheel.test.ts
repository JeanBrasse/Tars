import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import type { Terminal } from 'xterm';
import { stopWheelTyping } from '@/lib/terminal';

/**
 * The wheel over a terminal typed arrow keys into the program running in it.
 *
 * xterm 5.3 converts wheel travel over a buffer with no history into `ESC [ A`
 * and `ESC [ B`, through onData like a keystroke, and at Claude Code's prompt
 * those arrows walked back through the messages already sent.
 * `stopWheelTyping` stops the wheel on the terminal's element before xterm's
 * own listener sees it.
 *
 * That the arrows really stop, and that the keys and the history still work,
 * is proven in the app by e2e/terminal-wheel.spec.ts: the conversion needs a
 * measured row height, so a test with no layout sees no arrows with or without
 * the guard. What is held here is what can be held without a document: the
 * condition the guard applies, and that every terminal in src applies it.
 */

type WheelListener = (event: WheelEvent) => void;

function stubTerminal({ buffer = 'normal', scrollback }: { buffer?: 'normal' | 'alternate'; scrollback?: number } = {}) {
  const added: Array<{ type: string; listener: WheelListener; options: unknown }> = [];
  const term = {
    element: {
      addEventListener: (type: string, listener: WheelListener, options: unknown) => { added.push({ type, listener, options }); },
    },
    buffer: { active: { type: buffer } },
    options: scrollback === undefined ? {} : { scrollback },
  };
  const wheel = () => {
    const event = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), stopPropagation: vi.fn() };
    for (const entry of added) if (entry.type === 'wheel') entry.listener(event as unknown as WheelEvent);
    return event;
  };
  return { term: term as unknown as Terminal, added, wheel };
}

describe('stopWheelTyping', () => {
  it('listens on the terminal element in the capture phase, ahead of xterm, and may cancel', () => {
    const { term, added } = stubTerminal();
    stopWheelTyping(term);

    expect(added).toHaveLength(1);
    expect(added[0].type).toBe('wheel');
    expect(added[0].options).toMatchObject({ capture: true, passive: false });
  });

  it('stops the wheel over the alternate screen, where xterm would turn it into arrows', () => {
    const { term, wheel } = stubTerminal({ buffer: 'alternate', scrollback: 10000 });
    stopWheelTyping(term);

    const event = wheel();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    // And the page does not scroll in its place.
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('stops it over a main buffer that keeps no history, which xterm converts the same way', () => {
    const { term, wheel } = stubTerminal({ buffer: 'normal', scrollback: 0 });
    stopWheelTyping(term);

    expect(wheel().stopImmediatePropagation).toHaveBeenCalled();
  });

  it('leaves it to xterm over a main buffer with history, where the wheel scrolls it', () => {
    for (const scrollback of [1, 10000, undefined]) {
      const { term, wheel } = stubTerminal({ buffer: 'normal', scrollback });
      stopWheelTyping(term);

      const event = wheel();
      expect(event.stopImmediatePropagation, `scrollback ${scrollback}`).not.toHaveBeenCalled();
      expect(event.stopPropagation, `scrollback ${scrollback}`).not.toHaveBeenCalled();
      expect(event.preventDefault, `scrollback ${scrollback}`).not.toHaveBeenCalled();
    }
  });

  it('reads the buffer when the wheel turns, not when the terminal opened', () => {
    // A CLI takes the alternate screen after the terminal exists, and leaves it.
    const { term, wheel } = stubTerminal({ buffer: 'normal', scrollback: 1000 });
    stopWheelTyping(term);

    (term.buffer.active as { type: string }).type = 'alternate';
    expect(wheel().stopImmediatePropagation).toHaveBeenCalled();
    (term.buffer.active as { type: string }).type = 'normal';
    expect(wheel().stopImmediatePropagation).not.toHaveBeenCalled();
  });
});

/**
 * The class, found in the sources rather than listed.
 *
 * The replies filter was once guarded by a list of four files while nine
 * terminals forwarded input; the fifth site was simply not on it. So the
 * terminals are found here from the sources, parsed rather than grepped: a
 * comment in terminal-theme.ts and another in Terminal.tsx carry `new
 * Terminal(` and `term.open()`, and a pattern would count them.
 *
 * A terminal is a `new` of xterm's `Terminal`, however it was imported. Each
 * one must be opened in the function that makes it, and `stopWheelTyping` from
 * `@/lib/terminal` must be called on that same terminal after the open, since
 * the element it listens on only exists from `open()` on.
 */
describe('every terminal in src stops the wheel from typing', () => {
  const ROOT = process.cwd();
  const SRC = path.join(ROOT, 'src');
  const XTERM = new Set(['xterm', '@xterm/xterm']);

  /** Bytes in, string out: a file with a NUL byte in it is read like any other. */
  const readText = (file: string) => fs.readFileSync(file).toString('utf-8');

  function sources(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) out.push(full);
      }
    };
    walk(root);
    return out.sort();
  }

  interface Site { file: string; line: number; terminal: string; problem: string | null }

  const isXtermImport = (node: ts.Node) =>
    ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments.length === 1
    && ts.isStringLiteral(node.arguments[0])
    && XTERM.has(node.arguments[0].text);

  const contains = (node: ts.Node, test: (n: ts.Node) => boolean): boolean =>
    test(node) || (ts.forEachChild(node, child => (contains(child, test) ? true : undefined)) ?? false);

  function descendants(node: ts.Node): ts.Node[] {
    const out: ts.Node[] = [];
    const visit = (n: ts.Node) => { out.push(n); ts.forEachChild(n, visit); };
    ts.forEachChild(node, visit);
    return out;
  }

  /** Every xterm terminal constructed in one source, and what is wrong with each, if anything. */
  function sitesIn(file: string, text: string): Site[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const all = descendants(source);
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    // Local names for xterm's Terminal: a static import, aliased or not, or a
    // name destructured out of a dynamic import of the module.
    const constructors = new Set<string>();
    // Local names for the guard, and only when it comes from @/lib/terminal.
    const guards = new Set<string>();
    for (const node of all) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause && !node.importClause.isTypeOnly) {
        const from = node.moduleSpecifier.text;
        const named = node.importClause.namedBindings;
        if (!named || !ts.isNamedImports(named)) continue;
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          const imported = (element.propertyName ?? element.name).text;
          if (XTERM.has(from) && imported === 'Terminal') constructors.add(element.name.text);
          if (/(^@\/lib|\/lib)\/terminal$/.test(from) && imported === 'stopWheelTyping') guards.add(element.name.text);
        }
      }
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)
        && (node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : node.name.text) === 'Terminal') {
        let declaration: ts.Node = node;
        while (declaration && !ts.isVariableDeclaration(declaration)) declaration = declaration.parent;
        if (declaration && (declaration as ts.VariableDeclaration).initializer && contains((declaration as ts.VariableDeclaration).initializer!, isXtermImport)) {
          constructors.add(node.name.text);
        }
      }
    }

    const sites: Site[] = [];
    for (const node of all) {
      if (!ts.isNewExpression(node)) continue;
      const callee = node.expression;
      const isTerminal = (ts.isIdentifier(callee) && constructors.has(callee.text))
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Terminal');
      if (!isTerminal) continue;

      let holder: ts.Node = node.parent;
      while (ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder) || ts.isNonNullExpression(holder)) holder = holder.parent;
      if (!ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name)) {
        sites.push({ file, line: lineOf(node), terminal: '?', problem: 'the terminal is not held in a variable this test can follow' });
        continue;
      }
      const terminal = holder.name.text;

      let scope: ts.Node = node.parent;
      while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      const inScope = descendants(scope).filter(ts.isCallExpression);
      const opens = inScope.filter(call => ts.isPropertyAccessExpression(call.expression)
        && call.expression.name.text === 'open'
        && ts.isIdentifier(call.expression.expression)
        && call.expression.expression.text === terminal);
      const guarded = inScope.filter(call => ts.isIdentifier(call.expression)
        && guards.has(call.expression.text)
        && call.arguments.length === 1
        && ts.isIdentifier(call.arguments[0])
        && call.arguments[0].text === terminal);

      let problem: string | null = null;
      if (opens.length === 0) problem = `${terminal}.open() is not called where ${terminal} is made`;
      else if (guards.size === 0) problem = 'stopWheelTyping is not imported from @/lib/terminal';
      else if (!guarded.some(call => call.getStart(source) > opens[0].getEnd())) problem = `stopWheelTyping(${terminal}) does not follow ${terminal}.open()`;
      sites.push({ file, line: lineOf(node), terminal, problem });
    }
    return sites;
  }

  const scan = (root: string) => sources(root).flatMap(file => sitesIn(path.relative(ROOT, file), readText(file)));

  const SITES = scan(SRC);

  it('finds the terminals by reading src', () => {
    // No list of which: a terminal added tomorrow is found the same way and
    // held to the same rule below.
    expect(SITES.length, SITES.map(s => `${s.file}:${s.line}`).join('\n')).toBeGreaterThan(0);
  });

  it.each(SITES)('$file:$line stops the wheel of $terminal after opening it', (site: Site) => {
    expect(site.problem).toBeNull();
  });

  /**
   * The controls for the scan, the only part of this that could pass by seeing
   * nothing. Each real site with its guard taken out must be caught, and so
   * must the shapes a careless check would let through.
   */
  describe('the scan itself', () => {
    it.each(SITES)('catches $file:$line with its stopWheelTyping call taken out', (site: Site) => {
      const text = readText(path.join(ROOT, site.file));
      const call = `stopWheelTyping(${site.terminal});`;
      expect(text).toContain(call);
      const without = text.replace(call, '');

      const again = sitesIn(site.file, without).find(s => s.line === site.line);
      expect(again?.problem).toBe(`stopWheelTyping(${site.terminal}) does not follow ${site.terminal}.open()`);
    });

    const planted = (body: string, imports = "import { Terminal } from 'xterm';\nimport { stopWheelTyping } from '@/lib/terminal';\n") =>
      sitesIn('Planted.tsx', `${imports}\nexport async function mount(el: HTMLElement) {\n${body}\n}\n`);

    it('passes a guard right after the open', () => {
      expect(planted('const term = new Terminal({});\nterm.open(el);\nstopWheelTyping(term);')).toEqual([
        expect.objectContaining({ terminal: 'term', problem: null }),
      ]);
    });

    it('catches a guard called before the open, when the element does not exist yet', () => {
      expect(planted('const term = new Terminal({});\nstopWheelTyping(term);\nterm.open(el);')[0].problem)
        .toBe('stopWheelTyping(term) does not follow term.open()');
    });

    it('catches the second of two terminals when only the first is guarded', () => {
      const sites = planted('const a = new Terminal({});\nconst b = new Terminal({});\na.open(el);\nb.open(el);\nstopWheelTyping(a);');
      expect(sites.map(s => [s.terminal, s.problem])).toEqual([
        ['a', null],
        ['b', 'stopWheelTyping(b) does not follow b.open()'],
      ]);
    });

    it('catches a guard of the same name that is not the one from @/lib/terminal', () => {
      const sites = planted(
        'const term = new Terminal({});\nterm.open(el);\nstopWheelTyping(term);',
        "import { Terminal } from 'xterm';\nconst stopWheelTyping = (t: unknown) => t;\n",
      );
      expect(sites[0].problem).toBe('stopWheelTyping is not imported from @/lib/terminal');
    });

    it('finds a terminal made from an aliased import, a dynamic import, or a module object', () => {
      const aliased = planted('const x = new XTerm({});\nx.open(el);', "import { Terminal as XTerm } from 'xterm';\nimport { stopWheelTyping } from '@/lib/terminal';\n");
      const dynamic = planted("const { Terminal: T } = await import('xterm');\nconst y = new T({});\ny.open(el);");
      const members = planted('const z = new modules.Terminal({});\nz.open(el);');
      for (const sites of [aliased, dynamic, members]) {
        expect(sites).toHaveLength(1);
        expect(sites[0].problem).toMatch(/does not follow/);
      }
    });

    it('does not count a terminal named in a comment or a type', () => {
      const sites = planted(
        '// const term = new Terminal({}); term.open(el);\nlet later: Terminal | null = null;\nreturn later;',
        "import type { Terminal } from 'xterm';\n",
      );
      expect(sites).toEqual([]);
    });

    it('reads a source with NUL bytes in it rather than stepping over it', () => {
      // PluginsTab.tsx held raw NUL bytes, and every grep in use here took it
      // for a binary and skipped it without a word.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nul-terminal-'));
      try {
        fs.writeFileSync(
          path.join(dir, 'Planted.tsx'),
          "import { Terminal } from 'xterm';\nconst marker = ' ';\nexport function mount(el: HTMLElement) {\n  const term = new Terminal({});\n  term.open(el);\n}\n",
        );
        expect(fs.readFileSync(path.join(dir, 'Planted.tsx')).includes(0x00)).toBe(true);

        const found = scan(dir);
        expect(found).toHaveLength(1);
        expect(found[0].problem).toBe('stopWheelTyping is not imported from @/lib/terminal');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
