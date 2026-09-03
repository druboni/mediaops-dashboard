# MediaOps Dashboard

A self-hosted media operations dashboard that brings Plex, Sonarr, Radarr, Lidarr, qBittorrent, Overseerr, and the rest of your *arr stack together into a single unified interface. Built with React + TypeScript on the front end and Node.js + Fastify on the back end, deployed as a single Docker container.

![Dashboard](https://img.shields.io/badge/status-active-brightgreen) ![Docker](https://img.shields.io/badge/deploy-docker-blue) ![License](https://img.shields.io/badge/license-MIT-gray)

---

## Features

### Dashboard
- **Service health grid** — live status and version number for every connected service
- **Library stats** — movie, show, episode, and active stream counts
- **Active Plex streams** — who's watching what, play method (direct play / transcode), codec, resolution, and progress bar
- **Download activity** — combined qBittorrent + NZBGet speed and queue depth
- **Recently downloaded** — last 10 completed downloads from both clients with file size
- **Recently added** — last imports from Radarr, Sonarr, and Lidarr with show/episode names
- **Recently played** — Tautulli history feed (what your users have been watching)
- **Pending requests** — inline approve/decline for Overseerr requests
- **Health alerts** — Sonarr/Radarr/Lidarr application health warnings, Prowlarr indexer failures, and low-disk-space alerts, dismissible

### Downloads
- Unified queue and completed list across qBittorrent and NZBGet
- Per-torrent progress bar, speed, ETA, and status
- Pause / resume / delete (with or without files) directly from the UI
- Speed limiter toggle for qBittorrent (alt-speed mode) and NZBGet (1 MB/s cap)
- Filter by client and category
- Browser push notifications when a download completes (opt-in)

### Requests (Overseerr)
- Browse all requests with status badges (Pending / Approved / Available / etc.)
- Approve or decline individual requests
- Batch approve / batch decline all pending requests at once

### Plex Library Browser
- Pick any Plex library (Movies, TV Shows, Music)
- Poster grid with lazy-loaded artwork, ratings, year, and runtime
- Sort by Title, Recently Added, Rating, or Year
- **TV show drill-down**: click any show → season list → episode grid
  - 16:9 episode thumbnails (actual stills, not poster art)
  - Watched / unwatched badge per episode
  - Episode summary on click
- Paginated (50 items per page)

### Sonarr / Radarr / Lidarr Management
- **Indexers** — add, edit, enable/disable, test, and delete, with a live OK/Failing health badge per indexer and the real error surfaced when a test fails
- **Download clients** — add, edit, enable/disable, test, and delete
- **Root folders** — list, add, remove; shows free space and accessibility
- **Quality profiles** — edit name, cutoff, upgrade-allowed, and per-quality allowed toggles; create new profiles by duplicating an existing one
- **Naming** and **Media Management** settings
- **Host / General** settings (port, URL base, auth, SSL, logging, updates, proxy, backups)
- **Multi-instance support** — manage a secondary named instance per app (e.g. a separate 4K Sonarr/Radarr) alongside the primary one, configured in Settings → Additional Instances

### Wanted / Missing
- Missing movies from Radarr and missing episodes from Sonarr in one place
- Episodes grouped by series
- Trigger an individual search, a full series search, or a movie search with one click

### History
- Unified activity feed from Radarr, Sonarr, and Lidarr
- Filter by media type (Movie / TV / Music) and event (Imported / Grabbed / Failed)
- Color-coded event labels

### Play Statistics (Tautulli)
- Stacked bar chart of plays per day broken down by Movies, TV, and Music
- Top watched and most popular lists for shows and movies (with mini progress bars)
- Active users table with play count, total watch time, and last-seen time
- 7 / 14 / 30 day range picker

### Calendar
- Upcoming releases from Sonarr and Radarr in a month-grid calendar view, color-coded by status (downloaded / upcoming / missing)

### Search
- Global search across Sonarr, Radarr, and Overseerr from one box

### Subtitles (Bazarr)
- Wanted subtitles for movies and episodes, with per-item subtitle search/download
- Unified subtitle history feed
- Provider status (enabled providers, usage counts, last query, errors)
- Languages — view-only list of enabled/available languages (Bazarr keeps provider credentials and language config in one settings blob with no per-item write API, so this is deliberately read-only rather than guessing at that schema)

### System
- Live CPU, RAM, disk, network, and GPU stats (via [Glances](https://nicolargo.github.io/glances/)) for any number of servers you add in Settings → Monitored Servers
- **Docker container list** (requires mounting the Docker socket — see Configuration below): status, ports, restart with confirmation, recent log viewer, and an update-available check that compares your locally running image against the registry (Docker Hub, ghcr.io, and mirrors like lscr.io are all supported)
- **Speed test** (optional, per server) — run [`scripts/speedtest-sidecar.py`](scripts/speedtest-sidecar.py) on a monitored server and set its speedtest port in Settings to get a one-click internet speed test from that server's own connection

### Notifications
- Discord, [ntfy](https://ntfy.sh), Pushover, and Telegram — fires from Sonarr/Radarr's own webhook whenever new media is imported, independent of Plex
- Each channel has its own enable toggle, credential fields, and test button in Settings

### Settings
- Enable / disable services per category
- Per-service connection test before saving
- Additional Instances — configure secondary Sonarr/Radarr/Lidarr instances
- Quick Links — custom bookmarks that appear in the sidebar (e.g. links to your service web UIs)
- Dashboard theme selector (Dark / AMOLED / Dim)
- Manual and automatic (weekly) config backups, with restore
- Change dashboard password (see **Authentication** below for what this does and doesn't protect)

### Logs
- Recent server-side activity — proxied API calls, notification sends, container actions, errors — persisted to disk so a container restart doesn't lose the trail

---

## Supported Services

| Category | Service | Notes |
|---|---|---|
| Media Server | **Plex** | Streams, library browser, recently played |
| Media Server | **Tautulli** | Play stats, history |
| Media Management | **Sonarr** | TV shows, indexers, download clients, quality profiles, wanted, history, calendar |
| Media Management | **Radarr** | Movies, indexers, download clients, quality profiles, wanted, history, calendar |
| Media Management | **Lidarr** | Music library, indexers, download clients, quality profiles, history |
| Media Management | **Bazarr** | Subtitle wanted/history/providers, read-only language list |
| Requests | **Overseerr** | Request approval, search |
| Indexers | **Prowlarr** | Indexer management, health, search |
| Indexers | **Jackett** | Indexer health |
| Download Clients | **qBittorrent** | Queue, completed, speed control |
| Download Clients | **NZBGet** | Queue, completed, speed control |
| Utilities | **Huntarr** | Health status |
| Utilities | **Requestrr** | Health status |

All services are optional — only the ones you enable appear in the UI.

---

## Requirements

- **Docker** and **Docker Compose** (v2)
- Network access from the Docker host to each of your media services
- A modern browser (Chrome, Firefox, Edge)

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/druboni/mediaops-dashboard.git
cd mediaops-dashboard
```

### 2. Review `docker-compose.yml`

A `docker-compose.yml` is already included in the repo:

```yaml
services:
  mediaops:
    build: .
    container_name: mediaops
    ports:
      - "8990:8080"
    volumes:
      - /opt/mediaops/config:/app/config
      # - /var/run/docker.sock:/var/run/docker.sock:ro   # optional, see below
      # - /path/to/your/media:/mnt/plex:ro                # optional, see below
    environment:
      - JWT_SECRET=${JWT_SECRET:-change-me-in-production}
      - NODE_ENV=production
      - NODE_TLS_REJECT_UNAUTHORIZED=0
    restart: unless-stopped
```

Customise the port, volume path, and `JWT_SECRET` before deploying. The two commented-out volume mounts are optional feature flags:

- **Docker socket** — mount it to enable the System page's container list, restart, log viewer, and update-check. This grants the container control over every other container on the host, so only enable it if you're comfortable with that.
- **Media library mount** — mount it (as `/mnt/plex`, or set `PLEX_MOUNT_PATH` to match a different path) to enable the low-disk-space alert.

> **`NODE_TLS_REJECT_UNAUTHORIZED=0`** — required if any of your services use self-signed HTTPS certificates (common with Plex). Remove this line if all your services use valid certificates.

### 3. Build and start

```bash
docker compose build
docker compose up -d
```

The build compiles the React frontend and bundles everything into a single container. First build takes ~2 minutes; subsequent builds are faster due to layer caching.

> **Note for VPN/firewall environments**: If Docker's bridge network is blocked by a VPN on the host, build with `--network=host`:
> ```bash
> DOCKER_BUILDKIT=1 docker compose build --no-cache
> ```
> or add `network: host` under the `build:` key in your compose file.

### 4. Open the dashboard

Navigate to `http://your-server-ip:8990` — you'll be logged in automatically (see **Authentication** below).

---

## Authentication

There is currently **no login credential** — the app issues a session automatically on load. Anyone who can reach the app on your network can use it. This is a deliberate design choice for trusted-home-network use, not an oversight, but it means:

- Don't expose this directly to the internet. If you need remote access, put it behind a VPN, or a reverse proxy with its own authentication layer in front.
- Treat network access to the dashboard's port as equivalent to having full access to every service it's connected to.
- The **Settings → Change Password** field exists in the UI but isn't currently wired into the login flow — changing it has no effect on who can log in.

---

## Configuration

All configuration is stored in `config.json` inside the mapped volume (e.g. `/opt/mediaops/config/config.json`). The file is created automatically on first save. You can also edit it directly — the server reads it on every request so changes take effect without a restart. Every service's API key is encrypted at rest (see **Security Notes**).

### Connecting your services

1. Open **Settings** in the sidebar
2. For each service, toggle it **on**, enter the URL and API key, and click **Test** to verify the connection
3. Click **Save Changes**

#### Finding API keys

| Service | Location |
|---|---|
| Sonarr | Settings → General → Security → API Key |
| Radarr | Settings → General → Security → API Key |
| Lidarr | Settings → General → Security → API Key |
| Bazarr | Settings → General → Security → API Key |
| Prowlarr | Settings → General → Security → API Key |
| Overseerr | Settings → General → API Key |
| Tautulli | Settings → Web Interface → API Key |
| Jackett | Dashboard → API Key (top right) |
| Huntarr | Settings → General → API Key |
| Plex | Visit `https://plex.tv/claim` or find the token in a Plex request URL |

#### qBittorrent and NZBGet

These use **username:password** in the API Key field (not an API key):

- **qBittorrent** → enter `username:password` (e.g. `admin:password`)
- **NZBGet** → enter `username:password` (e.g. `nzbget:tegbzn6789`)

#### URL format

Always include the protocol and port, no trailing slash:

```
http://192.168.1.100:8989     ✓
https://sonarr.yourdomain.com ✓
http://192.168.1.100:8989/    ✗  (trailing slash — will be stripped automatically)
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | `change-me-in-production` | Signs login session tokens and derives the key used to encrypt API keys at rest. Set this to a long random string. |
| `PORT` | `8080` | Internal port the server listens on (change the Docker port mapping, not this). |
| `NODE_TLS_REJECT_UNAUTHORIZED` | unset | Set to `0` to allow connections to services with self-signed certificates. |
| `CONFIG_PATH` | `/app/config/config.json` | Path inside the container where config is stored. Only change if using a custom volume mount. |
| `PLEX_MOUNT_PATH` | `/mnt/plex` | Path your media library is mounted at, if you've enabled that optional mount. Only needed if you mount it somewhere other than `/mnt/plex`. |
| `LOG_PATH` | alongside `config.json` | Where server activity logs are written on disk. Rarely needs changing. |
| `BACKUP_DIR` | `config/backups` | Where automatic weekly config backups are written. Rarely needs changing. |

Generate a strong JWT secret:
```bash
openssl rand -hex 32
```

---

## Updating

```bash
cd mediaops-dashboard
git pull
docker compose build --no-cache
docker stop mediaops && docker rm mediaops
docker compose up -d
```

> Always use `docker compose build --no-cache` and recreate the container (stop + rm + up). Using `docker compose restart` will not pick up image changes.

---

## Docker Compose — Production Example

```yaml
services:
  mediaops:
    build: .
    container_name: mediaops
    ports:
      - "8990:8080"
    volumes:
      - /opt/mediaops/config:/app/config
      - /var/run/docker.sock:/var/run/docker.sock:ro  # optional: enables container stats on System page
    environment:
      - JWT_SECRET=your-very-long-random-secret-here
      - NODE_ENV=production
      - NODE_TLS_REJECT_UNAUTHORIZED=0
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/api/ping"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### Putting it behind a reverse proxy (nginx)

```nginx
location /mediaops/ {
    proxy_pass http://127.0.0.1:8990/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
}
```

Or as its own virtual host:

```nginx
server {
    listen 80;
    server_name mediaops.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8990;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Since there's no login credential (see **Authentication**), a reverse proxy is the place to add one (basic auth, OAuth, client certs, etc.) if you're exposing this beyond your own trusted network.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite (route-level code splitting), Tailwind CSS, TanStack Query |
| Backend | Node.js 22, Fastify, JWT (`@fastify/jwt`) |
| State | React Context (auth, config, theme) — no external state library |
| Auth | JWT stored in `localStorage`; auto-issued on load (see **Authentication**) |
| Container | Docker multi-stage build (Node 22 Alpine) |
| Config | JSON file on a Docker volume, API keys encrypted at rest (no database required) |
| CI | GitHub Actions — typecheck, build, and server syntax check on every push/PR |

---

## Project Structure

```
mediaops-dashboard/
├── client/                  # React frontend (Vite + TypeScript)
│   └── src/
│       ├── pages/           # One file per page/route
│       ├── components/      # Shared UI components (Layout, Sidebar, etc.)
│       ├── store/           # React Context providers (auth, config, theme)
│       ├── services/        # Axios API client
│       └── types/           # Shared TypeScript interfaces
├── server/                  # Fastify backend
│   ├── index.js             # Entry point, route registration
│   ├── crypto.js            # AES-256-GCM encryption for API keys at rest
│   ├── logBuffer.js         # In-memory + on-disk activity log
│   ├── autoBackup.js        # Weekly config backup scheduler
│   ├── middleware/          # Auth middleware
│   └── routes/              # One file per API domain
│       ├── dashboard.js     # Aggregated dashboard data
│       ├── downloads.js     # qBittorrent + NZBGet
│       ├── overseerr.js     # Request management
│       ├── plex.js          # Library browser + image proxy
│       ├── proxy.js         # Generic authenticated proxy to every *arr service
│       ├── wanted.js        # Missing media
│       ├── history.js       # Import/grab history
│       ├── stats.js         # Tautulli play stats
│       ├── system.js        # Glances stats + Docker container management
│       ├── health.js        # Cross-service health/alert aggregation
│       ├── webhooks.js      # Sonarr/Radarr "on import" → notification fan-out
│       ├── services.js      # Per-service connection test
│       ├── logs.js          # Activity log API
│       ├── config.js        # Settings persistence
│       └── ...
├── .github/workflows/       # CI
├── Dockerfile               # Multi-stage: build frontend → runtime image
└── docker-compose.yml
```

---

## Security Notes

- **There is no login credential** — see **Authentication** above. Don't expose this to the internet without a reverse proxy providing its own auth layer.
- **Set a strong `JWT_SECRET`** — it signs session tokens and derives the key used to encrypt API keys at rest. Losing/rotating it means previously-encrypted API keys can no longer be decrypted (they'll show as blank; just re-enter them).
- Service API keys are **encrypted at rest** in `config.json` (AES-256-GCM). Config backups are also encrypted; only the app itself, holding `JWT_SECRET`, can decrypt them.
- Mounting the Docker socket (optional, for the System page's container tools) gives this container control over every other container on the host — only enable it if you're comfortable with that tradeoff.
- The dashboard is designed for **trusted local network use**. If exposing it beyond that, put it behind a reverse proxy with HTTPS and its own authentication.

---

## Troubleshooting

**Container starts but I see a blank page or "frontend not built" error**
- Make sure you ran `docker compose build` before `docker compose up`

**I changed a server file but the container is still running old code**
- You must rebuild: `docker compose build --no-cache && docker stop mediaops && docker rm mediaops && docker compose up -d`
- `docker compose restart` does NOT rebuild the image

**Services show as offline even though they're running**
- Verify the URL is reachable from the Docker container (not just from your browser)
- Use the **Test** button in Settings to get a specific error message
- If your services use HTTPS with self-signed certs, make sure `NODE_TLS_REJECT_UNAUTHORIZED=0` is set

**Plex images don't load**
- This is handled automatically — the app proxies all Plex images through its own backend to avoid browser cert errors

**qBittorrent connection fails**
- Enter credentials as `username:password` in the API Key field
- Make sure qBittorrent's Web UI is enabled and the URL includes the port (e.g. `http://192.168.1.100:8080`)
- qBittorrent's Web UI must be accessible from the Docker container's network

**The build fails with network errors**
- If you're on a host with a VPN, Docker's bridge network may be blocked. Build with `DOCKER_BUILDKIT=1 docker compose build --no-cache`

**Docker container list is empty on the System page**
- Mount the Docker socket (`/var/run/docker.sock:/var/run/docker.sock:ro`) — see the Quick Start compose file

**Low-disk-space alert never appears**
- Mount your media library volume (e.g. as `/mnt/plex`) — see the Quick Start compose file. If you mount it at a different path, set `PLEX_MOUNT_PATH` to match.

---

## License

MIT — do whatever you want with it.
