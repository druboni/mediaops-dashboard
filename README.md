# MediaOps Dashboard

A self-hosted media operations dashboard that brings Plex, Sonarr, Radarr, qBittorrent, Overseerr, and the rest of your *arr stack together into a single unified interface. Built with React + TypeScript on the front end and Node.js + Fastify on the back end, deployed as a single Docker container.

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
- **Health alerts** — Sonarr/Radarr application health warnings + Prowlarr indexer failures, dismissible

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
- Upcoming releases from Sonarr and Radarr in a weekly calendar view

### Search
- Global search across Sonarr, Radarr, and Overseerr from one box

### Settings
- Enable / disable services per category
- Per-service connection test before saving
- Quick Links — custom bookmarks that appear in the sidebar (e.g. links to your service web UIs)
- Dashboard theme selector (Dark / AMOLED / Dim)
- Change dashboard login password

---

## Supported Services

| Category | Service | Notes |
|---|---|---|
| Media Server | **Plex** | Streams, library browser, recently played |
| Media Server | **Tautulli** | Play stats, history |
| Media Management | **Sonarr** | TV shows, wanted, history, calendar |
| Media Management | **Radarr** | Movies, wanted, history, calendar |
| Media Management | **Lidarr** | Music library, history |
| Media Management | **Bazarr** | Subtitle management |
| Requests | **Overseerr** | Request approval, search |
| Indexers | **Prowlarr** | Indexer health |
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

### 2. Create a `docker-compose.yml`

A `docker-compose.yml` is already included in the repo. The defaults are:

```yaml
services:
  mediaops:
    build: .
    container_name: mediaops
    ports:
      - "8990:8080"
    volumes:
      - /opt/mediaops/config:/app/config
    environment:
      - JWT_SECRET=change-me-in-production
      - NODE_ENV=production
      - NODE_TLS_REJECT_UNAUTHORIZED=0
    restart: unless-stopped
```

Customise the port, volume path, and `JWT_SECRET` before deploying.

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

Navigate to `http://your-server-ip:8990`

Default login password: **`changeme`**

Change it immediately in **Settings → Change Password**.

---

## Configuration

All configuration is stored in `config.json` inside the mapped volume (e.g. `/opt/mediaops/config/config.json`). The file is created automatically on first save. You can also edit it directly — the server reads it on every request so changes take effect without a restart.

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
| `JWT_SECRET` | `change-me-in-production` | Secret used to sign login tokens. Set this to a long random string. |
| `PORT` | `8080` | Internal port the server listens on (change the Docker port mapping, not this). |
| `NODE_TLS_REJECT_UNAUTHORIZED` | unset | Set to `0` to allow connections to services with self-signed certificates. |
| `CONFIG_PATH` | `/app/config/config.json` | Path inside the container where config is stored. Only change if using a custom volume mount. |

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
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/api/health"]
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

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, TanStack Query |
| Backend | Node.js 22, Fastify, JWT (`@fastify/jwt`) |
| Auth | JWT stored in memory (localStorage), bcrypt password hashing |
| Container | Docker multi-stage build (Node 22 Alpine) |
| Config | JSON file on a Docker volume (no database required) |

---

## Project Structure

```
mediaops-dashboard/
├── client/                  # React frontend (Vite + TypeScript)
│   └── src/
│       ├── pages/           # One file per page/route
│       ├── components/      # Shared UI components (Layout, Sidebar, etc.)
│       ├── store/           # Zustand stores (auth, config, theme)
│       ├── services/        # Axios API client
│       └── types/           # Shared TypeScript interfaces
├── server/                  # Fastify backend
│   ├── index.js             # Entry point, route registration
│   ├── middleware/          # Auth middleware
│   └── routes/              # One file per API domain
│       ├── dashboard.js     # Aggregated dashboard data
│       ├── downloads.js     # qBittorrent + NZBGet
│       ├── overseerr.js     # Request management
│       ├── plex.js          # Library browser + image proxy
│       ├── wanted.js        # Missing media
│       ├── history.js       # Import/grab history
│       ├── stats.js         # Tautulli play stats
│       ├── config.js        # Settings persistence
│       └── ...
├── Dockerfile               # Multi-stage: build frontend → runtime image
└── docker-compose.yml
```

---

## Security Notes

- **Change the default password** (`changeme`) immediately after first login via Settings → Change Password
- **Set a strong `JWT_SECRET`** — anyone with this secret can forge login tokens
- The dashboard is designed for **trusted local network use**. If exposing to the internet, place it behind a reverse proxy with HTTPS and consider adding IP allowlisting
- API keys for your media services are stored in plaintext in `config.json`. Ensure the config volume is not world-readable

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

---

## License

MIT — do whatever you want with it.
