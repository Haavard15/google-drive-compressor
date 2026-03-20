import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

const configSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  DASHBOARD_URL: z.string().default('http://localhost:3000'),
  /** Application + Fastify (pino) verbosity: silent | error | warn | info | debug */
  LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('warn'),

  // Database
  DATABASE_URL: z.string().default('file:./data/drive-compressor.db'),

  // Google Auth - Service Account
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  GOOGLE_PRIVATE_KEY: z.string().optional(),
  GOOGLE_DRIVE_ROOT_FOLDER_ID: z.string().optional(),
  GOOGLE_IMPERSONATE_USER: z.string().optional(), // Email of user to impersonate (for Shared Drive access)

  // Google Auth - OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:3001/api/auth/callback'),

  // Gemini AI
  GEMINI_API_KEY: z.string().optional(),

  // Processing
  TEMP_DIR: z.string().default('/tmp/drive-compressor'),
  /** Drive download streams sharing this cap (1 = one download at a time) */
  MAX_CONCURRENT_DOWNLOADS: z.coerce.number().default(1),
  /** Drive uploads run one at a time by default */
  MAX_CONCURRENT_UPLOADS: z.coerce.number().default(1),
  /** Parallel FFmpeg encode jobs (downloads/uploads stay serialized) */
  MAX_PARALLEL_ENCODES: z.coerce.number().default(2),
  MAX_DISK_USAGE_GB: z.coerce.number().default(128),
});

export const config = configSchema.parse(process.env);
export const baseConfig: Config = { ...config };

export type Config = z.infer<typeof configSchema>;
