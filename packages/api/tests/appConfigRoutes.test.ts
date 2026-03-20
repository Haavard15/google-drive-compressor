import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const envSnapshot = { ...process.env };

async function createConfigApp() {
  vi.resetModules();

  const dir = mkdtempSync(join(tmpdir(), 'gdc-config-test-'));
  process.env.DATABASE_URL = `file:${join(dir, 'config.db')}`;
  process.env.LOG_LEVEL = 'silent';

  const fastify = (await import('fastify')).default;
  const dbModule = await import('../src/db/index.js');
  const { loadStoredAppConfig } = await import('../src/services/appConfig.js');
  const { appConfigRoutes } = await import('../src/routes/appConfig.js');
  const { authRoutes } = await import('../src/routes/auth.js');

  await dbModule.initDb();
  await loadStoredAppConfig();

  const app = fastify({ logger: false });
  await app.register(appConfigRoutes, { prefix: '/api/app-config' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.ready();

  return { dir, app, dbModule };
}

describe('app config routes', () => {
  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('stores service account JSON and exposes safe status fields', async () => {
    const { dir, app, dbModule } = await createConfigApp();

    try {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/app-config',
        payload: {
          serviceAccountJson: JSON.stringify({
            client_email: 'svc@example.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
          }),
          googleImpersonateUser: 'editor@example.com',
          googleDriveRootFolderId: 'root-folder-123',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        config: {
          google: {
            serviceAccountEmail: 'svc@example.com',
            hasServiceAccountPrivateKey: true,
            impersonateUser: 'editor@example.com',
            rootFolderId: 'root-folder-123',
          },
        },
      });

      const authStatus = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
      });

      expect(authStatus.statusCode).toBe(200);
      expect(authStatus.json()).toMatchObject({
        hasServiceAccountConfig: true,
        hasOAuthConfig: false,
      });
    } finally {
      await app.close();
      dbModule.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores Gemini key state and reports heuristic mode by default', async () => {
    const { dir, app, dbModule } = await createConfigApp();

    try {
      const initial = await app.inject({
        method: 'GET',
        url: '/api/app-config',
      });

      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({
        gemini: {
          hasApiKey: false,
          analysisMode: 'heuristic',
        },
      });

      const updated = await app.inject({
        method: 'PATCH',
        url: '/api/app-config',
        payload: {
          geminiApiKey: 'test-gemini-key',
        },
      });

      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({
        config: {
          gemini: {
            hasApiKey: true,
            analysisMode: 'gemini',
          },
        },
      });
    } finally {
      await app.close();
      dbModule.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
