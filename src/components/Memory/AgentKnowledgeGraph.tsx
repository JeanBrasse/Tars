'use client';

import { useEffect, useMemo, useRef, useState, useCallback, useLayoutEffect } from 'react';
import type { AgentStatus, ProjectMemory } from '@/types/electron';
import { SimpleMarkdown } from '@/components/VaultView/components/MarkdownRenderer';
import { BrandSpinner, Button, Panel, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';

// ── Node / edge types ─────────────────────────────────────────────────────────

type NodeKind = 'project' | 'agent' | 'skill' | 'memory' | 'instructions' | 'plugin' | 'mcp';

interface NodeMeta {
  filePath?: string;     // for memory / instructions
  skillPath?: string;    // for skill nodes - path on disk
  description?: string;  // for plugins / skills
  command?: string;      // for mcp nodes
  args?: string;         // for mcp nodes
  editable?: boolean;    // whether the panel allows editing
}

interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** Mono second line inside the box - `3 memory files`, `mcp server`, a model name. */
  sub?: string;
  tone?: StatusTone;
  meta?: NodeMeta;
}

/** A node once the static layout has given it a place in the diagram. */
type PlacedNode = GraphNode & { x: number; y: number };

interface GraphEdge {
  source: string;
  target: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Static diagram geometry ───────────────────────────────────────────────────
//
// The graph used to be a force simulation drawn on a canvas: coloured glowing
// circles that moved for a second every time anything changed. It is a box
// diagram now - the same nodes and the same edges, but placed once, in rings
// around the project, so the picture is the same every time you open it.

const BOX_W = 176;
const BOX_H = 46;

/** Map zoom range. 25% shows a forty-agent graph whole; 200% reads a label. */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
/** Horizontal breathing room between two boxes sharing a ring. */
const BOX_GAP = 28;
/** Minimum distance between one ring and the next. */
const RING_GAP = 132;

const RING_OF: Record<NodeKind, number> = {
  project: 0,
  agent: 1,
  memory: 2,
  instructions: 2,
  skill: 3,
  plugin: 3,
  mcp: 3,
};

/** The mono sub-line for everything that is not an agent or a project. */
const KIND_SUB: Record<NodeKind, string> = {
  project: '',
  agent: '',
  skill: 'skill',
  memory: 'memory file',
  instructions: 'instructions',
  plugin: 'plugin',
  mcp: 'mcp server',
};

function agentTone(status: AgentStatus['status']): StatusTone {
  if (status === 'running') return 'running';
  if (status === 'waiting') return 'waiting';
  if (status === 'error') return 'error';
  return 'idle';
}

/**
 * Places every node on a ring: project in the middle, agents around it, the
 * files they read next, then the tools they share on the outside.
 *
 * A ring is widened until its circumference can hold its boxes, so the diagram
 * grows outwards instead of overlapping itself; the scroller around it takes
 * care of the rest.
 */
function layoutGraph(graph: GraphData): { nodes: PlacedNode[]; size: number } {
  const agentRank = new Map<string, number>();
  graph.nodes.filter(n => n.kind === 'agent').forEach((n, i) => agentRank.set(n.id, i));

  // Keep everything hanging off the same agent together on its ring, so the
  // edges fan out instead of crossing the whole diagram.
  const ownerRank = (id: string) => {
    for (const edge of graph.edges) {
      if (edge.target === id && agentRank.has(edge.source)) return agentRank.get(edge.source)!;
      if (edge.source === id && agentRank.has(edge.target)) return agentRank.get(edge.target)!;
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const rings: GraphNode[][] = [[], [], [], []];
  for (const nd of graph.nodes) rings[RING_OF[nd.kind]].push(nd);
  for (let r = 2; r < rings.length; r++) {
    rings[r].sort((a, b) => ownerRank(a.id) - ownerRank(b.id) || a.label.localeCompare(b.label));
  }

  const radii: number[] = [];
  let previous = 0;
  rings.forEach((ring, r) => {
    if (!ring.length) { radii[r] = previous; return; }
    if (r === 0 && ring.length === 1) { radii[0] = 0; previous = 0; return; }
    const needed = (ring.length * (BOX_W + BOX_GAP)) / (2 * Math.PI);
    const radius = Math.max(previous + RING_GAP, needed);
    radii[r] = radius;
    previous = radius;
  });

  const outer = radii.length ? Math.max(...radii) : 0;
  const size = Math.max(480, Math.round(2 * (outer + BOX_W / 2 + 32)));
  const centre = size / 2;

  const nodes: PlacedNode[] = [];
  rings.forEach((ring, r) => {
    const radius = radii[r] ?? 0;
    const step = (2 * Math.PI) / Math.max(ring.length, 1);
    ring.forEach((nd, i) => {
      const angle = -Math.PI / 2 + i * step;
      nodes.push({
        ...nd,
        x: radius === 0 ? centre : centre + Math.cos(angle) * radius,
        y: radius === 0 ? centre : centre + Math.sin(angle) * radius,
      });
    });
  });

  return { nodes, size };
}

// ── Data types ────────────────────────────────────────────────────────────────

type McpEntry = { command?: string; args?: string[] };
type ClaudeDataType = {
  plugins: Array<{ name?: string; displayName?: string; enabled?: boolean }>;
  skills: Array<{ name: string; source: string; path: string; description?: string }>;
  settings?: unknown;
  mcpServers?: Record<string, McpEntry>;
  projectMcpServers?: Record<string, McpEntry & { projectPaths: string[] }>;
};

// { filePath > agentId[] | 'global' }
type InstructionFiles = Record<string, string[] | 'global'>;

// ── Build graph ───────────────────────────────────────────────────────────────

const normalPath = (p: string) => p?.replace(/\/$/, '').toLowerCase();

/** The memory folder that belongs to a project path, matched loosely by tail. */
function findMemory(memories: ProjectMemory[], projectPath: string) {
  const wanted = normalPath(projectPath ?? '');
  if (!wanted) return undefined;
  return memories.find(m =>
    normalPath(m.projectPath) === wanted ||
    normalPath(m.projectPath).endsWith('/' + wanted.split('/').pop())
  );
}

function buildGraph(
  agents: AgentStatus[],
  claudeData: ClaudeDataType | null,
  memories: ProjectMemory[],
  instructions: InstructionFiles,
  selectedAgentId: string | null,
): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const added = new Set<string>();
  const edgeSet = new Set<string>();

  const addNode = (node: GraphNode) => {
    if (added.has(node.id)) return;
    added.add(node.id);
    nodes.push(node);
  };

  const addEdge = (source: string, target: string) => {
    const key = `${source}>${target}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ source, target });
  };

  const relevantAgents = selectedAgentId
    ? agents.filter(a => a.id === selectedAgentId)
    : agents;

  // ── Project nodes (the middle of the diagram) ──
  for (const projectPath of [...new Set(relevantAgents.map(a => a.projectPath).filter(Boolean))]) {
    const memory = findMemory(memories, projectPath);
    const fileCount = memory?.hasMemory ? memory.files?.length ?? 0 : 0;
    addNode({
      id: `project:${projectPath}`,
      label: memory?.projectName || projectPath.split('/').filter(Boolean).pop() || projectPath,
      kind: 'project',
      sub: `${fileCount} memory file${fileCount === 1 ? '' : 's'}`,
    });
  }

  // ── Agent nodes ──
  relevantAgents.forEach(agent => {
    addNode({
      id: agent.id,
      label: agent.name || `Agent ${agent.id.slice(0, 6)}`,
      kind: 'agent',
      sub: agent.model || agent.localModel || agent.provider || 'claude',
      tone: agentTone(agent.status),
    });

    if (agent.projectPath) addEdge(`project:${agent.projectPath}`, agent.id);

    // ── Agent skills ──
    for (const skillName of agent.skills ?? []) {
      const skillId = `skill:${skillName}`;
      if (!added.has(skillId)) {
        const skillMeta = claudeData?.skills?.find(s => s.name === skillName);
        addNode({
          id: skillId, label: skillName, kind: 'skill', sub: KIND_SUB.skill,
          meta: { skillPath: skillMeta?.path, description: skillMeta?.description },
        });
      }
      addEdge(agent.id, skillId);
    }

    // ── Memory files (MEMORY.md etc.) for this agent's project ──
    const agentMemory = findMemory(memories, agent.projectPath ?? '');

    if (agentMemory?.hasMemory && agentMemory.files?.length) {
      agentMemory.files.forEach(file => {
        const memId = `mem:${file.path}`;
        if (!added.has(memId)) {
          addNode({
            id: memId, label: file.name, kind: 'memory', sub: KIND_SUB.memory,
            meta: { filePath: file.path, editable: true },
          });
        }
        addEdge(agent.id, memId);
      });
    }
    // No fallback node - if there's no memory file, don't show one
  });

  // ── Instruction files (CLAUDE.md) ──
  // Show a clean ~/-prefixed path as label
  const toShortPath = (fp: string) =>
    fp.replace(/^\/(?:Users|home)\/[^/]+\//, '~/').replace(/^\/Users\/[^/]+\//, '~/');

  for (const [filePath, scope] of Object.entries(instructions)) {
    const label = toShortPath(filePath);
    const instrId = `instr:${filePath}`;
    const connectTo = scope === 'global' ? relevantAgents.map(a => a.id) : (scope as string[]);

    if (!added.has(instrId)) {
      addNode({
        id: instrId, label, kind: 'instructions', sub: KIND_SUB.instructions,
        meta: { filePath, editable: true },
      });
    }
    for (const agentId of connectTo) {
      if (relevantAgents.some(a => a.id === agentId)) addEdge(agentId, instrId);
    }
  }

  // ── Global plugins (connect to all agents) ──
  if (claudeData?.plugins?.length) {
    for (const plugin of claudeData.plugins.slice(0, 15)) {
      const p = plugin as { name?: string; displayName?: string };
      const name = (p.name ?? p.displayName ?? 'plugin').toString();
      const pluginId = `plugin:${name}`;
      if (!added.has(pluginId)) {
        const pFull = plugin as { name?: string; displayName?: string; description?: string };
        addNode({
          id: pluginId, label: name, kind: 'plugin', sub: KIND_SUB.plugin,
          meta: { description: pFull.description ?? '' },
        });
      }
      for (const agent of relevantAgents) {
        addEdge(agent.id, pluginId);
      }
    }
  }

  // ── MCP servers from ~/.claude/mcp.json (global - connect to all agents) ──
  const mcpServers = claudeData?.mcpServers;
  if (mcpServers) {
    for (const [mcpName, mcpCfg] of Object.entries(mcpServers).slice(0, 20)) {
      const mcpId = `mcp:${mcpName}`;
      if (!added.has(mcpId)) {
        addNode({
          id: mcpId, label: mcpName, kind: 'mcp', sub: KIND_SUB.mcp,
          meta: {
            command: mcpCfg?.command ?? '',
            args: mcpCfg?.args ? JSON.stringify(mcpCfg.args) : '',
          },
        });
      }
      for (const agent of relevantAgents) {
        addEdge(agent.id, mcpId);
      }
    }
  }

  // ── Per-project MCP servers (only for agents whose project has that MCP) ──
  const projectMcpServers = claudeData?.projectMcpServers;
  if (projectMcpServers) {
    for (const [mcpName, entry] of Object.entries(projectMcpServers).slice(0, 30)) {
      for (const agent of relevantAgents) {
        const hasAccess = entry.projectPaths.some(p => agent.projectPath === p);
        if (!hasAccess) continue;
        const mcpId = `mcp:${mcpName}`;
        if (!added.has(mcpId)) {
          addNode({
            id: mcpId, label: mcpName, kind: 'mcp', sub: KIND_SUB.mcp,
            meta: { command: entry.command ?? '', args: entry.args ? JSON.stringify(entry.args) : '' },
          });
        }
        addEdge(agent.id, mcpId);
      }
    }
  }

  return { nodes, edges };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AgentKnowledgeGraph() {
  const claudeDataRef    = useRef<ClaudeDataType | null>(null);
  const memoriesRef      = useRef<ProjectMemory[]>([]);
  const instructionsRef  = useRef<InstructionFiles>({});

  const [loading, setLoading] = useState(true);
  const [graphBuilding, setGraphBuilding] = useState(false);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });

  // ── Side panel state ──
  /**
   * Map zoom.
   *
   * The map is laid out at a fixed pixel size that grows with the number of
   * agents, inside a plain scroll container. Past a couple of dozen nodes the
   * stage is several times the viewport and there was no way to pull back and
   * see the shape of it: the map could only be scrolled, never zoomed out.
   * Scaling the stage keeps the layout maths in unscaled pixels, so hit
   * targets, edges and text stay in register at every step.
   */
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  /** The element that carries the zoom scale, used to anchor it at the pointer. */
  const scaledRef = useRef<HTMLDivElement>(null);

  const [panelNode, setPanelNode] = useState<GraphNode | null>(null);
  const [panelContent, setPanelContent] = useState('');
  const [panelDraft, setPanelDraft] = useState('');
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelTab, setPanelTab] = useState<'write' | 'preview'>('write');

  // ── Load all data ──
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [agentList, claudeData, memResult, mcpResult] = await Promise.all([
        window.electronAPI?.agent.list().catch(() => []) ?? [],
        window.electronAPI?.claude?.getData().catch(() => null) ?? null,
        window.electronAPI?.memory?.listProjects().catch(() => ({ projects: [], error: null })) ?? { projects: [], error: null },
        window.electronAPI?.fs?.readTextFile('~/.claude/mcp.json').catch(() => null) ?? null,
      ]);

      const typedAgents = agentList as AgentStatus[];
      const typedClaude = claudeData as ClaudeDataType | null;
      const memories = (memResult as { projects: ProjectMemory[] })?.projects ?? [];

      // Parse MCP servers from mcp.json
      let mcpServers: Record<string, McpEntry> | undefined;
      try {
        const mcpJson = (mcpResult as { output?: string } | null)?.output;
        if (mcpJson) {
          const parsed = JSON.parse(mcpJson);
          mcpServers = parsed?.mcpServers ?? undefined;
        }
      } catch { /* ignore parse errors */ }

      // enrichedClaude is built later after project MCPs are loaded
      // (placeholder - filled in after CLAUDE.md/MCP discovery below)
      claudeDataRef.current = null; // reset; will be set after discovery
      memoriesRef.current = memories;

      // ── Discover CLAUDE.md instruction files ──
      const typedAgentsCast = typedAgents as AgentStatus[];
      const uniqueProjectPaths = [...new Set(typedAgentsCast.map(a => a.projectPath).filter(Boolean))];

      // Only include the CLAUDE.md files that are actually loaded per agent:
      // - ~/.claude/CLAUDE.md  (global Claude config)
      // - ~/.dorothy/CLAUDE.md (global Tars config)
      // - {projectPath}/CLAUDE.md and {projectPath}/.claude/CLAUDE.md per agent
      const homeFiles = await window.electronAPI?.fs?.readProjectFiles({
        paths: uniqueProjectPaths,
        relative: ['CLAUDE.md', '.claude/CLAUDE.md'],
      }).catch(() => null);
      const claudeMdResult = { output: Object.keys(homeFiles?.files ?? {}).join('\n') };
      const instrFiles: InstructionFiles = {};
      // shell:exec via PTY may include \r and ANSI codes - strip them
      const rawOutput = (claudeMdResult as { output?: string; error?: string } | null)?.output
        ?? (claudeMdResult as { output?: string; error?: string } | null)?.error
        ?? '';
      // eslint-disable-next-line no-control-regex
      const cleanOutput = rawOutput.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
      const foundPaths = cleanOutput.split('\n').map(l => l.trim()).filter(l => l.startsWith('/'));
      for (const fp of foundPaths) {
        // Global: ~/.claude/ or ~/.dorothy/ files
        const isGlobal = (fp.includes('/.claude/') && !fp.includes('/.claude/projects/'))
          || fp.includes('/.dorothy/');
        if (isGlobal) {
          instrFiles[fp] = 'global';
        } else {
          // Project-specific: match to agents whose projectPath contains this file
          const matchingIds = typedAgentsCast
            .filter(a => a.projectPath && fp.startsWith(a.projectPath + '/'))
            .map(a => a.id);
          instrFiles[fp] = matchingIds.length > 0 ? matchingIds : 'global';
        }
      }
      instructionsRef.current = instrFiles;

      // ── Load per-project MCP servers (.mcp.json / .claude/mcp.json) ──
      const mcpFiles = await window.electronAPI?.fs?.readProjectFiles({
        paths: uniqueProjectPaths,
        relative: ['.mcp.json', '.claude/mcp.json'],
      }).catch(() => null);
      const projectMcpResults = await Promise.all(
        uniqueProjectPaths.map(async p => {
          const found = Object.entries(mcpFiles?.files ?? {}).find(([k]) => k.startsWith(p + '/'));
          const output = (found?.[1] ?? '').replace(/\r/g, '').trim();

          if (!output) return null;
          try {
            const parsed = JSON.parse(output);
            const servers = parsed?.mcpServers ?? parsed;
            return { projectPath: p, servers };
          } catch { return null; }
        }),
      );
      const projectMcpServers: Record<string, McpEntry & { projectPaths: string[] }> = {};
      for (const result of projectMcpResults) {
        if (!result) continue;
        for (const [name, cfg] of Object.entries(result.servers ?? {})) {
          const c = cfg as McpEntry;
          if (!projectMcpServers[name]) {
            projectMcpServers[name] = { command: c.command, args: c.args, projectPaths: [] };
          }
          projectMcpServers[name].projectPaths.push(result.projectPath);
        }
      }

      // Build final enriched claude data including project MCPs
      const enrichedClaude: ClaudeDataType | null = typedClaude
        ? { ...typedClaude, mcpServers, projectMcpServers }
        : (mcpServers || Object.keys(projectMcpServers).length > 0)
          ? { plugins: [], skills: [], mcpServers, projectMcpServers }
          : null;
      claudeDataRef.current = enrichedClaude;

      setAgents(typedAgents);

      // The whole project, not one agent: the diagram is about what the agents
      // share. Clicking an agent box still isolates it (and clicking it again
      // brings the others back) - that is what the filter pills used to do.
      setSelectedAgentId(null);

      setGraph(buildGraph(typedAgents, enrichedClaude, memories, instrFiles, null));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Rebuild when agent filter changes
  useEffect(() => {
    if (loading) return;
    setGraphBuilding(true);
    setGraph(buildGraph(
      agents,
      claudeDataRef.current,
      memoriesRef.current,
      instructionsRef.current,
      selectedAgentId,
    ));
    // Brief delay so the spinner is visible before the new graph renders
    const timer = setTimeout(() => setGraphBuilding(false), 300);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId, agents]);

  const { nodes, size } = useMemo(() => layoutGraph(graph), [graph]);
  const placedById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const openPanel = useCallback(async (node: GraphNode) => {
    setPanelNode(node);
    setPanelLoading(true);
    setPanelTab('preview');
    try {
      let content = '';
      if (node.kind === 'memory' && node.meta?.filePath) {
        const res = await window.electronAPI?.memory?.readFile(node.meta.filePath);
        content = res?.content ?? '';
      } else if (node.kind === 'instructions' && node.meta?.filePath) {
        const fp = node.meta.filePath.replace(/^~/, '');
        const res = await window.electronAPI?.fs?.readTextFile(fp);
        content = res?.content ?? '';
      } else if (node.kind === 'skill' && node.meta?.skillPath) {
        const p = node.meta.skillPath;
        const docs = await window.electronAPI?.fs?.readProjectFiles({
          paths: [p], relative: ['AGENTS.md', 'SKILL.md', 'skills/SKILL.md', 'README.md'],
        }).catch(() => null);
        content = Object.values(docs?.files ?? {})[0] ?? '_No documentation found._';
        setPanelTab('preview');
      } else if (node.kind === 'plugin') {
        content = node.meta?.description
          ? `# ${node.label}\n\n${node.meta.description}`
          : `# ${node.label}\n\n_No description available._`;
        setPanelTab('preview');
      } else if (node.kind === 'mcp') {
        const cmd = node.meta?.command ?? '';
        const args = node.meta?.args ?? '';
        content = `# ${node.label}\n\n**Command:** \`${cmd}\`\n\n**Args:** \`${args || 'none'}\``;
        setPanelTab('preview');
      }
      setPanelContent(content);
      setPanelDraft(content);
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const savePanel = useCallback(async () => {
    if (!panelNode?.meta?.filePath) return;
    const fp = panelNode.meta.filePath;
    if (panelNode.kind === 'memory') {
      await window.electronAPI?.memory?.writeFile(fp, panelDraft);
    } else {
      // For instruction files outside ~/.claude/projects/
      await window.electronAPI?.fs?.writeTextFile({ filePath: fp, content: panelDraft });
    }
    setPanelContent(panelDraft);
  }, [panelNode, panelDraft]);

  const handleNodeClick = useCallback((node: GraphNode) => {
    if (node.kind === 'agent') {
      setSelectedAgentId(prev => (prev === node.id ? null : node.id));
    } else if (node.kind !== 'project') {
      openPanel(node);
    }
  }, [openPanel]);

  /** The scale at which the whole stage fits the viewport, never magnifying. */
  const fitZoom = useCallback(() => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box || size === 0) return 1;
    // 32px of padding on both axes, matching the p-4 the stage sits in.
    return clampZoom(Math.min((box.width - 32) / size, (box.height - 32) / size));
  }, [size]);

  // Open on a map that fits. A user with forty agents should see the shape of
  // the graph first and zoom in on a corner second, not land inside one.
  const fittedFor = useRef<number | null>(null);
  useEffect(() => {
    if (nodes.length === 0 || fittedFor.current === size) return;
    fittedFor.current = size;
    setZoom(fitZoom());
  }, [size, nodes.length, fitZoom]);

  /**
   * Where the pointer was when the zoom gesture started, and which point of
   * the graph was under it. Scaling the stage alone leaves the scroll offset
   * where it was, so the viewport's top-left corner stays put and the graph
   * appears to zoom at the same spot wherever the pointer is. Keeping the
   * point under the pointer means correcting the scroll by however far it
   * moved, which can only be measured after the browser has laid the new
   * scale out.
   */
  const pendingAnchor = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);

  // Ctrl/Cmd + wheel is the zoom gesture everywhere else, including the pinch
  // a trackpad reports. Without the listener the browser zooms the whole app.
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const el = stageRef.current;
    const inner = scaledRef.current;
    if (el && inner) {
      const stage = inner.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      pendingAnchor.current = {
        px: (e.clientX - stage.left) / zoom,
        py: (e.clientY - stage.top) / zoom,
        cx: e.clientX - box.left,
        cy: e.clientY - box.top,
      };
    }
    setZoom(z => clampZoom(z * (e.deltaY > 0 ? 0.92 : 1.08)));
  }, [zoom]);

  // Measured rather than derived: the stage is centred while it is smaller
  // than the viewport and scrolled once it is bigger, so where a point lands
  // depends on padding and centring this does not need to model.
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    const el = stageRef.current;
    const inner = scaledRef.current;
    if (!anchor || !el || !inner) return;
    const stage = inner.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    el.scrollLeft += (stage.left - box.left) + anchor.px * zoom - anchor.cx;
    el.scrollTop += (stage.top - box.top) + anchor.py * zoom - anchor.cy;
  }, [zoom]);

  return (
    <Panel fill padded={false} className="relative w-full overflow-hidden">
      {/* Zoom controls. Words, not glyphs, at the 26px row height. */}
      {nodes.length > 0 && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1 border border-border bg-card p-1">
          <Button
            size="sm"
            className="font-mono w-7 justify-center"
            aria-label="Zoom out"
            disabled={zoom <= ZOOM_MIN}
            onClick={() => setZoom(z => clampZoom(z - ZOOM_STEP))}
          >
            &minus;
          </Button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            title="Back to 100%"
            className="h-[26px] w-12 shrink-0 font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button
            size="sm"
            className="font-mono w-7 justify-center"
            aria-label="Zoom in"
            disabled={zoom >= ZOOM_MAX}
            onClick={() => setZoom(z => clampZoom(z + ZOOM_STEP))}
          >
            +
          </Button>
          <Button size="sm" className="font-mono" onClick={() => setZoom(fitZoom())}>
            fit
          </Button>
        </div>
      )}

      {/* Diagram */}
      <div ref={stageRef} className="absolute inset-0 overflow-auto" onWheel={onWheel}>
        <div className="min-w-full min-h-full flex items-center justify-center p-4">
          {nodes.length === 0 && !loading ? (
            <p className="text-xs text-muted-foreground">No agents to map yet.</p>
          ) : (
            <div
              ref={scaledRef}
              className="relative shrink-0"
              style={{
                width: size * zoom,
                height: size * zoom,
              }}
            >
              <div
                className="absolute left-0 top-0 origin-top-left"
                style={{ width: size, height: size, transform: `scale(${zoom})` }}
              >
              <svg
                width={size}
                height={size}
                className="absolute inset-0 pointer-events-none"
                aria-hidden
              >
                {graph.edges.map(edge => {
                  const a = placedById.get(edge.source);
                  const b = placedById.get(edge.target);
                  if (!a || !b) return null;
                  return (
                    <line
                      key={`${edge.source}>${edge.target}`}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke="var(--border-accent)"
                      strokeWidth={1}
                    />
                  );
                })}
              </svg>

              {nodes.map(node => (
                <button
                  key={node.id}
                  onClick={() => handleNodeClick(node)}
                  style={{
                    left: node.x - BOX_W / 2,
                    top: node.y - BOX_H / 2,
                    width: BOX_W,
                    height: BOX_H,
                  }}
                  className={`absolute flex flex-col justify-center gap-0.5 px-2.5 text-left border transition-colors cursor-pointer ${
                    node.kind === 'project'
                      ? 'border-primary bg-accent-dim'
                      : selectedAgentId === node.id
                        ? 'border-border-accent bg-secondary'
                        : 'border-border bg-card hover:bg-secondary'
                  }`}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <StatusSquare tone={node.tone ?? 'idle'} />
                    <span className="text-[12px] text-foreground truncate">{node.label}</span>
                  </span>
                  {node.sub && (
                    <span className="pl-3 text-[10px] font-mono text-muted-foreground truncate">
                      {node.sub}
                    </span>
                  )}
                </button>
              ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Loading overlay */}
      {(loading || graphBuilding) && (
        <div className="absolute inset-0 flex items-center justify-center bg-card transition-opacity">
          <div className="flex flex-col items-center gap-2">
            <BrandSpinner size={30} label={loading ? 'Loading agent graph' : undefined} />
            {graphBuilding && !loading && (
              <span className="text-[11px] text-muted-foreground">Switching agent</span>
            )}
          </div>
        </div>
      )}

      {/* What the picture means - the legend box and its coloured dots are gone
          with the colour-coded circles they described. */}
      <div className="absolute bottom-3 left-3 text-[11px] leading-relaxed text-muted-foreground pointer-events-none">
        <p>agents share this project&apos;s memory</p>
        <p>edges = files each one has written</p>
      </div>

      {/* Side panel */}
      {panelNode && (
        <div className="absolute top-0 right-0 bottom-0 w-[360px] bg-background border-l border-border flex flex-col z-20">
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
            <span className="flex-1 text-sm font-medium text-foreground truncate">{panelNode.label}</span>
            {panelNode.meta?.editable && (
              <>
                <Button
                  size="sm"
                  className="font-mono"
                  active={panelTab === 'write'}
                  onClick={() => setPanelTab('write')}
                >
                  edit
                </Button>
                <Button
                  size="sm"
                  className="font-mono"
                  active={panelTab === 'preview'}
                  onClick={() => setPanelTab('preview')}
                >
                  preview
                </Button>
              </>
            )}
            <Button size="sm" className="font-mono" onClick={() => setPanelNode(null)}>
              close
            </Button>
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {panelLoading ? (
              <div className="flex items-center justify-center h-full">
                <BrandSpinner size={30} label="Loading content" />
              </div>
            ) : panelNode.meta?.editable && panelTab === 'write' ? (
              <textarea
                value={panelDraft}
                onChange={e => setPanelDraft(e.target.value)}
                className="w-full h-full bg-transparent p-4 text-sm font-mono text-foreground resize-none outline-none leading-relaxed"
                spellCheck={false}
              />
            ) : (
              <div className="p-4 text-sm text-foreground">
                <SimpleMarkdown content={panelTab === 'write' ? panelContent : panelDraft} />
              </div>
            )}
          </div>

          {/* Footer - save button for editable files */}
          {panelNode.meta?.editable && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
              {panelDraft !== panelContent && (
                <span className="text-[10px] text-muted-foreground">Unsaved changes</span>
              )}
              <Button
                size="sm"
                variant="primary"
                className="ml-auto font-mono"
                onClick={savePanel}
                disabled={panelDraft === panelContent}
              >
                save
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
