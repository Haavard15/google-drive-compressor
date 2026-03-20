import { GoogleGenerativeAI } from '@google/generative-ai';
import { eq, and, isNull, or, like, sql, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { File } from '../db/schema.js';

let genAI: GoogleGenerativeAI | null = null;
let genAIKey: string | null = null;

export function resetGeminiClient(): void {
  genAI = null;
  genAIKey = null;
}

export function hasGeminiConfigured(): boolean {
  return !!config.GEMINI_API_KEY;
}

function getGenAI(): GoogleGenerativeAI | null {
  if (!config.GEMINI_API_KEY) {
    resetGeminiClient();
    return null;
  }
  if (!genAI || genAIKey !== config.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    genAIKey = config.GEMINI_API_KEY;
  }
  return genAI;
}

export interface FileSuggestion {
  fileId: string;
  suggestion: 'delete' | 'compress' | 'keep';
  reason: string;
  confidence: number;
}

export async function analyzeFiles(
  fileIds?: string[],
  batchSize: number = 50
): Promise<FileSuggestion[]> {
  const db = getDb();
  
  // Get files to analyze
  let files: File[];
  if (fileIds && fileIds.length > 0) {
    // When specific IDs provided, analyze them regardless of current suggestion
    files = await db.select()
      .from(schema.files)
      .where(and(
        inArray(schema.files.id, fileIds),
        eq(schema.files.isFolder, false)
      ));
  } else {
    // Get unanalyzed video files
    files = await db.select()
      .from(schema.files)
      .where(and(
        isNull(schema.files.suggestion),
        eq(schema.files.isFolder, false),
        or(
          like(schema.files.mimeType, 'video/%'),
          like(schema.files.mimeType, 'application/mxf'),
        )
      ))
      .limit(batchSize);
  }
  
  log.info(`Analyzing ${files.length} files...`);

  if (files.length === 0) {
    return [];
  }

  const suggestions = await analyzeWithGemini(files);
  
  // Update database with suggestions
  for (const suggestion of suggestions) {
    await db.update(schema.files)
      .set({
        suggestion: suggestion.suggestion,
        suggestionReason: suggestion.reason,
        confidence: suggestion.confidence,
      })
      .where(eq(schema.files.id, suggestion.fileId));
  }

  return suggestions;
}

async function analyzeWithGemini(files: File[]): Promise<FileSuggestion[]> {
  const ai = getGenAI();
  if (!ai) {
    return files.map(applyHeuristics);
  }
  const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });

  // Prepare file data for the prompt
  const fileData = files.map(f => ({
    id: f.id,
    name: f.name,
    path: f.path,
    size: f.size,
    sizeMB: f.size ? Math.round(f.size / 1024 / 1024) : 0,
    duration: f.duration,
    durationMin: f.duration ? Math.round(f.duration / 60000) : 0,
    width: f.width,
    height: f.height,
    mimeType: f.mimeType,
    bitrateKbps: f.size && f.duration ? Math.round((f.size * 8) / f.duration) : null,
  }));

  const prompt = `You are analyzing video files from a video production company's Google Drive to help them reduce storage usage.

Analyze each file and suggest one of these actions:
- "delete": For raw footage, isolated recordings, screen recordings, temporary files, or obvious non-final content
- "compress": For high-bitrate videos that could be compressed without significant quality loss  
- "keep": For final deliverables, reasonably-sized archives, or files that should remain as-is

DELETION CRITERIA (suggest delete):
- Files in folders named: raw, rushes, footage, b-roll, proxy, temp, trash, unused, source
- File names containing: raw, original, take, MVI_, DSC_, IMG_, screen recording, zoom_, untitled
- Very large files (>10GB) in non-final folders
- Multiple similar files (likely multiple takes)

COMPRESSION CRITERIA (suggest compress):
- Bitrate > 50 Mbps for 4K content
- Bitrate > 20 Mbps for 1080p content  
- Bitrate > 10 Mbps for 720p or lower
- ProRes, DNxHD, or other production codecs
- Files over 5GB that aren't marked as masters/finals

KEEP CRITERIA:
- Files in folders named: final, export, delivery, master, client, archive
- Already compressed formats (h264/h265 with reasonable bitrate)
- Small files under 500MB

Here are the files to analyze:

${JSON.stringify(fileData, null, 2)}

Respond with a JSON array of suggestions. Each item must have:
- fileId: the file's id
- suggestion: "delete", "compress", or "keep"
- reason: brief explanation (max 100 chars)
- confidence: 0.0 to 1.0

Return ONLY valid JSON, no markdown or explanation.`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // Parse JSON from response (handle potential markdown code blocks)
    let jsonStr = response;
    if (response.includes('```')) {
      const match = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        jsonStr = match[1];
      }
    }

    const suggestions: FileSuggestion[] = JSON.parse(jsonStr.trim());
    
    // Validate and ensure all files have suggestions
    const suggestionMap = new Map(suggestions.map(s => [s.fileId, s]));
    
    return files.map(f => {
      const suggestion = suggestionMap.get(f.id);
      if (suggestion) {
        return {
          fileId: f.id,
          suggestion: suggestion.suggestion,
          reason: suggestion.reason,
          confidence: Math.min(1, Math.max(0, suggestion.confidence)),
        };
      }
      
      // Fallback: apply heuristic rules
      return applyHeuristics(f);
    });
  } catch (error) {
    log.error('Gemini analysis failed, falling back to heuristics:', error);
    return files.map(applyHeuristics);
  }
}

function applyHeuristics(file: File): FileSuggestion {
  const path = (file.path || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  const sizeMB = (file.size || 0) / 1024 / 1024;
  const bitrateKbps = file.size && file.duration 
    ? Math.round((file.size * 8) / file.duration) 
    : 0;

  // Delete patterns
  const deletePathPatterns = /\/(raw|rushes|footage|b-?roll|proxy|temp|trash|unused|source)\//i;
  const deleteNamePatterns = /(raw|original|take\d|MVI_|DSC_|IMG_|screen.?record|zoom_|untitled)/i;

  if (deletePathPatterns.test(path) || deleteNamePatterns.test(name)) {
    return {
      fileId: file.id,
      suggestion: 'delete',
      reason: 'Matches raw/temporary file pattern',
      confidence: 0.7,
    };
  }

  // Keep patterns  
  const keepPathPatterns = /\/(final|export|delivery|master|client|archive)\//i;
  
  if (keepPathPatterns.test(path) && sizeMB < 5000) {
    return {
      fileId: file.id,
      suggestion: 'keep',
      reason: 'Final/delivery file',
      confidence: 0.8,
    };
  }

  // Compression candidates
  const is4K = (file.width || 0) >= 3840;
  const is1080 = (file.width || 0) >= 1920;
  
  const highBitrate = (
    (is4K && bitrateKbps > 50000) ||
    (is1080 && !is4K && bitrateKbps > 20000) ||
    (!is1080 && bitrateKbps > 10000)
  );

  if (highBitrate || sizeMB > 5000) {
    return {
      fileId: file.id,
      suggestion: 'compress',
      reason: `High bitrate (${Math.round(bitrateKbps / 1000)} Mbps) or large file`,
      confidence: 0.6,
    };
  }

  // Default to keep
  return {
    fileId: file.id,
    suggestion: 'keep',
    reason: 'No issues detected',
    confidence: 0.5,
  };
}

export async function getAnalysisStats() {
  const db = getDb();
  
  const [stats] = await db.select({
    total: sql<number>`count(*)`,
    analyzed: sql<number>`count(${schema.files.suggestion})`,
    deleteCount: sql<number>`sum(case when ${schema.files.suggestion} = 'delete' then 1 else 0 end)`,
    compressCount: sql<number>`sum(case when ${schema.files.suggestion} = 'compress' then 1 else 0 end)`,
    keepCount: sql<number>`sum(case when ${schema.files.suggestion} = 'keep' then 1 else 0 end)`,
    deleteSize: sql<number>`sum(case when ${schema.files.suggestion} = 'delete' then ${schema.files.size} else 0 end)`,
    compressSize: sql<number>`sum(case when ${schema.files.suggestion} = 'compress' then ${schema.files.size} else 0 end)`,
  })
  .from(schema.files)
  .where(eq(schema.files.isFolder, false));

  return stats;
}
