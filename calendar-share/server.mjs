// Standalone server for the public calendar page.
//
// This is the only MediaOps-related thing meant to face the internet. It
// serves one page and one read-only data endpoint, and it can't do anything
// else: it holds no dashboard code, no service credentials, and no route that
// writes anything. The single secret it has — the calendar token — only grants
// read access to calendar data, and is sent to MediaOps in a request header
// from here, so it never reaches a browser, a URL or an access log.
//
// Zero dependencies on purpose: Node built-ins only, so there's no package
// tree to patch or to be compromised through.

import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Configuration ───────────────────────────────────────────────────────────

const MEDIAOPS_URL = (process.env.MEDIAOPS_URL || 'http://127.0.0.1:8990').replace(/\/$/, '')
const TOKEN = process.env.CALENDAR_TOKEN || ''
const PORT = parseInt(process.env.PORT || '8991', 10)
const HOST = process.env.HOST || '0.0.0.0'
const STATIC_DIR = process.env.STATIC_DIR || fileURLToPath(new URL('./public/', import.meta.url))

const DAY = 86_400_000
const MAX_RANGE_DAYS = 62            // matches MediaOps's own cap
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CACHE_TTL_MS = 120_000         // calendar data barely moves minute to minute
const CACHE_MAX = 100
const UPSTREAM_PER_MINUTE = 30       // ceiling on what public traffic can make MediaOps do
const UPSTREAM_TIMEOUT_MS = 10_000

function fail(msg) {
  console.error(`calendar-share: ${msg}`)
  process.exit(1)
}

if (TOKEN.length < 32) fail('CALENDAR_TOKEN is missing or too short — copy it from MediaOps Settings → Sharing')

// The token must never cross a network unencrypted. Plain http is only allowed
// to this machine's loopback, where the traffic never leaves the box; anything
// else has to be https, so moving this container elsewhere can't silently
// downgrade the hop to cleartext.
{
  let u
  try { u = new URL(MEDIAOPS_URL) } catch { fail(`MEDIAOPS_URL is not a valid URL: ${MEDIAOPS_URL}`) }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)
  if (u.protocol === 'http:' && !loopback) {
    fail(`refusing to send the calendar token over plain http to ${u.hostname} — use https, or run this on the same host as MediaOps`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`unsupported MEDIAOPS_URL protocol: ${u.protocol}`)
}

// ── Static files ────────────────────────────────────────────────────────────

// Loaded once at startup and served from memory by exact name. Requests never
// touch the filesystem, so there's no path to traverse.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const files = new Map() // url path -> { body, type, immutable }

async function loadStatic() {
  const page = await readFile(join(STATIC_DIR, 'share.html'))
  files.set('/', { body: page, type: TYPES['.html'], immutable: false })
  for (const name of await readdir(join(STATIC_DIR, 'assets'))) {
    const type = TYPES[extname(name)]
    if (!type) continue
    // Vite content-hashes these names, so a given URL's bytes never change.
    files.set(`/assets/${name}`, { body: await readFile(join(STATIC_DIR, 'assets', name)), type, immutable: true })
  }
}

// ── Security headers ────────────────────────────────────────────────────────

// The page is one script and one stylesheet from this origin talking to this
// origin. Nothing else is allowed to load, frame it, or be sent a referrer.
// HSTS is left to the reverse proxy, since that's where TLS terminates.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Robots-Tag': 'noindex, nofollow',
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
  res.end(res.req.method === 'HEAD' ? undefined : body)
}

const sendJson = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers })

// ── Calendar data ───────────────────────────────────────────────────────────

const cache = new Map()     // `${start}|${end}` -> { at, body }
const inFlight = new Map()  // same key -> Promise, so a burst makes one upstream call
let budget = UPSTREAM_PER_MINUTE
setInterval(() => { budget = UPSTREAM_PER_MINUTE }, 60_000).unref()

// Re-projected here even though MediaOps already trims its response: if that
// endpoint ever grew a field, this server still only passes on what the page draws.
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]))

function project(data) {
  return {
    sonarr: !!data?.sonarr,
    radarr: !!data?.radarr,
    episodes: (Array.isArray(data?.episodes) ? data.episodes : []).map((e) => ({
      ...pick(e, ['title', 'seasonNumber', 'episodeNumber', 'airDate', 'hasFile']),
      ...(e?.series ? { series: pick(e.series, ['title', 'network']) } : {}),
    })),
    movies: (Array.isArray(data?.movies) ? data.movies : []).map((m) =>
      pick(m, ['title', 'year', 'inCinemas', 'digitalRelease', 'physicalRelease', 'hasFile'])),
  }
}

async function fetchUpstream(start, end) {
  const qs = new URLSearchParams({ start, end })
  const res = await fetch(`${MEDIAOPS_URL}/api/public/calendar?${qs}`, {
    headers: { 'X-Calendar-Token': TOKEN, Accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    redirect: 'error', // never follow a redirect that could carry the token somewhere else
  })
  if (res.status === 404) return { status: 404 }
  if (!res.ok) throw new Error(`MediaOps answered HTTP ${res.status}`)
  return { status: 200, body: JSON.stringify(project(await res.json())) }
}

async function handleCalendar(req, res, url) {
  const start = url.searchParams.get('start') ?? ''
  const end = url.searchParams.get('end') ?? ''
  // Validated here too, so junk never costs an upstream call.
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return sendJson(res, 400, { error: 'start and end are required as YYYY-MM-DD' })
  }
  const span = (Date.parse(end) - Date.parse(start)) / DAY
  if (!(span >= 0) || span > MAX_RANGE_DAYS) {
    return sendJson(res, 400, { error: `Range must be between 0 and ${MAX_RANGE_DAYS} days` })
  }

  const key = `${start}|${end}`
  const cached = cache.get(key)
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=60' }
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return send(res, 200, cached.body, headers)

  let pending = inFlight.get(key)
  if (!pending) {
    if (budget <= 0) {
      // Out of upstream budget: stale data beats an error for a calendar.
      if (cached) return send(res, 200, cached.body, headers)
      return sendJson(res, 429, { error: 'Busy, try again shortly' }, { 'Retry-After': '30' })
    }
    budget -= 1
    pending = fetchUpstream(start, end).finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
  }

  try {
    const result = await pending
    if (result.status === 404) {
      cache.delete(key)
      return sendJson(res, 404, { error: 'Not available' })
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(key, { at: Date.now(), body: result.body })
    return send(res, 200, result.body, headers)
  } catch (err) {
    console.error(`calendar-share: upstream error: ${err.message}`)
    if (cached) return send(res, 200, cached.body, headers)
    return sendJson(res, 502, { error: 'Calendar temporarily unavailable' })
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' })
    }
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    if (url.pathname === '/api/calendar') return await handleCalendar(req, res, url)

    const file = files.get(url.pathname)
    if (file) {
      return send(res, 200, file.body, {
        'Content-Type': file.type,
        'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
    }
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' })
  } catch (err) {
    console.error(`calendar-share: ${err.message}`)
    if (!res.headersSent) send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain; charset=utf-8' })
  }
})

// Slow-client protection — nothing here legitimately takes long to send.
server.headersTimeout = 10_000
server.requestTimeout = 15_000
server.keepAliveTimeout = 5_000

await loadStatic()
server.listen(PORT, HOST, () => {
  const u = new URL(MEDIAOPS_URL)
  console.log(`calendar-share: serving on http://${HOST}:${PORT}, reading from ${u.protocol}//${u.host}`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)))
}
