import { FastifyPluginAsync } from 'fastify';
import { eq, and, like, isNull, isNotNull, sql, desc, asc, inArray, notInArray } from 'drizzle-orm';
import { getDb, schema, runRawQuery } from '../db/index.js';

/** Action rows that mean this file is already in the processing pipeline or waiting in queue. */
const ACTIVE_QUEUE_ACTION_STATUSES = [
  'pending',
  'running',
  'download_queued',
  'downloading',
  'ready_to_encode',
  'encoding',
  'ready_to_upload',
  'uploading',
] as const;

export const filesRoutes: FastifyPluginAsync = async (fastify) => {
  // List files with filtering and pagination
  fastify.get('/', async (request) => {
    const db = getDb();
    const {
      parentId,
      suggestion,
      mimeType,
      minSize,
      maxSize,
      search,
      sortBy = 'size',
      sortOrder = 'desc',
      page = 1,
      limit = 50,
      foldersOnly,
      videosOnly,
      excludeCompressed,
      excludeQueued,
      missingOnly,
      hideMissing,
    } = request.query as {
      parentId?: string;
      suggestion?: string;
      mimeType?: string;
      minSize?: string;
      maxSize?: string;
      search?: string;
      sortBy?: string;
      sortOrder?: string;
      page?: number;
      limit?: number;
      foldersOnly?: string;
      videosOnly?: string;
      excludeCompressed?: string;
      excludeQueued?: string;
      missingOnly?: string;
      hideMissing?: string;
    };

    const conditions = [];

    // Parent folder filter
    if (parentId === 'root') {
      conditions.push(isNull(schema.files.parentId));
    } else if (parentId) {
      conditions.push(eq(schema.files.parentId, parentId));
    }

    // Suggestion filter
    if (suggestion) {
      conditions.push(eq(schema.files.suggestion, suggestion));
    }

    // MIME type filter
    if (mimeType) {
      conditions.push(like(schema.files.mimeType, `${mimeType}%`));
    }

    // Size filters
    if (minSize) {
      conditions.push(sql`${schema.files.size} >= ${parseInt(minSize)}`);
    }
    if (maxSize) {
      conditions.push(sql`${schema.files.size} <= ${parseInt(maxSize)}`);
    }

    // Search
    if (search) {
      conditions.push(like(schema.files.name, `%${search}%`));
    }

    // Folders only
    if (foldersOnly === 'true') {
      conditions.push(eq(schema.files.isFolder, true));
    }

    // Videos only
    if (videosOnly === 'true') {
      conditions.push(like(schema.files.mimeType, 'video/%'));
    }

    const truthy = (v: string | undefined) => v === 'true' || v === '1';

    // Hide originals that were replaced by a compressed upload (new_file_id set on the source row)
    if (truthy(excludeCompressed)) {
      conditions.push(isNull(schema.files.newFileId));
    }

    // Hide files that already have a non-terminal action (any type)
    if (truthy(excludeQueued)) {
      const queuedFileSubquery = db
        .select({ fileId: schema.actions.fileId })
        .from(schema.actions)
        .where(
          and(
            inArray(schema.actions.status, [...ACTIVE_QUEUE_ACTION_STATUSES]),
            isNotNull(schema.actions.fileId),
          ),
        )
        .groupBy(schema.actions.fileId);

      conditions.push(notInArray(schema.files.id, queuedFileSubquery));
    }

    if (truthy(missingOnly)) {
      conditions.push(eq(schema.files.missingFromDrive, true));
    } else if (truthy(hideMissing)) {
      conditions.push(eq(schema.files.missingFromDrive, false));
    }

    // Build query
    const offset = (Number(page) - 1) * Number(limit);

    /** Bits per second: size (bytes)×8 / (duration_ms/1000). NULL when duration missing or zero. */
    const bitrateBpsExpr = sql`(CASE WHEN ${schema.files.duration} > 0 AND ${schema.files.size} IS NOT NULL THEN (CAST(${schema.files.size} AS REAL) * 8000.0 / ${schema.files.duration}) ELSE NULL END)`;

    const orderFn = sortOrder === 'asc' ? asc : desc;
    const orderByClause =
      sortBy === 'bitrate'
        ? orderFn(bitrateBpsExpr)
        : orderFn(
            sortBy === 'name'
              ? schema.files.name
              : sortBy === 'modifiedAt'
                ? schema.files.modifiedAt
                : schema.files.size,
          );

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [files, countResult] = await Promise.all([
      db.select()
        .from(schema.files)
        .where(whereClause)
        .orderBy(orderByClause)
        .limit(Number(limit))
        .offset(offset),
      db.select({ count: sql<number>`count(*)` })
        .from(schema.files)
        .where(whereClause),
    ]);

    const total = countResult[0]?.count || 0;

    return {
      files,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    };
  });

  // Get folder tree structure
  fastify.get('/tree', async (request) => {
    const db = getDb();
    const { maxDepth = 3 } = request.query as { maxDepth?: number };

    // Get all folders
    const folders = await db.select({
      id: schema.files.id,
      name: schema.files.name,
      parentId: schema.files.parentId,
      size: sql<number>`(
        SELECT COALESCE(SUM(size), 0) FROM files 
        WHERE path LIKE ${schema.files.path} || '/%' AND is_folder = 0
      )`,
      fileCount: sql<number>`(
        SELECT COUNT(*) FROM files 
        WHERE parent_id = ${schema.files.id} AND is_folder = 0
      )`,
      folderCount: sql<number>`(
        SELECT COUNT(*) FROM files 
        WHERE parent_id = ${schema.files.id} AND is_folder = 1
      )`,
    })
    .from(schema.files)
    .where(eq(schema.files.isFolder, true));

    // Build tree structure
    const folderMap = new Map(folders.map(f => [f.id, { ...f, children: [] as any[] }]));
    const tree: any[] = [];

    for (const folder of folders) {
      const node = folderMap.get(folder.id)!;
      if (folder.parentId && folderMap.has(folder.parentId)) {
        folderMap.get(folder.parentId)!.children.push(node);
      } else {
        tree.push(node);
      }
    }

    return { tree };
  });

  // Get treemap data for visualization
  fastify.get('/treemap', async (request) => {
    const db = getDb();
    const { parentId, minSize = 0 } = request.query as { 
      parentId?: string;
      minSize?: number;
    };

    // For root level, find top-level folders (look at path structure)
    let files;
    if (!parentId) {
      // Get items at root level - either null parent or items whose path has only one segment
      files = await db.select({
        id: schema.files.id,
        name: schema.files.name,
        size: schema.files.size,
        isFolder: schema.files.isFolder,
        parentId: schema.files.parentId,
        path: schema.files.path,
        suggestion: schema.files.suggestion,
        mimeType: schema.files.mimeType,
      })
      .from(schema.files)
      .where(
        sql`(${schema.files.parentId} IS NULL OR ${schema.files.path} NOT LIKE '%/%/%')`
      );
    } else {
      // Get children of specific folder
      files = await db.select({
        id: schema.files.id,
        name: schema.files.name,
        size: schema.files.size,
        isFolder: schema.files.isFolder,
        parentId: schema.files.parentId,
        path: schema.files.path,
        suggestion: schema.files.suggestion,
        mimeType: schema.files.mimeType,
      })
      .from(schema.files)
      .where(eq(schema.files.parentId, parentId));
    }

    // For folders, calculate total size of contents using recursive parent lookup
    const result = await Promise.all(files.map(async (file) => {
      if (file.isFolder) {
        // Use raw SQL for recursive CTE to calculate folder size by ID (not path)
        const sizeResult = runRawQuery<{ totalSize: number }>(`
          WITH RECURSIVE descendants AS (
            SELECT id, is_folder, size FROM files WHERE parent_id = ?
            UNION ALL
            SELECT f.id, f.is_folder, f.size FROM files f
            INNER JOIN descendants d ON f.parent_id = d.id
          )
          SELECT COALESCE(SUM(size), 0) as totalSize FROM descendants WHERE is_folder = 0
        `, [file.id]);
        
        const totalSize = sizeResult?.[0]?.totalSize || 0;

        return {
          ...file,
          size: totalSize,
        };
      }
      return file;
    }));

    // Filter by minimum size
    const filtered = result.filter(f => (f.size || 0) >= Number(minSize));

    return { files: filtered };
  });

  // Get single file details
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const db = getDb();
    const { id } = request.params;

    const [file] = await db.select()
      .from(schema.files)
      .where(eq(schema.files.id, id));

    if (!file) {
      throw { statusCode: 404, message: 'File not found' };
    }

    // Get children if it's a folder
    let children = undefined;
    if (file.isFolder) {
      children = await db.select()
        .from(schema.files)
        .where(eq(schema.files.parentId, id))
        .orderBy(desc(schema.files.size));
    }

    return { file, children };
  });

  // Bulk update suggestions (for manual override)
  fastify.patch('/suggestions', async (request) => {
    const db = getDb();
    const { fileIds, suggestion } = request.body as {
      fileIds: string[];
      suggestion: 'delete' | 'compress' | 'keep';
    };

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      throw { statusCode: 400, message: 'fileIds array required' };
    }

    if (!['delete', 'compress', 'keep'].includes(suggestion)) {
      throw { statusCode: 400, message: 'Invalid suggestion' };
    }

    let updated = 0;
    for (const fileId of fileIds) {
      const result = await db.update(schema.files)
        .set({ 
          suggestion,
          suggestionReason: 'Manually set by user',
          confidence: 1.0,
        })
        .where(eq(schema.files.id, fileId));
      updated++;
    }

    return { updated };
  });
};
