'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  HardDrive, Scan, Trash2, Minimize2, Check, AlertCircle, 
  Play, Pause, RefreshCw, Folder, Film, Zap, Database, Settings2
} from 'lucide-react';
import { authApi, scanApi, statsApi, actionsApi, formatBytes, Stats } from '@/lib/api';
import { StorageStats } from '@/components/StorageStats';
import { TreeMap } from '@/components/TreeMap';
import { FileTable } from '@/components/FileTable';
import { ActionQueue } from '@/components/ActionQueue';
import { SuggestionPanel } from '@/components/SuggestionPanel';
import { ScanPanel } from '@/components/ScanPanel';
import { SetupPanel } from '@/components/SetupPanel';

type TabType = 'overview' | 'scan' | 'files' | 'queue' | 'settings';

const TAB_STORAGE_KEY = 'gdrive-dashboard-tab';

function readStoredTab(): TabType | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (v === 'overview' || v === 'scan' || v === 'files' || v === 'queue' || v === 'settings') return v;
  } catch {
    /* ignore */
  }
  return null;
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [authError, setAuthError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const stored = readStoredTab();
    if (stored) setActiveTab(stored);
  }, []);

  const changeTab = useCallback((tab: TabType) => {
    setActiveTab(tab);
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      /* ignore */
    }
  }, []);

  // Auth status
  const { data: authStatus, isLoading: authLoading } = useQuery({
    queryKey: ['auth'],
    queryFn: authApi.getStatus,
  });

  // Stats
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ['stats'],
    queryFn: statsApi.get,
    enabled: authStatus?.authenticated,
    refetchInterval: 15_000,
  });

  // Scan status
  const { data: scanStatus, refetch: refetchScan } = useQuery({
    queryKey: ['scan-status'],
    queryFn: scanApi.getStatus,
    enabled: authStatus?.authenticated,
    refetchInterval: 5_000,
  });

  // Start scan mutation
  const startScan = useMutation({
    mutationFn: () => scanApi.start(),
    onSuccess: () => {
      refetchScan();
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['scan-latest'] });
    },
  });

  const prevScanStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const s = scanStatus?.status;
    const prev = prevScanStatus.current;
    if (prev === 'running' && s && s !== 'running') {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['treemap'] });
      queryClient.invalidateQueries({ queryKey: ['scan-latest'] });
    }
    prevScanStatus.current = s;
  }, [scanStatus?.status, queryClient]);

  // Analyze mutation
  const analyze = useMutation({
    mutationFn: () => statsApi.analyze(undefined, 100),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['files'] });
    },
  });

  // Init service account
  const initServiceAccount = useMutation({
    mutationFn: authApi.initServiceAccount,
    onMutate: () => {
      setAuthError(null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auth'] });
    },
    onError: (error) => {
      setAuthError(error instanceof Error ? error.message : 'Could not connect service account');
    },
  });

  // OAuth flow
  const startOAuth = async () => {
    setAuthError(null);
    try {
      const { url } = await authApi.getOAuthUrl();
      window.location.href = url;
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not start Google sign-in');
    }
  };

  // Not authenticated
  if (!authLoading && !authStatus?.authenticated) {
    const hasAnyAuthConfig = authStatus?.hasServiceAccountConfig || authStatus?.hasOAuthConfig;
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="w-full max-w-5xl grid grid-cols-1 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] gap-6 items-start">
        <div className="glass rounded-2xl p-8 w-full text-center">
          <div className="w-16 h-16 mx-auto mb-6 rounded-xl bg-gradient-to-br from-neon-cyan to-neon-purple flex items-center justify-center">
            <HardDrive className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Drive Compressor</h1>
          <p className="text-zinc-400 mb-8">
            Connect Google Drive, choose how the app authenticates, and optionally enable Gemini AI.
          </p>
          
          <div className="space-y-3">
            {authStatus?.hasServiceAccountConfig && (
              <button
                onClick={() => initServiceAccount.mutate()}
                disabled={initServiceAccount.isPending}
                className="w-full py-3 px-4 rounded-xl bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/30 hover:bg-neon-cyan/30 transition-colors font-medium"
              >
                {initServiceAccount.isPending ? 'Connecting...' : 'Use Service Account'}
              </button>
            )}
            
            {authStatus?.hasOAuthConfig && (
              <button
                onClick={startOAuth}
                className="w-full py-3 px-4 rounded-xl bg-void-700 hover:bg-void-600 transition-colors font-medium border border-zinc-700"
              >
                Sign in with Google
              </button>
            )}

            {!hasAnyAuthConfig && (
              <div className="text-sm text-zinc-500 p-4 bg-void-800 rounded-xl">
                <p>No Google Drive authentication configured yet.</p>
                <p className="mt-2">Use the setup form to add OAuth or service-account credentials.</p>
              </div>
            )}

            {hasAnyAuthConfig && (
              <button
                type="button"
                onClick={() => setShowSetup((prev) => !prev)}
                className="w-full py-3 px-4 rounded-xl bg-void-800 hover:bg-void-700 transition-colors font-medium border border-zinc-800"
              >
                {showSetup ? 'Hide setup' : 'Edit setup'}
              </button>
            )}

            {authError && (
              <p className="text-sm text-red-400" role="alert">
                {authError}
              </p>
            )}
          </div>
        </div>

          {(showSetup || !hasAnyAuthConfig) && <SetupPanel showTitle compact />}
        </div>
      </div>
    );
  }

  const isScanning = scanStatus?.status === 'running';

  const queueBadgeCount = stats
    ? (stats.actions.pending || 0) + (stats.actions.running || 0)
    : 0;

  return (
    <div
      className={
        activeTab === 'files' || activeTab === 'queue'
          ? 'h-screen flex flex-col overflow-hidden'
          : 'min-h-screen flex flex-col'
      }
    >
      {/* Header */}
      <header className="sticky top-0 z-50 glass border-b border-zinc-800/50 shrink-0">
        <div className="max-w-[1800px] mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-neon-cyan to-neon-purple flex items-center justify-center">
                <HardDrive className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold">Drive Compressor</h1>
                <p className="text-sm text-zinc-500">
                  {stats ? `${formatBytes(stats.storage.totalSize)} across ${stats.storage.totalFiles.toLocaleString()} files` : 'Loading...'}
                </p>
              </div>
            </div>

            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-3">
                {/* Scan button */}
                <button
                  onClick={() => startScan.mutate()}
                  disabled={isScanning || startScan.isPending}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium transition-all ${
                    isScanning
                      ? 'bg-neon-cyan/20 text-neon-cyan'
                      : 'bg-void-700 hover:bg-void-600 text-zinc-200'
                  }`}
                >
                  <Scan className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
                  {isScanning ? `Scanning… ${scanStatus?.scannedFiles?.toLocaleString() ?? 0}` : 'Scan Drive'}
                </button>

                {/* Analyze button */}
                <button
                  onClick={() => analyze.mutate()}
                  disabled={analyze.isPending || (stats?.suggestions.unanalyzed || 0) === 0}
                  title={
                    stats?.analysis.mode === 'gemini'
                      ? 'Analyze with Gemini AI suggestions'
                      : 'Analyze with built-in heuristics (Gemini key not configured)'
                  }
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-neon-purple/20 text-neon-purple border border-neon-purple/30 hover:bg-neon-purple/30 transition-colors font-medium disabled:opacity-50"
                >
                  <Zap className={`w-4 h-4 ${analyze.isPending ? 'animate-pulse' : ''}`} />
                  {analyze.isPending
                    ? 'Analyzing...'
                    : stats?.analysis.mode === 'gemini'
                      ? `Analyze ${stats?.suggestions.unanalyzed || 0}`
                      : `Analyze (heuristics) ${stats?.suggestions.unanalyzed || 0}`}
                </button>
              </div>
              {startScan.isError && (
                <p className="text-xs text-red-400 max-w-sm text-right leading-snug" role="alert">
                  {(startScan.error as Error).message}
                </p>
              )}
            </div>
          </div>

          {/* Tabs */}
          <nav className="flex gap-1 mt-4 -mb-4">
            {[
              { id: 'overview', label: 'Overview', icon: Database },
              { id: 'scan', label: 'Scan', icon: Scan },
              { id: 'files', label: 'Files', icon: Folder },
              { id: 'queue', label: 'Queue', icon: Play },
              { id: 'settings', label: 'Settings', icon: Settings2 },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => changeTab(tab.id as TabType)}
                className={`flex items-center gap-2 px-4 py-3 rounded-t-xl font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-void-800 text-white border-t border-x border-zinc-800/50'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
                {tab.id === 'scan' && isScanning && (
                  <span
                    className="ml-1 flex h-2 w-2 rounded-full bg-neon-cyan animate-pulse"
                    title="Scan in progress"
                    aria-hidden
                  />
                )}
                {tab.id === 'queue' && queueBadgeCount > 0 && (
                  <span
                    className="ml-1 px-2 py-0.5 text-xs rounded-full bg-neon-pink/20 text-neon-pink tabular-nums"
                    title={`${stats?.actions.pending ?? 0} waiting · ${stats?.actions.running ?? 0} in pipeline`}
                  >
                    {queueBadgeCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Main content */}
      <main
        className={`max-w-[1800px] mx-auto w-full ${
          activeTab === 'queue'
            ? 'px-4 py-2 flex-1 min-h-0 flex flex-col overflow-hidden'
            : activeTab === 'files'
              ? 'p-6 flex-1 min-h-0 flex flex-col overflow-hidden'
              : 'p-6 flex-1 min-h-0'
        }`}
      >
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Stats cards */}
            {stats && <StorageStats stats={stats} />}
            
            {/* Treemap and suggestions */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              <div className="xl:col-span-2">
                <TreeMap pollWhileScanning={isScanning} />
              </div>
              <div>
                <SuggestionPanel stats={stats} />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'scan' && (
          <ScanPanel scanStatus={scanStatus} isScanning={isScanning} startScan={startScan} />
        )}

        {activeTab === 'files' && (
          <div className="flex-1 min-h-0 flex flex-col min-w-0">
            <FileTable pollWhileScanning={isScanning} />
          </div>
        )}
        
        {activeTab === 'queue' && <ActionQueue />}

        {activeTab === 'settings' && <SetupPanel />}
      </main>
    </div>
  );
}
