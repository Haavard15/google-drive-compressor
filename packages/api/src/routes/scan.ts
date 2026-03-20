import { FastifyPluginAsync } from 'fastify';
import {
  startScan,
  getScanStatus,
  getLatestScan,
  onScanProgress,
  recoverStalledScanJobs,
} from '../services/scanner.js';
import { isAuthenticated } from '../services/drive.js';

// Store connected WebSocket clients
const wsClients = new Set<WebSocket>();

export const scanRoutes: FastifyPluginAsync = async (fastify) => {
  // Set up progress callback to broadcast to WebSocket clients
  onScanProgress((progress) => {
    const message = JSON.stringify({ type: 'scan_progress', data: progress });
    wsClients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    });
  });

  // WebSocket endpoint for real-time scan progress
  fastify.get('/ws', { websocket: true }, (socket, request) => {
    wsClients.add(socket as unknown as WebSocket);
    
    socket.on('close', () => {
      wsClients.delete(socket as unknown as WebSocket);
    });
  });

  // Start a new scan
  fastify.post('/', async (request) => {
    if (!isAuthenticated()) {
      throw { statusCode: 401, message: 'Not authenticated with Google Drive' };
    }

    const { folderId } = (request.body as { folderId?: string }) || {};
    
    const job = await startScan(folderId);
    
    return {
      success: true,
      jobId: job.id,
      message: 'Scan started',
    };
  });

  // Get scan status by job ID
  fastify.get<{ Params: { jobId: string } }>('/:jobId', async (request) => {
    const jobId = parseInt(request.params.jobId);
    
    if (isNaN(jobId)) {
      throw { statusCode: 400, message: 'Invalid job ID' };
    }

    const job = await getScanStatus(jobId);
    
    if (!job) {
      throw { statusCode: 404, message: 'Scan job not found' };
    }

    return job;
  });

  // Get latest scan job
  fastify.get('/latest', async () => {
    const job = await getLatestScan();
    return job || { message: 'No scans found' };
  });

  /** Clear zombie `running` rows without restarting the API (same as startup recovery). */
  fastify.post('/recover-stuck', async () => {
    if (!isAuthenticated()) {
      throw { statusCode: 401, message: 'Not authenticated with Google Drive' };
    }
    const count = await recoverStalledScanJobs({ excludeActiveScanner: true });
    return { success: true, recovered: count };
  });

  // Get current scan status (if any running)
  fastify.get('/status', async () => {
    const job = await getLatestScan();
    
    if (!job) {
      return { status: 'idle', message: 'No scans performed yet' };
    }

    if (job.status === 'running') {
      return {
        status: 'running',
        jobId: job.id,
        scannedFiles: job.scannedFiles,
        totalSize: job.totalSize,
      };
    }

    return {
      status: job.status,
      jobId: job.id,
      scannedFiles: job.scannedFiles,
      totalFiles: job.totalFiles,
      totalSize: job.totalSize,
      completedAt: job.completedAt,
      error: job.error ?? undefined,
    };
  });
};
