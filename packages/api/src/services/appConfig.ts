import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { baseConfig, config, type Config } from '../config.js';
import { resetDriveAuthState } from './drive.js';
import { resetGeminiClient } from './analyzer.js';

const SETTING_KEYS = {
  serviceAccountEmail: 'app_google_service_account_email',
  serviceAccountPrivateKey: 'app_google_private_key',
  driveRootFolderId: 'app_google_drive_root_folder_id',
  impersonateUser: 'app_google_impersonate_user',
  clientId: 'app_google_client_id',
  clientSecret: 'app_google_client_secret',
  redirectUri: 'app_google_redirect_uri',
  geminiApiKey: 'app_gemini_api_key',
} as const;

type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

type AppConfigKeyMap = {
  storedKey: SettingKey;
  configKey: keyof Config;
};

const CONFIG_KEY_MAP: AppConfigKeyMap[] = [
  { storedKey: SETTING_KEYS.serviceAccountEmail, configKey: 'GOOGLE_SERVICE_ACCOUNT_EMAIL' },
  { storedKey: SETTING_KEYS.serviceAccountPrivateKey, configKey: 'GOOGLE_PRIVATE_KEY' },
  { storedKey: SETTING_KEYS.driveRootFolderId, configKey: 'GOOGLE_DRIVE_ROOT_FOLDER_ID' },
  { storedKey: SETTING_KEYS.impersonateUser, configKey: 'GOOGLE_IMPERSONATE_USER' },
  { storedKey: SETTING_KEYS.clientId, configKey: 'GOOGLE_CLIENT_ID' },
  { storedKey: SETTING_KEYS.clientSecret, configKey: 'GOOGLE_CLIENT_SECRET' },
  { storedKey: SETTING_KEYS.redirectUri, configKey: 'GOOGLE_REDIRECT_URI' },
  { storedKey: SETTING_KEYS.geminiApiKey, configKey: 'GEMINI_API_KEY' },
];

export type AppConfigStatus = {
  google: {
    serviceAccountEmail: string | null;
    hasServiceAccountPrivateKey: boolean;
    impersonateUser: string | null;
    rootFolderId: string | null;
    clientId: string | null;
    hasClientSecret: boolean;
    redirectUri: string;
  };
  gemini: {
    hasApiKey: boolean;
    analysisMode: 'gemini' | 'heuristic';
  };
};

export type AppConfigPatch = {
  serviceAccountJson?: string | null;
  googleImpersonateUser?: string | null;
  googleDriveRootFolderId?: string | null;
  googleClientId?: string | null;
  googleClientSecret?: string | null;
  googleRedirectUri?: string | null;
  geminiApiKey?: string | null;
};

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function applyConfigOverride<K extends keyof Config>(key: K, value: Config[K] | undefined): void {
  (config as Config)[key] = (value ?? baseConfig[key]) as Config[K];
}

async function upsertSetting(key: SettingKey, value: string): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value },
    });
}

async function deleteSetting(key: SettingKey): Promise<void> {
  const db = getDb();
  await db.delete(schema.appSettings).where(eq(schema.appSettings.key, key));
}

async function getStoredSettings(): Promise<Record<string, string>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.appSettings)
    .where(inArray(schema.appSettings.key, CONFIG_KEY_MAP.map((entry) => entry.storedKey)));

  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function loadStoredAppConfig(): Promise<void> {
  const stored = await getStoredSettings();
  for (const { storedKey, configKey } of CONFIG_KEY_MAP) {
    const value = stored[storedKey];
    applyConfigOverride(configKey, value as Config[typeof configKey] | undefined);
  }
}

function parseServiceAccountJson(raw: string): { email: string; privateKey: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Service account JSON is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Service account JSON is invalid');
  }

  const email = normalizeOptionalString((parsed as { client_email?: string }).client_email);
  const privateKey = normalizeOptionalString((parsed as { private_key?: string }).private_key);

  if (!email || !privateKey) {
    throw new Error('Service account JSON must include client_email and private_key');
  }

  return { email, privateKey };
}

function getAnalysisMode(): 'gemini' | 'heuristic' {
  return config.GEMINI_API_KEY ? 'gemini' : 'heuristic';
}

export async function getAppConfigStatus(): Promise<AppConfigStatus> {
  return {
    google: {
      serviceAccountEmail: config.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null,
      hasServiceAccountPrivateKey: !!config.GOOGLE_PRIVATE_KEY,
      impersonateUser: config.GOOGLE_IMPERSONATE_USER ?? null,
      rootFolderId: config.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? null,
      clientId: config.GOOGLE_CLIENT_ID ?? null,
      hasClientSecret: !!config.GOOGLE_CLIENT_SECRET,
      redirectUri: config.GOOGLE_REDIRECT_URI,
    },
    gemini: {
      hasApiKey: !!config.GEMINI_API_KEY,
      analysisMode: getAnalysisMode(),
    },
  };
}

export async function patchAppConfig(patch: AppConfigPatch): Promise<AppConfigStatus> {
  let authConfigChanged = false;
  let geminiChanged = false;

  if (patch.serviceAccountJson !== undefined) {
    const normalized = normalizeOptionalString(patch.serviceAccountJson);
    if (normalized == null) {
      await deleteSetting(SETTING_KEYS.serviceAccountEmail);
      await deleteSetting(SETTING_KEYS.serviceAccountPrivateKey);
      authConfigChanged = true;
    } else {
      const parsed = parseServiceAccountJson(normalized);
      await upsertSetting(SETTING_KEYS.serviceAccountEmail, parsed.email);
      await upsertSetting(SETTING_KEYS.serviceAccountPrivateKey, parsed.privateKey);
      authConfigChanged = true;
    }
  }

  const stringPatches: Array<{
    field: keyof AppConfigPatch;
    storedKey: SettingKey;
    authConfig?: boolean;
    geminiConfig?: boolean;
  }> = [
    { field: 'googleImpersonateUser', storedKey: SETTING_KEYS.impersonateUser, authConfig: true },
    { field: 'googleDriveRootFolderId', storedKey: SETTING_KEYS.driveRootFolderId },
    { field: 'googleClientId', storedKey: SETTING_KEYS.clientId, authConfig: true },
    { field: 'googleClientSecret', storedKey: SETTING_KEYS.clientSecret, authConfig: true },
    { field: 'googleRedirectUri', storedKey: SETTING_KEYS.redirectUri, authConfig: true },
    { field: 'geminiApiKey', storedKey: SETTING_KEYS.geminiApiKey, geminiConfig: true },
  ];

  for (const entry of stringPatches) {
    const incoming = patch[entry.field];
    if (incoming === undefined) continue;
    const normalized = normalizeOptionalString(incoming);
    if (normalized == null) {
      await deleteSetting(entry.storedKey);
    } else {
      await upsertSetting(entry.storedKey, normalized);
    }
    if (entry.authConfig) authConfigChanged = true;
    if (entry.geminiConfig) geminiChanged = true;
  }

  await loadStoredAppConfig();

  if (authConfigChanged) {
    resetDriveAuthState();
  }
  if (geminiChanged) {
    resetGeminiClient();
  }

  return getAppConfigStatus();
}
