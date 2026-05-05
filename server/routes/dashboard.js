import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { addLog } from '../logBuffer.js'

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
  const [libResult, histResult] = await Promise.all([
    safeFetch(`${base}&cmd=get_libraries_table`),
    safeFetch(`${base}&cmd=get_history&length=15&order_column=date&order_dir=desc`),
  ])

  const libOk = libResult.ok && libResult.data?.response?.result === 'success'
  let movieCount = null, showCount = null, episodeCount = null, musicCount = null
  if (libOk) {
    for (const lib of libResult.data.response.data?.data ?? []) {
      const n = parseInt(lib.count) || 0
      if (lib.section_type === 'movie')  movieCount  = (movieCount  ?? 0) + n
      if (lib.section_type === 'show')  { showCount   = (showCount   ?? 0) + n; episodeCount = (episodeCount ?? 0) + (parseInt(lib.child_count) || 0) }
      if (lib.section_type === 'artist') musicCount  = (musicCount  ?? 0) + n
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

  return { health: { ok: libOk }, movieCount, showCount, episodeCount, musicCount, recentlyPlayed }
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

async function getQbitData(url, userpass) {
  try {
    const sep = (userpass || '').indexOf(':')
    const username = sep > -1 ? userpass.slice(0, sep) : 'admin'
    const password = sep > -1 ? userpass.slice(sep + 1) : (userpass || '')
    const loginRes = await fetch(`${url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      signal: AbortSignal.timeout(5000),
    })
    const loginText = await loginRes.text()
    if (loginText.trim() !== 'Ok.') return { health: { ok: false, error: 'Auth failed — check password' } }

    const sid = loginRes.headers.get('set-cookie')?.match(/SID=([^;]+)/)?.[1]
    if (!sid) return { health: { ok: false, error: 'No session cookie returned' } }

    const cookie = `SID=${sid}`
    const [info, active, completed] = await Promise.all([
      fetch(`${url}/api/v2/transfer/info`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
      fetch(`${url}/api/v2/torrents/info?filter=active`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
      fetch(`${url}/api/v2/torrents/info?filter=completed&sort=completion_on&reverse=true&limit=10`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) }).then((r) => r.json()),
    ])
    const recentlyDownloaded = Array.isArray(completed)
      ? completed
          .filter((t) => t.completion_on > 0)
          .map((t) => ({ name: t.name, date: new Date(t.completion_on * 1000).toISOString(), size: t.size, client: 'qbittorrent' }))
      : []
    return {
      health: { ok: true },
      dlSpeed: info.dl_info_speed || 0,
      upSpeed: info.up_info_speed || 0,
      activeCount: Array.isArray(active) ? active.length : 0,
      recentlyDownloaded,
    }
  } catch (err) {
    return { health: { ok: false, error: err.message } }
  }
}

async function getNzbgetData(url, userpass) {
  const sep = (userpass || '').indexOf(':')
  const user = sep > -1 ? userpass.slice(0, sep) : 'nzbget'
  const pass = sep > -1 ? userpass.slice(sep + 1) : (userpass || '')
  const auth = Buffer.from(`${user}:${pass}`).toString('base64')
  const headers = { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` }

  const [statusRes, histRes] = await Promise.all([
    safeFetch(`${url}/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ version: '1.1', method: 'status', params: [] }) }),
    safeFetch(`${url}/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ version: '1.1', method: 'history', params: [false] }) }),
  ])
  if (!statusRes.ok) return { health: { ok: false, error: statusRes.error } }

  const result = statusRes.data.result || {}
  const recentlyDownloaded = histRes.ok && Array.isArray(histRes.data.result)
    ? histRes.data.result
        .filter((h) => h.Status === 'SUCCESS')
        .slice(0, 10)
        .map((h) => ({ name: h.NZBName, date: new Date(h.HistoryTime * 1000).toISOString(), size: h.FileSizeMB * 1024 * 1024, client: 'nzbget' }))
    : []
  return {
    health: { ok: true },
    dlSpeed: result.DownloadRate || 0,
    activeCount: (result.RemainingSizeMB || 0) > 0 ? 1 : 0,
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

    const [radarr, sonarr, lidarr, bazarr, overseerr, prowlarr, jackett, plex, qbit, nzbget, huntarr, requestrr, tautulli] =
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
        on('huntarr')     ? getSimpleHealth(at('huntarr').url, '/api/status', arrH(at('huntarr').key)) : null,
        on('requestrr')   ? getSimpleHealth(at('requestrr').url, '/')                     : null,
        on('tautulli')    ? getTautulliData(at('tautulli').url, at('tautulli').key)       : null,
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
    addHealth('nzbget', nzbget); addHealth('huntarr', huntarr); addHealth('requestrr', requestrr)
    addHealth('tautulli', tautulli)

    addLog('debug', '[dashboard] poll complete', {
      service: 'dashboard',
      responseText: [
        radarr   && `radarr:${radarr.movieCount ?? '?'}movies`,
        sonarr   && `sonarr:${sonarr.seriesCount ?? '?'}shows`,
        qbit     && `qbit:${qbit.activeCount ?? 0}active`,
        nzbget   && `nzbget:${nzbget.activeCount ?? 0}active`,
        plex     && `plex:${plex.activeStreams ?? 0}streams`,
        overseerr && `overseerr:${overseerr.pendingCount ?? 0}pending`,
      ].filter(Boolean).join(' | '),
    })

    const recentlyAdded = [
      ...(radarr?.recent || []),
      ...(sonarr?.recent || []),
      ...(lidarr?.recent || []),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10)

    const recentlyDownloaded = [
      ...(qbit?.recentlyDownloaded || []),
      ...(nzbget?.recentlyDownloaded || []),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10)

    return {
      health,
      stats: {
        movies:          tautulli?.movieCount   ?? radarr?.movieCount   ?? null,
        shows:           tautulli?.showCount    ?? sonarr?.seriesCount  ?? null,
        episodes:        tautulli?.episodeCount ?? sonarr?.episodeCount ?? null,
        artists:         tautulli?.musicCount   ?? lidarr?.artistCount  ?? null,
        albums:          lidarr?.albumCount ?? null,
        plexStreams:     plex?.activeStreams  ?? null,
        pendingRequests: overseerr?.pendingCount ?? null,
      },
      downloads: {
        qbittorrent: on('qbittorrent') && qbit ? { ok: qbit.health.ok, dlSpeed: qbit.dlSpeed, upSpeed: qbit.upSpeed, active: qbit.activeCount } : null,
        nzbget:      on('nzbget') && nzbget     ? { ok: nzbget.health.ok, dlSpeed: nzbget.dlSpeed, active: nzbget.activeCount }                  : null,
      },
      plexStreams: plex?.streamDetails || [],
      recentlyAdded,
      recentlyDownloaded,
      recentlyPlayed: tautulli?.recentlyPlayed || [],
      pendingRequests: overseerr?.pendingRequests || [],
    }
  })
}
