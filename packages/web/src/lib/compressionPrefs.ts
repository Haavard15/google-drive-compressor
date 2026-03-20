const LS_PRESET = 'gdrive-compress-preset';
const LS_DELETE = 'gdrive-compress-delete-original';

export type CompressionPresetId = 'archive' | 'balanced' | 'aggressive' | 'fast';

const DEFAULT_PRESET: CompressionPresetId = 'archive';

export function readCompressionPrefs(): {
  preset: CompressionPresetId;
  deleteOriginal: boolean;
} {
  if (typeof window === 'undefined') {
    return { preset: DEFAULT_PRESET, deleteOriginal: true };
  }
  try {
    const p = window.localStorage.getItem(LS_PRESET) as CompressionPresetId | null;
    const d = window.localStorage.getItem(LS_DELETE);
    const preset =
      p && ['archive', 'balanced', 'aggressive', 'fast'].includes(p) ? p : DEFAULT_PRESET;
    const deleteOriginal = d === null ? true : d === 'true';
    return { preset, deleteOriginal };
  } catch {
    return { preset: DEFAULT_PRESET, deleteOriginal: true };
  }
}

export function writeCompressionPrefs(prefs: {
  preset: CompressionPresetId;
  deleteOriginal: boolean;
}): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_PRESET, prefs.preset);
    window.localStorage.setItem(LS_DELETE, String(prefs.deleteOriginal));
  } catch {
    /* ignore */
  }
}

/** Payload for `actionsApi.queueSuggestions` compressMetadata. */
export function getCompressQueueMetadata(): { preset: string; deleteOriginal: boolean } {
  const { preset, deleteOriginal } = readCompressionPrefs();
  return { preset, deleteOriginal };
}
