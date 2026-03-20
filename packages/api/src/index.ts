import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { initDb } from './db/index.js';
import { recoverZombieRunningActions } from './services/processor.js';
import { recoverOrphanedPipelineJobs, kickPipeline } from './services/pipeline.js';
import { recoverStalledScanJobs } from './services/scanner.js';
import { scanRoutes } from './routes/scan.js';
import { filesRoutes } from './routes/files.js';
import { actionsRoutes } from './routes/actions.js';
import { statsRoutes } from './routes/stats.js';
import { queueRoutes } from './routes/queue.js';
import { compressionRoutes } from './routes/compression.js';
import { authRoutes } from './routes/auth.js';
import { appConfigRoutes } from './routes/appConfig.js';
import { initServiceAccount } from './services/drive.js';
import { log } from './logger.js';
import { loadStoredAppConfig } from './services/appConfig.js';

function fastifyLoggerOption(): boolean | { level: string } {
  if (config.LOG_LEVEL === 'silent') return false;
  const level =
    config.LOG_LEVEL === 'debug'
      ? 'debug'
      : config.LOG_LEVEL === 'info'
        ? 'info'
        : config.LOG_LEVEL === 'warn'
          ? 'warn'
          : 'error';
  return { level };
}

export function buildServer(): FastifyInstance {
  return Fastify({
    logger: fastifyLoggerOption(),
    disableRequestLogging: true,
  });
}

function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;

  try {
    const requestUrl = new URL(origin);
    const dashboardOrigin = new URL(config.DASHBOARD_URL).origin;

    if (requestUrl.origin === dashboardOrigin) {
      return true;
    }

    const isLocalhostHost =
      requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1';

    if (isLocalhostHost) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(cors, {
    origin: (origin, cb) => {
      cb(null, isAllowedOrigin(origin));
    },
    credentials: true,
  });

  await fastify.register(websocket);

  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(appConfigRoutes, { prefix: '/api/app-config' });
  await fastify.register(scanRoutes, { prefix: '/api/scan' });
  await fastify.register(filesRoutes, { prefix: '/api/files' });
  await fastify.register(actionsRoutes, { prefix: '/api/actions' });
  await fastify.register(statsRoutes, { prefix: '/api/stats' });
  await fastify.register(queueRoutes, { prefix: '/api/queue' });
  await fastify.register(compressionRoutes, { prefix: '/api/compression' });

  fastify.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}

async function runStartupRecovery(): Promise<void> {
  const stalledScans = await recoverStalledScanJobs();
  if (stalledScans > 0) {
    log.warn(
      `♻️ Marked ${stalledScans} scan job(s) as failed (were still "running" after restart — no active scanner).`,
    );
  }

  const pipelineResume = await recoverOrphanedPipelineJobs();
  if (pipelineResume.resumed > 0) {
    log.info(
      `♻️ Pipeline resume: reconciled ${pipelineResume.resumed}/${pipelineResume.examined} compress/download job(s) from local temp files after restart.`,
    );
  }

  const zombies = await recoverZombieRunningActions();
  if (zombies > 0) {
    log.warn(
      `♻️ Recovered ${zombies} stuck queue job(s) that were still "running" in the database (no active worker). Files reset to pending — re-queue if needed.`,
    );
  }
}

async function maybeInitServiceAccount(): Promise<void> {
  if (config.GOOGLE_SERVICE_ACCOUNT_EMAIL && config.GOOGLE_PRIVATE_KEY) {
    try {
      await initServiceAccount();
      log.info('🔐 Google Drive service account initialized');
    } catch (error) {
      log.warn(
        '⚠️ Failed to init service account:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export async function startServer(
  options?: { port?: number; host?: string },
): Promise<FastifyInstance> {
  await initDb();
  await loadStoredAppConfig();
  await runStartupRecovery();
  await maybeInitServiceAccount();

  const fastify = buildServer();
  await registerRoutes(fastify);

  await fastify.listen({
    port: options?.port ?? config.PORT,
    host: options?.host ?? config.HOST,
  });

  console.log(`🚀 Server running at http://${options?.host ?? config.HOST}:${options?.port ?? config.PORT}`);
  kickPipeline();
  return fastify;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectExecution()) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
