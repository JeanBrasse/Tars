'use client';

import { useState, useEffect, useCallback, memo } from 'react';
import {
  GitBranch,
  RefreshCw,
  GitCommit,
  Plus,
  Minus,
  FileDiff,
  FileText,
  Clock,
  User,
  ChevronRight,
  ChevronDown,
  Code2,
} from 'lucide-react';
import { BrandSpinner } from '@/components/ui';
import type { GitData } from './constants';
import { INITIAL_GIT_DATA } from './constants';

// Strip ANSI escape codes from string
const stripAnsi = (str: string): string => {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
};

interface GitPanelProps {
  projectPath: string;
  className?: string;
  hideHeader?: boolean;
  onBranchChange?: (branch: string) => void;
}

// Memoized commit item to prevent re-renders
const CommitItem = memo(function CommitItem({
  commit,
}: {
  commit: { hash: string; message: string; author: string; date: string };
}) {
  return (
    <div className="px-3 py-2 border-b border-border-primary/50 last:border-0 hover:bg-bg-tertiary/30">
      <div className="flex items-center gap-2">
        <code className="text-[10px] px-1.5 py-0.5 bg-primary/20 text-primary rounded">
          {commit.hash}
        </code>
        <span className="text-xs text-text-primary truncate flex-1">
          {commit.message}
        </span>
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-text-muted">
        <span className="flex items-center gap-1">
          <User className="w-2.5 h-2.5" />
          {commit.author}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="w-2.5 h-2.5" />
          {commit.date}
        </span>
      </div>
    </div>
  );
});

// Memoized file status item
const FileStatusItem = memo(function FileStatusItem({
  item,
}: {
  item: { status: string; file: string };
}) {
  const getStatusIcon = () => {
    switch (item.status) {
      case 'new':
        return <Plus className="w-3 h-3 text-primary shrink-0" />;
      case 'added':
        return <Plus className="w-3 h-3 text-success shrink-0" />;
      case 'deleted':
        return <Minus className="w-3 h-3 text-danger shrink-0" />;
      case 'modified':
        return <FileDiff className="w-3 h-3 text-warning shrink-0" />;
      case 'renamed':
        return <FileText className="w-3 h-3 text-primary shrink-0" />;
      default:
        return <FileDiff className="w-3 h-3 text-text-muted shrink-0" />;
    }
  };

  const getStatusColor = () => {
    switch (item.status) {
      case 'new':
        return 'text-primary';
      case 'added':
        return 'text-success';
      case 'deleted':
        return 'text-danger';
      case 'modified':
        return 'text-warning';
      case 'renamed':
        return 'text-primary';
      default:
        return 'text-text-secondary';
    }
  };

  const getStatusLabel = () => {
    switch (item.status) {
      case 'new':
        return 'N';
      case 'added':
        return 'A';
      case 'deleted':
        return 'D';
      case 'modified':
        return 'M';
      case 'renamed':
        return 'R';
      default:
        return '?';
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-bg-tertiary/30">
      {getStatusIcon()}
      <span className={`w-4 text-[10px] font-mono ${getStatusColor()}`}>{getStatusLabel()}</span>
      <span className={`truncate flex-1 ${getStatusColor()}`}>{item.file}</span>
    </div>
  );
});

export default function GitPanel({ projectPath, className = '', hideHeader = false, onBranchChange }: GitPanelProps) {
  const [gitData, setGitData] = useState<GitData>(INITIAL_GIT_DATA);
  const [loading, setLoading] = useState(false);
  const [showCommits, setShowCommits] = useState(false);

  // Load git data
  const loadGitData = useCallback(async () => {
    if (!projectPath || !window.electronAPI?.review?.repo) return;

    setLoading(true);

    try {
      // One shell-free call: git runs with an argv array in the main process,
      // so a branch or path containing a quote is data rather than syntax.
      const res = await window.electronAPI.review.repo(projectPath);
      if (!res.success || !res.summary) {
        setGitData(INITIAL_GIT_DATA);
        return;
      }

      const { branch, status, commits, additions, deletions } = res.summary;
      const diff = status.length > 0
        ? `${status.length} file${status.length === 1 ? '' : 's'} changed, +${additions} -${deletions}`
        : '';

      setGitData({
        branch,
        status,
        diff,
        commits: commits.map(c => ({ hash: c.hash, message: c.subject, author: c.author, date: c.when })),
      });
      onBranchChange?.(branch);
    } catch (err) {
      console.error('Failed to load git data:', err);
    } finally {
      setLoading(false);
    }
  }, [projectPath, onBranchChange]);

  // Open project in Cursor IDE
  const handleOpenInCursor = useCallback(async () => {
    if (!projectPath || !window.electronAPI?.shell?.reveal) return;
    try {
      await window.electronAPI.shell.reveal(projectPath);
    } catch (err) {
      console.error('Failed to open in Cursor:', err);
    }
  }, [projectPath]);

  // Load git data on mount and when path changes
  useEffect(() => {
    loadGitData();
  }, [loadGitData]);

  return (
    <div className={`flex flex-col bg-[#0d0d14] overflow-hidden ${className}`}>
      {/* Header - hidden when embedded in accordion */}
      {!hideHeader && (
        <div className="px-3 py-2 border-b border-border-primary bg-bg-tertiary/30 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-warning" />
            <span className="text-sm font-medium text-text-primary">Git</span>
            <span className="px-2 py-0.5 text-xs bg-warning/20 text-warning rounded-full">
              {gitData.branch || 'loading...'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleOpenInCursor}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-primary/20 text-primary hover:bg-primary/30 rounded transition-colors"
              title="Open project in Cursor"
            >
              <Code2 className="w-3 h-3" />
              Cursor
            </button>
            <button
              onClick={loadGitData}
              className="p-1 hover:bg-bg-tertiary rounded transition-colors"
              title="Refresh"
            >
              {loading ? (
                <BrandSpinner size={14} label="Refreshing" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 text-text-muted" />
              )}
            </button>
          </div>
        </div>
      )}

      {loading && gitData.status.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <BrandSpinner size={30} label="Loading git data" />
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Changed Files */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="px-3 py-2 bg-bg-tertiary/20 shrink-0">
              <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                <FileDiff className="w-3.5 h-3.5" />
                <span>Changes</span>
                {gitData.status.length > 0 && (
                  <>
                    {gitData.status.filter(s => s.status === 'new').length > 0 && (
                      <span className="px-1.5 py-0.5 text-[10px] bg-primary/20 text-primary rounded">
                        +{gitData.status.filter(s => s.status === 'new').length} new
                      </span>
                    )}
                    {gitData.status.filter(s => s.status !== 'new').length > 0 && (
                      <span className="px-1.5 py-0.5 text-[10px] bg-warning/20 text-warning rounded">
                        {gitData.status.filter(s => s.status !== 'new').length} modified
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
            {gitData.status.length === 0 ? (
              <div className="px-3 py-3 text-xs text-text-muted text-center">No changes</div>
            ) : (
              <div className="flex-1 overflow-y-auto min-h-0">
                {gitData.status.map((item, idx) => (
                  <FileStatusItem key={`${item.file}-${idx}`} item={item} />
                ))}
              </div>
            )}
          </div>

          {/* Recent Commits - Collapsed by default */}
          <div className="shrink-0 border-t border-border-primary">
            <button
              onClick={() => setShowCommits(!showCommits)}
              className="w-full px-3 py-2 bg-bg-tertiary/20 flex items-center justify-between hover:bg-bg-tertiary/40 transition-colors"
            >
              <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                <GitCommit className="w-3.5 h-3.5" />
                <span>Recent Commits</span>
                {gitData.commits.length > 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] bg-primary/20 text-primary rounded">
                    {gitData.commits.length}
                  </span>
                )}
              </div>
              {showCommits ? (
                <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
              )}
            </button>
            {showCommits && (
              <>
                {gitData.commits.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-text-muted text-center">No commits</div>
                ) : (
                  <div className="max-h-40 overflow-y-auto">
                    {gitData.commits.map((commit, idx) => (
                      <CommitItem key={`${commit.hash}-${idx}`} commit={commit} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
