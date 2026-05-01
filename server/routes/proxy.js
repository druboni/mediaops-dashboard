import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

const AUTH_HEADER = {
  sonarr:    (key) => ({ 'X-Api-Key': key }),
  radarr:    (key) => ({ 'X-Api-Key': key }),
  lidarr:    (key) => ({ 'X-Api-Key': key }),
  bazarr:    (key) => ({ 'X-Api-Key': key }),
  prowlarr:  (key) => ({ 'X-Api-Key': key }),
  overseerr: (key) => ({ 'X-Api-Key': key }),
  jackett:   (key) => ({ 'X-Api-Key': key }),
  huntarr:   (key) => ({ 'X-Api-Key': key }),
  plex:      (key) => ({ 'X-Plex-Token': key }),
}

export default async function proxyRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.route({
    method: ['GET', 'POST', 'PUT', 'DELETE'],
    url: '/:service/*',
    handler: async (request, reply) => {
      const { service } = request.params
      const path = request.params['*']

      const config = await getConfig()
      const svc = config.services[service]
      if (!svc?.enabled) return reply.status(400).send({ error: `${service} is not enabled` })

      const authFn = AUTH_HEADER[service]
      if (!authFn) return reply.status(400).send({ error: `Unknown service: ${service}` })

      const baseUrl = svc.url.replace(/\/$/, '')
      const qs = Object.keys(request.query || {}).length
        ? '?' + new URLSearchParams(request.query).toString()
        : ''
      const targetUrl = `${baseUrl}/${path}${qs}`

      const options = {
        method: request.method,
        headers: { ...authFn(svc.apiKey), 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      }
      if ((request.method === 'POST' || request.method === 'PUT') && request.body != null) {
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
