import { FastifyPluginAsync } from 'fastify';
import { eq, sql, and, like } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { analyzeFiles, getAnalysisStats, hasGeminiConfigured } from '../services/analyzer.js';
import { getAvailableDiskSpace } from '../services/processor.js';

export const statsRoutes: FastifyPluginAsync = async (fastify) => {
  // Get overall storage stats
  fastify.get('/', async () => {
    const db = getDb();

    const [overall] = await db.select({
      totalFiles: sql<number>`count(*)`,
      totalFolders: sql<number>`sum(case when is_folder = 1 then 1 else 0 end)`,
      totalSize: sql<number>`sum(case when is_folder = 0 then size else 0 end)`,
      videoFiles: sql<number>`sum(case when mime_type like 'video/%' then 1 else 0 end)`,
      videoSize: sql<number>`sum(case when mime_type like 'video/%' then size else 0 end)`,
      goneVideoFiles: sql<number>`sum(case when coalesce(missing_from_drive, 0) = 1 and is_folder = 0 and mime_type like 'video/%' then 1 else 0 end)`,
      goneVideoSize: sql<number>`sum(case when coalesce(missing_from_drive, 0) = 1 and is_folder = 0 and mime_type like 'video/%' then coalesce(size, 0) else 0 end)`,
    })
    .from(schema.files);

    const [suggestions] = await db.select({
      deleteCount: sql<number>`sum(case when suggestion = 'delete' then 1 else 0 end)`,
      deleteSize: sql<number>`sum(case when suggestion = 'delete' then size else 0 end)`,
      compressCount: sql<number>`sum(case when suggestion = 'compress' then 1 else 0 end)`,
      compressSize: sql<number>`sum(case when suggestion = 'compress' then size else 0 end)`,
      keepCount: sql<number>`sum(case when suggestion = 'keep' then 1 else 0 end)`,
      keepSize: sql<number>`sum(case when suggestion = 'keep' then size else 0 end)`,
      unanalyzedCount: sql<number>`sum(case when suggestion is null and is_folder = 0 then 1 else 0 end)`,
    })
    .from(schema.files);

    const [actions] = await db.select({
      pending: sql<number>`sum(case when status = 'pending' then 1 else 0 end)`,
      running: sql<number>`sum(case when status in ('running','download_queued','downloading','ready_to_encode','encoding','ready_to_upload','uploading') then 1 else 0 end)`,
      completed: sql<number>`sum(case when status = 'completed' then 1 else 0 end)`,
      failed: sql<number>`sum(case when status = 'failed' then 1 else 0 end)`,
    })
    .from(schema.actions);

    const [realizedCompress] = await db.select({
      bytes: sql<number>`coalesce(sum(case
        when action = 'compress' and status = 'completed'
          and size_before_bytes is not null and size_after_bytes is not null
          and size_before_bytes > size_after_bytes
        then size_before_bytes - size_after_bytes else 0 end), 0)`,
      jobs: sql<number>`coalesce(sum(case when action = 'compress' and status = 'completed' then 1 else 0 end), 0)`,
    })
    .from(schema.actions);

    const [realizedDelete] = await db.select({
      bytes: sql<number>`coalesce(sum(case
        when action = 'delete' and status = 'completed' and size_before_bytes is not null
        then size_before_bytes else 0 end), 0)`,
      jobs: sql<number>`coalesce(sum(case when action = 'delete' and status = 'completed' then 1 else 0 end), 0)`,
    })
    .from(schema.actions);

    const realizedCompressionBytes = Number(realizedCompress?.bytes) || 0;
    const realizedDeletionBytes = Number(realizedDelete?.bytes) || 0;
    const realizedTotalBytes = realizedCompressionBytes + realizedDeletionBytes;

    // Estimate savings from compression (assume 70% reduction)
    const estimatedCompressionSavings = Math.round((suggestions?.compressSize || 0) * 0.7);
    const totalPotentialSavings = (suggestions?.deleteSize || 0) + estimatedCompressionSavings;

    const availableDiskSpace = await getAvailableDiskSpace();

    return {
      storage: {
        totalFiles: overall?.totalFiles || 0,
        totalFolders: overall?.totalFolders || 0,
        totalSize: overall?.totalSize || 0,
        videoFiles: overall?.videoFiles || 0,
        videoSize: overall?.videoSize || 0,
        goneFromDriveVideos: Number(overall?.goneVideoFiles) || 0,
        goneFromDriveVideoBytes: Number(overall?.goneVideoSize) || 0,
      },
      suggestions: {
        delete: {
          count: suggestions?.deleteCount || 0,
          size: suggestions?.deleteSize || 0,
        },
        compress: {
          count: suggestions?.compressCount || 0,
          size: suggestions?.compressSize || 0,
          estimatedSavings: estimatedCompressionSavings,
        },
        keep: {
          count: suggestions?.keepCount || 0,
          size: suggestions?.keepSize || 0,
        },
        unanalyzed: suggestions?.unanalyzedCount || 0,
      },
      actions: {
        pending: actions?.pending || 0,
        running: actions?.running || 0,
        completed: actions?.completed || 0,
        failed: actions?.failed || 0,
      },
      savings: {
        fromDeletion: suggestions?.deleteSize || 0,
        fromCompression: estimatedCompressionSavings,
        total: totalPotentialSavings,
        percentageReduction: overall?.totalSize 
          ? Math.round((totalPotentialSavings / overall.totalSize) * 100)
          : 0,
      },
      system: {
        availableDiskSpace,
      },
      analysis: {
        mode: hasGeminiConfigured() ? 'gemini' : 'heuristic',
        hasGeminiKey: hasGeminiConfigured(),
      },
      realized: {
        compressionBytesSaved: realizedCompressionBytes,
        deletionBytesFreed: realizedDeletionBytes,
        totalBytesReclaimed: realizedTotalBytes,
        completedCompressionJobs: Number(realizedCompress?.jobs) || 0,
        completedDeletionJobs: Number(realizedDelete?.jobs) || 0,
      },
    };
  });

  // Get stats by file type
  fastify.get('/by-type', async () => {
    const db = getDb();

    const byType = await db.select({
      mimeType: schema.files.mimeType,
      count: sql<number>`count(*)`,
      totalSize: sql<number>`sum(size)`,
    })
    .from(schema.files)
    .where(eq(schema.files.isFolder, false))
    .groupBy(schema.files.mimeType)
    .orderBy(sql`sum(size) desc`)
    .limit(20);

    return { byType };
  });

  // Get largest files
  fastify.get('/largest', async (request) => {
    const db = getDb();
    const { limit = 50, mimeType } = request.query as { 
      limit?: number;
      mimeType?: string;
    };

    const conditions = [eq(schema.files.isFolder, false)];
    if (mimeType) {
      conditions.push(like(schema.files.mimeType, `${mimeType}%`));
    }

    const largest = await db.select()
      .from(schema.files)
      .where(and(...conditions))
      .orderBy(sql`size desc`)
      .limit(Number(limit));

    return { files: largest };
  });

  // Get folder sizes
  fastify.get('/folders', async (request) => {
    const db = getDb();
    const { parentId, limit = 20 } = request.query as {
      parentId?: string;
      limit?: number;
    };

    // Get folders with calculated sizes
    const folders = await db.select({
      id: schema.files.id,
      name: schema.files.name,
      path: schema.files.path,
      parentId: schema.files.parentId,
    })
    .from(schema.files)
    .where(and(
      eq(schema.files.isFolder, true),
      parentId ? eq(schema.files.parentId, parentId) : sql`1=1`
    ));

    // Calculate size for each folder
    const foldersWithSize = await Promise.all(folders.map(async (folder) => {
      const [sizeResult] = await db.select({
        totalSize: sql<number>`COALESCE(SUM(size), 0)`,
        fileCount: sql<number>`COUNT(*)`,
      })
      .from(schema.files)
      .where(and(
        like(schema.files.path, `${folder.path}/%`),
        eq(schema.files.isFolder, false)
      ));

      return {
        ...folder,
        size: sizeResult?.totalSize || 0,
        fileCount: sizeResult?.fileCount || 0,
      };
    }));

    // Sort by size and limit
    const sorted = foldersWithSize
      .sort((a, b) => b.size - a.size)
      .slice(0, Number(limit));

    return { folders: sorted };
  });

  // Trigger AI analysis
  fastify.post('/analyze', async (request) => {
    const { fileIds, batchSize = 50 } = request.body as {
      fileIds?: string[];
      batchSize?: number;
    };

    const suggestions = await analyzeFiles(fileIds, batchSize);

    return {
      analyzed: suggestions.length,
      suggestions,
    };
  });

  // Get analysis progress
  fastify.get('/analysis', async () => {
    const stats = await getAnalysisStats();
    return stats;
  });
};
