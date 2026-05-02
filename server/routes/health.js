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

    // Prowlarr: temporarily disabled indexers
    let indexerStatus = []
    if (on('prowlarr')) {
      const data = await safeFetch(baseUrl('prowlarr') + '/api/v1/indexerstatus', apiKey('prowlarr'))
      if (Array.isArray(data)) indexerStatus = data
    }

    return { alerts, indexerStatus }
  })
}
