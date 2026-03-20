'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { compressionApi } from '@/lib/api';
import {
  readCompressionPrefs,
  writeCompressionPrefs,
  type CompressionPresetId,
} from '@/lib/compressionPrefs';

type Props = {
  className?: string;
  compact?: boolean;
};

export function CompressionSettings({ className = '', compact = false }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['compressionPresets'],
    queryFn: compressionApi.getPresets,
    staleTime: 60_000,
  });

  const [preset, setPreset] = useState<CompressionPresetId>('archive');
  const [deleteOriginal, setDeleteOriginal] = useState(true);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  useEffect(() => {
    const p = readCompressionPrefs();
    setPreset(p.preset);
    setDeleteOriginal(p.deleteOriginal);
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return;
    writeCompressionPrefs({ preset, deleteOriginal });
  }, [prefsLoaded, preset, deleteOriginal]);

  const presets = data?.presets?.length
    ? data.presets
    : [
        { id: 'archive', label: 'Archive', description: '' },
        { id: 'balanced', label: 'Balanced', description: '' },
        { id: 'aggressive', label: 'Aggressive', description: '' },
        { id: 'fast', label: 'Fast (H.264)', description: '' },
      ];

  return (
    <div
      className={`rounded-lg border border-zinc-800/80 bg-void-800/50 ${compact ? 'p-2' : 'p-4'} ${className}`}
    >
      <p className={`font-medium text-zinc-300 ${compact ? 'text-[11px] mb-1.5' : 'text-sm mb-3'}`}>
        {compact ? 'Compression (new jobs)' : 'Video compression (new jobs)'}
      </p>
      <div
        className={`flex flex-col ${compact ? 'sm:flex-row sm:items-center sm:gap-3' : 'md:flex-row md:items-end'} gap-2`}
      >
        <label className={`flex gap-2 items-center min-w-0 ${compact ? 'flex-1' : 'flex-col flex-1 gap-1'}`}>
          {!compact && <span className="text-xs text-zinc-500">Preset</span>}
          <select
            value={preset}
            disabled={isLoading}
            onChange={(e) => setPreset(e.target.value as CompressionPresetId)}
            className={`rounded-md bg-void-800 border border-zinc-700 focus:outline-none focus:border-neon-cyan/50 disabled:opacity-50 ${
              compact
                ? 'w-full min-w-0 max-w-md py-1 pl-2 pr-1 text-xs sm:max-w-[12rem] lg:flex-1 lg:max-w-none'
                : 'px-3 py-2 rounded-lg text-sm w-full min-w-0'
            }`}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id} title={p.description}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label
          className={`flex items-center gap-1.5 text-zinc-400 cursor-pointer select-none shrink-0 ${
            compact ? 'text-[11px]' : 'text-sm pb-2 gap-2'
          }`}
        >
          <input
            type="checkbox"
            checked={deleteOriginal}
            onChange={(e) => setDeleteOriginal(e.target.checked)}
            className="rounded bg-void-700 border-zinc-600 size-3.5"
          />
          {compact ? 'Trash original' : 'Trash original after upload'}
        </label>
      </div>
      {!compact && presets.find((p) => p.id === preset)?.description && (
        <p className="text-xs text-zinc-500 mt-2">
          {presets.find((p) => p.id === preset)?.description}
        </p>
      )}
    </div>
  );
}
