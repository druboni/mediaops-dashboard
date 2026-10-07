# calendar-share

A tiny container that serves MediaOps's read-only calendar page and nothing
else, so it can safely sit behind a public reverse proxy while MediaOps itself
stays private.

```
browser ──HTTPS──▶ your reverse proxy ──LAN──▶ calendar-share :8991 ──loopback──▶ MediaOps :8990
                   (TLS terminates here)        public data only               token stays here
```

## Why a separate container

MediaOps has no real login, so exposing it, even only certain paths, is risky.
This container is safe to expose because of what it doesn't contain:

- **No dashboard code.** It's built from its own Vite entry
  (`vite.share.config.ts`), so the bundle holds the calendar and nothing else.
- **No service credentials, and no write routes.** It serves one page and one
  read-only endpoint, `GET /api/calendar`.
- **One narrow secret.** It holds a calendar token, which only unlocks read
  access to calendar data. The token is sent to MediaOps in a request header
  from the server, so it never reaches a browser, a URL or an access log.
- **No dependencies.** It uses Node built-ins only, with no `node_modules` in
  the runtime image.

## Security

- **The token never travels in the clear over a network.** With `network_mode:
  host`, the container talks to MediaOps over `127.0.0.1`, which never leaves
  the machine. The server refuses to start if `MEDIAOPS_URL` is plain `http`
  to anything other than localhost. If you ever move it to another host, it
  will require `https` instead of quietly sending the token in plaintext.
- **Two credentials, kept separate.** Revoking the in-network share link
  doesn't affect this container, and rotating this token doesn't affect the
  link. The **Public calendar** switch in MediaOps disables both immediately.
- **Limited load on MediaOps.** Responses are cached for 2 minutes and
  identical concurrent requests share one lookup. Public traffic can trigger at
  most 30 MediaOps lookups a minute; beyond that, visitors get cached data or a
  `429`.
- **Locked-down page.** It sends a strict Content-Security-Policy (this
  origin only, no inline code, no framing) and the `nosniff`, `no-referrer`
  and `noindex` headers.
- **Locked-down container.** It runs as a non-root user with a read-only
  filesystem, all capabilities dropped and `no-new-privileges`. Watchtower is
  disabled for it, because this image is built locally and Watchtower could
  otherwise "update" it with an unrelated image of the same name from Docker
  Hub.

## Setup

1. In MediaOps, go to **Settings → Sharing**, turn on **Public calendar**, and
   click **Save Changes**. Copy the **Calendar container token**.
2. On the MediaOps host:
   ```bash
   sudo mkdir -p /opt/mediaops/calendar-share
   sudo chown "$USER" /opt/mediaops/calendar-share
   (umask 077; printf 'CALENDAR_TOKEN=%s\n' 'PASTE_TOKEN_HERE' > /opt/mediaops/calendar-share/.env)
   ```
3. Build and start the container. Re-run this to update it later:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/druboni/mediaops-dashboard/master/calendar-share/deploy.sh | bash
   ```
4. Check it's working: `http://<mediaops-host>:8991` should show the calendar.

## Reverse proxy

Point your proxy at `http://<mediaops-host>:8991` and terminate TLS there.
Set HSTS at the proxy, since this container never sees HTTPS. An nginx
example:

```nginx
server {
    listen 443 ssl http2;
    server_name calendar.example.com;

    ssl_certificate     /etc/letsencrypt/live/calendar.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/calendar.example.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://192.168.99.142:8991;
        proxy_set_header Host $host;
    }
}
```

In Nginx Proxy Manager, add a Proxy Host that forwards to the same address and
port, request an SSL certificate, and enable "Force SSL" and "HSTS".

**Optional:** port 8991 only ever serves public data, but if you want only the
proxy server to be able to reach it:

```bash
sudo ufw allow from <proxy-server-ip> to any port 8991 proto tcp
sudo ufw deny 8991/tcp
```

## Configuration

| Variable | Default | |
|---|---|---|
| `CALENDAR_TOKEN` | *(required)* | From MediaOps **Settings → Sharing**. Keep it in `.env` (mode 600), not in the compose file. |
| `MEDIAOPS_URL` | `http://127.0.0.1:8990` | Must be `https://` unless it points at localhost. |
| `PORT` | `8991` | What your reverse proxy forwards to. |
| `HOST` | `0.0.0.0` | Interface to listen on. |

**Rotating the token:** click **New token** in MediaOps, update `.env`, then
run `docker compose -f /opt/mediaops/calendar-share/docker-compose.yml up -d
--force-recreate`. Until you do, the page shows "This calendar isn't
available".
