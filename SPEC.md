# MediaOps Dashboard — Project Spec

A self-hosted, Dockerized web app providing unified full-control management of your entire media automation stack through a single authenticated interface. All services are optional — users enable only what they run.

---

## Goals

- Single pane of glass for the full *arr + Plex + download client stack
- Full control (not just monitoring) — add, edit, remove, approve, trigger actions
- Service-agnostic: any service can be disabled; the UI adapts automatically
- Shareable with others who run different subsets of the same stack
- Runs as a single Docker container alongside existing services

## Non-Goals

- Not a replacement for Sonarr/Radarr/etc. — it wraps their APIs, not their logic
- No media playback (Plex handles that)
- No mobile app (responsive web is sufficient)
- No multi-user roles (single admin user)

---

## Tech Stack

| Layer         | Choice                        | Reason                                          |
|---------------|-------------------------------|-------------------------------------------------|
| Frontend      | React + TypeScript + Vite     | Fast builds, strong typing, good ecosystem      |
| Backend       | Node.js + Fastify             | Lightweight API proxy, low overhead             |
| Styling       | Tailwind CSS                  | Rapid UI, dark-mode friendly                    |
| Auth          | JWT + bcrypt                  | Stateless, simple single-user auth              |
| Config store  | JSON file (volume-mounted)    | No database needed; human-readable              |
| Deployment    | Docker + Docker Compose       | Matches existing self-hosted stack pattern      |

---

## Architecture

```
Browser
  └── React SPA
        └── REST calls → Fastify Backend (single port, e.g. 8080)
                          ├── Auth middleware (JWT validation)
                          ├── Config API        → reads/writes config.json
                          ├── /proxy/sonarr/*   → Sonarr instance
                          ├── /proxy/radarr/*   → Radarr instance
                          ├── /proxy/lidarr/*   → Lidarr instance
                          ├── /proxy/bazarr/*   → Bazarr instance
                          ├── /proxy/prowlarr/* → Prowlarr instance
                          ├── /proxy/jackett/*  → Jackett instance
                          ├── /proxy/overseerr/*→ Overseerr instance
                          ├── /proxy/plex/*     → Plex Media Server
                          ├── /proxy/qbit/*     → qBittorrent Web API
                          ├── /proxy/nzbget/*   → NZBGet JSON-RPC
                          ├── /proxy/huntarr/*  → Huntarr
                          └── /proxy/requestrr/*→ Requestrr
```

API keys and credentials never reach the browser. The backend holds all secrets and proxies every request.

---

## Service Registry

All services are optional. Each is independently toggled in Settings. Disabled services are hidden from the sidebar, dashboard, and all API calls.

### Supported Services

| Service      | Category          | API Type       | Notes                          |
|--------------|-------------------|----------------|--------------------------------|
| Plex         | Media Server      | Plex API       | Library, sessions, streams     |
| Sonarr       | Media Management  | REST           | TV automation                  |
| Radarr       | Media Management  | REST           | Movie automation               |
| Lidarr       | Media Management  | REST           | Music automation               |
| Bazarr       | Media Management  | REST           | Subtitle management            |
| Overseerr    | Requests          | REST           | Media request management       |
| Prowlarr     | Indexers          | REST           | Indexer manager                |
| Jackett      | Indexers          | REST           | Indexer proxy/aggregator       |
| qBittorrent  | Download Clients  | Web API        | Torrent client                 |
| NZBGet       | Download Clients  | JSON-RPC       | Usenet downloader              |
| Huntarr      | Utilities         | REST           | Missing/upgrade hunter         |
| Requestrr    | Utilities         | Limited/Status | Discord request bot            |

### Config Schema (`config.json`)

```json
{
  "services": {
    "plex":         { "enabled": true,  "url": "http://localhost:32400", "apiKey": "..." },
    "sonarr":       { "enabled": true,  "url": "http://localhost:8989",  "apiKey": "..." },
    "radarr":       { "enabled": true,  "url": "http://localhost:7878",  "apiKey": "..." },
    "lidarr":       { "enabled": false, "url": "",                       "apiKey": "" },
    "bazarr":       { "enabled": false, "url": "",                       "apiKey": "" },
    "overseerr":    { "enabled": true,  "url": "http://localhost:5055",  "apiKey": "..." },
    "prowlarr":     { "enabled": true,  "url": "http://localhost:9696",  "apiKey": "..." },
    "jackett":      { "enabled": false, "url": "",                       "apiKey": "" },
    "qbittorrent":  { "enabled": true,  "url": "http://localhost:8080",  "apiKey": "" },
    "nzbget":       { "enabled": true,  "url": "http://localhost:6789",  "apiKey": "" },
    "huntarr":      { "enabled": false, "url": "",                       "apiKey": "" },
    "requestrr":    { "enabled": false, "url": "",                       "apiKey": "" }
  }
}
```

---

## Navigation

Sidebar links are shown **only for enabled services**. Sections with no enabled services are hidden entirely.

```
Sidebar
├── Dashboard            ← always visible
├── ── Media ──
├── Movies               ← Radarr
├── TV Shows             ← Sonarr
├── Music                ← Lidarr
├── Subtitles            ← Bazarr
├── ── Requests ──
├── Requests             ← Overseerr
├── ── Downloads ──
├── Downloads            ← unified qBittorrent + NZBGet queue
├── ── Indexers ──
├── Indexers             ← Prowlarr + Jackett
├── ── Utilities ──
├── Hunt                 ← Huntarr
├── Activity             ← unified history feed (all *arrs)
└── Settings             ← always visible
```

---

## Views

### Dashboard
- Service health grid (green/yellow/red per enabled service)
- Combined download speed widget (torrent + usenet)
- Plex active streams count + who is watching what
- Library size counters (movies, shows, episodes, artists, albums)
- Pending requests count (Overseerr) with quick-approve buttons
- Recently added media (last 10 across Plex/Sonarr/Radarr)
- First-run prompt if no services configured

### Movies (Radarr)
- Browse/search full movie library
- Add new movie: search TMDb, select quality profile + root folder
- Movie detail: status, files, history, manual search
- Edit monitoring, quality profile, tags
- Delete movie (with/without files)
- Queue items per movie

### TV Shows (Sonarr)
- Browse/search full series library
- Add new series: search TVDb, select quality profile + root folder
- Series detail: seasons, episodes, files, history, manual search
- Season/episode monitoring toggles
- Edit quality profile, tags, language profile
- Delete series (with/without files)

### Music (Lidarr)
- Browse artists and albums
- Add artist with quality profile
- Album detail: tracks, files, history
- Manual search per album

### Subtitles (Bazarr)
- Wanted subtitles list (movies + episodes)
- History of downloaded subtitles
- Trigger manual subtitle search per item
- Provider status

### Requests (Overseerr)
- Pending requests list with approve / deny / delete actions
- Request detail: requestor, media info, status
- All requests view with filters (pending, approved, available, declined)
- Issue reports list

### Downloads
- Unified queue combining qBittorrent and NZBGet
- Columns: name, client, category, size, progress, speed, ETA, status
- Per-item actions: pause, resume, delete (with/without data)
- Global speed limit toggle per client
- Completed/history tab
- Filter by client or category

### Indexers
- List of all configured indexers (Prowlarr + Jackett)
- Per-indexer: last test status, enabled state, categories
- Test connection per indexer
- Prowlarr: trigger app sync
- Jackett: add/remove indexers (if API supports)
- Manual search across all indexers

### Activity Feed
- Merged chronological timeline from Sonarr, Radarr, Lidarr, Bazarr history
- Event types: grabbed, imported, upgraded, deleted, subtitle downloaded, failed
- Filter by service or event type

### Hunt (Huntarr)
- Missing media list
- Upgrade candidates
- Trigger hunt manually
- Hunt history/log

### Settings
- Per-service card:
  - Enable / disable toggle
  - Base URL input
  - API key input (masked)
  - "Test Connection" button with live feedback
- Change admin password
- App version / service version info

---

## Auth

- Single admin user
- Password set via environment variable on first run (hashed with bcrypt, stored in config)
- Login page → JWT issued on success (stored in `localStorage`)
- All backend routes protected by JWT middleware
- Token expiry: 7 days (configurable)
- No registration flow — single user only

---

## First-Run Experience

1. App detects `config.json` has no enabled services
2. Redirects to Settings with a banner: _"Welcome — enable and configure at least one service to get started."_
3. User enables services, enters URLs + API keys, tests connections
4. On first successful connection test, dashboard becomes accessible

---

## Docker Setup

### `Dockerfile`
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "server/index.js"]
```

### `docker-compose.yml`
```yaml
services:
  mediaops:
    build: .
    container_name: mediaops
    ports:
      - "8080:8080"
    volumes:
      - ./config:/app/config
    environment:
      - JWT_SECRET=changeme
      - ADMIN_PASSWORD=changeme
    restart: unless-stopped
```

Single container, single exposed port, config persisted via bind mount.

---

## Project Structure

```
mediaops-dashboard/
├── client/                    # React frontend
│   ├── src/
│   │   ├── components/        # Shared UI components
│   │   ├── pages/             # One file per view
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Movies.tsx
│   │   │   ├── TVShows.tsx
│   │   │   ├── Music.tsx
│   │   │   ├── Subtitles.tsx
│   │   │   ├── Requests.tsx
│   │   │   ├── Downloads.tsx
│   │   │   ├── Indexers.tsx
│   │   │   ├── Activity.tsx
│   │   │   ├── Hunt.tsx
│   │   │   └── Settings.tsx
│   │   ├── services/          # Per-service API client wrappers
│   │   ├── hooks/             # Shared React hooks
│   │   ├── store/             # Global state (enabled services, config)
│   │   └── App.tsx
│   └── index.html
├── server/                    # Fastify backend
│   ├── routes/
│   │   ├── auth.js
│   │   ├── config.js
│   │   └── proxy.js           # Generic proxy handler per service
│   ├── services/              # Service-specific proxy logic
│   ├── middleware/
│   │   └── auth.js            # JWT validation
│   └── index.js
├── config/                    # Volume-mounted at runtime
│   └── config.json
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Phased Build Plan

| Phase | Deliverable                                               |
|-------|-----------------------------------------------------------|
| 1     | Project scaffold, Docker setup, auth (login/JWT), settings page with connection testing |
| 2     | Dashboard: health grid, library stats, active streams     |
| 3     | Downloads: unified qBittorrent + NZBGet queue             |
| 4     | Movies (Radarr) + TV Shows (Sonarr) full views            |
| 5     | Requests (Overseerr) approve/deny flow                    |
| 6     | Indexers (Prowlarr + Jackett)                             |
| 7     | Music (Lidarr) + Subtitles (Bazarr)                       |
| 8     | Activity feed + Hunt (Huntarr) + polish                   |

---

## Out of Scope (Future Ideas)

- Mobile app
- Multi-user with roles
- Notifications (push/email/Discord)
- Tautulli integration (Plex analytics)
- Readarr / Whisparr support
- Custom dashboard widget layout
- Dark/light theme toggle
