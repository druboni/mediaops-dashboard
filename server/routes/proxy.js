import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { addLog } from '../logBuffer.js'

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
const AUTH_QUERY = {
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
        const ct = res.headers.get('content-type') || ''
        const responseData = ct.includes('application/json') ? await res.json() : await res.text()

        const logData = { service, status: res.status, url: targetUrl }

        if (['POST', 'PUT', 'PATCH'].includes(request.method) && request.body) {
          const b = JSON.stringify(request.body)
          logData.body = b.length > 250 ? b.slice(0, 250) + '…' : b
        }

        if (path.includes('command') && res.ok && responseData && typeof responseData === 'object') {
          const r = Array.isArray(responseData) ? responseData[0] : responseData
          if (r?.name) logData.responseText = `id:${r.id} name:${r.name} status:${r.status ?? 'queued'}`
        } else if (!res.ok && responseData) {
          const errStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData)
          logData.responseText = errStr.slice(0, 200)
        }

        addLog(res.ok ? 'info' : 'warn', `[proxy:${service}] ${request.method} /${path} → ${res.status}`, logData)
        reply.status(res.status)
        return reply.send(responseData)
      } catch (err) {
        addLog('error', `[proxy:${service}] ${request.method} /${path} → ${err.message}`, {
          service, error: err.message, url: targetUrl,
        })
        return reply.status(502).send({ error: err.message })
      }
    },
  })
}
