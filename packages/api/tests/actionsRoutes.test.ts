import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const envSnapshot = { ...process.env };

async function createActionsApp() {
  vi.resetModules();

  const dir = mkdtempSync(join(tmpdir(), 'gdc-actions-test-'));
  process.env.DATABASE_URL = `file:${join(dir, 'actions.db')}`;
  process.env.LOG_LEVEL = 'silent';

  const fastify = (await import('fastify')).default;
  const websocket = (await import('@fastify/websocket')).default;
  const dbModule = await import('../src/db/index.js');
  const { actionsRoutes } = await import('../src/routes/actions.js');

  await dbModule.initDb();

  const app = fastify({ logger: false });
  await app.register(websocket);
  await app.register(actionsRoutes, { prefix: '/api/actions' });
  await app.ready();

  return { dir, app, dbModule };
}

describe('actions routes', () => {
  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('does not create duplicate queued actions for files with active work', async () => {
    const { dir, app, dbModule } = await createActionsApp();
    const db = dbModule.getDb();
    const { schema } = dbModule;

    try {
      await db.insert(schema.files).values({
        id: 'file-1',
        name: 'clip.mov',
        mimeType: 'video/quicktime',
        size: 1_000,
        suggestion: 'delete',
        confidence: 0.9,
        status: 'pending',
        isFolder: false,
      });

      await db.insert(schema.actions).values({
        fileId: 'file-1',
        action: 'delete',
        status: 'running',
        createdAt: new Date(),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/actions/queue-suggestions',
        payload: {
          suggestions: ['delete'],
          minConfidence: 0.5,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ success: true, queued: 0 });

      const actions = await db.select().from(schema.actions);
      expect(actions).toHaveLength(1);
    } finally {
      await app.close();
      dbModule.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows re-queuing suggestions when prior work is terminal', async () => {
    const { dir, app, dbModule } = await createActionsApp();
    const db = dbModule.getDb();
    const { schema } = dbModule;

    try {
      await db.insert(schema.files).values({
        id: 'file-2',
        name: 'clip.mov',
        mimeType: 'video/quicktime',
        size: 1_000,
        suggestion: 'compress',
        confidence: 0.9,
        status: 'pending',
        isFolder: false,
      });

      await db.insert(schema.actions).values({
        fileId: 'file-2',
        action: 'compress',
        status: 'failed',
        createdAt: new Date(),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/actions/queue-suggestions',
        payload: {
          suggestions: ['compress'],
          minConfidence: 0.5,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ success: true, queued: 1 });

      const actions = await db.select().from(schema.actions);
      expect(actions).toHaveLength(2);
      expect(actions.filter((action) => action.fileId === 'file-2' && action.status === 'pending')).toHaveLength(1);
    } finally {
      await app.close();
      dbModule.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid clear status filters', async () => {
    const { dir, app, dbModule } = await createActionsApp();

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/actions/clear?status=running',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        message: 'Invalid status "running"',
      });
    } finally {
      await app.close();
      dbModule.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
