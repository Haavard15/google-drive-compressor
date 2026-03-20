'use client';

import { HardDrive, Trash2, Minimize2, Check, Film, TrendingDown, CloudOff } from 'lucide-react';
import { Stats, formatBytes } from '@/lib/api';

interface StorageStatsProps {
  stats: Stats;
}

const CARD_COLOR_STYLES = {
  cyan: {
    iconBg: 'bg-neon-cyan/20',
    iconText: 'text-neon-cyan',
  },
  purple: {
    iconBg: 'bg-neon-purple/20',
    iconText: 'text-neon-purple',
  },
  pink: {
    iconBg: 'bg-neon-pink/20',
    iconText: 'text-neon-pink',
  },
  yellow: {
    iconBg: 'bg-neon-yellow/20',
    iconText: 'text-neon-yellow',
  },
} as const;

export function StorageStats({ stats }: StorageStatsProps) {
  const goneN = stats.storage.goneFromDriveVideos ?? 0;
  const goneBytes = stats.storage.goneFromDriveVideoBytes ?? 0;

  const cards = [
    {
      label: 'Total Storage',
      value: formatBytes(stats.storage.totalSize),
      subValue: `${stats.storage.totalFiles.toLocaleString()} files`,
      icon: HardDrive,
      color: 'cyan',
      gradient: 'from-neon-cyan/20 to-transparent',
    },
    {
      label: 'Video Files',
      value: formatBytes(stats.storage.videoSize),
      subValue: `${stats.storage.videoFiles.toLocaleString()} videos`,
      icon: Film,
      color: 'purple',
      gradient: 'from-neon-purple/20 to-transparent',
    },
    {
      label: 'Can Delete',
      value: formatBytes(stats.suggestions.delete.size),
      subValue: `${stats.suggestions.delete.count.toLocaleString()} files`,
      icon: Trash2,
      color: 'pink',
      gradient: 'from-neon-pink/20 to-transparent',
    },
    {
      label: 'Can Compress',
      value: formatBytes(stats.suggestions.compress.size),
      subValue: `Save ~${formatBytes(stats.suggestions.compress.estimatedSavings)}`,
      icon: Minimize2,
      color: 'yellow',
      gradient: 'from-neon-yellow/20 to-transparent',
    },
    {
      label: 'Potential Savings',
      value: formatBytes(stats.savings.total),
      subValue: `${stats.savings.percentageReduction}% reduction`,
      icon: TrendingDown,
      color: 'cyan',
      gradient: 'from-neon-cyan/20 via-neon-purple/10 to-transparent',
      highlight: true,
    },
    ...(goneN > 0
      ? [
          {
            label: 'Gone from Drive',
            value: formatBytes(goneBytes),
            subValue: `${goneN.toLocaleString()} videos (stale index)`,
            icon: CloudOff,
            color: 'yellow' as const,
            gradient: 'from-amber-500/15 to-transparent',
            highlight: false as const,
          },
        ]
      : []),
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`glass rounded-2xl p-5 relative overflow-hidden ${
            card.highlight ? 'ring-1 ring-neon-cyan/30' : ''
          }`}
        >
          {/* Gradient background */}
          <div className={`absolute inset-0 bg-gradient-to-br ${card.gradient} pointer-events-none`} />

          <div className="relative">
            {(() => {
              const colorStyles = CARD_COLOR_STYLES[card.color as keyof typeof CARD_COLOR_STYLES];
              return (
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${colorStyles.iconBg}`}
                >
                  <card.icon className={`w-5 h-5 ${colorStyles.iconText}`} />
                </div>
              );
            })()}

            <p className="text-sm text-zinc-500 mb-1">{card.label}</p>
            <p className="text-2xl font-bold tabular-nums">{card.value}</p>
            <p className="text-sm text-zinc-500 mt-1">{card.subValue}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
