import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { addLog } from '../logBuffer.js'

const TEST_ENDPOINT = {
  sonarr:    (url, key) => ({ url: `${url}/api/v3/system/status`, headers: { 'X-Api-Key': key } }),
  radarr:    (url, key) => ({ url: `${url}/api/v3/system/status`, headers: { 'X-Api-Key': key } }),
  lidarr:    (url, key) => ({ url: `${url}/api/v1/system/status`, headers: { 'X-Api-Key': key } }),
  bazarr:    (url, key) => ({ url: `${url}/api/system/status`,    headers: { 'X-Api-Key': key } }),
  prowlarr:  (url, key) => ({ url: `${url}/api/v1/system/status`, headers: { 'X-Api-Key': key } }),
  overseerr: (url, key) => ({ url: `${url}/api/v1/status`,        headers: { 'X-Api-Key': key } }),
  plex:      (url, key) => ({ url: `${url}/identity`,             headers: { 'X-Plex-Token': key } }),
  // torznab caps endpoint accepts apikey without requiring a session cookie
  jackett:   (url, key) => ({ url: `${url}/api/v2.0/indexers/all/results/torznab?apikey=${key}&t=caps`, headers: {} }),
  // qBittorrent requires a login POST — plain GET to any endpoint returns 403
  qbittorrent: (url, key) => {
    const sep = (key || '').indexOf(':')
    const username = sep > -1 ? key.slice(0, sep) : 'admin'
    const password = sep > -1 ? key.slice(sep + 1) : (key || '')
    return {
      url: `${url}/api/v2/auth/login`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      checkText: 'Ok.',
    }
  },
  nzbget: (url, key) => {
    const sep = (key || '').indexOf(':')
    const user = sep > -1 ? key.slice(0, sep) : 'nzbget'
    const pass = sep > -1 ? key.slice(sep + 1) : (key || '')
    const b64 = Buffer.from(`${user}:${pass}`).toString('base64')
    return {
      url: `${url}/jsonrpc`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${b64}` },
      body: JSON.stringify({ version: '1.1', method: 'status', params: [] }),
    }
  },
  huntarr:   (url, key) => ({ url: `${url}/api/v1/system/status`, headers: { 'X-Api-Key': key } }),
  requestrr: (url)      => ({ url: `${url}/`,                     headers: {} }),
  tautulli:  (url, key) => ({ url: `${url}/api/v2?apikey=${encodeURIComponent(key)}&cmd=get_server_info`, headers: {} }),
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
      const fetchOpts = {
        method: endpoint.method || 'GET',
        headers: endpoint.headers,
        signal: AbortSignal.timeout(5000),
      }
      if (endpoint.body != null) fetchOpts.body = endpoint.body
      addLog('info', `[test:${service}] ${fetchOpts.method} ${endpoint.url}`, {
        service,
        body: endpoint.body,
      })
      const response = await fetch(endpoint.url, fetchOpts)
      if (response.ok || response.status === 401) {
        if (response.status === 401) {
          addLog('error', `[test:${service}] 401 Unauthorized`, { service, status: 401 })
          return reply.status(502).send({ ok: false, error: 'Reachable but API key is invalid (401)' })
        }
        if (endpoint.checkText) {
          const text = await response.text()
          addLog(text.trim() === endpoint.checkText ? 'info' : 'error',
            `[test:${service}] ${response.status} response: "${text.trim()}"`,
            { service, status: response.status, responseText: text.trim() })
          if (text.trim() !== endpoint.checkText) {
            return reply.status(502).send({ ok: false, error: 'Auth failed — check credentials' })
          }
        } else {
          addLog('info', `[test:${service}] ${response.status} OK`, { service, status: response.status })
        }
        return { ok: true, status: response.status }
      }
      addLog('error', `[test:${service}] HTTP ${response.status}`, { service, status: response.status })
      return reply.status(502).send({ ok: false, error: `Service returned HTTP ${response.status}` })
    } catch (err) {
      addLog('error', `[test:${service}] ${err.message}`, { service, error: err.message })
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
