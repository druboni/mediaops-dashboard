import { statfs } from 'fs/promises'
import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { missingDrives, driveSize, glancesDown } from '../driveWatch.js'
import { fetchArrQueue } from '../arrQueue.js'

// Optional — only relevant if you mount your media library volume into the
// container and want a low-disk-space alert. Defaults to /mnt/plex to match
// this project's own docker-compose.yml; set to whatever path you mount it
// at, or leave unmounted entirely (the check just silently skips).
const PLEX_MOUNT_PATH = process.env.PLEX_MOUNT_PATH || '/mnt/plex'

async function safeFetch(url, headers = {}, timeout = 8000) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

const ARR_HEALTH = [
  { name: 'sonarr',   path: '/api/v3/health' },
  { name: 'radarr',   path: '/api/v3/health' },
  { name: 'lidarr',   path: '/api/v1/health' },
  { name: 'prowlarr', path: '/api/v1/health' },
]

export default async function healthRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async () => {
    const config = await getConfig()
    const svcs = config.services
    const on = (n) => svcs[n]?.enabled
    const apiKey = (n) => ({ 'X-Api-Key': svcs[n].apiKey })
    const baseUrl = (n) => svcs[n].url.replace(/\/$/, '')

    const alerts = []

    // Health alerts from *arr services
    const results = await Promise.allSettled(
      ARR_HEALTH
        .filter(({ name }) => on(name))
        .map(async ({ name, path }) => ({
          name,
          data: await safeFetch(baseUrl(name) + path, apiKey(name)),
        }))
    )

    for (const r of results) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value?.data)) continue
      for (const item of r.value.data) {
        if (item.type === 'warning' || item.type === 'error') {
          alerts.push({ service: r.value.name, level: item.type, source: item.source, message: item.message })
        }
      }
    }

    // Drives that have disappeared from a monitored server (see driveWatch.js).
    const missing = missingDrives()
    for (const s of config.monitoredServers ?? []) {
      for (const d of missing[s.id] ?? []) {
        // No time in the text: it would be in the container's UTC, and a
        // changing message would undo a dismissal. The System page has it.
        alerts.push({
          service: 'storage', level: 'error', source: 'drive',
          message: `Drive missing on ${s.name}: ${d.label} (${d.mount}, ${driveSize(d.total)}). Details on the System page`,
        })
      }
    }

    // A server whose Glances stopped answering: no CPU/disk stats, and the drive
    // watch can't see its drives. Ten minutes (two drive checks) so a restart
    // doesn't raise it. No duration in the text, so a dismissal sticks.
    const down = glancesDown()
    for (const s of config.monitoredServers ?? []) {
      if (down[s.id] && Date.now() - down[s.id] >= 10 * 60_000) {
        alerts.push({
          service: 'system', level: 'warning', source: 'glances',
          message: `No stats from ${s.name}: Glances isn't answering at ${s.host}:${s.glancesPort || 61208}, so drive alerts for it are paused`,
        })
      }
    }

    // Plex drive low-space alert: warning under 10% free, error under 5%
    try {
      const s = await statfs(PLEX_MOUNT_PATH)
      const total = s.blocks * s.bsize
      const free = s.bavail * s.bsize
      if (total > 0) {
        const pctFree = (free / total) * 100
        const freeTB = (free / 1_099_511_627_776).toFixed(1)
        if (pctFree < 5) {
          alerts.push({ service: 'storage', level: 'error', source: 'disk', message: `Plex drive critically low: ${freeTB} TB free (${pctFree.toFixed(1)}%)` })
        } else if (pctFree < 10) {
          alerts.push({ service: 'storage', level: 'warning', source: 'disk', message: `Plex drive low on space: ${freeTB} TB free (${pctFree.toFixed(1)}%)` })
        }
      }
    } catch { /* drive not mounted in container — skip */ }

    // Blocked imports: Sonarr/Radarr grabbed a release but can't auto-import it
    // (e.g. ambiguous match) — these silently sit in the queue needing manual action.
    const blockedResults = await Promise.allSettled(
      ['sonarr', 'radarr']
        .filter((name) => on(name))
        .map(async (name) => {
          // Every page: blocked imports are finished downloads, which sort last.
          const include = name === 'sonarr' ? 'includeSeries=true&includeEpisode=true' : 'includeMovie=true'
          const records = await fetchArrQueue(baseUrl(name), 'v3', svcs[name].apiKey, `${include}&status=completed`, 8000).catch(() => [])
          // A season pack is one record per episode: one alert per download, not per episode.
          const seen = new Set()
          return { name, records: records.filter((r) => !r.downloadId || (!seen.has(r.downloadId) && seen.add(r.downloadId))) }
        })
    )
    for (const r of blockedResults) {
      if (r.status !== 'fulfilled') continue
      const { name, records } = r.value
      for (const rec of records) {
        if (rec.trackedDownloadState !== 'importBlocked') continue
        const title = name === 'sonarr'
          ? (rec.series?.title || rec.title || 'Unknown')
          : (rec.movie?.title || rec.title || 'Unknown')
        const reason = (rec.statusMessages || []).flatMap((s) => s.messages || [])[0] || 'Manual import required'
        alerts.push({ service: name, level: 'warning', source: 'import', message: `${title}: ${reason}` })
      }
    }

    // Listenarr has no health endpoint, so check what it would warn about:
    // root folders it can't use, and downloads that haven't finished in a day.
    // (Completed items stay in its queue while they seed; that's normal.)
    const LISTENARR = { listenarr: 'Listenarr', listenarrMam: 'Listenarr (MAM)' }
    const STALLED_MS = 24 * 3600_000
    await Promise.allSettled(Object.entries(LISTENARR).filter(([n]) => on(n)).map(async ([n, label]) => {
      const [folders, queue] = await Promise.all([
        safeFetch(baseUrl(n) + '/api/v1/rootfolders', apiKey(n)),
        safeFetch(baseUrl(n) + '/api/v1/download/queue', apiKey(n)),
      ])
      for (const f of Array.isArray(folders) ? folders : []) {
        if (f.storageState && f.storageState !== 'Healthy') {
          alerts.push({ service: n, level: 'warning', source: 'rootfolder', message: `${label}: root folder "${f.name}" (${f.path}) is ${f.storageState}${f.storageReason && f.storageReason !== 'None' ? ` (${f.storageReason})` : ''}` })
        }
      }
      for (const q of queue?.items ?? []) {
        // Finished torrents the client won't seed show as "queued" at 100%; not a problem.
        if (q.status === 'completed' || (q.progress ?? 0) >= 100) continue
        const added = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(q.addedAt ?? '') ? q.addedAt : `${q.addedAt}Z`)
        const failed = /fail|error|warning/i.test(q.status ?? '')
        if (!failed && !(Date.now() - added > STALLED_MS)) continue
        const days = Math.floor((Date.now() - added) / 86_400_000)
        alerts.push({
          service: n,
          level: failed ? 'error' : 'warning',
          source: 'queue',
          message: `${label}: "${q.title}" ${failed ? `download ${q.status}` : `still ${q.status} after ${days} day${days === 1 ? '' : 's'}`} (${q.downloadClient ?? 'download client'})`,
        })
      }
    }))

    // Prowlarr: temporarily disabled indexers
    let indexerStatus = []
    if (on('prowlarr')) {
      const data = await safeFetch(baseUrl('prowlarr') + '/api/v1/indexerstatus', apiKey('prowlarr'))
      if (Array.isArray(data)) indexerStatus = data
    }

    return { alerts, indexerStatus }
  })
}
