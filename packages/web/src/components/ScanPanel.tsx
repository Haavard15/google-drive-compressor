'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import {
  Scan,
  FolderOpen,
  Radio,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Database,
} from 'lucide-react';
import { scanApi, formatBytes, type ScanJobDto } from '@/lib/api';
import { useScanProgress } from '@/hooks/useWebSocket';

export type ScanStatusPayload = {
  status: string;
  jobId?: number;
  scannedFiles?: number;
  totalFiles?: number;
  totalSize?: number;
  completedAt?: string;
  error?: string;
  message?: string;
};

type LiveProgress = {
  jobId: number;
  status: 'running' | 'completed' | 'failed';
  scannedFiles: number;
  totalFiles: number;
  totalSize: number;
  currentFolder?: string;
  error?: string;
};

function isScanJobDto(x: ScanJobDto | { message: string }): x is ScanJobDto {
  return x != null && typeof x === 'object' && 'id' in x;
}

export function ScanPanel({
  scanStatus,
  isScanning,
  startScan,
}: {
  scanStatus: ScanStatusPayload | undefined;
  isScanning: boolean;
  startScan: UseMutationResult<{ success: boolean; jobId: number }, Error, void, unknown>;
}) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveProgress | null>(null);

  const onProgress = useCallback((p: LiveProgress) => {
    setLive(p);
    if (p.status === 'completed' || p.status === 'failed') {
      queryClient.invalidateQueries({ queryKey: ['scan-status'] });
      queryClient.invalidateQueries({ queryKey: ['scan-latest'] });
    }
  }, [queryClient]);

  const { isConnected: wsConnected } = useScanProgress(onProgress);

  const recoverStuck = useMutation({
    mutationFn: scanApi.recoverStuck,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scan-status'] });
      queryClient.invalidateQueries({ queryKey: ['scan-latest'] });
      setLive(null);
    },
  });

  const { data: latestRaw, refetch: refetchLatest } = useQuery({
    queryKey: ['scan-latest'],
    queryFn: scanApi.getLatest,
    refetchInterval: isScanning ? false : 20_000,
  });

  const latestJob = useMemo(
    () => (latestRaw && isScanJobDto(latestRaw) ? latestRaw : null),
    [latestRaw],
  );

  const activeJobId = scanStatus?.jobId;

  useEffect(() => {
    setLive((prev) => {
      if (!prev || activeJobId == null) return prev;
      return prev.jobId === activeJobId ? prev : null;
    });
  }, [activeJobId]);

  const merged = useMemo(() => {
    if (live && activeJobId != null && live.jobId === activeJobId) {
      return {
        jobId: live.jobId,
        status: live.status,
        scannedFiles: live.scannedFiles,
        totalFiles: live.totalFiles,
        totalSize: live.totalSize,
        currentFolder: live.currentFolder,
        error: live.error,
        fromWs: true as const,
      };
    }
    const st = scanStatus?.status || 'idle';
    return {
      jobId: activeJobId,
      status: st === 'running' ? 'running' : st === 'completed' ? 'completed' : st === 'failed' ? 'failed' : 'idle',
      scannedFiles: scanStatus?.scannedFiles ?? scanStatus?.totalFiles ?? 0,
      totalFiles: scanStatus?.totalFiles ?? scanStatus?.scannedFiles ?? 0,
      totalSize: scanStatus?.totalSize ?? 0,
      currentFolder: undefined as string | undefined,
      error: scanStatus?.error,
      fromWs: false as const,
    };
  }, [live, scanStatus, activeJobId]);

  const showRunning = merged.status === 'running' || isScanning;
  const showFailed =
    !showRunning &&
    (merged.status === 'failed' || (live?.status === 'failed' && live?.jobId === activeJobId));

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Scan className="w-5 h-5 text-neon-cyan" />
          Drive scan
        </h2>
        <p className="text-sm text-zinc-500 mt-1 leading-relaxed">
          Walks your Drive tree and refreshes the local index (metadata, paths, sizes). When a run{' '}
          <span className="text-zinc-400 font-medium">finishes successfully</span>, any indexed files that were
          never visited are tagged as gone from Drive so you can filter them on the Files tab. Safe to run while the
          queue is processing — it does not cancel jobs.
        </p>
      </div>

      <div className="glass rounded-xl p-5 border border-zinc-800/60">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${
                wsConnected
                  ? 'border-emerald-500/30 text-emerald-300/90 bg-emerald-500/10'
                  : 'border-zinc-700 text-zinc-500 bg-void-800'
              }`}
            >
              <Radio className={`w-3.5 h-3.5 ${wsConnected ? 'text-emerald-400' : ''}`} />
              Live updates {wsConnected ? 'on' : 'off'}
            </span>
            {activeJobId != null && (
              <span className="tabular-nums text-zinc-600">Job #{activeJobId}</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => startScan.mutate()}
            disabled={isScanning || startScan.isPending}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium transition-all ${
              isScanning
                ? 'bg-neon-cyan/15 text-neon-cyan border border-neon-cyan/30 cursor-wait'
                : 'bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/35 hover:bg-neon-cyan/30'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {startScan.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Scan className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} />
            )}
            {isScanning ? 'Scan in progress…' : 'Start full scan'}
          </button>
        </div>

        {startScan.isError && (
          <p className="text-sm text-red-400 mb-4" role="alert">
            {(startScan.error as Error).message}
          </p>
        )}

        {showRunning && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="rounded-lg bg-void-800/80 border border-zinc-800/80 p-3">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">Items indexed</p>
                <p className="text-xl font-bold tabular-nums text-white mt-0.5">
                  {merged.scannedFiles.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg bg-void-800/80 border border-zinc-800/80 p-3">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">Volume seen</p>
                <p className="text-xl font-bold tabular-nums text-neon-cyan mt-0.5">
                  {formatBytes(merged.totalSize)}
                </p>
              </div>
              <div className="rounded-lg bg-void-800/80 border border-zinc-800/80 p-3 col-span-2 sm:col-span-1">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">Status</p>
                <p className="text-sm font-medium text-amber-200/90 mt-1 flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  Crawling Drive…
                </p>
              </div>
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1.5">Current folder</p>
              <div className="flex items-start gap-2 rounded-lg bg-void-900/50 border border-zinc-800/60 px-3 py-2 min-h-[2.5rem]">
                <FolderOpen className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />
                <p className="text-sm text-zinc-300 font-mono break-all leading-snug">
                  {merged.currentFolder || 'Starting…'}
                </p>
              </div>
            </div>

            <div className="h-2 rounded-full bg-void-800 overflow-hidden border border-zinc-800/60">
              <div className="h-full w-full scan-progress-indeterminate rounded-full" />
            </div>
            <p className="text-[11px] text-zinc-500">
              Drive does not report a total file count up front — progress is live as folders are visited.
            </p>
            <div className="pt-2 border-t border-zinc-800/60 mt-3">
              <p className="text-[11px] text-zinc-600 mb-2">
                Stuck after an API restart or frozen counts? Clear orphan &quot;running&quot; rows so you can start
                again. A real in-progress scan on this server is left alone.
              </p>
              <button
                type="button"
                disabled={recoverStuck.isPending}
                onClick={() => recoverStuck.mutate()}
                className="text-xs text-zinc-400 hover:text-amber-200/90 underline-offset-2 hover:underline disabled:opacity-50"
              >
                {recoverStuck.isPending ? 'Resetting…' : 'Reset stuck scan state'}
              </button>
              {recoverStuck.isError && (
                <p className="text-[11px] text-red-400 mt-1">{(recoverStuck.error as Error).message}</p>
              )}
              {recoverStuck.isSuccess && recoverStuck.data.recovered > 0 && (
                <p className="text-[11px] text-emerald-400/90 mt-1">
                  Cleared {recoverStuck.data.recovered} stale job(s).
                </p>
              )}
              {recoverStuck.isSuccess && recoverStuck.data.recovered === 0 && (
                <p className="text-[11px] text-zinc-500 mt-1">No orphan running jobs to clear.</p>
              )}
            </div>
          </div>
        )}

        {!showRunning && merged.status === 'completed' && activeJobId != null && (
          <div className="flex items-start gap-3 rounded-lg bg-emerald-500/10 border border-emerald-500/25 p-4">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-emerald-200/95">Scan finished</p>
              <p className="text-sm text-zinc-400 mt-1 tabular-nums">
                {merged.scannedFiles.toLocaleString()} items · {formatBytes(merged.totalSize)} total size
              </p>
            </div>
          </div>
        )}

        {!showRunning && showFailed && (
          <div className="flex items-start gap-3 rounded-lg bg-red-500/10 border border-red-500/25 p-4">
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-200/95">Scan failed</p>
              <p className="text-sm text-red-300/80 mt-1">{merged.error || latestJob?.error || 'Unknown error'}</p>
            </div>
          </div>
        )}

        {!showRunning && merged.status === 'idle' && (
          <div className="flex items-start gap-3 rounded-lg bg-void-800/40 border border-zinc-800/60 p-4">
            <Database className="w-5 h-5 text-zinc-500 shrink-0 mt-0.5" />
            <p className="text-sm text-zinc-400">
              No scan running. Start a scan to refresh the index from Google Drive.
            </p>
          </div>
        )}
      </div>

      <div className="glass rounded-xl p-5 border border-zinc-800/60">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-medium text-zinc-300">Last completed job</h3>
          <button
            type="button"
            onClick={() => {
              refetchLatest();
              queryClient.invalidateQueries({ queryKey: ['scan-status'] });
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-void-700 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
        {latestJob ? (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-zinc-500 text-xs">Job</dt>
              <dd className="text-zinc-200 tabular-nums">#{latestJob.id}</dd>
            </div>
            <div>
              <dt className="text-zinc-500 text-xs">Result</dt>
              <dd className="text-zinc-200 capitalize">{latestJob.status}</dd>
            </div>
            <div>
              <dt className="text-zinc-500 text-xs">Root folder id</dt>
              <dd className="text-zinc-300 font-mono text-xs break-all">{latestJob.rootFolderId || 'root'}</dd>
            </div>
            <div>
              <dt className="text-zinc-500 text-xs">Indexed</dt>
              <dd className="text-zinc-200 tabular-nums">
                {latestJob.scannedFiles?.toLocaleString?.() ?? latestJob.totalFiles?.toLocaleString?.() ?? '—'} items
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-zinc-500 text-xs">Total size</dt>
              <dd className="text-neon-cyan/90 tabular-nums">{formatBytes(latestJob.totalSize)}</dd>
            </div>
            {latestJob.completedAt && (
              <div className="sm:col-span-2">
                <dt className="text-zinc-500 text-xs">Completed</dt>
                <dd className="text-zinc-400 text-xs">
                  {new Date(latestJob.completedAt).toLocaleString()}
                </dd>
              </div>
            )}
            {latestJob.error && (
              <div className="sm:col-span-2">
                <dt className="text-zinc-500 text-xs">Error</dt>
                <dd className="text-red-300/90 text-xs">{latestJob.error}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="text-sm text-zinc-500">No scan jobs in the database yet.</p>
        )}
      </div>

    </div>
  );
}
