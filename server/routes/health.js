import { statfs } from 'fs/promises'
import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

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

    // Plex drive low-space alert: warning under 10% free, error under 5%
    try {
      const s = await statfs('/mnt/plex')
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

    // Prowlarr: temporarily disabled indexers
    let indexerStatus = []
    if (on('prowlarr')) {
      const data = await safeFetch(baseUrl('prowlarr') + '/api/v1/indexerstatus', apiKey('prowlarr'))
      if (Array.isArray(data)) indexerStatus = data
    }

    return { alerts, indexerStatus }
  })
}
