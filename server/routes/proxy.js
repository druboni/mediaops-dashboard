import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

const AUTH_HEADER = {
  sonarr:    (key) => ({ 'X-Api-Key': key }),
  radarr:    (key) => ({ 'X-Api-Key': key }),
  lidarr:    (key) => ({ 'X-Api-Key': key }),
  bazarr:    (key) => ({ 'X-Api-Key': key }),
  prowlarr:  (key) => ({ 'X-Api-Key': key }),
  overseerr: (key) => ({ 'X-Api-Key': key }),
  huntarr:   (key) => ({ 'X-Api-Key': key }),
  plex:      (key) => ({ 'X-Plex-Token': key }),
}

// Services that use a query param for auth instead of a header
const AUTH_QUERY: Record<string, string> = {
  jackett: 'apikey',
}

export default async function proxyRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/:service/*',
    handler: async (request, reply) => {
      const { service } = request.params
      const path = request.params['*']

      const config = await getConfig()
      const svc = config.services[service]
      if (!svc?.enabled) return reply.status(400).send({ error: `${service} is not enabled` })

      const authQueryParam = AUTH_QUERY[service]
      const authFn = AUTH_HEADER[service]
      if (!authFn && !authQueryParam) return reply.status(400).send({ error: `Unknown service: ${service}` })

      const baseUrl = svc.url.replace(/\/$/, '')
      const queryObj = { ...(request.query || {}) }
      if (authQueryParam) queryObj[authQueryParam] = svc.apiKey
      const qs = Object.keys(queryObj).length ? '?' + new URLSearchParams(queryObj).toString() : ''
      const targetUrl = `${baseUrl}/${path}${qs}`

      const authHeaders = authFn ? authFn(svc.apiKey) : {}
      const options = {
        method: request.method,
        headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      }
      if (['POST', 'PUT', 'PATCH'].includes(request.method) && request.body != null) {
        options.body = JSON.stringify(request.body)
      }

      try {
        const res = await fetch(targetUrl, options)
        reply.status(res.status)
        const ct = res.headers.get('content-type') || ''
        return reply.send(ct.includes('application/json') ? await res.json() : await res.text())
      } catch (err) {
        return reply.status(502).send({ error: err.message })
      }
    },
  })
}
