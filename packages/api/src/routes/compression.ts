import { FastifyPluginAsync } from 'fastify';

/** Static list aligned with `compressionPresets` in processor (labels only; encoder picks real config). */
const PRESET_INFO: { id: string; label: string; description: string }[] = [
  {
    id: 'archive',
    label: 'Archive',
    description: 'HEVC, high quality — best for long-term storage',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'HEVC, good quality / smaller than archive',
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    description: 'HEVC, smaller files, more visible compression',
  },
  {
    id: 'fast',
    label: 'Fast (H.264)',
    description: 'H.264 — quicker encode, larger files than HEVC',
  },
];

export const compressionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/presets', async () => ({
    presets: PRESET_INFO,
    defaultPreset: 'archive',
  }));
};
