'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Loader2,
  Package,
  CheckCircle,
  XCircle,
  X,
  Check,
  MonitorDown,
} from 'lucide-react';
import { useClaude } from '@/hooks/useClaude';
import { useElectronSkills } from '@/hooks/useElectron';
import { SKILLS_DATABASE, fetchSkillsPaginated, type Skill } from '@/lib/skills-database';
import { PROVIDER_REGISTRY } from '@/lib/providers';
import TerminalDialog from '@/components/TerminalDialog';
import ProviderBadge from '@/components/ProviderBadge';
import { Button, DialogShell, Input, Label } from '@/components/ui';

/** Providers with a local CLI binary that have their own skill directory */
const CLI_PROVIDER_IDS = PROVIDER_REGISTRY.filter((p) => p.requiresCli).map((p) => p.id);

const COL_STYLES = {
  rank: { width: '4%' },
  skill: { width: '30%' },
  repo: { width: '25%' },
  installs: { width: '10%' },
  status: { width: '31%' },
} as const;

export default function SkillsTab() {
  const { data, loading, error, refresh: refreshClaude } = useClaude();
  const { installedSkills, installedSkillsByProvider, isSkillInstalledOn, isElectron: hasElectron, linkToProvider, refresh: refreshSkills } = useElectronSkills();
  const [search, setSearch] = useState('');
  const [copiedSkill, setCopiedSkill] = useState<string | null>(null);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [showToast, setShowToast] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null);

  // Custom skill installation
  const [showCustomInstall, setShowCustomInstall] = useState(false);
  const [customRepo, setCustomRepo] = useState('');
  const [customSkillName, setCustomSkillName] = useState('');

  // Terminal modal for installation
  const [showInstallTerminal, setShowInstallTerminal] = useState(false);
  const [currentInstallRepo, setCurrentInstallRepo] = useState('');
  const [currentInstallTitle, setCurrentInstallTitle] = useState('');

  // Paginated skills data from skills.sh
  const PAGE_SIZE = 50;
  const [liveSkills, setLiveSkills] = useState<Skill[] | null>(null);
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalSkills, setTotalSkills] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [activeSearch, setActiveSearch] = useState('');

  const loadSkills = useCallback(async (page: number, searchQuery: string, append = false) => {
    if (page === 1) setLoadingSkills(true);
    else setLoadingMore(true);

    try {
      const result = await fetchSkillsPaginated({
        page,
        pageSize: PAGE_SIZE,
        search: searchQuery || undefined,
      });
      if (result) {
        if (append && page > 1) {
          setLiveSkills(prev => [...(prev || []), ...result.skills]);
        } else {
          setLiveSkills(result.skills);
        }
        setTotalSkills(result.total);
        setHasMore(result.hasMore);
        setCurrentPage(page);
      }
    } finally {
      setLoadingSkills(false);
      setLoadingMore(false);
    }
  }, []);

  // Initial load
  const initialLoadDone = useRef(false);
  useEffect(() => { loadSkills(1, ''); initialLoadDone.current = true; }, [loadSkills]);

  // Search with debounce - triggers server-side search
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Skip on initial mount (the initial load effect handles that)
    if (!initialLoadDone.current) return;

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setActiveSearch(search);
      loadSkills(1, search);
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search, loadSkills]);

  const skillsDatabase = liveSkills || SKILLS_DATABASE;

  const installedPlugins = data?.plugins || [];
  const installedSkillsFromClaude = data?.skills || [];

  const settings = data?.settings;

  // Get list of installed skill names (from all sources)
  const installedSkillNames = useMemo(() => {
    const fromPlugins = installedPlugins.map(p => p.name.toLowerCase());
    const fromClaudeSkills = installedSkillsFromClaude.map(s => s.name.toLowerCase());
    const fromElectron = installedSkills.map(s => s.toLowerCase());
    return [...new Set([...fromPlugins, ...fromClaudeSkills, ...fromElectron])];
  }, [installedPlugins, installedSkillsFromClaude, installedSkills]);

  // Check if a skill is installed
  const isSkillInstalled = (skillName: string) => {
    return installedSkillNames.includes(skillName.toLowerCase());
  };

  // Filter skills - client-side filter for instant feedback on currently loaded data.
  // The debounced search also triggers a server-side fetch for broader results.
  const filteredSkills = useMemo(() => {
    let skills = skillsDatabase;

    // If the local search differs from the active (server) search, apply client-side filter
    // on the loaded data for instant feedback while server results load
    if (search && search !== activeSearch) {
      const q = search.toLowerCase();
      skills = skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.repo.toLowerCase().includes(q)
      );
    }

    return skills;
  }, [search, activeSearch, skillsDatabase]);

  // Install skill directly (Electron only)
  const handleDirectInstall = async (repo: string, skillName: string) => {
    if (!hasElectron) {
      copyInstallCommand(repo, skillName);
      return;
    }

    const fullRepo = `${repo}/${skillName}`;
    setInstallingSkill(skillName);
    setCurrentInstallRepo(fullRepo);
    setCurrentInstallTitle(skillName);
    setShowInstallTerminal(true);
  };

  const copyInstallCommand = async (repo: string, skillName: string) => {
    const command = `npx skills add https://github.com/${repo} --skill ${skillName}`;
    try {
      await navigator.clipboard.writeText(command);
      setCopiedSkill(skillName);
      setShowToast({
        message: `Command copied! Open your terminal and paste to install "${skillName}"`,
        type: 'success',
      });
      setTimeout(() => {
        setCopiedSkill(null);
        setShowToast(null);
      }, 3000);
    } catch (err) {
      setShowToast({
        message: 'Failed to copy to clipboard',
        type: 'info',
      });
    }
  };

  const handleCustomInstall = async () => {
    if (!customRepo) return;

    const fullRepo = customSkillName ? `${customRepo}/${customSkillName}` : customRepo;

    if (hasElectron) {
      setInstallingSkill('custom');
      setCurrentInstallRepo(fullRepo);
      setCurrentInstallTitle(customSkillName || customRepo);
      setShowCustomInstall(false);
      setCustomRepo('');
      setCustomSkillName('');
      setShowInstallTerminal(true);
    } else {
      // Fallback to copy
      const command = customSkillName
        ? `npx skills add https://github.com/${customRepo} --skill ${customSkillName}`
        : `npx skills add https://github.com/${customRepo}`;
      try {
        await navigator.clipboard.writeText(command);
        setShowToast({
          message: 'Command copied! Open your terminal and paste to install.',
          type: 'success',
        });
        setCustomRepo('');
        setCustomSkillName('');
        setShowCustomInstall(false);
        setTimeout(() => setShowToast(null), 3000);
      } catch (err) {
        setShowToast({
          message: 'Failed to copy to clipboard',
          type: 'info',
        });
      }
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">Loading skills...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center text-danger">
          <p className="mb-2">Failed to load skills</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-muted-foreground text-xs lg:text-sm hidden sm:block">
            {hasElectron
              ? 'Install skills directly to enhance your AI Agents'
              : 'Browse and copy install commands for skills'
            }
          </p>
          <Button variant="primary" onClick={() => setShowCustomInstall(true)} className="shrink-0">
            + Custom Install
          </Button>
        </div>

        {/* Badges row - below on mobile */}
        <div className="flex flex-wrap items-center gap-2">
          {!hasElectron && (
            <div className="flex items-center gap-1.5 h-[26px] px-2.5 bg-warning/10 text-warning text-xs">
              <MonitorDown className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Desktop app for direct install</span>
              <span className="sm:hidden">Desktop only</span>
            </div>
          )}
          <div className="text-xs lg:text-sm text-muted-foreground">
            {totalSkills > 0 ? (
              <>
                Showing <span className="font-medium">{filteredSkills.length}</span>
                {totalSkills > filteredSkills.length && (
                  <> of <span className="font-medium">{totalSkills.toLocaleString()}</span></>
                )}
                {' '}skills
              </>
            ) : (
              <><span className="font-medium">{skillsDatabase.length}</span> skills</>
            )}
            {liveSkills && <span className="text-muted-foreground/60"> (live from skills.sh)</span>}
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {showToast && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`p-4 border flex items-center justify-between ${showToast.type === 'success'
              ? 'bg-primary/10 border-primary/30 text-primary'
              : showToast.type === 'error'
                ? 'bg-danger/10 border-danger/30 text-danger'
                : 'bg-secondary border-border text-foreground'
              }`}
          >
            <div className="flex items-center gap-3">
              {showToast.type === 'error' ? (
                <XCircle className="w-5 h-5" />
              ) : (
                <CheckCircle className="w-5 h-5" />
              )}
              <p className="text-sm">{showToast.message}</p>
            </div>
            <button onClick={() => setShowToast(null)} className="p-1 hover:opacity-70">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Custom Install Modal */}
      <DialogShell
        open={showCustomInstall}
        onClose={() => setShowCustomInstall(false)}
        title="Install Custom Skill"
        subtitle="Point at a GitHub repository and Tars runs the installer for you."
        footerRight={
          <>
            <Button onClick={() => setShowCustomInstall(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleCustomInstall}
              disabled={!customRepo || installingSkill === 'custom'}
            >
              {installingSkill === 'custom'
                ? 'Installing...'
                : hasElectron
                  ? 'Install Skill'
                  : 'Copy Install Command'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label>Repository (owner/repo)</Label>
            <Input
              type="text"
              mono
              value={customRepo}
              onChange={(e) => setCustomRepo(e.target.value)}
              placeholder="e.g., anthropics/skills"
            />
          </div>

          <div>
            <Label>Skill Name (optional)</Label>
            <Input
              type="text"
              mono
              value={customSkillName}
              onChange={(e) => setCustomSkillName(e.target.value)}
              placeholder="e.g., frontend-design"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty to install all skills from the repository
            </p>
          </div>

          <div className="p-3 bg-secondary border border-border font-mono text-xs text-muted-foreground">
            npx skills add https://github.com/{customRepo}{customSkillName ? ` --skill ${customSkillName}` : ''}
          </div>

          {!hasElectron && (
            <p className="text-xs text-muted-foreground">
              After copying, open your terminal and paste the command to install
            </p>
          )}
        </div>
      </DialogShell>

      {/* Search */}
      <div className="flex gap-3 mt-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search all skills on skills.sh..."
            className="w-full h-8 pl-10 pr-4 rounded-none text-sm"
          />
        </div>
      </div>

      {/* Skills Table */}
      <div className="flex-1 border border-border bg-card overflow-hidden flex flex-col min-h-0 mt-4">
        <div className="shrink-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary">
                <th style={COL_STYLES.rank} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">#</th>
                <th style={COL_STYLES.skill} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Skill</th>
                <th style={COL_STYLES.repo} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground hidden md:table-cell">Repository</th>
                <th style={COL_STYLES.installs} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground hidden lg:table-cell">Installs</th>
                <th style={COL_STYLES.status} className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
          </table>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {loadingSkills && !liveSkills ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mr-2" />
              <span className="text-sm text-muted-foreground">Loading skills from skills.sh...</span>
            </div>
          ) : (
            <table className="w-full">
              <tbody>
                {filteredSkills.map((skill) => {
                  const installed = isSkillInstalled(skill.name);
                  const justCopied = copiedSkill === skill.name;
                  const isInstalling = installingSkill === skill.name;

                  return (
                    <tr
                      key={`${skill.repo}-${skill.name}`}
                      className="border-b border-border/50 hover:bg-secondary/50 transition-colors"
                    >
                      <td style={COL_STYLES.rank} className="px-4 py-3 text-xs text-muted-foreground">
                        {skill.rank}
                      </td>
                      <td style={COL_STYLES.skill} className="px-4 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-8 h-8 flex items-center justify-center shrink-0 ${installed ? 'bg-primary/10' : 'bg-secondary'
                            }`}>
                            {installed ? (
                              <CheckCircle className="w-4 h-4 text-primary" />
                            ) : (
                              <Package className="w-4 h-4 text-muted-foreground" />
                            )}
                          </div>
                          <span className="font-medium text-sm truncate">{skill.name}</span>
                        </div>
                      </td>
                      <td style={COL_STYLES.repo} className="px-4 py-3 hidden md:table-cell">
                        <span className="text-xs text-muted-foreground font-mono truncate block">{skill.repo}</span>
                      </td>
                      <td style={COL_STYLES.installs} className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-xs text-muted-foreground">{skill.installs}</span>
                      </td>
                      <td style={COL_STYLES.status} className="px-4 py-3 text-right">
                        {installed ? (
                          <div className="inline-flex items-center gap-1">
                            {CLI_PROVIDER_IDS.map((pid) =>
                              isSkillInstalledOn(skill.name, pid) ? (
                                <ProviderBadge key={pid} provider={pid} />
                              ) : null
                            )}
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary text-[10px] font-medium ml-1">
                              <Check className="w-2.5 h-2.5" />
                              Installed
                            </span>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant={isInstalling || justCopied ? 'secondary' : 'primary'}
                            onClick={() => handleDirectInstall(skill.repo, skill.name)}
                            disabled={isInstalling}
                          >
                            {isInstalling ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Installing...
                              </>
                            ) : justCopied ? (
                              'Copied!'
                            ) : hasElectron ? (
                              'Install'
                            ) : (
                              'Copy'
                            )}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Load More button */}
          {hasMore && !loadingSkills && (
            <div className="flex justify-center py-6 border-t border-border/50">
              <Button
                onClick={() => loadSkills(currentPage + 1, activeSearch, true)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </>
                ) : (
                  `Load More (${Math.max(0, totalSkills - (liveSkills?.length || 0)).toLocaleString()} remaining)`
                )}
              </Button>
            </div>
          )}
        </div>
      </div>


      {/* Installation Terminal Modal */}
      <TerminalDialog
        open={showInstallTerminal}
        repo={currentInstallRepo}
        title={currentInstallTitle}
        availableProviders={CLI_PROVIDER_IDS}
        onClose={(success) => {
          setShowInstallTerminal(false);
          setInstallingSkill(null);
          // Always re-sync skills on close (install may have succeeded before terminal was closed)
          refreshSkills();
          refreshClaude();
          if (success) {
            setShowToast({
              message: `Successfully installed "${currentInstallRepo}"!`,
              type: 'success',
            });
            setTimeout(() => setShowToast(null), 4000);
          }
        }}
      />
    </div>
  );
}
