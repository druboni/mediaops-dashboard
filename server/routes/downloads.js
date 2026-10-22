import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { addLog } from '../logBuffer.js'
import { getQbitSid, refreshQbitCookie } from '../qbitSession.js'
import { deadReason } from '../deadTorrents.js'
import { badFileLog } from '../badFiles.js'

function mapQbitState(state) {
  switch (state) {
    case 'downloading': case 'forcedDL': return 'downloading'
    case 'stalledDL': return 'stalled'
    case 'metaDL': case 'forcedMetaDL': return 'finding peers'
    case 'pausedDL': return 'paused'
    case 'queuedDL': return 'queued'
    case 'checkingDL': case 'checkingUP': return 'checking'
    case 'uploading': case 'forcedUP': case 'stalledUP': case 'queuedUP': return 'seeding'
    case 'pausedUP': return 'paused (seeding)'
    case 'error': case 'missingFiles': return 'error'
    case 'moving': return 'moving'
    default: return state
  }
}

function isQbitCompleted(state) {
  return ['uploading', 'forcedUP', 'stalledUP', 'queuedUP', 'pausedUP', 'checkingUP'].includes(state)
}

function mapNzbStatus(status) {
  switch (status) {
    case 'DOWNLOADING': return 'downloading'
    case 'PAUSED': return 'paused'
    case 'QUEUED': return 'queued'
    case 'PP_QUEUED': case 'LOADING_PARS': case 'VERIFYING_SOURCE_FILES':
    case 'REPAIRING': case 'VERIFYING_REPAIRED': case 'RENAMING':
    case 'UNPACKING': case 'MOVING': case 'EXECUTING_SCRIPT': return 'processing'
    case 'PP_FAILED': case 'SCAN_FAILED': return 'error'
    default: return (status || '').toLowerCase()
  }
}

function getNzbAuth(userpass) {
  const sep = (userpass || '').indexOf(':')
  const user = sep > -1 ? userpass.slice(0, sep) : 'nzbget'
  const pass = sep > -1 ? userpass.slice(sep + 1) : (userpass || '')
  return Buffer.from(`${user}:${pass}`).toString('base64')
}

async function nzbRpc(url, userpass, method, params = []) {
  const auth = getNzbAuth(userpass)
  const res = await fetch(`${url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ version: '1.1', method, params }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`NZBGet HTTP ${res.status}`)
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'NZBGet RPC error')
  return json.result
}

// Every NZBGet instance, keyed by its name under config.services. Each one is
// its own daemon with its own queue, so NZBIDs are only unique per instance —
// items carry their service key as `client` and actions route back by it.
const NZB_CLIENTS = ['nzbget', 'nzbgetMusic']

// Every qBittorrent instance. 'qbittorrent' is the one Sonarr/Radarr/Lidarr
// (and the original Listenarr) use; 'qbittorrentMam' is Listenarr-MAM's, whose
// torrents must keep seeding for MyAnonamouse — the client never auto-deletes from it.
const QBIT_CLIENTS = ['qbittorrent', 'qbittorrentMam']

const mbToBytes = (mb) => Math.round((mb || 0) * 1024 * 1024)

async function getQbitData(url, password, client) {
  let cookie = await getQbitSid(url, password)
  let headers = { Cookie: cookie }

  // Fetch torrent list — if qBit was restarted the cached cookie is stale (403).
  // Detect that and transparently re-login once before giving up.
  let torrentsRes = await fetch(`${url}/api/v2/torrents/info?filter=all`, { headers, signal: AbortSignal.timeout(8000) })
  if (torrentsRes.status === 403) {
    cookie = await refreshQbitCookie(url, password)
    headers = { Cookie: cookie }
    torrentsRes = await fetch(`${url}/api/v2/torrents/info?filter=all`, { headers, signal: AbortSignal.timeout(8000) })
  }
  const torrents = await torrentsRes.json()

  const [speedLimitModeText] = await Promise.all([
    fetch(`${url}/api/v2/transfer/speedLimitsMode`, { headers, signal: AbortSignal.timeout(5000) }).then((r) => r.text()),
  ])

  const queue = []
  const completed = []
  const now = Date.now()
  for (const t of Array.isArray(torrents) ? torrents : []) {
    const item = {
      id: t.hash,
      client,
      name: t.name,
      category: t.category || '',
      size: t.size || 0,
      downloaded: t.downloaded || 0,
      progress: t.progress || 0,
      dlSpeed: t.dlspeed || 0,
      upSpeed: t.upspeed || 0,
      eta: t.eta ?? -1,
      status: mapQbitState(t.state),
      rawState: t.state,
      canDeleteFiles: true,
      // Nobody is sharing it; the dead-torrent sweep will replace it (main qBit only).
      dead: client === 'qbittorrent' ? deadReason(t, now) : null,
    }
    if (isQbitCompleted(t.state)) completed.push(item)
    else queue.push(item)
  }

  return { queue, completed, speedLimitMode: parseInt(speedLimitModeText) || 0 }
}

// Lidarr is still on the v1 API; Sonarr and Radarr are v3.
const arrApi = (service) => (service === 'lidarr' ? 'v1' : 'v3')

const HASH = /^[0-9a-f]{40}$/i

// The release name the *arr grabbed, from its history. Release names never
// change, so each one is looked up once and remembered.
const releaseNames = new Map() // hash → name
async function releaseName({ title, service, url, apiKey, downloadId }) {
  if (title) return title
  const hash = downloadId.toLowerCase()
  if (releaseNames.has(hash)) return releaseNames.get(hash)
  try {
    const res = await fetch(`${url}/api/${arrApi(service)}/history?page=1&pageSize=5&downloadId=${encodeURIComponent(downloadId)}`, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const json = await res.json()
    const name = (json.records ?? []).map((r) => r.sourceTitle).find((t) => t && !HASH.test(t)) ?? null
    if (name) releaseNames.set(hash, name)
    if (releaseNames.size > 2000) releaseNames.delete(releaseNames.keys().next().value)
    return name
  } catch {
    return null
  }
}

// The qBittorrent categories an arr files its downloads under (e.g. 'tv-sonarr').
// The auto-delete sweep only touches these: anything else in qBittorrent —
// Listenarr's 'audiobooks', hand-added torrents — isn't the arrs' to clean up,
// and "not in any arr queue" says nothing about whether it's still needed.
async function getArrQbitCategories(url, apiKey, service) {
  try {
    const res = await fetch(`${url}/api/${arrApi(service)}/downloadclient`, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, categories: [] }
    const clients = await res.json()
    const categories = (Array.isArray(clients) ? clients : [])
      .filter((c) => c.implementation === 'QBittorrent' && c.enable !== false)
      .flatMap((c) => (c.fields || []).filter((f) => /^(tv|movie|music)Category$/.test(f.name)).map((f) => f.value))
      .filter(Boolean)
    return { ok: true, categories }
  } catch {
    return { ok: false, categories: [] }
  }
}

async function getArrQueue(url, apiKey, service) {
  try {
    const include = {
      sonarr: 'includeSeries=true&includeEpisode=true',
      radarr: 'includeMovie=true',
      // No includeAlbum: album objects make a large Lidarr queue several MB per poll.
      lidarr: 'includeArtist=true',
    }[service]
    // The whole queue, not just a first page — allHashes below is what stops the
    // client's auto-delete sweep removing a torrent that is still waiting on import.
    const endpoint = `${url}/api/${arrApi(service)}/queue?pageSize=1000&${include}`
    const res = await fetch(endpoint, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, importing: [], allHashes: new Set() }
    const json = await res.json()
    const records = json.records ?? json ?? []

    // Collect every download ID in the queue (all states) so the client can
    // identify which seeding torrents Sonarr/Radarr is still tracking.
    const allHashes = new Set(records.map((r) => r.downloadId).filter(Boolean))

    // Release titles by hash: a magnet that hasn't fetched its metadata yet is
    // named only by its hash in qBittorrent, and the *arr's queue copies that
    // name, so the queue title is only kept when it's a real one.
    const titles = {}
    for (const r of records) if (r.downloadId) titles[String(r.downloadId).toLowerCase()] = { title: HASH.test(r.title || '') ? null : r.title, service, url, apiKey, downloadId: r.downloadId }

    const blockedRecords = records.filter((r) => {
      const state = r.trackedDownloadState
      // importBlocked = finished downloading but Radarr/Sonarr can't auto-import
      // (e.g. ambiguous release match) — needs the same visibility as active imports.
      return state === 'importPending' || state === 'importing' || state === 'importBlocked'
    })

    // A season-pack file gets one Sonarr queue record PER EPISODE even though it's
    // one download — group by downloadId so the UI shows one row, not a dozen.
    const groups = new Map() // downloadId (or record id if none) -> records[]
    for (const r of blockedRecords) {
      const key = r.downloadId || `solo-${r.id}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(r)
    }

    const importing = Array.from(groups.values()).map((group) => {
      const r = group[0]
      let title = r.title || 'Unknown'
      let mediaTitle = null
      if (service === 'sonarr') {
        mediaTitle = r.series?.title || null
        if (group.length > 1) {
          const eps = group
            .map((g) => g.episode)
            .filter(Boolean)
            .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
          const seasons = [...new Set(eps.map((e) => e.seasonNumber))]
          title = seasons.length === 1
            ? `Season ${seasons[0]} (${group.length} episodes)`
            : `${group.length} episodes across ${seasons.length} seasons`
        } else if (r.episode) {
          const code = `S${String(r.episode.seasonNumber).padStart(2, '0')}E${String(r.episode.episodeNumber).padStart(2, '0')}`
          title = r.episode.title ? `${code} – ${r.episode.title}` : code
        }
      } else if (service === 'lidarr') {
        mediaTitle = r.artist?.artistName || null
      } else {
        mediaTitle = r.movie?.title || r.title || null
        title = mediaTitle || title
      }
      return {
        id: String(r.id),
        groupIds: group.map((g) => String(g.id)), // all underlying queue record ids (for Clear)
        service,
        mediaTitle,
        title,
        state: r.trackedDownloadState,   // 'importPending' | 'importing' | 'importBlocked'
        downloadClient: r.downloadClient || null,
        downloadId: r.downloadId || null, // torrent hash for qBittorrent
        protocol: r.protocol || null,    // 'torrent' | 'usenet'
        size: r.size || 0,
        statusMessages: (r.statusMessages || []).flatMap((s) => s.messages || []),
      }
    })

    return { ok: true, importing, allHashes, titles }
  } catch {
    return { ok: false, importing: [], allHashes: new Set() }
  }
}

async function getNzbData(url, userpass, client) {
  const [groups, history, status] = await Promise.all([
    nzbRpc(url, userpass, 'listgroups', [0]),
    nzbRpc(url, userpass, 'history', [false]),
    nzbRpc(url, userpass, 'status', []),
  ])

  // NZBGet listgroups does NOT include per-group DownloadRate.
  // The total system download rate (bytes/sec) is in status.DownloadRate.
  // Assign it to the first actively DOWNLOADING group; others get 0.
  const totalDlRate = status?.DownloadRate ?? 0
  let rateAssigned = false

  const queue = (groups || []).map((g) => {
    const sizeMB = g.FileSizeMB || 0
    const remainMB = g.RemainingSizeMB || 0
    const dlMB = sizeMB - remainMB
    const remainBytes = mbToBytes(remainMB)

    const isDownloading = g.Status === 'DOWNLOADING'
    let dlRate = 0
    if (isDownloading && !rateAssigned) {
      dlRate = totalDlRate
      rateAssigned = true
    }

    const eta = dlRate > 0 ? Math.round(remainBytes / dlRate) : -1
    return {
      id: String(g.NZBID),
      client,
      name: g.NZBName,
      category: g.Category || '',
      size: mbToBytes(sizeMB),
      downloaded: mbToBytes(dlMB),
      progress: sizeMB > 0 ? dlMB / sizeMB : 0,
      dlSpeed: dlRate,
      upSpeed: 0,
      eta,
      status: mapNzbStatus(g.Status),
      rawState: g.Status,
      canDeleteFiles: false,
    }
  })

  const completed = (history || []).slice(0, 100).map((h) => ({
    id: String(h.NZBID),
    client,
    name: h.NZBName,
    category: h.Category || '',
    size: mbToBytes(h.FileSizeMB || 0),
    downloaded: mbToBytes(h.FileSizeMB || 0),
    progress: 1,
    dlSpeed: 0,
    upSpeed: 0,
    eta: 0,
    status: (h.Status || '').toLowerCase(),
    rawState: h.Status,
    canDeleteFiles: false,
  }))

  return { queue, completed, speedLimit: status?.DownloadLimit ?? 0 }
}

export default async function downloadsRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async () => {
    const config = await getConfig()
    const svcs = config.services
    const on = (name) => svcs[name]?.enabled
    const at = (name) => ({ url: svcs[name].url.replace(/\/$/, ''), key: svcs[name].apiKey })

    const ARRS = ['sonarr', 'radarr', 'lidarr']
    const arrQueue = (name) => on(name)
      ? getArrQueue(at(name).url, at(name).key, name)
      : Promise.resolve({ ok: true, importing: [], allHashes: new Set() })
    const arrCats = (name) => on(name)
      ? getArrQbitCategories(at(name).url, at(name).key, name)
      : Promise.resolve({ ok: true, categories: [] })

    const settled = await Promise.allSettled([
      ...QBIT_CLIENTS.map((c) => (on(c) ? getQbitData(at(c).url, at(c).key, c) : Promise.resolve(null))),
      ...NZB_CLIENTS.map((c) => (on(c) ? getNzbData(at(c).url, at(c).key, c) : Promise.resolve(null))),
      ...ARRS.map(arrQueue),
      ...ARRS.map(arrCats),
    ])
    const take = (n) => settled.splice(0, n)
    const qbitResults = take(QBIT_CLIENTS.length)
    const nzbResults = take(NZB_CLIENTS.length)
    const arrQueueResults = take(ARRS.length)
    const arrCatResults = take(ARRS.length)

    const value = (r) => (r.status === 'fulfilled' ? r.value : null)
    const qbits = qbitResults.map(value)
    const nzbs = nzbResults.map(value)
    const arrs = arrQueueResults.map((r) => value(r) ?? { ok: false, importing: [], allHashes: new Set() })
    const cats = arrCatResults.map((r) => value(r) ?? { ok: false, categories: [] })
    const importing = arrs.flatMap((a) => a.importing)
    // Union of all download IDs currently tracked by Sonarr+Radarr+Lidarr (any state).
    // Used by the client to identify seeding torrents that have already been imported.
    const arrQueueHashes = arrs.flatMap((a) => [...a.allHashes])
    const arrTitles = Object.assign({}, ...arrs.map((a) => a.titles || {}))
    const unnamed = qbits.flatMap((q) => q?.queue || []).filter((item) => HASH.test(item.name) && arrTitles[item.name.toLowerCase()])
    await Promise.all(unnamed.map(async (item) => {
      const name = await releaseName(arrTitles[item.name.toLowerCase()])
      if (name) item.name = name
    }))

    const limits = {}
    const errors = {}
    QBIT_CLIENTS.forEach((c, i) => {
      limits[c] = on(c) ? { speedLimitMode: qbits[i]?.speedLimitMode ?? 0 } : null
      errors[c] = qbitResults[i].status === 'rejected' ? qbitResults[i].reason?.message : null
    })
    NZB_CLIENTS.forEach((c, i) => {
      limits[c] = on(c) ? { speedLimit: nzbs[i]?.speedLimit ?? 0 } : null
      errors[c] = nzbResults[i].status === 'rejected' ? nzbResults[i].reason?.message : null
    })

    return {
      queue: [
        ...qbits.flatMap((q) => q?.queue || []),
        ...nzbs.flatMap((n) => n?.queue || []),
      ].sort((a, b) => b.dlSpeed - a.dlSpeed),
      completed: [
        ...qbits.flatMap((q) => q?.completed || []),
        ...nzbs.flatMap((n) => n?.completed || []),
      ],
      importing,
      arrQueueHashes,
      // Categories the arrs use in qBittorrent; the sweep deletes nothing outside them.
      arrCategories: [...new Set(cats.flatMap((c) => c.categories))],
      // False when an enabled arr's queue or download-client list couldn't be
      // read, i.e. the sweep would be working from incomplete information.
      arrQueueOk: arrs.every((a) => a.ok) && cats.every((c) => c.ok),
      replaceDeadTorrents: config.replaceDeadTorrents !== false,
      limits,
      errors,
    }
  })

  for (const client of QBIT_CLIENTS) fastify.post(`/${client}/action`, async (request, reply) => {
    const config = await getConfig()
    const svc = config.services[client]
    if (!svc?.enabled) return reply.status(400).send({ error: `${client} not enabled` })

    const { hash, action, deleteFiles = false } = request.body
    if (!hash || !action) return reply.status(400).send({ error: 'hash and action required' })

    const url = svc.url.replace(/\/$/, '')
    try {
      const cookie = await getQbitSid(url, svc.apiKey)

      const endpoints = {
        pause:  { path: '/api/v2/torrents/pause',  body: `hashes=${hash}` },
        resume: { path: '/api/v2/torrents/resume', body: `hashes=${hash}` },
        delete: { path: '/api/v2/torrents/delete', body: `hashes=${hash}&deleteFiles=${deleteFiles}` },
      }
      const ep = endpoints[action]
      if (!ep) return reply.status(400).send({ error: `Unknown action: ${action}` })

      const res = await fetch(`${url}${ep.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: ep.body,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return reply.status(502).send({ ok: false, error: `HTTP ${res.status}` })
      return { ok: true }
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err.message })
    }
  })

  for (const client of NZB_CLIENTS) fastify.post(`/${client}/action`, async (request, reply) => {
    const config = await getConfig()
    const svc = config.services[client]
    if (!svc?.enabled) return reply.status(400).send({ error: `${client} not enabled` })

    const { id, action } = request.body
    if (!id || !action) return reply.status(400).send({ error: 'id and action required' })

    const nzbActions = { pause: 'GroupPause', resume: 'GroupResume', delete: 'GroupDelete' }
    const nzbAction = nzbActions[action]
    if (!nzbAction) return reply.status(400).send({ error: `Unknown action: ${action}` })

    try {
      const url = svc.url.replace(/\/$/, '')
      await nzbRpc(url, svc.apiKey, 'editqueue', [nzbAction, '', [parseInt(id)]])
      return { ok: true }
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err.message })
    }
  })

  for (const client of QBIT_CLIENTS) fastify.post(`/${client}/toggle-limit`, async (request, reply) => {
    const config = await getConfig()
    const svc = config.services[client]
    if (!svc?.enabled) return reply.status(400).send({ error: `${client} not enabled` })

    try {
      const url = svc.url.replace(/\/$/, '')
      const cookie = await getQbitSid(url, svc.apiKey)
      const res = await fetch(`${url}/api/v2/transfer/toggleSpeedLimitsMode`, {
        method: 'POST',
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return reply.status(502).send({ ok: false, error: `HTTP ${res.status}` })
      return { ok: true }
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err.message })
    }
  })

  fastify.post('/clear-import', async (request, reply) => {
    const config = await getConfig()
    const { service, id, ids, removeFromClient = true } = request.body
    // A season-pack item groups multiple Sonarr queue records under one download —
    // `ids` clears all of them; `id` alone still works for a single-record item.
    const targetIds = Array.isArray(ids) && ids.length > 0 ? ids : (id ? [id] : [])
    if (!service || targetIds.length === 0) return reply.status(400).send({ error: 'service and id/ids required' })

    const svc = config.services[service]
    if (!svc?.enabled) return reply.status(400).send({ error: `${service} not enabled` })

    const url = svc.url.replace(/\/$/, '')
    try {
      // Only the first delete needs to touch the download client — later ones
      // for the same downloadId would just fail against an already-removed item.
      for (let i = 0; i < targetIds.length; i++) {
        const params = new URLSearchParams({
          removeFromClient: String(i === 0 ? removeFromClient : false),
          blocklist: 'false',
          skipRedownload: 'true',
        })
        const res = await fetch(`${url}/api/${arrApi(service)}/queue/${targetIds[i]}?${params}`, {
          method: 'DELETE',
          headers: { 'X-Api-Key': svc.apiKey },
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok && res.status !== 404) return reply.status(502).send({ ok: false, error: `HTTP ${res.status}` })
      }
      return { ok: true }
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err.message })
    }
  })

  // List candidate files Radarr/Sonarr found for a stuck (importBlocked) download,
  // so the user can confirm the match instead of switching to the arr's own UI.
  // Releases removed for containing programs or archives, newest first.
  fastify.get('/bad-files', async () => badFileLog())

  fastify.get('/manual-import', async (request, reply) => {
    const config = await getConfig()
    const { service, downloadId } = request.query
    if (!service || !downloadId) return reply.status(400).send({ error: 'service and downloadId required' })

    const svc = config.services[service]
    if (!svc?.enabled) return reply.status(400).send({ error: `${service} not enabled` })

    try {
      const url = svc.url.replace(/\/$/, '')
      const res = await fetch(
        `${url}/api/v3/manualimport?downloadId=${encodeURIComponent(downloadId)}&filterExistingFiles=true`,
        { headers: { 'X-Api-Key': svc.apiKey }, signal: AbortSignal.timeout(10000) }
      )
      if (!res.ok) return reply.status(502).send({ error: `HTTP ${res.status}` })
      const data = await res.json()

      const files = (Array.isArray(data) ? data : []).map((f) => ({
        id: f.id,
        path: f.path,
        name: f.name,
        size: f.size || 0,
        quality: f.quality,
        qualityName: f.quality?.quality?.name || 'Unknown',
        releaseGroup: f.releaseGroup || null,
        languages: f.languages || [],
        indexerFlags: f.indexerFlags || 0,
        downloadId: f.downloadId || downloadId,
        rejections: (f.rejections || []).map((r) => r.reason || String(r)),
        movieId: f.movie?.id ?? null,
        movieTitle: f.movie?.title ?? null,
        seriesId: f.series?.id ?? null,
        seriesTitle: f.series?.title ?? null,
        episodeIds: (f.episodes || []).map((e) => e.id),
        episodeLabels: (f.episodes || []).map(
          (e) => `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`
        ),
      }))
      return { files }
    } catch (err) {
      return reply.status(502).send({ error: err.message })
    }
  })

  // Submit the confirmed file → movie/episode matches back to Radarr/Sonarr.
  fastify.post('/manual-import', async (request, reply) => {
    const config = await getConfig()
    const { service, files } = request.body ?? {}
    if (!service || !Array.isArray(files) || files.length === 0)
      return reply.status(400).send({ error: 'service and files required' })

    const svc = config.services[service]
    if (!svc?.enabled) return reply.status(400).send({ error: `${service} not enabled` })

    const payloadFiles = files.map((f) => {
      const base = {
        path: f.path,
        quality: f.quality,
        releaseGroup: f.releaseGroup,
        languages: f.languages,
        indexerFlags: f.indexerFlags,
        downloadId: f.downloadId,
      }
      if (service === 'radarr') base.movieId = f.movieId
      else { base.seriesId = f.seriesId; base.episodeIds = f.episodeIds }
      return base
    })

    try {
      const url = svc.url.replace(/\/$/, '')
      const res = await fetch(`${url}/api/v3/command`, {
        method: 'POST',
        headers: { 'X-Api-Key': svc.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ManualImport', files: payloadFiles, importMode: 'auto' }),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return reply.status(502).send({ ok: false, error: `HTTP ${res.status}` })
      return { ok: true }
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err.message })
    }
  })

  for (const client of NZB_CLIENTS) fastify.post(`/${client}/set-limit`, async (request, reply) => {
    const config = await getConfig()
    const svc = config.services[client]
    if (!svc?.enabled) return reply.status(400).send({ error: `${client} not enabled` })

    const { limit } = request.body
    try {
      const url = svc.url.replace(/\/$/, '')
      await nzbRpc(url, svc.apiKey, 'rate', [parseInt(limit) || 0])
      return { ok: true }
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err.message })
    }
  })
}
