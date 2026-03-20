import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getAppConfigStatus, patchAppConfig } from '../services/appConfig.js';

const appConfigPatchSchema = z.object({
  serviceAccountJson: z.string().nullable().optional(),
  googleImpersonateUser: z.string().nullable().optional(),
  googleDriveRootFolderId: z.string().nullable().optional(),
  googleClientId: z.string().nullable().optional(),
  googleClientSecret: z.string().nullable().optional(),
  googleRedirectUri: z.string().nullable().optional(),
  geminiApiKey: z.string().nullable().optional(),
});

export const appConfigRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    return getAppConfigStatus();
  });

  fastify.patch('/', async (request) => {
    const parsed = appConfigPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw { statusCode: 400, message: 'Invalid app config payload' };
    }

    const next = await patchAppConfig(parsed.data);
    return {
      success: true,
      config: next,
    };
  });
};
