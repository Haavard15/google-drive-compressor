# Google Drive Video Compressor

A powerful tool for video production companies to analyze, manage, and optimize Google Drive storage. Features AI-powered suggestions for files to delete or compress, with an interactive treemap visualization.

## Features

- **Storage Visualization**: Interactive treemap showing storage usage by folder
- **AI-Powered Suggestions**: Uses Gemini AI to identify files to delete or compress
- **Batch Processing**: Queue and execute multiple file operations
- **Video Compression**: FFmpeg with **Apple VideoToolbox** (H.265/H.264) on macOS by default; software x265/x264 fallback on other platforms
- **Real-time Progress**: WebSocket updates for scan and processing progress

## Screenshots

UI captures for docs and sharing live in [`screenshots/`](screenshots/). On the **Overview** tab, enable **Screenshot mode — hide names in Storage Map** to obscure folder and file names for public shots.

![Overview — Storage Map and AI suggestions](screenshots/Screenshot%202026-03-20%20at%2023.59.42.png)

![Google Drive Video Compressor — dashboard](screenshots/Screenshot%202026-03-20%20at%2022.05.56.png)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Next.js Dashboard                        │
│  • Treemap visualization  • File browser  • Action queue   │
└─────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────┐
│                     Fastify API                             │
│  • Google Drive scanning  • Gemini AI analysis             │
│  • FFmpeg processing      • SQLite storage                 │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js 18+
- pnpm 8+
- FFmpeg (for video compression)
- Google Cloud Project with Drive API enabled
- Gemini API key (optional, for AI suggestions)

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

#### Google Drive Authentication

**Option A: Service Account (Recommended for Google Workspace)**

1. Create a Service Account in Google Cloud Console
2. Enable Domain-Wide Delegation
3. Download the JSON key file
4. Add to `.env`:
   ```
   GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```

**Option B: OAuth 2.0 (For personal accounts)**

1. Create OAuth 2.0 credentials in Google Cloud Console
2. Add `http://localhost:3001/api/auth/callback` as authorized redirect URI
3. Add to `.env`:
   ```
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```

#### Gemini AI (Optional)

Get an API key from https://makersuite.google.com/app/apikey

```
GEMINI_API_KEY=your-gemini-api-key
```

### 3. Start development servers

```bash
# Start API + web only
pnpm dev

# Or separately:
pnpm dev:api   # API on http://localhost:3001 (no auto-restart on file changes)
pnpm dev:api:watch   # same API, but restarts when sources change (optional)
pnpm dev:web   # Web on http://localhost:3000
```

#### Desktop app (Electron)

The desktop app now opens the dashboard in a native **Electron window** while keeping the **tray menu** for quick status and queue controls. In development it connects to the existing local API + web servers; packaged builds bundle the local API and Next.js dashboard so the app can launch them itself. The **menu bar icon** adapts to macOS light/dark, switches to an **active** variant while work is running, and shows **offline** when the WebSocket is disconnected.

**Use only one dev stack** — do not run `pnpm dev` and `pnpm dev:electron` together (you would start **two** API + **two** web servers on the same ports).

| Command | What it starts |
|---------|----------------|
| `pnpm dev:electron` | API + web + desktop app in **one** terminal (`concurrently`; **Ctrl+C** stops all). |
| `pnpm dev:desktop` | Alias for `pnpm dev:electron`. |
| `pnpm dev` then `pnpm dev:tray` | API + web in the first terminal; tray only in the second (no duplicate servers). |

```bash
# Recommended: everything in one process group
pnpm dev:electron

# Or: API + web already running (e.g. pnpm dev), add tray only
pnpm dev:tray
```

`wait-on` waits for TCP **127.0.0.1:3001** and **127.0.0.1:3000**, then Electron starts. Optional env:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DASHBOARD_URL` | `http://localhost:3000` | Desktop window + browser fallback target |
| `API_URL` | `http://localhost:3001` | API + WebSocket base |
| `OPEN_BROWSER_ON_START` | `true` | Set `false` to keep the desktop window hidden on launch |

#### Desktop release builds

```bash
# Build the bundled desktop runtime (API + standalone web bundle)
pnpm build:desktop:bundle

# Produce local installer artifacts in packages/desktop/dist
pnpm dist:desktop
```

GitHub Actions will also build tagged desktop releases on **macOS** and **Windows** using `.github/workflows/desktop-release.yml`.
For macOS signing/notarization setup, see `docs/macos-signing.md`.

### 4. Open the dashboard

Visit http://localhost:3000 (or use the tray **Open dashboard** after `pnpm dev:electron`).

## Usage

### 1. Connect to Google Drive

On first visit, you'll be prompted to authenticate with Google Drive.

### 2. Scan your Drive

Click "Scan Drive" to analyze your storage. The scanner will:
- Recursively scan all folders
- Extract video metadata (duration, resolution)
- Store everything in a local SQLite database

### 3. Analyze with AI

Click "Analyze" to run Gemini AI suggestions on unanalyzed files. The AI will suggest:
- **Delete**: Raw footage, temp files, screen recordings
- **Compress**: High-bitrate videos that can be optimized
- **Keep**: Final deliverables and properly compressed files

### 4. Review and Queue Actions

Use the treemap and file browser to:
- Review AI suggestions
- Override suggestions manually
- Queue files for deletion or compression

### 5. Process Queue

Start processing from the Queue tab. For compression:
1. File is downloaded to temp directory
2. Compressed with FFmpeg (default: **HEVC via VideoToolbox** on macOS, `hvc1` + `yuv420p` for broad playback)
3. Uploaded back to Drive
4. Original moved to trash

## FFmpeg Compression Presets

On **macOS**, video uses **VideoToolbox** hardware encoders (`hevc_videotoolbox` / `h264_videotoolbox`) with **`-q:v`** quality steps. On **Linux/Windows**, the same preset names fall back to **libx265** / **libx264** with the CRF/preset shown below.

| Preset | macOS (VT) | Fallback (CRF) | Notes |
|--------|------------|----------------|--------|
| archive | HEVC, q≈68 | libx265 CRF 23, medium | Default quality |
| balanced | HEVC, q≈62 | libx265 CRF 25, medium | Smaller than archive |
| aggressive | HEVC, q≈52 | libx265 CRF 28, slow | Smallest HEVC preset |
| fast | H.264, q≈68 | libx264 CRF 23, fast | Widest compatibility |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/status` | Check authentication status |
| POST | `/api/scan` | Start Drive scan |
| GET | `/api/scan/status` | Get scan progress |
| GET | `/api/files` | List files with filters |
| GET | `/api/files/treemap` | Get treemap data |
| GET | `/api/stats` | Storage statistics |
| POST | `/api/stats/analyze` | Run AI analysis |
| POST | `/api/actions` | Queue actions |
| POST | `/api/actions/:id/execute` | Execute action |
| GET | `/api/queue/settings` | Queue auto-advance + stop-after-current flags |
| PATCH | `/api/queue/settings` | Update queue settings (`autoAdvance`, `pauseAfterCurrent`) |

## Project Structure

```
google-drive-compressor/
├── screenshots/                # UI screenshots for README / publishing
├── packages/
│   ├── api/                    # Fastify backend
│   │   ├── src/
│   │   │   ├── db/            # SQLite + Drizzle ORM
│   │   │   ├── services/      # Business logic
│   │   │   └── routes/        # API endpoints
│   │   └── package.json
│   │
│   ├── web/                    # Next.js frontend
│   │   ├── src/
│   │   │   ├── app/           # Next.js app router
│   │   │   ├── components/    # React components
│   │   │   ├── hooks/         # Custom hooks
│   │   │   └── lib/           # Utilities
│   │   └── package.json
│   │
│   └── desktop/                # Electron desktop app + tray
│       ├── main.cjs
│       └── assets/
│
├── .env.example
├── package.json
└── pnpm-workspace.yaml
```

## License

MIT
