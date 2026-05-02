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

      const t0 = Date.now()
      try {
        const res = await fetch(targetUrl, options)
        const ms = Date.now() - t0
        const ct = res.headers.get('content-type') || ''
        const responseData = ct.includes('application/json') ? await res.json() : await res.text()

        // Build a clean display path (strip auth query params)
        const displayQs = { ...(request.query || {}) }
        if (authQueryParam) delete displayQs[authQueryParam]
        const displayPath = `/${path}` + (Object.keys(displayQs).length ? '?' + new URLSearchParams(displayQs).toString() : '')

        // Build response summary
        let respSummary = ''
        if (Array.isArray(responseData)) {
          respSummary = ` [${responseData.length} items]`
        } else if (path.includes('command') && res.ok && responseData?.name) {
          respSummary = ` [${responseData.name}]`
        }

        const logData = { service, status: res.status, url: targetUrl, duration: ms }

        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.body) {
          const b = JSON.stringify(request.body)
          logData.body = b.length > 300 ? b.slice(0, 300) + '…' : b
        }

        if (path.includes('command') && res.ok && responseData && typeof responseData === 'object') {
          const r = Array.isArray(responseData) ? responseData[0] : responseData
          if (r?.name) logData.responseText = `id:${r.id} name:${r.name} status:${r.status ?? 'queued'}`
        } else if (!res.ok && responseData) {
          const errStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData)
          logData.responseText = errStr.slice(0, 300)
        } else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && res.ok && responseData && !Array.isArray(responseData)) {
          const s = typeof responseData === 'string' ? responseData : JSON.stringify(responseData)
          if (s.length < 300) logData.responseText = s
        }

        addLog(res.ok ? 'info' : 'warn',
          `[proxy:${service}] ${request.method} ${displayPath} → ${res.status}${respSummary} (${ms}ms)`,
          logData)
        reply.status(res.status)
        return reply.send(responseData)
      } catch (err) {
        const ms = Date.now() - t0
        addLog('error', `[proxy:${service}] ${request.method} /${path} → ${err.message} (${ms}ms)`, {
          service, error: err.message, url: targetUrl, duration: ms,
        })
        return reply.status(502).send({ error: err.message })
      }
    },
  })
}
