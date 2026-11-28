import { statfs } from 'fs/promises'
import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { enrichWithTitles } from './overseerr.js'
import { addLog } from '../logBuffer.js'
import { getQbitSid, refreshQbitCookie } from '../qbitSession.js'
import { getSlskdDashboard } from '../slskd.js'
import { dockerApiGet } from './system.js'
import { getRecovery } from '../recovery.js'

// See server/routes/health.js for the full explanation — same optional mount path.
const PLEX_MOUNT_PATH = process.env.PLEX_MOUNT_PATH || '/mnt/plex'

async function getDiskUsage(path) {
  try {
    const s = await statfs(path)
    const total = s.blocks * s.bsize
    const free = s.bavail * s.bsize
    return { total, free, used: total - free }
  } catch {
    return null
  }
}

async function safeFetch(url, options = {}, timeout = 5000) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const text = await res.text()
    try {
      return { ok: true, data: JSON.parse(text) }
    } catch {
      return { ok: true, data: text }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

const arrH = (key) => ({ 'X-Api-Key': key })

// Merge Plex and Tautulli recently-played lists.
// Plex is the ground truth (always up to date); Tautulli can silently stop logging.
// De-duplicate by rounding viewedAt to the nearest 5 minutes + title.
function mergeRecentlyPlayed(plexItems = [], tautulliItems = []) {
  const seen = new Set()
  const dedup = (item) => {
    const bucket = Math.floor(new Date(item.date).getTime() / (5 * 60 * 1000))
    const key = `${item.title}|${bucket}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
  return [...(plexItems || []), ...(tautulliItems || [])]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .filter(dedup)
    .slice(0, 15)
}

async function getRadarrData(url, key) {
  const [status, movies, history] = await Promise.all([
    safeFetch(`${url}/api/v3/system/status`, { headers: arrH(key) }),
    safeFetch(`${url}/api/v3/movie`, { headers: arrH(key) }),
    safeFetch(`${url}/api/v3/history?pageSize=5&sortKey=date&sortDirection=descending&eventType=3&includeMovie=true`, { headers: arrH(key) }),
  ])
  return {
    health: status.ok ? { ok: true, version: status.data.version } : { ok: false, error: status.error },
    movieCount: movies.ok && Array.isArray(movies.data) ? movies.data.filter((m) => m.hasFile).length : null,
    recent: history.ok ? (history.data.records || []).map((r) => ({
      title: r.movie?.title || r.sourceTitle,
      year: r.movie?.year,
      type: 'movie',
      service: 'radarr',
      date: r.date,
    })) : [],
  }
}

async function getSonarrData(url, key) {
  const [status, series, history] = await Promise.all([
    safeFetch(`${url}/api/v3/system/status`, { headers: arrH(key) }),
    safeFetch(`${url}/api/v3/series`, { headers: arrH(key) }),
    safeFetch(`${url}/api/v3/history?pageSize=5&sortKey=date&sortDirection=descending&eventType=3&includeSeries=true&includeEpisode=true`, { headers: arrH(key) }),
  ])
  const seriesData = series.ok && Array.isArray(series.data) ? series.data : []
  return {
    health: status.ok ? { ok: true, version: status.data.version } : { ok: false, error: status.error },
    seriesCount: series.ok ? seriesData.length : null,
    episodeCount: series.ok ? seriesData.reduce((s, x) => s + (x.statistics?.episodeFileCount || 0), 0) : null,
    recent: history.ok ? (history.data.records || []).map((r) => ({
      title: r.series?.title || r.sourceTitle,
      type: 'episode',
      service: 'sonarr',
      date: r.date,
      subtitle: r.episode ? `S${String(r.episode.seasonNumber).padStart(2,'0')}E${String(r.episode.episodeNumber).padStart(2,'0')} – ${r.episode.title}` : null,
    })) : [],
  }
}

async function getLidarrData(url, key) {
  const [status, artists, history] = await Promise.all([
    safeFetch(`${url}/api/v1/system/status`, { headers: arrH(key) }),
    safeFetch(`${url}/api/v1/artist`, { headers: arrH(key) }),
    safeFetch(`${url}/api/v1/history?pageSize=5&sortKey=date&sortDirection=descending&eventType=downloadImported`, { headers: arrH(key) }),
  ])
  const artistData = artists.ok && Array.isArray(artists.data) ? artists.data : []
  return {
    health: status.ok ? { ok: true, version: status.data.version } : { ok: false, error: status.error },
    artistCount: artists.ok ? artistData.length : null,
    albumCount: artists.ok ? artistData.reduce((s, a) => s + (a.statistics?.albumCount || 0), 0) : null,
    recent: history.ok ? (history.data.records || []).map((r) => ({
      title: r.artist?.artistName || r.sourceTitle,
      subtitle: r.album?.title || null,
      type: 'album',
      service: 'lidarr',
      date: r.date,
    })) : [],
  }
}

async function getTautulliData(url, key) {
  const base = `${url}/api/v2?apikey=${encodeURIComponent(key)}`
  const [libResult, histResult, infoResult] = await Promise.all([
    safeFetch(`${base}&cmd=get_libraries_table`),
    safeFetch(`${base}&cmd=get_history&length=15&order_column=date&order_dir=desc`),
    safeFetch(`${base}&cmd=get_tautulli_info`),
  ])
  const tautulliVersion = infoResult.ok ? (infoResult.data?.response?.data?.tautulli_version?.replace(/^v/, '') ?? null) : null

  const libOk = libResult.ok && libResult.data?.response?.result === 'success'
  let movieCount = null, showCount = null, episodeCount = null, musicCount = null, albumCount = null, trackCount = null
  if (libOk) {
    for (const lib of libResult.data.response.data?.data ?? []) {
      const n = parseInt(lib.count) || 0
      if (lib.section_type === 'movie')  movieCount  = (movieCount  ?? 0) + n
      if (lib.section_type === 'show')  { showCount   = (showCount   ?? 0) + n; episodeCount = (episodeCount ?? 0) + (parseInt(lib.child_count) || 0) }
      // Music sections: count = artists, parent_count = albums, child_count = tracks.
      if (lib.section_type === 'artist') {
        musicCount = (musicCount ?? 0) + n
        albumCount = (albumCount ?? 0) + (parseInt(lib.parent_count) || 0)
        trackCount = (trackCount ?? 0) + (parseInt(lib.child_count) || 0)
      }
    }
  }

  let recentlyPlayed = []
  if (histResult.ok && histResult.data?.response?.result === 'success') {
    recentlyPlayed = (histResult.data.response.data?.data ?? []).map((h) => ({
      title:    h.media_type === 'episode' ? h.grandparent_title : h.title,
      subtitle: h.media_type === 'episode' ? h.title : (h.year ? String(h.year) : null),
      type:     h.media_type,
      user:     h.friendly_name,
      date:     new Date(h.date * 1000).toISOString(),
    }))
  }

  return { health: { ok: libOk, ...(tautulliVersion ? { version: tautulliVersion } : {}) }, movieCount, showCount, episodeCount, musicCount, albumCount, trackCount, recentlyPlayed }
}

async function getSimpleHealth(url, path, headers = {}, extractVersion = null) {
  const r = await safeFetch(`${url}${path}`, { headers })
  if (!r.ok) return { health: { ok: false, error: r.error } }
  const version = extractVersion ? extractVersion(r.data) : null
  return { health: { ok: true, ...(version ? { version } : {}) } }
}

// For apps (Listenarr) that answer unknown paths with their web page: a reply
// that isn't JSON means the URL is wrong, not that the service is healthy.
async function getJsonHealth(url, path, headers = {}, extractVersion = null) {
  const r = await safeFetch(`${url}${path}`, { headers })
  if (!r.ok) return { health: { ok: false, error: r.error } }
  if (typeof r.data !== 'object' || r.data === null) return { health: { ok: false, error: 'Not an API response — check the URL' } }
  const version = extractVersion ? extractVersion(r.data) : null
  return { health: { ok: true, ...(version ? { version } : {}) } }
}

/**
 * For apps with no version anywhere over HTTP (Soularr): the version label of
 * the image a container on this machine runs, through the local Docker socket.
 * Images built from a branch say "main", so those show the commit instead.
 */
async function imageVersion(container) {
  try {
    const list = await dockerApiGet(null, `/containers/json?filters=${encodeURIComponent(JSON.stringify({ name: [container] }))}`)
    const c = list.find((x) => x.Names?.includes(`/${container}`))
    const labels = c?.Labels ?? {}
    const v = labels['org.opencontainers.image.version']
    const rev = labels['org.opencontainers.image.revision']
    if (v && /^v?\d/.test(v)) return v.replace(/^v/, '')
    if (rev) return `${v ? `${v}@` : ''}${rev.slice(0, 7)}`
    return v || null
  } catch { return null }
}

/** Health from one call, plus a version from another that never makes the app look down. */
async function withVersion(healthPromise, versionPromise) {
  const [h, version] = await Promise.all([healthPromise, versionPromise.catch(() => null)])
  return h?.health?.ok && version && !h.health.version ? { ...h, health: { ...h.health, version } } : h
}

// Wizarr's /health is open; /api/version needs a Wizarr API key (Settings → API Keys).
async function wizarrVersion(url, key) {
  if (!key) return null
  const r = await safeFetch(`${url}/api/version`, { headers: { 'X-API-Key': key } })
  return r.ok && typeof r.data?.version === 'string' ? r.data.version : null
}

// Plexamp Requester's /api/stats needs the dashboard key from its Settings page.
// Without one there's nothing to show beyond the /api/ping health check.
// Audiobook Requester's has the same shape (books instead of albums).
async function getMusicRequests(url, key, app = 'Plexamp Requester', minVersion = '0.8.0') {
  if (!key) return null
  const r = await safeFetch(`${url}/api/stats`, { headers: { 'X-Api-Key': key } }, 10_000)
  if (!r.ok) return { error: r.error === 'HTTP 401' ? `API key rejected — copy it again from ${app} → Settings` : r.error }
  if (typeof r.data !== 'object' || !r.data?.counts) return { error: `This ${app} is too old for request stats (needs v${minVersion})` }
  return r.data
}

// Audiobook side of the dashboard, from whichever of these are set up:
//  - Audiobook Requester /api/stats (needs its dashboard key; same shape as the music one)
//  - Listenarr + Listenarr (MAM): monitored books with no file yet ("wanted")
//  - Audiobookshelf: who's listening now, and how many books there are
async function getAudiobooks(svcs, on, at) {
  const abs = on('audiobookshelf') && at('audiobookshelf').key ? at('audiobookshelf') : null
  const absH = abs ? { Authorization: `Bearer ${abs.key}` } : null
  const listenarrs = [['listenarr', 'Listenarr'], ['listenarrMam', 'MAM']].filter(([n]) => on(n))

  const [requests, wantedLists, online, users, libraries] = await Promise.all([
    on('audiobookRequester') ? getMusicRequests(at('audiobookRequester').url, at('audiobookRequester').key, 'Audiobook Requester', '0.12.0') : null,
    Promise.all(listenarrs.map(async ([n, label]) => {
      const r = await safeFetch(`${at(n).url}/api/v1/library`, { headers: arrH(at(n).key) }, 15_000)
      if (!r.ok || !Array.isArray(r.data)) return []
      return r.data
        .filter((b) => b.monitored && b.wanted !== false && !b.fileCount && b.status !== 'quality-match')
        .map((b) => ({ title: b.title, authors: b.authors ?? [], series: b.series ? `${b.series}${b.seriesNumber ? ` #${b.seriesNumber}` : ''}` : null, instance: label }))
    })),
    absH ? safeFetch(`${abs.url}/api/users/online`, { headers: absH }) : null,
    absH ? safeFetch(`${abs.url}/api/users`, { headers: absH }) : null,
    absH ? safeFetch(`${abs.url}/api/libraries`, { headers: absH }) : null,
  ])
  if (!requests && !listenarrs.length && !abs) return null

  const names = new Map((users?.ok ? users.data?.users ?? [] : []).map((u) => [u.id, u.username]))
  const listening = (online?.ok ? online.data?.openSessions ?? [] : []).map((s) => ({
    title: s.displayTitle || s.mediaMetadata?.title || 'Unknown',
    author: s.displayAuthor || null,
    user: s.user?.username || names.get(s.userId) || 'Someone',
    device: s.deviceInfo?.clientName || s.deviceInfo?.deviceName || null,
    currentTime: s.currentTime ?? 0,
    duration: s.duration ?? null,
  }))

  let books = null
  if (libraries?.ok) {
    const bookLibs = (libraries.data?.libraries ?? []).filter((l) => l.mediaType === 'book')
    const totals = await Promise.all(bookLibs.map((l) => safeFetch(`${abs.url}/api/libraries/${l.id}/items?limit=1`, { headers: absH })))
    if (totals.every((t) => t.ok)) books = totals.reduce((n, t) => n + (t.data?.total ?? 0), 0)
  }

  return { requests, wanted: wantedLists.flat(), listening, books }
}

// 0=other, 1=video, 2=audio, 3=subtitles, 4=not available — matches the labels
// the Requests page already uses.
const ISSUE_TYPE = { 0: 'Other', 1: 'Video', 2: 'Audio', 3: 'Subtitles', 4: 'Not Available' }

async function getOverseerrData(url, key) {
  const headers = { 'X-Api-Key': key }
  const [status, counts, pending, issues] = await Promise.all([
    safeFetch(`${url}/api/v1/status`, { headers }),
    safeFetch(`${url}/api/v1/request/count`, { headers }),
    safeFetch(`${url}/api/v1/request?filter=pending&take=5&skip=0&sort=added`, { headers }),
    // Open issues are the whole point of surfacing this on the dashboard — an
    // unread problem report shouldn't sit in a tab waiting to be noticed.
    safeFetch(`${url}/api/v1/issue?filter=open&take=5&skip=0&sort=added`, { headers }),
  ])

  // The issue payload carries a media object but no title, so resolve those the
  // same way the Requests page does.
  let openIssues = []
  if (issues.ok) {
    const raw = issues.data?.results ?? []
    const enriched = await enrichWithTitles({ url, apiKey: key }, raw).catch(() => raw)
    openIssues = enriched.map((i) => ({
      id: i.id,
      title: i.media?.title || i.media?.originalTitle || 'Unknown',
      issueType: ISSUE_TYPE[i.issueType] ?? 'Other',
      mediaType: i.media?.mediaType ?? null,
      tmdbId: i.media?.tmdbId ?? null,
      reportedBy: i.createdBy?.displayName || i.createdBy?.plexUsername || 'Unknown',
      createdAt: i.createdAt ?? null,
      problemSeason: i.problemSeason || 0,
      problemEpisode: i.problemEpisode || 0,
      commentCount: (i.comments ?? []).length,
    }))
  }

  return {
    health: status.ok ? { ok: true, version: status.data.version } : { ok: false, error: status.error },
    pendingCount: counts.ok ? (counts.data.pending ?? null) : null,
    openIssueCount: issues.ok ? (issues.data?.pageInfo?.results ?? openIssues.length) : null,
    openIssues,
    pendingRequests: pending.ok ? (pending.data.results || []).map((r) => ({
      id: r.id,
      title: r.media?.originalTitle || r.media?.title || 'Unknown',
      type: r.type,
      requestedBy: r.requestedBy?.displayName || 'Unknown',
    })) : [],
  }
}

// Live library totals straight from Plex. Tautulli's get_libraries_table only refreshes
// its counts every few hours, so during a big re-download the dashboard lagged by
// hundreds of items. X-Plex-Container-Size=0 returns just totalSize, so this is cheap.
// Plex item types: 1 movie, 2 show, 4 episode, 8 artist, 9 album, 10 track.
async function getPlexLibraryCounts(url, headers) {
  const sections = await safeFetch(`${url}/library/sections`, { headers })
  if (!sections.ok) return null
  const wanted = { movie: { movies: 1 }, show: { shows: 2, episodes: 4 }, artist: { artists: 8, albums: 9, tracks: 10 } }
  const counts = {}
  const jobs = []
  for (const s of sections.data?.MediaContainer?.Directory ?? []) {
    for (const [field, type] of Object.entries(wanted[s.type] ?? {})) {
      jobs.push(safeFetch(`${url}/library/sections/${s.key}/all?type=${type}&X-Plex-Container-Start=0&X-Plex-Container-Size=0`, { headers })
        .then((r) => { if (r.ok) counts[field] = (counts[field] ?? 0) + (r.data?.MediaContainer?.totalSize ?? 0) }))
    }
  }
  await Promise.all(jobs)
  return Object.keys(counts).length ? counts : null
}

async function getPlexData(url, token) {
  const headers = { 'X-Plex-Token': token, Accept: 'application/json' }
  const [identity, sessions, accounts, history] = await Promise.all([
    safeFetch(`${url}/identity`, { headers }),
    safeFetch(`${url}/status/sessions`, { headers }),
    safeFetch(`${url}/accounts`, { headers }),
    safeFetch(`${url}/status/sessions/history/all?sort=viewedAt:desc&limit=20`, { headers }),
  ])

  // Build accountID → display name map
  const accountMap = {}
  for (const a of (accounts.ok ? accounts.data?.MediaContainer?.Account ?? [] : [])) {
    accountMap[a.id] = a.name || a.title || 'Unknown'
  }

  const meta = sessions.ok ? (sessions.data.MediaContainer?.Metadata || []) : []
  const plexVersion = identity.ok ? (identity.data?.MediaContainer?.version ?? null) : null

  // Parse Plex play history (source of truth — more reliable than Tautulli agent)
  const recentlyPlayed = history.ok
    ? (history.data?.MediaContainer?.Metadata ?? []).map((h) => ({
        title:    h.type === 'episode' ? (h.grandparentTitle || h.title) : h.title,
        subtitle: h.type === 'episode' ? h.title : (h.year ? String(h.year) : null),
        type:     h.type,
        user:     accountMap[h.accountID] || `user#${h.accountID}`,
        date:     new Date(h.viewedAt * 1000).toISOString(),
      }))
    : []

  return {
    health: identity.ok ? { ok: true, ...(plexVersion ? { version: plexVersion } : {}) } : { ok: false, error: identity.error },
    libraryCounts: identity.ok ? await getPlexLibraryCounts(url, headers) : null,
    activeStreams: sessions.ok ? (sessions.data.MediaContainer?.size ?? meta.length) : null,
    recentlyPlayed,
    streamDetails: meta.map((m) => {
      const media = m.Media?.[0] || {}
      const ts = m.TranscodeSession
      const videoDecision = ts?.videoDecision || 'directplay'
      const audioDecision = ts?.audioDecision || 'directplay'
      const isTranscoding = videoDecision === 'transcode' || audioDecision === 'transcode'
      const playMethod = isTranscoding ? 'transcode' : (ts ? 'direct stream' : 'direct play')
      return {
        title: m.type === 'episode' ? `${m.grandparentTitle} · ${m.title}` : m.title,
        // "S02E05" for episodes (Plex: parentIndex = season, index = episode).
        episode: m.type === 'episode' && m.index != null
          ? `${m.parentIndex != null ? `S${String(m.parentIndex).padStart(2, '0')}` : ''}E${String(m.index).padStart(2, '0')}`
          : null,
        user: m.User?.title || 'Unknown',
        player: m.Player?.title || 'Unknown',
        platform: m.Player?.platform || null,
        state: m.Player?.state || 'playing',
        viewOffset: m.viewOffset || 0,
        duration: m.duration || null,
        videoCodec: media.videoCodec || null,
        videoResolution: media.videoResolution || null,
        audioCodec: media.audioCodec || null,
        playMethod,
      }
    }),
  }
}

async function getQbitData(url, userpass, client = 'qbittorrent') {
  try {
    let cookie = await getQbitSid(url, userpass)

    // If qBit was restarted the cached session cookie is stale — detect 403 and re-login once.
    const probe = await fetch(`${url}/api/v2/transfer/info`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) })
    if (probe.status === 403) cookie = await refreshQbitCookie(url, userpass)
    const info = probe.status === 403
      ? await fetch(`${url}/api/v2/transfer/info`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).then((r) => r.json())
      : await probe.json()

    const [all, completed, versionText] = await Promise.all([
      fetch(`${url}/api/v2/torrents/info?filter=all`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
      fetch(`${url}/api/v2/torrents/info?filter=completed&sort=completion_on&reverse=true&limit=10`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
      fetch(`${url}/api/v2/app/version`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).then((r) => r.text()).catch(() => null),
    ])
    const recentlyDownloaded = Array.isArray(completed)
      ? completed
          .filter((t) => t.completion_on > 0)
          .map((t) => ({ name: t.name, date: new Date(t.completion_on * 1000).toISOString(), size: t.size, client }))
      : []
    // "active" here means "in the queue", matching the Downloads page's own
    // count — not qBittorrent's filter=active, which only counts torrents
    // currently transferring and undercounts anything queued/stalled/paused.
    const COMPLETED_STATES = ['uploading', 'forcedUP', 'stalledUP', 'queuedUP', 'pausedUP', 'checkingUP']
    const queueCount = Array.isArray(all) ? all.filter((t) => !COMPLETED_STATES.includes(t.state)).length : 0
    return {
      // qBittorrent reports "v5.2.4"; the UI adds its own "v".
      health: { ok: true, ...(versionText ? { version: versionText.trim().replace(/^v/i, '') } : {}) },
      dlSpeed: info.dl_info_speed || 0,
      upSpeed: info.up_info_speed || 0,
      activeCount: queueCount,
      recentlyDownloaded,
    }
  } catch (err) {
    return { health: { ok: false, error: err.message } }
  }
}

async function getNzbgetData(url, userpass, client) {
  const sep = (userpass || '').indexOf(':')
  const user = sep > -1 ? userpass.slice(0, sep) : 'nzbget'
  const pass = sep > -1 ? userpass.slice(sep + 1) : (userpass || '')
  const auth = Buffer.from(`${user}:${pass}`).toString('base64')
  const headers = { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` }

  const [statusRes, histRes, versionRes, groupsRes] = await Promise.all([
    safeFetch(`${url}/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ version: '1.1', method: 'status', params: [] }) }),
    safeFetch(`${url}/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ version: '1.1', method: 'history', params: [false] }) }),
    safeFetch(`${url}/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ version: '1.1', method: 'version', params: [] }) }),
    safeFetch(`${url}/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ version: '1.1', method: 'listgroups', params: [0] }) }),
  ])
  if (!statusRes.ok) return { health: { ok: false, error: statusRes.error } }
  const nzbVersion = versionRes.ok ? versionRes.data?.result : null

  const result = statusRes.data.result || {}
  const recentlyDownloaded = histRes.ok && Array.isArray(histRes.data.result)
    ? histRes.data.result
        .filter((h) => h.Status === 'SUCCESS')
        .slice(0, 10)
        .map((h) => ({ name: h.NZBName, date: new Date(h.HistoryTime * 1000).toISOString(), size: h.FileSizeMB * 1024 * 1024, client }))
    : []
  const queueCount = groupsRes.ok && Array.isArray(groupsRes.data?.result) ? groupsRes.data.result.length : 0
  return {
    health: { ok: true, ...(nzbVersion ? { version: nzbVersion } : {}) },
    dlSpeed: result.DownloadRate || 0,
    activeCount: queueCount,
    recentlyDownloaded,
  }
}

export default async function dashboardRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async () => {
    const config = await getConfig()
    const svcs = config.services
    const on = (name) => svcs[name]?.enabled
    const at = (name) => ({ url: svcs[name].url.replace(/\/$/, ''), key: svcs[name].apiKey })

    const [radarr, sonarr, lidarr, bazarr, overseerr, prowlarr, jackett, plex, qbit, nzbget, nzbgetMusic, huntarr, requestrr, tautulli, plexDisk,
      qbitMam, listenarr, listenarrMam, audiobookshelf, audiobookRequester,
      audiobookshelfDemo, homeshelfWeb, plexampRequester, wizarr, slskd, soularr, musicRequests, audiobooks, recovery] =
      (await Promise.allSettled([
        on('radarr')      ? getRadarrData(at('radarr').url, at('radarr').key)             : null,
        on('sonarr')      ? getSonarrData(at('sonarr').url, at('sonarr').key)             : null,
        on('lidarr')      ? getLidarrData(at('lidarr').url, at('lidarr').key)             : null,
        on('bazarr')      ? getSimpleHealth(at('bazarr').url, '/api/system/status', arrH(at('bazarr').key), d => d?.data?.bazarr_version) : null,
        on('overseerr')   ? getOverseerrData(at('overseerr').url, at('overseerr').key)   : null,
        on('prowlarr')    ? getSimpleHealth(at('prowlarr').url, '/api/v1/system/status', arrH(at('prowlarr').key), d => d?.version) : null,
        on('jackett')     ? getSimpleHealth(at('jackett').url, `/api/v2.0/indexers?apikey=${at('jackett').key}`) : null,
        on('plex')        ? getPlexData(at('plex').url, at('plex').key)                   : null,
        on('qbittorrent') ? getQbitData(at('qbittorrent').url, at('qbittorrent').key)     : null,
        on('nzbget')      ? getNzbgetData(at('nzbget').url, at('nzbget').key, 'nzbget')   : null,
        on('nzbgetMusic') ? getNzbgetData(at('nzbgetMusic').url, at('nzbgetMusic').key, 'nzbgetMusic') : null,
        on('huntarr')     ? getSimpleHealth(at('huntarr').url, '/api/status', arrH(at('huntarr').key)) : null,
        on('requestrr')   ? getSimpleHealth(at('requestrr').url, '/')                     : null,
        on('tautulli')    ? getTautulliData(at('tautulli').url, at('tautulli').key)       : null,
        getDiskUsage(PLEX_MOUNT_PATH),
        on('qbittorrentMam') ? getQbitData(at('qbittorrentMam').url, at('qbittorrentMam').key, 'qbittorrentMam') : null,
        on('listenarr')    ? getJsonHealth(at('listenarr').url, '/api/v1/system/info', arrH(at('listenarr').key), d => d?.version) : null,
        on('listenarrMam') ? getJsonHealth(at('listenarrMam').url, '/api/v1/system/info', arrH(at('listenarrMam').key), d => d?.version) : null,
        on('audiobookshelf') ? getJsonHealth(at('audiobookshelf').url, '/status', {}, d => d?.serverVersion) : null,
        on('audiobookRequester') ? getJsonHealth(at('audiobookRequester').url, '/api/ping', {}, d => d?.version) : null,
        on('audiobookshelfDemo') ? getJsonHealth(at('audiobookshelfDemo').url, '/status', {}, d => d?.serverVersion) : null,
        on('homeshelfWeb') ? getJsonHealth(at('homeshelfWeb').url, '/api/ping', {}, d => d?.version) : null,
        on('plexampRequester') ? getJsonHealth(at('plexampRequester').url, '/api/ping', {}, d => d?.version) : null,
        on('wizarr')       ? withVersion(getSimpleHealth(at('wizarr').url, '/health'), wizarrVersion(at('wizarr').url, at('wizarr').key)) : null,
        on('slskd')        ? getSlskdDashboard(at('slskd').url, at('slskd').key)          : null,
        on('soularr')      ? withVersion(getSimpleHealth(at('soularr').url, '/'), imageVersion('soularr')) : null,
        on('plexampRequester') ? getMusicRequests(at('plexampRequester').url, at('plexampRequester').key) : null,
        getAudiobooks(svcs, on, at),
        on('plex') ? getRecovery() : null,
      ])).map((r) => (r.status === 'fulfilled' ? r.value : null))

    const health = {}
    const addHealth = (name, data) => {
      if (!on(name)) return
      const h = data?.health || { ok: false, error: 'Failed' }
      health[name] = h
      if (!h.ok) addLog('warn', `[dashboard] ${name} unhealthy: ${h.error || 'no response'}`, { service: name })
    }
    addHealth('radarr', radarr); addHealth('sonarr', sonarr); addHealth('lidarr', lidarr)
    addHealth('bazarr', bazarr); addHealth('overseerr', overseerr); addHealth('prowlarr', prowlarr)
    addHealth('jackett', jackett); addHealth('plex', plex); addHealth('qbittorrent', qbit)
    addHealth('nzbget', nzbget); addHealth('nzbgetMusic', nzbgetMusic); addHealth('huntarr', huntarr); addHealth('requestrr', requestrr)
    addHealth('tautulli', tautulli)
    addHealth('qbittorrentMam', qbitMam); addHealth('listenarr', listenarr); addHealth('listenarrMam', listenarrMam)
    addHealth('audiobookshelf', audiobookshelf); addHealth('audiobookRequester', audiobookRequester)
    addHealth('audiobookshelfDemo', audiobookshelfDemo); addHealth('homeshelfWeb', homeshelfWeb)
    addHealth('plexampRequester', plexampRequester); addHealth('wizarr', wizarr)
    addHealth('slskd', slskd); addHealth('soularr', soularr)

    addLog('debug', '[dashboard] poll complete', {
      service: 'dashboard',
      responseText: [
        radarr   && `radarr:${radarr.movieCount ?? '?'}movies`,
        sonarr   && `sonarr:${sonarr.seriesCount ?? '?'}shows`,
        qbit     && `qbit:${qbit.activeCount ?? 0}active`,
        qbitMam  && `qbitMam:${qbitMam.activeCount ?? 0}active`,
        nzbget   && `nzbget:${nzbget.activeCount ?? 0}active`,
        nzbgetMusic && `nzbgetMusic:${nzbgetMusic.activeCount ?? 0}active`,
        plex     && `plex:${plex.activeStreams ?? 0}streams`,
        overseerr && `overseerr:${overseerr.pendingCount ?? 0}pending/${overseerr.openIssueCount ?? 0}issues`,
      ].filter(Boolean).join(' | '),
    })

    const recentlyAdded = [
      ...(radarr?.recent || []),
      ...(sonarr?.recent || []),
      ...(lidarr?.recent || []),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10)

    const recentlyDownloaded = [
      ...(qbit?.recentlyDownloaded || []),
      ...(qbitMam?.recentlyDownloaded || []),
      ...(nzbget?.recentlyDownloaded || []),
      ...(nzbgetMusic?.recentlyDownloaded || []),
      ...(slskd?.recentlyDownloaded || []),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10)

    return {
      health,
      stats: {
        // Live Plex counts first; Tautulli's are cached for hours. Lidarr's album count
        // includes albums it hasn't downloaded, so it's the last resort.
        movies:          plex?.libraryCounts?.movies   ?? tautulli?.movieCount   ?? radarr?.movieCount   ?? null,
        shows:           plex?.libraryCounts?.shows    ?? tautulli?.showCount    ?? sonarr?.seriesCount  ?? null,
        episodes:        plex?.libraryCounts?.episodes ?? tautulli?.episodeCount ?? sonarr?.episodeCount ?? null,
        artists:         plex?.libraryCounts?.artists  ?? tautulli?.musicCount   ?? lidarr?.artistCount  ?? null,
        albums:          plex?.libraryCounts?.albums   ?? tautulli?.albumCount   ?? lidarr?.albumCount   ?? null,
        tracks:          plex?.libraryCounts?.tracks   ?? tautulli?.trackCount   ?? null,
        plexStreams:     plex?.activeStreams  ?? null,
        pendingRequests: overseerr?.pendingCount ?? null,
        openIssues:      overseerr?.openIssueCount ?? null,
      },
      plexDisk,
      downloads: {
        qbittorrent: on('qbittorrent') && qbit ? { ok: qbit.health.ok, dlSpeed: qbit.dlSpeed, upSpeed: qbit.upSpeed, active: qbit.activeCount } : null,
        qbittorrentMam: on('qbittorrentMam') && qbitMam ? { ok: qbitMam.health.ok, dlSpeed: qbitMam.dlSpeed, upSpeed: qbitMam.upSpeed, active: qbitMam.activeCount } : null,
        nzbget:      on('nzbget') && nzbget     ? { ok: nzbget.health.ok, dlSpeed: nzbget.dlSpeed, active: nzbget.activeCount }                  : null,
        nzbgetMusic: on('nzbgetMusic') && nzbgetMusic ? { ok: nzbgetMusic.health.ok, dlSpeed: nzbgetMusic.dlSpeed, active: nzbgetMusic.activeCount } : null,
        slskd:       on('slskd') && slskd ? { ok: slskd.health.ok, dlSpeed: slskd.dlSpeed ?? 0, active: slskd.activeCount ?? 0 } : null,
      },
      plexStreams: plex?.streamDetails || [],
      recentlyAdded,
      recentlyDownloaded,
      // Plex history is the source of truth; merge Tautulli entries as a supplement
      // (Tautulli agent can stop logging while Plex keeps its own history up to date).
      recentlyPlayed: mergeRecentlyPlayed(plex?.recentlyPlayed, tautulli?.recentlyPlayed),
      pendingRequests: overseerr?.pendingRequests || [],
      openIssues: overseerr?.openIssues || [],
      musicRequests,
      audiobooks,
      recovery,
    }
  })
}
