'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Sparkles, Upload } from 'lucide-react';
import { appConfigApi } from '@/lib/api';

type Props = {
  showTitle?: boolean;
  compact?: boolean;
};

const helperLinkClass = 'text-neon-cyan hover:text-neon-cyan/80 underline underline-offset-4';

export function SetupPanel({ showTitle = true, compact = false }: Props) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['appConfig'],
    queryFn: appConfigApi.get,
  });

  const [serviceAccountJson, setServiceAccountJson] = useState('');
  const [serviceAccountFileName, setServiceAccountFileName] = useState<string | null>(null);
  const [googleImpersonateUser, setGoogleImpersonateUser] = useState('');
  const [googleDriveRootFolderId, setGoogleDriveRootFolderId] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [googleRedirectUri, setGoogleRedirectUri] = useState('http://localhost:3001/api/auth/callback');
  const [geminiApiKey, setGeminiApiKey] = useState('');

  useEffect(() => {
    if (!data) return;
    setGoogleImpersonateUser(data.google.impersonateUser ?? '');
    setGoogleDriveRootFolderId(data.google.rootFolderId ?? '');
    setGoogleClientId(data.google.clientId ?? '');
    setGoogleRedirectUri(data.google.redirectUri);
  }, [data]);

  const commonSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['appConfig'] });
    queryClient.invalidateQueries({ queryKey: ['auth'] });
    queryClient.invalidateQueries({ queryKey: ['stats'] });
  };

  const saveServiceAccount = useMutation({
    mutationFn: () =>
      appConfigApi.patch({
        serviceAccountJson: serviceAccountJson || undefined,
        googleImpersonateUser,
        googleDriveRootFolderId,
      }),
    onSuccess: () => {
      setServiceAccountJson('');
      setServiceAccountFileName(null);
      commonSuccess();
    },
  });

  const saveOAuth = useMutation({
    mutationFn: () =>
      appConfigApi.patch({
        googleClientId,
        googleClientSecret: googleClientSecret || undefined,
        googleRedirectUri,
        googleDriveRootFolderId,
      }),
    onSuccess: () => {
      setGoogleClientSecret('');
      commonSuccess();
    },
  });

  const saveGemini = useMutation({
    mutationFn: () =>
      appConfigApi.patch({
        geminiApiKey: geminiApiKey || undefined,
      }),
    onSuccess: () => {
      setGeminiApiKey('');
      commonSuccess();
    },
  });

  const errorMessage =
    (saveServiceAccount.error as Error | null)?.message ||
    (saveOAuth.error as Error | null)?.message ||
    (saveGemini.error as Error | null)?.message ||
    null;

  const analysisModeLabel = useMemo(() => {
    if (!data) return 'Loading…';
    return data.gemini.analysisMode === 'gemini' ? 'Gemini AI enabled' : 'Heuristic-only analysis';
  }, [data]);

  const onServiceAccountFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setServiceAccountFileName(file.name);
    const text = await file.text();
    setServiceAccountJson(text);
  };

  return (
    <div className={`glass rounded-2xl border border-zinc-800/70 ${compact ? 'p-4' : 'p-6'}`}>
      {showTitle && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold">Setup & Settings</h2>
          <p className="text-sm text-zinc-500 mt-1">
            Configure Google Drive access and optional Gemini AI without editing <code>.env</code>.
            Settings are stored locally on this machine.
          </p>
        </div>
      )}

      {errorMessage && (
        <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {errorMessage}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className="rounded-2xl border border-zinc-800/60 bg-void-800/40 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-neon-cyan" />
              <h3 className="font-medium">Service Account</h3>
            </div>
            {data?.google.hasServiceAccountPrivateKey && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Configured
              </span>
            )}
          </div>

          <p className="text-sm text-zinc-500 mt-2 leading-relaxed">
            Best for Google Workspace or Shared Drives. Create a service account in Google Cloud,
            enable Drive API, then upload the downloaded JSON key file.
          </p>

          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <a
              className={helperLinkClass}
              href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
              target="_blank"
              rel="noreferrer"
            >
              Enable Drive API
            </a>
            <a
              className={helperLinkClass}
              href="https://console.cloud.google.com/iam-admin/serviceaccounts"
              target="_blank"
              rel="noreferrer"
            >
              Create service account
            </a>
          </div>

          <label className="mt-4 block text-sm text-zinc-400">
            Service account JSON
            <div className="mt-2 flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 bg-void-700 px-3 py-2 text-sm hover:bg-void-600">
                <Upload className="w-4 h-4" />
                Upload JSON
                <input type="file" accept=".json,application/json" className="hidden" onChange={onServiceAccountFile} />
              </label>
              {serviceAccountFileName && (
                <span className="text-xs text-zinc-500 truncate">{serviceAccountFileName}</span>
              )}
            </div>
            <textarea
              value={serviceAccountJson}
              onChange={(e) => setServiceAccountJson(e.target.value)}
              placeholder='Paste the full JSON key here, including "client_email" and "private_key".'
              className="mt-3 min-h-32 w-full rounded-xl border border-zinc-800 bg-void-900/70 px-3 py-3 text-sm text-zinc-200 focus:border-neon-cyan/50 focus:outline-none"
            />
          </label>

          <label className="mt-3 block text-sm text-zinc-400">
            Impersonate user (optional)
            <input
              value={googleImpersonateUser}
              onChange={(e) => setGoogleImpersonateUser(e.target.value)}
              placeholder="name@your-company.com"
              className="mt-2 w-full rounded-xl border border-zinc-800 bg-void-900/70 px-3 py-2.5 text-sm focus:border-neon-cyan/50 focus:outline-none"
            />
          </label>

          <label className="mt-3 block text-sm text-zinc-400">
            Default Drive root folder ID (optional)
            <input
              value={googleDriveRootFolderId}
              onChange={(e) => setGoogleDriveRootFolderId(e.target.value)}
              placeholder="Leave blank to scan My Drive root"
              className="mt-2 w-full rounded-xl border border-zinc-800 bg-void-900/70 px-3 py-2.5 text-sm focus:border-neon-cyan/50 focus:outline-none"
            />
          </label>

          {data?.google.serviceAccountEmail && (
            <p className="mt-3 text-xs text-zinc-500">
              Current service account: <span className="text-zinc-300">{data.google.serviceAccountEmail}</span>
            </p>
          )}

          <button
            type="button"
            onClick={() => saveServiceAccount.mutate()}
            disabled={saveServiceAccount.isPending}
            className="mt-4 w-full rounded-xl border border-neon-cyan/30 bg-neon-cyan/15 px-4 py-2.5 text-sm font-medium text-neon-cyan hover:bg-neon-cyan/25 disabled:opacity-50"
          >
            {saveServiceAccount.isPending ? 'Saving…' : 'Save service account settings'}
          </button>
        </section>

        <section className="rounded-2xl border border-zinc-800/60 bg-void-800/40 p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-neon-purple" />
              <h3 className="font-medium">Google Sign-In</h3>
            </div>
            {data?.google.hasClientSecret && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Configured
              </span>
            )}
          </div>

          <p className="text-sm text-zinc-500 mt-2 leading-relaxed">
            Best for personal Google Drive accounts. Create an OAuth client in Google Cloud and add
            the exact redirect URI shown below.
          </p>

          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <a
              className={helperLinkClass}
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noreferrer"
            >
              Open Google credentials
            </a>
          </div>

          <label className="mt-4 block text-sm text-zinc-400">
            OAuth client ID
            <input
              value={googleClientId}
              onChange={(e) => setGoogleClientId(e.target.value)}
              placeholder="Google OAuth client ID"
              className="mt-2 w-full rounded-xl border border-zinc-800 bg-void-900/70 px-3 py-2.5 text-sm focus:border-neon-purple/50 focus:outline-none"
            />
          </label>

          <label className="mt-3 block text-sm text-zinc-400">
            OAuth client secret
            <input
              type="password"
              value={googleClientSecret}
              onChange={(e) => setGoogleClientSecret(e.target.value)}
              placeholder={data?.google.hasClientSecret ? 'Saved locally - enter a new one to replace it' : 'Google OAuth client secret'}
              className="mt-2 w-full rounded-xl border border-zinc-800 bg-void-900/70 px-3 py-2.5 text-sm focus:border-neon-purple/50 focus:outline-none"
            />
          </label>

          <label className="mt-3 block text-sm text-zinc-400">
            Redirect URI
            <input
              value={googleRedirectUri}
              onChange={(e) => setGoogleRedirectUri(e.target.value)}
              className="mt-2 w-full rounded-xl border border-zinc-800 bg-void-900/70 px-3 py-2.5 text-sm focus:border-neon-purple/50 focus:outline-none"
            />
          </label>

          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            Add this exact URI to Google Cloud under OAuth redirect URIs, otherwise sign-in will fail.
          </p>

          <button
            type="button"
            onClick={() => saveOAuth.mutate()}
            disabled={saveOAuth.isPending}
            className="mt-4 w-full rounded-xl border border-neon-purple/30 bg-neon-purple/15 px-4 py-2.5 text-sm font-medium text-neon-purple hover:bg-neon-purple/25 disabled:opacity-50"
          >
            {saveOAuth.isPending ? 'Saving…' : 'Save Google sign-in settings'}
          </button>
        </section>
      </div>

      <section className="mt-6 rounded-2xl border border-zinc-800/60 bg-void-800/40 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-neon-yellow" />
            <h3 className="font-medium">Gemini AI</h3>
          </div>
          <span className="text-xs text-zinc-500">{analysisModeLabel}</span>
        </div>

        <p className="text-sm text-zinc-500 mt-2 leading-relaxed">
          Optional. Without a Gemini key the app still analyzes files using local heuristics.
        </p>

        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          <a
            className={helperLinkClass}
            href="https://makersuite.google.com/app/apikey"
            target="_blank"
            rel="noreferrer"
          >
            Get Gemini API key
          </a>
        </div>

        <label className="mt-4 block text-sm text-zinc-400">
          Gemini API key
          <input
            type="password"
            value={geminiApiKey}
            onChange={(e) => setGeminiApiKey(e.target.value)}
            placeholder={data?.gemini.hasApiKey ? 'Saved locally - enter a new key to replace it' : 'Paste Gemini API key'}
            className="mt-2 w-full rounded-xl border border-zinc-800 bg-void-900/70 px-3 py-2.5 text-sm focus:border-neon-yellow/50 focus:outline-none"
          />
        </label>

        <button
          type="button"
          onClick={() => saveGemini.mutate()}
          disabled={saveGemini.isPending}
          className="mt-4 rounded-xl border border-neon-yellow/30 bg-neon-yellow/15 px-4 py-2.5 text-sm font-medium text-neon-yellow hover:bg-neon-yellow/25 disabled:opacity-50"
        >
          {saveGemini.isPending ? 'Saving…' : 'Save Gemini settings'}
        </button>
      </section>

      {isLoading && <p className="mt-4 text-sm text-zinc-500">Loading current setup…</p>}
    </div>
  );
}
