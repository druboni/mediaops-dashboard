import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

const TEST_ENDPOINT = {
  sonarr:      (url, key) => ({ url: `${url}/api/v3/system/status`, headers: { 'X-Api-Key': key } }),
  radarr:      (url, key) => ({ url: `${url}/api/v3/system/status`, headers: { 'X-Api-Key': key } }),
  lidarr:      (url, key) => ({ url: `${url}/api/v1/system/status`, headers: { 'X-Api-Key': key } }),
  bazarr:      (url, key) => ({ url: `${url}/api/system/status`,    headers: { 'X-Api-Key': key } }),
  prowlarr:    (url, key) => ({ url: `${url}/api/v1/system/status`, headers: { 'X-Api-Key': key } }),
  overseerr:   (url, key) => ({ url: `${url}/api/v1/status`,        headers: { 'X-Api-Key': key } }),
  jackett:     (url, key) => ({ url: `${url}/api/v2.0/indexers?apikey=${key}`, headers: {} }),
  plex:        (url, key) => ({ url: `${url}/identity`,             headers: { 'X-Plex-Token': key } }),
  qbittorrent: (url)      => ({ url: `${url}/api/v2/app/version`,   headers: {} }),
  nzbget:      (url)      => ({ url: `${url}/jsonrpc`,              headers: {} }),
  huntarr:     (url, key) => ({ url: `${url}/api/v1/system/status`, headers: { 'X-Api-Key': key } }),
  requestrr:   (url)      => ({ url: `${url}/`,                     headers: {} }),
}

export default async function servicesRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.post('/:service/test', async (request, reply) => {
    const { service } = request.params
    const { url, apiKey } = request.body

    if (!url) return reply.status(400).send({ error: 'URL is required' })

    const testFn = TEST_ENDPOINT[service]
    if (!testFn) return reply.status(400).send({ error: `Unknown service: ${service}` })

    const endpoint = testFn(url.replace(/\/$/, ''), apiKey || '')

    try {
      const response = await fetch(endpoint.url, {
        headers: endpoint.headers,
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok || response.status === 401) {
        // 401 means the service is reachable but the key is wrong
        if (response.status === 401) {
          return reply.status(502).send({ ok: false, error: 'Reachable but API key is invalid (401)' })
        }
        return { ok: true, status: response.status }
      }
      return reply.status(502).send({ ok: false, error: `Service returned HTTP ${response.status}` })
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err.message })
    }
  })

  fastify.post('/overseerr/requests/:id/approve', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.overseerr
    if (!svc?.enabled) return reply.status(400).send({ error: 'Overseerr not enabled' })

    try {
      const url = svc.url.replace(/\/$/, '')
      const res = await fetch(`${url}/api/v1/request/${request.params.id}/approve`, {
        method: 'POST',
        headers: { 'X-Api-Key': svc.apiKey },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return reply.status(502).send({ ok: false, error: `HTTP ${res.status}` })
      return { ok: true }
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err.message })
    }
  })

  fastify.post('/overseerr/requests/:id/decline', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.overseerr
    if (!svc?.enabled) return reply.status(400).send({ error: 'Overseerr not enabled' })

    try {
      const url = svc.url.replace(/\/$/, '')
      const res = await fetch(`${url}/api/v1/request/${request.params.id}/decline`, {
        method: 'POST',
        headers: { 'X-Api-Key': svc.apiKey },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return reply.status(502).send({ ok: false, error: `HTTP ${res.status}` })
      return { ok: true }
    } catch (err) {
      return reply.status(502).send({ ok: false, error: err.message })
    }
  })
}
