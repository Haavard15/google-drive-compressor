import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  getQueueSettings,
  patchQueueSettings,
} from '../services/queueSettings.js';
import { kickPipeline } from '../services/pipeline.js';

const patchBodySchema = z.object({
  autoAdvance: z.boolean().optional(),
  pauseAfterCurrent: z.boolean().optional(),
});

export const queueRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/settings', async () => {
    const settings = await getQueueSettings();
    return {
      autoAdvance: settings.autoAdvance,
      pauseAfterCurrent: settings.pauseAfterCurrent,
    };
  });

  fastify.patch('/settings', async (request) => {
    const parsed = patchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw { statusCode: 400, message: 'Invalid body' };
    }
    const body = parsed.data;
    if (Object.keys(body).length === 0) {
      throw { statusCode: 400, message: 'No fields to update' };
    }

    const settings = await patchQueueSettings(body);

    kickPipeline();

    return {
      success: true,
      autoAdvance: settings.autoAdvance,
      pauseAfterCurrent: settings.pauseAfterCurrent,
    };
  });
};
