'use client';

import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Play, X, Trash2, Minimize2, Download,
  CheckCircle, XCircle, Clock, Loader2, RefreshCw, Square, ExternalLink,
} from 'lucide-react';
import { actionsApi, queueApi, statsApi, formatBytes, Action } from '@/lib/api';
import { useActionProgress } from '@/hooks/useWebSocket';
import { CompressionSettings } from '@/components/CompressionSettings';

/** Must match `ORPHANED_RUNNING_ERROR_MESSAGE` in packages/api processor (recover stuck) */
const ORPHANED_RUNNING_ERROR_MESSAGE =
  'Orphaned "running" state (server restarted or worker died).';

/** In pipeline after a download slot is taken (excludes `download_queued` — shown under Pending). */
const ACTIVE_JOB_STATUSES = new Set([
  'running',
  'downloading',
  'ready_to_encode',
  'encoding',
  'ready_to_upload',
  'uploading',
]);

const PENDING_COLUMN_STATUSES = new Set(['pending', 'download_queued']);

function actionCreatedAtMs(a: Action): number {
  const c = a.createdAt;
  if (c == null || c === '') return 0;
  if (typeof c === 'number') {
    return c < 1_000_000_000_000 ? c * 1000 : c;
  }
  const t = new Date(String(c)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Same ordering as the API pipeline: higher priority first, then older jobs first. */
function comparePipelineQueueOrder(a: Action, b: Action): number {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pb - pa;
  return actionCreatedAtMs(a) - actionCreatedAtMs(b);
}

function canRequeueFromHistory(action: Action): boolean {
  if (action.status === 'failed') return true;
  return (
    action.status === 'cancelled' && action.error === ORPHANED_RUNNING_ERROR_MESSAGE
  );
}

/** Scroll region inside a flex column: grows with panel, scrolls when content overflows. */
const SCROLL_PANEL =
  'flex-1 min-h-0 overflow-y-auto overscroll-y-contain pr-1';

function pipelineCheckpointLine(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata) as {
      pipelineStages?: {
        download?: { completedAt?: string; skippedRedownload?: boolean; recoveredAt?: string };
        encode?: { completedAt?: string; outputBytes?: number; recoveredAt?: string };
        upload?: { completedAt?: string; newFileId?: string };
      };
      resumeLog?: { message?: string }[];
    };
    const s = m.pipelineStages;
    const parts: string[] = [];
    if (s?.download?.completedAt || s?.download?.skippedRedownload || s?.download?.recoveredAt) {
      parts.push('Download ✓');
    }
    if (s?.encode?.completedAt || s?.encode?.outputBytes != null || s?.encode?.recoveredAt) {
      parts.push('Encode ✓');
    }
    if (s?.upload?.completedAt || s?.upload?.newFileId) parts.push('Upload ✓');
    const tip = parts.length > 0 ? parts.join(' · ') : null;
    const last =
      m.resumeLog?.length && m.resumeLog[m.resumeLog.length - 1]?.message
        ? m.resumeLog[m.resumeLog.length - 1]!.message
        : null;
    if (!tip && !last) return null;
    return [tip, last].filter(Boolean).join(' · ');
  } catch {
    return null;
  }
}

export function ActionQueue() {
  const queryClient = useQueryClient();

  const onActionProgress = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['actions'] });
    queryClient.invalidateQueries({ queryKey: ['stats'] });
    queryClient.invalidateQueries({ queryKey: ['queueSettings'] });
  }, [queryClient]);

  const { isConnected: actionWsConnected } = useActionProgress(onActionProgress);

  const { data, isLoading } = useQuery({
    queryKey: ['actions'],
    queryFn: () => actionsApi.listAll(200),
    refetchInterval: actionWsConnected ? 10_000 : 3_000,
  });

  const { data: queueSettings } = useQuery({
    queryKey: ['queueSettings'],
    queryFn: () => queueApi.getSettings(),
    refetchInterval: actionWsConnected ? 12_000 : 4_000,
  });

  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: statsApi.get,
    refetchInterval: actionWsConnected ? 15_000 : 5_000,
  });

  const patchQueue = useMutation({
    mutationFn: queueApi.patchSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queueSettings'] });
    },
  });

  const executeAction = useMutation({
    mutationFn: (actionId: number) => actionsApi.execute(actionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['actions'] });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['actions'] });
    },
  });

  const executeNext = useMutation({
    mutationFn: actionsApi.executeNext,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['actions'] });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['actions'] });
    },
  });

  const cancelAction = useMutation({
    mutationFn: (actionId: number) => actionsApi.cancel(actionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['actions'] });
      queryClient.invalidateQueries({ queryKey: ['files'] });
    },
  });

  const clearActions = useMutation({
    mutationFn: (status: string | undefined) => actionsApi.clear(status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['actions'] });
    },
  });

  const recoverStuck = useMutation({
    mutationFn: actionsApi.recoverStuck,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['actions'] });
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const retryAction = useMutation({
    mutationFn: actionsApi.retry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['actions'] });
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const getActionIcon = (action: string) => {
    switch (action) {
      case 'delete': return <Trash2 className="w-4 h-4 text-neon-pink" />;
      case 'compress': return <Minimize2 className="w-4 h-4 text-neon-yellow" />;
      case 'download': return <Download className="w-4 h-4 text-neon-cyan" />;
      default: return null;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending': return <Clock className="w-4 h-4 text-zinc-500" />;
      case 'running':
      case 'downloading':
      case 'encoding':
      case 'uploading':
        return <Loader2 className="w-4 h-4 text-neon-cyan animate-spin" />;
      case 'download_queued':
      case 'ready_to_encode':
      case 'ready_to_upload':
        return <Loader2 className="w-4 h-4 text-amber-400/90 animate-pulse" />;
      case 'completed': return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'failed': return <XCircle className="w-4 h-4 text-red-500" />;
      case 'cancelled': return <X className="w-4 h-4 text-zinc-500" />;
      default: return null;
    }
  };

  const formatHistorySizes = (action: Action) => {
    const before = action.sizeBeforeBytes;
    const after = action.sizeAfterBytes;
    if (action.action === 'delete' && before != null && before > 0) {
      return `${formatBytes(before)} trashed`;
    }
    if (before != null && before > 0 && after != null && after > 0) {
      const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      const delta = pct > 0 ? ` · ${pct}% smaller` : pct < 0 ? ` · ${Math.abs(pct)}% larger` : '';
      return `${formatBytes(before)} → ${formatBytes(after)}${delta}`;
    }
    if (before != null && before > 0) {
      return `${formatBytes(before)} → —`;
    }
    if (after != null && after > 0) {
      return `— → ${formatBytes(after)}`;
    }
    return null;
  };

  const getStatusLabel = (status: string) => {
    const styles: Record<string, string> = {
      pending: 'bg-zinc-700 text-zinc-300',
      running: 'bg-neon-cyan/20 text-neon-cyan',
      download_queued: 'bg-amber-500/15 text-amber-200',
      downloading: 'bg-neon-cyan/20 text-neon-cyan',
      ready_to_encode: 'bg-violet-500/15 text-violet-200',
      encoding: 'bg-neon-cyan/20 text-neon-cyan',
      ready_to_upload: 'bg-sky-500/15 text-sky-200',
      uploading: 'bg-neon-cyan/20 text-neon-cyan',
      completed: 'bg-green-500/20 text-green-400',
      failed: 'bg-red-500/20 text-red-400',
      cancelled: 'bg-zinc-700 text-zinc-400',
    };
    const labels: Record<string, string> = {
      download_queued: 'queued for download',
      ready_to_encode: 'ready to encode',
      ready_to_upload: 'ready to upload',
    };
    const text = labels[status] ?? status.replace(/_/g, ' ');
    return (
      <span
        className={`px-1.5 py-0.5 text-[10px] rounded-full leading-none ${styles[status] || styles.pending}`}
      >
        {text}
      </span>
    );
  };

  const completedActions =
    data?.actions.filter((a) => ['completed', 'failed', 'cancelled'].includes(a.status)) || [];

  const pendingSorted = [...(data?.actions.filter((a) => PENDING_COLUMN_STATUSES.has(a.status)) || [])].sort(
    comparePipelineQueueOrder,
  );
  const activeSorted = [...(data?.actions.filter((a) => ACTIVE_JOB_STATUSES.has(a.status)) || [])].sort(
    comparePipelineQueueOrder,
  );
  const historySorted = [...completedActions].sort(
    (a, b) => actionCreatedAtMs(b) - actionCreatedAtMs(a),
  );

  const queueError =
    (executeAction.error as Error | null)?.message ||
    (executeNext.error as Error | null)?.message ||
    null;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2 overflow-hidden w-full min-w-0">
      {queueError && (
        <div
          className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
          role="alert"
        >
          <p className="font-medium text-red-100">Could not start processing</p>
          <p className="mt-0.5 text-red-200/90">{queueError}</p>
        </div>
      )}
      {/* Controls — kept short vertically; full detail in button titles */}
      <div className="glass rounded-xl p-3 shrink-0 overflow-y-auto max-h-[min(34vh,320px)]">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 mb-2">
          <h2 className="text-base font-semibold">Processing Queue</h2>
          <div className="flex flex-wrap items-center gap-1.5 justify-end">
            {completedActions.length > 0 && (
              <button
                onClick={() => clearActions.mutate(undefined)}
                className="px-2.5 py-1 rounded-lg bg-void-700 hover:bg-void-600 text-xs transition-colors"
              >
                Clear history
              </button>
            )}
            <button
              type="button"
              onClick={() => recoverStuck.mutate()}
              disabled={recoverStuck.isPending}
              className="px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-200 border border-amber-500/25 hover:bg-amber-500/25 text-xs transition-colors disabled:opacity-50"
              title="Clears ghost in-progress rows after a crash (running, download, encode, upload)"
            >
              {recoverStuck.isPending ? '…' : 'Fix stuck'}
            </button>
            <button
              onClick={() => executeNext.mutate()}
              disabled={
                executeNext.isPending ||
                pendingSorted.length === 0 ||
                queueSettings?.autoAdvance === false
              }
              title={
                queueSettings?.autoAdvance === false
                  ? 'Resume the queue first — Start queue only runs while auto-advance is on'
                  : 'Promote pending jobs when disk allows and tick the pipeline'
              }
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/30 hover:bg-neon-cyan/30 text-xs font-medium disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              Start
            </button>
          </div>
        </div>

        <p
          className="text-[11px] leading-snug text-zinc-500 mb-2"
          title="One download and one upload at a time; multiple encodes. Left = not yet downloading (pending + queued for download slot). Right = download through upload in progress."
        >
          Left: waiting for the pipeline (including queued for download). Right: active download / encode / upload.
          {queueSettings && !queueSettings.autoAdvance ? ' Paused — resume to continue.' : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2 mb-2 px-2 py-1.5 rounded-lg bg-void-800/80 border border-zinc-800/60">
          <span className="text-[11px] text-zinc-500">Queue</span>
          <button
            type="button"
            disabled={patchQueue.isPending || queueSettings === undefined}
            onClick={() =>
              patchQueue.mutate({ autoAdvance: !queueSettings?.autoAdvance })
            }
            title={
              queueSettings?.autoAdvance
                ? 'Pause: no new downloads, encodes, or uploads; in-flight work keeps running'
                : 'Resume: allow the pipeline to pick up pending and queued work'
            }
            className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-50 ${
              queueSettings?.autoAdvance
                ? 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/30 hover:bg-neon-cyan/25'
                : 'bg-zinc-700 text-zinc-300 border-zinc-600 hover:bg-zinc-600'
            }`}
          >
            {queueSettings?.autoAdvance ? 'Running — pause' : 'Paused — resume'}
          </button>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          <div className="py-2 px-2 rounded-lg bg-void-800 text-center">
            <p className="text-lg font-bold tabular-nums leading-tight">{pendingSorted.length}</p>
            <p className="text-[10px] text-zinc-500 leading-tight mt-0.5">Pending</p>
          </div>
          <div className="py-2 px-2 rounded-lg bg-void-800 text-center">
            <p className="text-lg font-bold tabular-nums text-neon-cyan leading-tight">{activeSorted.length}</p>
            <p className="text-[10px] text-zinc-500 leading-tight mt-0.5">Active</p>
          </div>
          <div className="py-2 px-2 rounded-lg bg-void-800 text-center">
            <p className="text-lg font-bold tabular-nums text-green-500 leading-tight">
              {completedActions.filter((a) => a.status === 'completed').length}
            </p>
            <p className="text-[10px] text-zinc-500 leading-tight mt-0.5">Done</p>
          </div>
          <div className="py-2 px-2 rounded-lg bg-void-800 text-center">
            <p className="text-lg font-bold tabular-nums text-red-500 leading-tight">
              {completedActions.filter((a) => a.status === 'failed').length}
            </p>
            <p className="text-[10px] text-zinc-500 leading-tight mt-0.5">Failed</p>
          </div>
        </div>

        {stats?.realized && (
          <div className="mt-2 py-2 px-2.5 rounded-lg bg-gradient-to-r from-emerald-500/10 to-neon-cyan/10 border border-emerald-500/20">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Reclaimed</span>
              <span className="text-base font-bold tabular-nums text-emerald-300">
                {formatBytes(stats.realized.totalBytesReclaimed)}
              </span>
            </div>
            <p className="text-[10px] text-zinc-500 mt-1 leading-snug">
              Compress {formatBytes(stats.realized.compressionBytesSaved)} · {stats.realized.completedCompressionJobs}{' '}
              jobs · Del {formatBytes(stats.realized.deletionBytesFreed)} · {stats.realized.completedDeletionJobs} jobs
            </p>
          </div>
        )}

        <div className="mt-2">
          <CompressionSettings compact />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)] gap-3 flex-1 min-h-[min(24rem,58vh)] min-w-0 lg:grid-rows-1 lg:items-stretch">
        <div className="glass rounded-xl p-3 flex flex-col min-h-[min(16rem,38vh)] lg:min-h-0 h-full min-w-0">
          <h3 className="text-xs font-medium text-zinc-400 shrink-0 mb-1.5">
            Pending ({pendingSorted.length})
          </h3>
          {pendingSorted.length === 0 ? (
            <p className="text-sm text-zinc-600 py-4 shrink-0">Nothing waiting in the pending queue.</p>
          ) : (
            <div className={`${SCROLL_PANEL} space-y-1.5`}>
              {pendingSorted.map((action) => {
                const downloadQueued = action.status === 'download_queued';
                return (
                  <div
                    key={action.id}
                    className={`flex items-center gap-2 p-2 rounded-lg transition-colors ${
                      downloadQueued
                        ? 'bg-amber-500/5 border border-amber-500/25 hover:bg-amber-500/[0.08]'
                        : 'bg-void-800/50 hover:bg-void-700/50'
                    }`}
                  >
                    {getActionIcon(action.action)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-sm font-medium truncate min-w-0">
                          {action.file?.name || 'Unknown file'}
                        </p>
                        {downloadQueued ? getStatusLabel(action.status) : null}
                      </div>
                      <p className="text-xs text-zinc-500">
                        {formatBytes(action.file?.size)} • {action.action}
                        {downloadQueued ? ' · waiting for download slot' : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {!downloadQueued && (
                        <button
                          type="button"
                          onClick={() => executeAction.mutate(action.id)}
                          className="p-1.5 rounded-lg hover:bg-void-600 text-neon-cyan"
                          title="Admit to pipeline now"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => cancelAction.mutate(action.id)}
                        className="p-1.5 rounded-lg hover:bg-void-600 text-zinc-400"
                        title="Cancel"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="glass rounded-xl p-3 flex flex-col min-h-[min(16rem,38vh)] lg:min-h-0 h-full min-w-0">
          <h3 className="text-xs font-medium text-zinc-400 shrink-0 mb-1.5">
            Active ({activeSorted.length})
          </h3>
          {activeSorted.length === 0 ? (
            <p className="text-xs text-zinc-600 py-2 shrink-0">Nothing in the pipeline.</p>
          ) : (
            <div className={`${SCROLL_PANEL} space-y-1`}>
              {activeSorted.map((action) => {
                const statusHint =
                  action.status === 'ready_to_encode'
                    ? 'Downloaded · waiting for encoder…'
                    : action.status === 'ready_to_upload'
                      ? 'Encoded · waiting for upload slot…'
                      : null;
                const detailLine =
                  action.progressDetails?.statusLine ||
                  action.progressDetails?.lastStatus ||
                  statusHint ||
                  'Working…';
                const speedBits =
                  `${action.progress}%` +
                  (action.progressDetails?.speedFormatted
                    ? ` · ${action.progressDetails.speedFormatted}`
                    : '');
                const stageLine =
                  action.action === 'compress' || action.action === 'download'
                    ? pipelineCheckpointLine(action.metadata ?? null)
                    : null;
                return (
                  <div
                    key={action.id}
                    className="px-2 py-1.5 rounded-md border bg-neon-cyan/10 border-neon-cyan/30"
                  >
                    <div className="flex items-center gap-1.5 min-w-0 flex-wrap sm:flex-nowrap sm:gap-2">
                      <div className="shrink-0 [&_svg]:w-3.5 [&_svg]:h-3.5">{getActionIcon(action.action)}</div>
                      <div className="flex min-w-0 flex-1 basis-full sm:basis-0 items-center gap-x-1.5 gap-y-0 overflow-hidden sm:flex-nowrap">
                        <p className="text-xs font-medium truncate shrink-0 max-w-[min(48%,18rem)] sm:max-w-[min(40%,24rem)] leading-tight">
                          {action.file?.name || 'Unknown file'}
                        </p>
                        <p className="text-[10px] text-zinc-500 truncate min-w-0 flex-1 leading-tight">
                          {action.file?.path}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 ml-auto sm:ml-0">
                        {getStatusLabel(action.status)}
                        <button
                          type="button"
                          onClick={() => cancelAction.mutate(action.id)}
                          disabled={cancelAction.isPending}
                          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 text-[10px] font-medium disabled:opacity-50 transition-colors leading-none"
                          title="Stop or cancel this job"
                        >
                          <Square className="w-2.5 h-2.5 fill-current" />
                          Stop
                        </button>
                        <span className="shrink-0 [&_svg]:w-3.5 [&_svg]:h-3.5 flex items-center">
                          {getStatusIcon(action.status)}
                        </span>
                      </div>
                    </div>

                    <div className="h-1 bg-void-800 rounded-full overflow-hidden mt-1">
                      <div
                        className="h-full bg-neon-cyan transition-all duration-500"
                        style={{ width: `${Math.max(0, Math.min(100, action.progress))}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0 mt-0.5">
                      <p className="text-[10px] text-neon-cyan/90 font-medium leading-tight break-words min-w-0 flex-1">
                        {detailLine}
                      </p>
                      <p className="text-[9px] text-zinc-500 tabular-nums shrink-0 text-right leading-tight">{speedBits}</p>
                    </div>
                    {stageLine ? (
                      <p
                        className="text-[9px] text-zinc-500 leading-tight mt-0.5 break-words"
                        title={stageLine}
                      >
                        {stageLine}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {historySorted.length > 0 && (
        <div className="glass rounded-xl p-2.5 flex flex-col shrink-0 max-h-[min(28vh,260px)] overflow-hidden">
          <h3 className="text-[11px] font-medium text-zinc-400 shrink-0 mb-1">
            History ({historySorted.length})
          </h3>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pr-1 space-y-1">
            {historySorted.map((action) => {
              const sizeLine = formatHistorySizes(action);
              return (
                <div
                  key={action.id}
                  className={`flex items-start gap-1.5 px-2 py-1.5 rounded-md transition-colors ${
                    action.status === 'failed'
                      ? 'bg-red-500/10'
                      : 'bg-void-800/30'
                  }`}
                >
                  <div className="flex items-center gap-1 shrink-0 pt-0.5 [&_svg]:w-3.5 [&_svg]:h-3.5">
                    {getStatusIcon(action.status)}
                    {getActionIcon(action.action)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate leading-tight">
                      {action.file?.name || 'Unknown file'}
                    </p>
                    {sizeLine && (
                      <p className="text-[10px] text-zinc-400 tabular-nums leading-tight mt-0.5">
                        {sizeLine}
                      </p>
                    )}
                    {action.status === 'completed' &&
                      action.action === 'compress' &&
                      action.replacementLog && (
                        <p className="text-[10px] text-zinc-500 mt-1 leading-tight">
                          <span className="text-emerald-400/90">Source removed</span>
                          {' · '}
                          <span className="text-zinc-500 truncate inline-block max-w-full align-bottom">
                            “{action.replacementLog.sourceFileName}”
                          </span>
                          <span className="text-zinc-600"> · </span>
                          <a
                            href={action.replacementLog.newFileDriveUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-neon-cyan hover:text-neon-cyan/80 font-medium"
                          >
                            Open
                            <span className="truncate max-w-[10rem]">{action.replacementLog.newFileName}</span>
                            <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-80" />
                          </a>
                        </p>
                      )}
                    {action.error && (
                      <p className="text-[10px] text-red-400 truncate mt-0.5 leading-tight">{action.error}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap justify-end shrink-0 pt-0.5">
                    {getStatusLabel(action.status)}
                    {canRequeueFromHistory(action) && (
                      <button
                        type="button"
                        onClick={() => retryAction.mutate(action.id)}
                        disabled={retryAction.isPending}
                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-neon-cyan/15 text-neon-cyan border border-neon-cyan/30 hover:bg-neon-cyan/25 text-[10px] font-medium leading-none disabled:opacity-50 transition-colors"
                        title="Put this job back in the pending queue"
                      >
                        <RefreshCw className="w-2.5 h-2.5" />
                        Re-queue
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="glass rounded-xl p-6 text-center">
          <Loader2 className="w-6 h-6 text-neon-cyan animate-spin mx-auto" />
          <p className="text-zinc-500 text-xs mt-2">Loading queue…</p>
        </div>
      ) : data?.actions.length === 0 && (
        <div className="glass rounded-xl p-6 text-center">
          <div className="w-12 h-12 mx-auto mb-2 rounded-lg bg-void-700 flex items-center justify-center">
            <Clock className="w-6 h-6 text-zinc-500" />
          </div>
          <h3 className="text-sm font-medium mb-1">No actions queued</h3>
          <p className="text-zinc-500 text-xs max-w-sm mx-auto">
            Use Overview → AI suggestions to queue work.
          </p>
        </div>
      )}
    </div>
  );
}
