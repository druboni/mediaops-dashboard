import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

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

async function getRadarrData(url, key) {
  const [status, movies, history] = await Promise.all([
    safeFetch(`${url}/api/v3/system/status`, { headers: arrH(key) }),
    safeFetch(`${url}/api/v3/movie`, { headers: arrH(key) }),
    safeFetch(`${url}/api/v3/history?pageSize=5&sortKey=date&sortDirection=descending&eventType=downloadFolderImported`, { headers: arrH(key) }),
  ])
  return {
    health: status.ok ? { ok: true, version: status.data.version } : { ok: false, error: status.error },
    movieCount: movies.ok && Array.isArray(movies.data) ? movies.data.length : null,
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
    safeFetch(`${url}/api/v3/history?pageSize=5&sortKey=date&sortDirection=descending&eventType=downloadFolderImported`, { headers: arrH(key) }),
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
  const [status, artists] = await Promise.all([
    safeFetch(`${url}/api/v1/system/status`, { headers: arrH(key) }),
    safeFetch(`${url}/api/v1/artist`, { headers: arrH(key) }),
  ])
  const artistData = artists.ok && Array.isArray(artists.data) ? artists.data : []
  return {
    health: status.ok ? { ok: true, version: status.data.version } : { ok: false, error: status.error },
    artistCount: artists.ok ? artistData.length : null,
    albumCount: artists.ok ? artistData.reduce((s, a) => s + (a.statistics?.albumCount || 0), 0) : null,
  }
}

async function getSimpleHealth(url, path, headers = {}) {
  const r = await safeFetch(`${url}${path}`, { headers })
  return { health: r.ok ? { ok: true } : { ok: false, error: r.error } }
}

async function getOverseerrData(url, key) {
  const headers = { 'X-Api-Key': key }
  const [status, counts, pending] = await Promise.all([
    safeFetch(`${url}/api/v1/status`, { headers }),
    safeFetch(`${url}/api/v1/request/count`, { headers }),
    safeFetch(`${url}/api/v1/request?filter=pending&take=5&skip=0&sort=added`, { headers }),
  ])
  return {
    health: status.ok ? { ok: true, version: status.data.version } : { ok: false, error: status.error },
    pendingCount: counts.ok ? (counts.data.pending ?? null) : null,
    pendingRequests: pending.ok ? (pending.data.results || []).map((r) => ({
      id: r.id,
      title: r.media?.originalTitle || r.media?.title || 'Unknown',
      type: r.type,
      requestedBy: r.requestedBy?.displayName || 'Unknown',
    })) : [],
  }
}

async function getPlexData(url, token) {
  const headers = { 'X-Plex-Token': token, Accept: 'application/json' }
  const [identity, sessions] = await Promise.all([
    safeFetch(`${url}/identity`, { headers }),
    safeFetch(`${url}/status/sessions`, { headers }),
  ])
  const meta = sessions.ok ? (sessions.data.MediaContainer?.Metadata || []) : []
  return {
    health: identity.ok ? { ok: true } : { ok: false, error: identity.error },
    activeStreams: sessions.ok ? (sessions.data.MediaContainer?.size ?? meta.length) : null,
    streamDetails: meta.map((m) => ({
      title: m.type === 'episode' ? `${m.grandparentTitle} · ${m.title}` : m.title,
      user: m.User?.title || 'Unknown',
      player: m.Player?.title || 'Unknown',
      state: m.Player?.state || 'playing',
    })),
  }
}

async function getQbitData(url, password) {
  try {
    const loginRes = await fetch(`${url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=admin&password=${encodeURIComponent(password)}`,
      signal: AbortSignal.timeout(5000),
    })
    const loginText = await loginRes.text()
    if (loginText.trim() !== 'Ok.') return { health: { ok: false, error: 'Auth failed — check password' } }

    const sid = loginRes.headers.get('set-cookie')?.match(/SID=([^;]+)/)?.[1]
    if (!sid) return { health: { ok: false, error: 'No session cookie returned' } }

    const cookie = `SID=${sid}`
    const [info, active] = await Promise.all([
      fetch(`${url}/api/v2/transfer/info`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
      fetch(`${url}/api/v2/torrents/info?filter=active`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
    ])
    return {
      health: { ok: true },
      dlSpeed: info.dl_info_speed || 0,
      upSpeed: info.up_info_speed || 0,
      activeCount: Array.isArray(active) ? active.length : 0,
    }
  } catch (err) {
    return { health: { ok: false, error: err.message } }
  }
}

async function getNzbgetData(url, userpass) {
  const sep = (userpass || '').indexOf(':')
  const user = sep > -1 ? userpass.slice(0, sep) : 'nzbget'
  const pass = sep > -1 ? userpass.slice(sep + 1) : (userpass || 'tegbzn6789')
  const auth = Buffer.from(`${user}:${pass}`).toString('base64')

  const r = await safeFetch(`${url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ version: '1.1', method: 'status', params: [] }),
  })
  if (!r.ok) return { health: { ok: false, error: r.error } }

  const result = r.data.result || {}
  return {
    health: { ok: true },
    dlSpeed: result.DownloadRate || 0,
    activeCount: (result.RemainingSizeMB || 0) > 0 ? 1 : 0,
  }
}

export default async function dashboardRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async () => {
    const config = await getConfig()
    const svcs = config.services
    const on = (name) => svcs[name]?.enabled
    const at = (name) => ({ url: svcs[name].url.replace(/\/$/, ''), key: svcs[name].apiKey })

    const [radarr, sonarr, lidarr, bazarr, overseerr, prowlarr, jackett, plex, qbit, nzbget, huntarr, requestrr] =
      (await Promise.allSettled([
        on('radarr')      ? getRadarrData(at('radarr').url, at('radarr').key)             : null,
        on('sonarr')      ? getSonarrData(at('sonarr').url, at('sonarr').key)             : null,
        on('lidarr')      ? getLidarrData(at('lidarr').url, at('lidarr').key)             : null,
        on('bazarr')      ? getSimpleHealth(at('bazarr').url, '/api/system/status', arrH(at('bazarr').key)) : null,
        on('overseerr')   ? getOverseerrData(at('overseerr').url, at('overseerr').key)   : null,
        on('prowlarr')    ? getSimpleHealth(at('prowlarr').url, '/api/v1/system/status', arrH(at('prowlarr').key)) : null,
        on('jackett')     ? getSimpleHealth(at('jackett').url, `/api/v2.0/indexers?apikey=${at('jackett').key}`) : null,
        on('plex')        ? getPlexData(at('plex').url, at('plex').key)                   : null,
        on('qbittorrent') ? getQbitData(at('qbittorrent').url, at('qbittorrent').key)     : null,
        on('nzbget')      ? getNzbgetData(at('nzbget').url, at('nzbget').key)             : null,
        on('huntarr')     ? getSimpleHealth(at('huntarr').url, '/api/v1/system/status', arrH(at('huntarr').key)) : null,
        on('requestrr')   ? getSimpleHealth(at('requestrr').url, '/')                     : null,
      ])).map((r) => (r.status === 'fulfilled' ? r.value : null))

    const health = {}
    const addHealth = (name, data) => { if (on(name)) health[name] = data?.health || { ok: false, error: 'Failed' } }
    addHealth('radarr', radarr); addHealth('sonarr', sonarr); addHealth('lidarr', lidarr)
    addHealth('bazarr', bazarr); addHealth('overseerr', overseerr); addHealth('prowlarr', prowlarr)
    addHealth('jackett', jackett); addHealth('plex', plex); addHealth('qbittorrent', qbit)
    addHealth('nzbget', nzbget); addHealth('huntarr', huntarr); addHealth('requestrr', requestrr)

    const recentlyAdded = [
      ...(radarr?.recent || []),
      ...(sonarr?.recent || []),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10)

    return {
      health,
      stats: {
        movies:          radarr?.movieCount   ?? null,
        shows:           sonarr?.seriesCount  ?? null,
        episodes:        sonarr?.episodeCount ?? null,
        artists:         lidarr?.artistCount  ?? null,
        albums:          lidarr?.albumCount   ?? null,
        plexStreams:     plex?.activeStreams  ?? null,
        pendingRequests: overseerr?.pendingCount ?? null,
      },
      downloads: {
        qbittorrent: on('qbittorrent') && qbit ? { ok: qbit.health.ok, dlSpeed: qbit.dlSpeed, upSpeed: qbit.upSpeed, active: qbit.activeCount } : null,
        nzbget:      on('nzbget') && nzbget     ? { ok: nzbget.health.ok, dlSpeed: nzbget.dlSpeed, active: nzbget.activeCount }                  : null,
      },
      plexStreams: plex?.streamDetails || [],
      recentlyAdded,
      pendingRequests: overseerr?.pendingRequests || [],
    }
  })
}
