'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Minimize2, Check, PlayCircle, Zap } from 'lucide-react';
import { actionsApi, formatBytes, Stats } from '@/lib/api';
import { getCompressQueueMetadata } from '@/lib/compressionPrefs';
import { CompressionSettings } from '@/components/CompressionSettings';

interface SuggestionPanelProps {
  stats?: Stats;
}

const SUGGESTION_COLOR_STYLES = {
  pink: {
    containerActive: 'border-neon-pink/30 bg-neon-pink/5',
    iconBg: 'bg-neon-pink/20',
    iconText: 'text-neon-pink',
    accentText: 'text-neon-pink',
  },
  yellow: {
    containerActive: 'border-neon-yellow/30 bg-neon-yellow/5',
    iconBg: 'bg-neon-yellow/20',
    iconText: 'text-neon-yellow',
    accentText: 'text-neon-yellow',
  },
  cyan: {
    containerActive: 'border-neon-cyan/30 bg-neon-cyan/5',
    iconBg: 'bg-neon-cyan/20',
    iconText: 'text-neon-cyan',
    accentText: 'text-neon-cyan',
  },
} as const;

export function SuggestionPanel({ stats }: SuggestionPanelProps) {
  const queryClient = useQueryClient();

  const queueSuggestions = useMutation({
    mutationFn: (suggestions: string[]) =>
      actionsApi.queueSuggestions(
        suggestions,
        0.5,
        suggestions.includes('compress') ? getCompressQueueMetadata() : undefined,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['actions'] });
      queryClient.invalidateQueries({ queryKey: ['files'] });
    },
  });

  const executeNext = useMutation({
    mutationFn: actionsApi.executeNext,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['actions'] });
    },
  });

  if (!stats) return null;

  const suggestions = [
    {
      type: 'delete',
      label: 'Files to Delete',
      description: 'Raw footage, temp files, and duplicates',
      count: stats.suggestions.delete.count,
      size: stats.suggestions.delete.size,
      icon: Trash2,
      color: 'pink',
      savings: stats.suggestions.delete.size,
    },
    {
      type: 'compress',
      label: 'Files to Compress',
      description: 'High-bitrate videos that can be optimized',
      count: stats.suggestions.compress.count,
      size: stats.suggestions.compress.size,
      icon: Minimize2,
      color: 'yellow',
      savings: stats.suggestions.compress.estimatedSavings,
    },
    {
      type: 'keep',
      label: 'Files to Keep',
      description: 'Final deliverables and optimized archives',
      count: stats.suggestions.keep.count,
      size: stats.suggestions.keep.size,
      icon: Check,
      color: 'cyan',
      savings: 0,
    },
  ];

  return (
    <div className="glass rounded-2xl p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">AI Suggestions</h2>
        {stats.suggestions.unanalyzed > 0 && (
          <span className="text-sm text-zinc-500">
            {stats.suggestions.unanalyzed} unanalyzed
          </span>
        )}
      </div>

      <div className="space-y-4 mb-6">
        {suggestions.map((item) => (
          <div
            key={item.type}
            className={`p-4 rounded-xl border transition-colors ${
              item.count > 0
                ? SUGGESTION_COLOR_STYLES[item.color as keyof typeof SUGGESTION_COLOR_STYLES].containerActive
                : 'border-zinc-800 bg-void-800/50'
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`p-2 rounded-lg ${
                  SUGGESTION_COLOR_STYLES[item.color as keyof typeof SUGGESTION_COLOR_STYLES].iconBg
                }`}
              >
                <item.icon
                  className={`w-5 h-5 ${
                    SUGGESTION_COLOR_STYLES[item.color as keyof typeof SUGGESTION_COLOR_STYLES].iconText
                  }`}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{item.label}</h3>
                  <span className="text-lg font-bold tabular-nums">{item.count}</span>
                </div>
                <p className="text-sm text-zinc-500 mt-0.5">{item.description}</p>
                <div className="flex items-center justify-between mt-2 text-sm">
                  <span className="text-zinc-400">{formatBytes(item.size)}</span>
                  {item.savings > 0 && (
                    <span
                      className={
                        SUGGESTION_COLOR_STYLES[item.color as keyof typeof SUGGESTION_COLOR_STYLES].accentText
                      }
                    >
                      Save {formatBytes(item.savings)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Total savings */}
      <div className="p-4 rounded-xl bg-gradient-to-br from-neon-cyan/10 to-neon-purple/10 border border-neon-cyan/20 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-zinc-400">Total Potential Savings</p>
            <p className="text-2xl font-bold gradient-text">{formatBytes(stats.savings.total)}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-zinc-400">Storage Reduction</p>
            <p className="text-2xl font-bold text-neon-cyan">{stats.savings.percentageReduction}%</p>
          </div>
        </div>
      </div>

      <CompressionSettings className="mb-6" />

      {/* Action buttons */}
      <div className="space-y-3">
        <button
          onClick={() => queueSuggestions.mutate(['delete'])}
          disabled={queueSuggestions.isPending || stats.suggestions.delete.count === 0}
          className="w-full py-3 px-4 rounded-xl bg-neon-pink/20 text-neon-pink border border-neon-pink/30 hover:bg-neon-pink/30 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          Queue All Deletions ({stats.suggestions.delete.count})
        </button>
        
        <button
          onClick={() => queueSuggestions.mutate(['compress'])}
          disabled={queueSuggestions.isPending || stats.suggestions.compress.count === 0}
          className="w-full py-3 px-4 rounded-xl bg-neon-yellow/20 text-neon-yellow border border-neon-yellow/30 hover:bg-neon-yellow/30 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Minimize2 className="w-4 h-4" />
          Queue All Compressions ({stats.suggestions.compress.count})
        </button>

        {stats.actions.pending > 0 && (
          <button
            onClick={() => executeNext.mutate()}
            disabled={executeNext.isPending}
            className="w-full py-3 px-4 rounded-xl bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/30 hover:bg-neon-cyan/30 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <PlayCircle className={`w-4 h-4 ${executeNext.isPending ? 'animate-spin' : ''}`} />
            {stats.actions.running > 0
              ? `Start / advance queue (${stats.actions.pending} pending, ${stats.actions.running} active)`
              : `Start Processing (${stats.actions.pending} in queue)`}
          </button>
        )}
      </div>
    </div>
  );
}
