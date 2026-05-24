import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { addLog } from '../logBuffer.js'
import { getQbitSid } from '../qbitSession.js'

function mapQbitState(state) {
  switch (state) {
    case 'downloading': case 'forcedDL': return 'downloading'
    case 'stalledDL': return 'stalled'
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

const mbToBytes = (mb) => Math.round((mb || 0) * 1024 * 1024)

async function getQbitData(url, password) {
  const cookie = await getQbitSid(url, password)
  const headers = { Cookie: cookie }

  const [torrents, speedLimitModeText] = await Promise.all([
    fetch(`${url}/api/v2/torrents/info?filter=all`, { headers, signal: AbortSignal.timeout(8000) }).then((r) => r.json()),
    fetch(`${url}/api/v2/transfer/speedLimitsMode`, { headers, signal: AbortSignal.timeout(5000) }).then((r) => r.text()),
  ])

  const queue = []
  const completed = []
  for (const t of Array.isArray(torrents) ? torrents : []) {
    const item = {
      id: t.hash,
      client: 'qbittorrent',
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
    }
    if (isQbitCompleted(t.state)) completed.push(item)
    else queue.push(item)
  }

  return { queue, completed, speedLimitMode: parseInt(speedLimitModeText) || 0 }
}

async function getArrQueue(url, apiKey, service) {
  try {
    const endpoint = service === 'sonarr'
      ? `${url}/api/v3/queue?pageSize=100&includeSeries=true&includeEpisode=true`
      : `${url}/api/v3/queue?pageSize=100&includeMovie=true`
    const res = await fetch(endpoint, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { importing: [], allHashes: new Set() }
    const json = await res.json()
    const records = json.records ?? json ?? []

    // Collect every download ID in the queue (all states) so the client can
    // identify which seeding torrents Sonarr/Radarr is still tracking.
    const allHashes = new Set(records.map((r) => r.downloadId).filter(Boolean))

    const importing = records
      .filter((r) => {
        const state = r.trackedDownloadState
        return state === 'importPending' || state === 'importing'
      })
      .map((r) => {
        let title = r.title || 'Unknown'
        let mediaTitle = null
        if (service === 'sonarr') {
          const series = r.series?.title || null
          const ep = r.episode
          if (ep) {
            const code = `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`
            title = ep.title ? `${code} – ${ep.title}` : code
          }
          mediaTitle = series
        } else {
          mediaTitle = r.movie?.title || r.title || null
          title = mediaTitle || title
        }
        return {
          id: String(r.id),
          service,
          mediaTitle,
          title,
          state: r.trackedDownloadState,   // 'importPending' | 'importing'
          downloadClient: r.downloadClient || null,
          downloadId: r.downloadId || null, // torrent hash for qBittorrent
          protocol: r.protocol || null,    // 'torrent' | 'usenet'
          size: r.size || 0,
          statusMessages: (r.statusMessages || []).flatMap((s) => s.messages || []),
        }
      })

    return { importing, allHashes }
  } catch {
    return { importing: [], allHashes: new Set() }
  }
}

async function getNzbData(url, userpass) {
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
      client: 'nzbget',
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
    client: 'nzbget',
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

    const [qbitResult, nzbResult, sonarrQueue, radarrQueue] = await Promise.allSettled([
      on('qbittorrent') ? getQbitData(at('qbittorrent').url, at('qbittorrent').key) : Promise.resolve(null),
      on('nzbget') ? getNzbData(at('nzbget').url, at('nzbget').key) : Promise.resolve(null),
      on('sonarr') ? getArrQueue(at('sonarr').url, at('sonarr').key, 'sonarr') : Promise.resolve([]),
      on('radarr') ? getArrQueue(at('radarr').url, at('radarr').key, 'radarr') : Promise.resolve([]),
    ])

    const qbit = qbitResult.status === 'fulfilled' ? qbitResult.value : null
    const nzb = nzbResult.status === 'fulfilled' ? nzbResult.value : null
    const sonarr = sonarrQueue.status === 'fulfilled' ? sonarrQueue.value : { importing: [], allHashes: new Set() }
    const radarr = radarrQueue.status === 'fulfilled' ? radarrQueue.value : { importing: [], allHashes: new Set() }
    const importing = [...sonarr.importing, ...radarr.importing]
    // Union of all download IDs currently tracked by Sonarr+Radarr (any state).
    // Used by the client to identify seeding torrents that have already been imported.
    const arrQueueHashes = [...sonarr.allHashes, ...radarr.allHashes]

    return {
      queue: [
        ...(qbit?.queue || []),
        ...(nzb?.queue || []),
      ].sort((a, b) => b.dlSpeed - a.dlSpeed),
      completed: [
        ...(qbit?.completed || []),
        ...(nzb?.completed || []),
      ],
      importing,
      arrQueueHashes,
      limits: {
        qbittorrent: on('qbittorrent') ? { speedLimitMode: qbit?.speedLimitMode ?? 0 } : null,
        nzbget: on('nzbget') ? { speedLimit: nzb?.speedLimit ?? 0 } : null,
      },
      errors: {
        qbittorrent: qbitResult.status === 'rejected' ? qbitResult.reason?.message : null,
        nzbget: nzbResult.status === 'rejected' ? nzbResult.reason?.message : null,
      },
    }
  })

  fastify.post('/qbittorrent/action', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.qbittorrent
    if (!svc?.enabled) return reply.status(400).send({ error: 'qBittorrent not enabled' })

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

  fastify.post('/nzbget/action', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.nzbget
    if (!svc?.enabled) return reply.status(400).send({ error: 'NZBGet not enabled' })

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

  fastify.post('/qbittorrent/toggle-limit', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.qbittorrent
    if (!svc?.enabled) return reply.status(400).send({ error: 'qBittorrent not enabled' })

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

  fastify.post('/nzbget/set-limit', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.nzbget
    if (!svc?.enabled) return reply.status(400).send({ error: 'NZBGet not enabled' })

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
