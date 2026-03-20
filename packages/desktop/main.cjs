'use strict';

const { app, Tray, Menu, shell, nativeImage, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');

const MANAGED_SERVERS = app.isPackaged || process.env.DESKTOP_MANAGED_SERVERS === 'true';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const API_URL = process.env.API_URL || 'http://localhost:3001';
const OPEN_BROWSER_ON_START = process.env.OPEN_BROWSER_ON_START !== 'false';

let tray = null;
let mainWindow = null;
let ws = null;
let reconnectTimer = null;
let menuRebuildTimer = null;
let menuPollTimer = null;
let webServerProc = null;
let apiServer = null;
let lastProgressLine = 'Idle';
let lastProgressPct = 0;
let appQuitting = false;
let wsConnected = false;
let jobProcessing = false;
let apiReportsPipelineWork = false;

const ACTIVE_PHASES = new Set(['download', 'compress', 'upload', 'trash', 'delete']);
const TRAY_ACTIVE_JOB_STATUSES = new Set([
  'running',
  'downloading',
  'ready_to_encode',
  'encoding',
  'ready_to_upload',
  'uploading',
]);

function normalizeApiBase(url) {
  let s = url.replace(/\/$/, '');
  s = s.replace(/\/api\/?$/, '');
  s = s.replace('://0.0.0.0:', '://127.0.0.1:');
  s = s.replace('://[::]:', '://127.0.0.1:');
  return s;
}

function apiRoot() {
  return normalizeApiBase(API_URL);
}

function apiUrl(suffix) {
  const base = apiRoot();
  const s = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${base}/api${s}`;
}

function wsActionsUrl() {
  const u = new URL(apiRoot());
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}/api/actions/ws`;
}

function releaseRoot() {
  return app.isPackaged
    ? path.join(app.getAppPath(), '.release')
    : path.join(__dirname, '.release');
}

function loadReleaseManifest() {
  const manifestPath = path.join(releaseRoot(), 'manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw);
}

function trayIconPath(processing) {
  const base = processing ? 'trayActive' : 'tray';
  if (process.platform === 'darwin') {
    const templatePath = path.join(__dirname, 'assets', `${base}Template.png`);
    if (fs.existsSync(templatePath)) return templatePath;
  }
  return path.join(__dirname, 'assets', `${base}.png`);
}

function loadTrayNativeImage(processing) {
  const iconPath = trayIconPath(processing);
  const img = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin' && iconPath.includes('Template')) {
    img.setTemplateImage(true);
  }
  if (img.isEmpty()) {
    console.error('[desktop] Tray icon missing or invalid:', iconPath);
  }
  return img;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function actionCreatedAtMs(a) {
  const c = a.createdAt;
  if (c == null || c === '') return 0;
  if (typeof c === 'number') {
    return c < 1_000_000_000_000 ? c * 1000 : c;
  }
  const t = new Date(String(c)).getTime();
  return Number.isFinite(t) ? t : 0;
}

function comparePipelineQueueOrder(a, b) {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pb - pa;
  return actionCreatedAtMs(a) - actionCreatedAtMs(b);
}

function humanizeActionStatus(status) {
  const labels = {
    download_queued: 'queued for download',
    ready_to_encode: 'ready to encode',
    ready_to_upload: 'ready to upload',
  };
  if (labels[status]) return labels[status];
  return String(status || '').replace(/_/g, ' ') || 'unknown';
}

function applyTrayImage() {
  if (!tray) return;
  const processing = apiReportsPipelineWork || (wsConnected && jobProcessing);
  const img = loadTrayNativeImage(processing);
  if (!img.isEmpty()) {
    tray.setImage(img);
  }
}

function refreshTooltip() {
  if (!tray) return;
  if (!wsConnected) {
    tray.setToolTip('Drive compressor — offline');
    return;
  }
  tray.setToolTip(truncate(`${lastProgressPct}% · ${lastProgressLine}`, 110));
}

function setWsConnected(connected) {
  if (wsConnected === connected) return;
  wsConnected = connected;
  jobProcessing = false;
  applyTrayImage();
  scheduleMenuRebuild();
}

function setJobProcessing(on) {
  if (jobProcessing === on) return;
  jobProcessing = on;
  applyTrayImage();
  scheduleMenuRebuild();
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: 'Drive Compressor',
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'tray.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('close', (event) => {
    if (!appQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(DASHBOARD_URL).catch((err) => {
    console.error('[desktop] Failed to load dashboard:', err);
  });

  return mainWindow;
}

function showMainWindow() {
  const win = createMainWindow();
  if (!win.isVisible()) {
    win.show();
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
}

async function fetchQueueSettings() {
  const r = await fetch(apiUrl('/queue/settings'));
  if (!r.ok) throw new Error(`settings ${r.status}`);
  return r.json();
}

async function patchQueueSettings(body) {
  const r = await fetch(apiUrl('/queue/settings'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.message || r.statusText);
  }
  return r.json();
}

async function waitForUrl(url, maxMs = 120000) {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch (err) {
      const now = Date.now();
      if (now - lastLog > 8000) {
        lastLog = now;
        console.error('[desktop] waiting for service…', url, '-', err.message);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForHealth(maxMs = 120000) {
  return waitForUrl(apiUrl('/health'), maxMs);
}

async function fetchPipelineActions() {
  const collected = [];
  let page = 1;
  const limit = 100;
  const maxPages = 30;

  for (let i = 0; i < maxPages; i += 1) {
    const r = await fetch(apiUrl(`/actions?page=${page}&limit=${limit}`));
    if (!r.ok) throw new Error(`actions ${r.status}`);
    const j = await r.json();
    const batch = j.actions || [];
    collected.push(...batch);
    const total = Number(j.pagination?.total ?? collected.length);
    if (batch.length < limit || collected.length >= total) break;
    page += 1;
  }

  return collected
    .filter((a) => TRAY_ACTIVE_JOB_STATUSES.has(a.status))
    .sort(comparePipelineQueueOrder);
}

async function rebuildMenu() {
  if (!tray) return;
  let settings = { autoAdvance: true, pauseAfterCurrent: false };
  try {
    settings = await fetchQueueSettings();
  } catch (_) {
    /* offline */
  }

  let pipelineJobs = [];
  try {
    pipelineJobs = await fetchPipelineActions();
  } catch (_) {
    pipelineJobs = [];
  }

  const hadApiWork = pipelineJobs.length > 0;
  if (apiReportsPipelineWork !== hadApiWork) {
    apiReportsPipelineWork = hadApiWork;
    applyTrayImage();
  }

  const wsNote = !wsConnected ? ' · WS offline' : '';
  const runLabel = hadApiWork
    ? `Pipeline: ${pipelineJobs.length} job${pipelineJobs.length === 1 ? '' : 's'}${wsNote}`
    : wsConnected && jobProcessing
      ? `Working…${wsNote}`
      : `Idle${wsNote}`;

  const template = [
    {
      label: 'Open dashboard',
      click: () => showMainWindow(),
    },
    {
      label: 'Open in browser',
      click: () => shell.openExternal(DASHBOARD_URL),
    },
    { type: 'separator' },
    { label: runLabel, enabled: false },
  ];

  if (pipelineJobs.length > 0) {
    template.push({ type: 'separator' });
    for (const a of pipelineJobs) {
      const name = truncate(a.file?.name || 'Unknown file', 52);
      const st = humanizeActionStatus(a.status);
      const pct = typeof a.progress === 'number' ? `${Math.round(a.progress)}%` : '';
      template.push({
        label: `${name} · ${st}${pct ? ` · ${pct}` : ''}`,
        enabled: false,
      });
    }
  } else if (wsConnected) {
    template.push({
      label: `Last event: ${truncate(lastProgressLine, 44)} (${lastProgressPct}%)`,
      enabled: false,
    });
  }

  template.push(
    { type: 'separator' },
    {
      label: settings.autoAdvance ? 'Pause queue' : 'Resume queue',
      click: async () => {
        try {
          await patchQueueSettings({ autoAdvance: !settings.autoAdvance });
        } catch (e) {
          console.error(e);
        }
        await rebuildMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function scheduleMenuRebuild() {
  if (menuRebuildTimer) return;
  menuRebuildTimer = setTimeout(() => {
    menuRebuildTimer = null;
    rebuildMenu().catch(() => {});
  }, 400);
}

function connectWs() {
  if (appQuitting) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch (_) {
      /* ignore */
    }
    ws = null;
  }

  const url = wsActionsUrl();
  console.log('[desktop] WebSocket →', url);
  ws = new WebSocket(url);

  ws.on('open', () => {
    setWsConnected(true);
    refreshTooltip();
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'action_progress' && msg.data) {
        const d = msg.data;
        const line = d.statusLine || d.status || '';
        if (line) lastProgressLine = line;
        if (typeof d.progress === 'number') lastProgressPct = d.progress;

        const ph = d.phase;
        if (ph === 'finalize') {
          setJobProcessing(false);
        } else if (ph && ACTIVE_PHASES.has(String(ph))) {
          setJobProcessing(true);
        }

        refreshTooltip();
        scheduleMenuRebuild();
      }
    } catch (_) {
      /* ignore */
    }
  });

  ws.on('error', (err) => {
    console.error('[desktop] WebSocket error:', err.message || err);
  });

  ws.on('close', () => {
    ws = null;
    setWsConnected(false);
    refreshTooltip();
    if (appQuitting) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs();
    }, 4000);
  });
}

async function startManagedApiServer() {
  process.env.PORT = '3001';
  process.env.HOST = '127.0.0.1';
  process.env.API_URL = API_URL;
  process.env.DASHBOARD_URL = DASHBOARD_URL;
  process.env.GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/callback';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || `file:${path.join(app.getPath('userData'), 'drive-compressor.db')}`;
  process.env.TEMP_DIR =
    process.env.TEMP_DIR || path.join(app.getPath('temp'), 'drive-compressor');

  const apiEntry = path.join(releaseRoot(), 'api', 'index.js');
  const apiModule = await import(pathToFileURL(apiEntry).href);
  apiServer = await apiModule.startServer({ host: '127.0.0.1', port: 3001 });
}

async function startManagedWebServer() {
  const manifest = loadReleaseManifest();
  const webEntry = path.join(releaseRoot(), manifest.webEntry);
  const webCwd = path.dirname(webEntry);

  webServerProc = spawn(process.execPath, [webEntry], {
    cwd: webCwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: '3000',
      HOSTNAME: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  webServerProc.stdout.on('data', (chunk) => {
    console.log(`[desktop:web] ${chunk.toString().trim()}`);
  });
  webServerProc.stderr.on('data', (chunk) => {
    console.error(`[desktop:web] ${chunk.toString().trim()}`);
  });
  webServerProc.on('exit', (code, signal) => {
    webServerProc = null;
    if (!appQuitting) {
      console.error('[desktop] Web server exited unexpectedly:', code, signal);
    }
  });
}

async function startManagedRuntime() {
  await startManagedApiServer();
  await startManagedWebServer();
  await waitForHealth();
  await waitForUrl(DASHBOARD_URL);
}

async function stopManagedRuntime() {
  if (webServerProc) {
    webServerProc.kill();
    webServerProc = null;
  }
  if (apiServer) {
    try {
      await apiServer.close();
    } catch (_) {
      /* ignore */
    }
    apiServer = null;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[desktop] Another desktop instance is running — exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

app.whenReady().then(async () => {
  try {
    console.log('[desktop] API', apiRoot(), '| dashboard', DASHBOARD_URL, '| managed', MANAGED_SERVERS);

    if (MANAGED_SERVERS) {
      await startManagedRuntime();
    } else {
      await waitForHealth();
      await waitForUrl(DASHBOARD_URL);
    }

    const icon = loadTrayNativeImage(false);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.on('double-click', () => showMainWindow());
    refreshTooltip();

    await rebuildMenu();

    if (menuPollTimer) clearInterval(menuPollTimer);
    menuPollTimer = setInterval(() => {
      if (tray) rebuildMenu().catch(() => {});
    }, 5000);

    createMainWindow();
    connectWs();

    if (OPEN_BROWSER_ON_START) {
      showMainWindow();
    }
  } catch (err) {
    console.error('[desktop] Failed to start desktop app:', err);
    await stopManagedRuntime();
    app.quit();
    process.exit(1);
  }
});

app.on('activate', () => {
  showMainWindow();
});

app.on('before-quit', () => {
  appQuitting = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (menuRebuildTimer) {
    clearTimeout(menuRebuildTimer);
    menuRebuildTimer = null;
  }
  if (menuPollTimer) {
    clearInterval(menuPollTimer);
    menuPollTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch (_) {
      /* ignore */
    }
    ws = null;
  }
  void stopManagedRuntime();
});

app.on('window-all-closed', () => {});
