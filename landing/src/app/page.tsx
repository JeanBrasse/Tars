'use client';

import { Download, Github } from 'lucide-react';
import { useState, useEffect } from 'react';

const FEATURES = [
  {
    title: 'Every agent, one screen',
    body: 'Real terminals in a grid, grouped by project. Watch six agents work at once, jump into any of them, broadcast one instruction to all.',
  },
  {
    title: 'Delegation that reports back',
    body: 'An orchestrator hands work over the Agent Client Protocol, not by typing into a terminal and hoping. Every task returns a stop reason and what it cost.',
  },
  {
    title: 'Deploy a whole team',
    body: 'One click puts an orchestrator, frontend, backend, QA, audit and database engineer on a project \u2014 each on its own git worktree, model and brief.',
  },
  {
    title: 'Any CLI, any model',
    body: 'Claude, Codex, Gemini, Grok, OpenCode, DeepSeek, Kimi, MiniMax and a dozen more. Model lists and prices come from a live catalogue, so today\u2019s release is here today.',
  },
  {
    title: 'One memory, five sources',
    body: 'Project files, the session ledger, your Hermes gateway, gbrain and Honcho behind one interface \u2014 reachable by every CLI, not just the ones with hooks.',
  },
  {
    title: 'See what they actually did',
    body: 'A diff review of every branch, one search across the whole fleet\u2019s output, and per-provider spend against the budget you set.',
  },
];

export default function Home() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/stats').then(r => r.json()).then(d => setCount(d.total)).catch(() => { });
  }, []);

  return (
    <main className="min-h-screen bg-bg text-ink">
      <nav className="max-w-[1040px] mx-auto px-6 py-6 flex items-center justify-between">
        <a href="#" className="flex items-center gap-2.5">
          <span className="inline-block w-2.5 h-2.5 bg-accent" />
          <span className="font-display text-xl">Tars</span>
        </a>
        <div className="hidden md:flex items-center gap-8 text-[13px] text-ink-soft">
          <a href="#features" className="hover:text-ink transition-colors">Features</a>
          <a href="#how" className="hover:text-ink transition-colors">How it works</a>
          <a href="#download" className="hover:text-ink transition-colors">Download</a>
        </div>
        <div className="flex items-center gap-4">
          <a href="https://github.com/JeanBrasse/Tars" target="_blank" rel="noopener noreferrer" className="text-ink-soft hover:text-ink transition-colors">
            <Github className="w-[18px] h-[18px]" />
          </a>
          <a href="#download" className="hidden sm:flex items-center gap-1.5 px-4 py-2 bg-accent text-bg text-[13px] font-medium hover:bg-accent-deep transition-colors">
            <Download className="w-3.5 h-3.5" />
            Download
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-[1040px] mx-auto px-6 pt-16 pb-20 border-b border-line">
        <p className="font-mono text-xs text-accent mb-5">A control room for AI coding agents</p>
        <h1 className="font-display text-5xl md:text-7xl leading-[1.05] max-w-3xl mb-6">
          Run a team of agents like you run a team of engineers.
        </h1>
        <p className="text-ink-soft text-[15px] leading-relaxed max-w-xl mb-9">
          Tars puts every agent in one place: parallel terminals per project, teams you deploy in a
          click, one memory they all share, and delegation that reports back instead of hoping.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <a href="#download" className="flex items-center gap-2 px-5 py-2.5 bg-accent text-bg text-sm font-medium hover:bg-accent-deep transition-colors">
            <Download className="w-4 h-4" />
            Download for Mac
          </a>
          <a href="https://github.com/JeanBrasse/Tars" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-5 py-2.5 border border-line-strong text-sm text-ink-soft hover:text-ink transition-colors">
            <Github className="w-4 h-4" />
            Source
          </a>
          {count !== null && (
            <span className="font-mono text-xs text-ink-muted">{count.toLocaleString()} downloads</span>
          )}
        </div>
      </section>

      {/* Terminal sketch */}
      <section className="max-w-[1040px] mx-auto px-6 py-16 border-b border-line">
        <div className="border border-line bg-surface">
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-line">
            <span className="font-mono text-xs text-ink">Tars</span>
            <span className="font-mono text-xs text-ink-muted">1212-Capital</span>
            <span className="font-mono text-xs text-ink-muted">sakartvelo</span>
            <span className="ml-auto font-mono text-xs text-ink-muted">2x2</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-line">
            {[
              { name: 'orchestrator', tone: 'text-ok', lines: ['delegate_task frontend \u00ab fix the scroll lock \u00bb', '\u2192 frontend  running   feat/frontend', '\u2713 backend   merged  \u2192 main', 'acp  stopReason=end_turn  $0.42'] },
              { name: 'frontend', tone: 'text-accent', lines: ['vitest run --changed', '184 passed (184)', 'apply patch to TerminalGrid.tsx? (y/n)', ''] },
              { name: 'backend', tone: 'text-ok', lines: ['npm run build', 'electron  tsc clean', 'bundling  mcp-memory \u2192 dist/bundle.js', 'watching\u2026'] },
              { name: 'qa', tone: 'text-ink-muted', lines: ['733 passed (733) in 4.3s', 'coverage  87.3%', '', ''] },
            ].map(p => (
              <div key={p.name} className="bg-surface p-4">
                <div className="flex items-center gap-2 mb-2.5">
                  <span className={`inline-block w-1.5 h-1.5 ${p.tone === 'text-ok' ? 'bg-ok' : p.tone === 'text-accent' ? 'bg-accent' : 'bg-ink-muted'}`} />
                  <span className="font-mono text-xs text-ink">{p.name}</span>
                </div>
                {p.lines.map((l, i) => (
                  <p key={i} className="font-mono text-[11px] text-ink-soft leading-relaxed">{l}</p>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-[1040px] mx-auto px-6 py-16 border-b border-line">
        <h2 className="font-display text-3xl mb-10">What it does</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-9">
          {FEATURES.map(f => (
            <div key={f.title}>
              <h3 className="text-base font-medium mb-2">{f.title}</h3>
              <p className="text-ink-soft text-[14px] leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How */}
      <section id="how" className="max-w-[1040px] mx-auto px-6 py-16 border-b border-line">
        <h2 className="font-display text-3xl mb-10">How it works</h2>
        <ol className="space-y-6">
          {[
            ['Point it at a folder', 'Add your project. Tars finds the CLIs already installed on your machine.'],
            ['Create an agent, or a team', 'One agent from a template, or a full engineering team with one worktree branch each.'],
            ['Let them work', 'Terminals stream live. The orchestrator delegates and gets an answer. Nothing starts without you asking.'],
            ['Wire in Hermes', 'Your own gateway schedules the recurring work, and its kanban board drives what the team picks up next.'],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-5">
              <span className="font-mono text-xs text-accent pt-1 shrink-0">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <h3 className="text-base font-medium mb-1">{t}</h3>
                <p className="text-ink-soft text-[14px] leading-relaxed">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Download */}
      <section id="download" className="max-w-[1040px] mx-auto px-6 py-20 text-center">
        <h2 className="font-display text-4xl mb-4">Get Tars</h2>
        <p className="text-ink-soft text-[15px] mb-8 max-w-md mx-auto">
          macOS desktop app. Free and open source. No account, no cloud in the middle.
        </p>
        <a href="/api/download" className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-bg text-sm font-medium hover:bg-accent-deep transition-colors">
          <Download className="w-4 h-4" />
          Download for Mac
        </a>
      </section>

      <footer className="border-t border-line">
        <div className="max-w-[1040px] mx-auto px-6 py-8 flex items-center justify-between">
          <span className="flex items-center gap-2.5">
            <span className="inline-block w-2 h-2 bg-accent" />
            <span className="font-display text-base">Tars</span>
          </span>
          <a href="https://github.com/JeanBrasse/Tars" target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-ink-muted hover:text-ink transition-colors">
            github
          </a>
        </div>
      </footer>
    </main>
  );
}
