import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

async function callOverseerr(svc, path, params = {}) {
  const baseUrl = svc.url.replace(/\/$/, '')
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
  const res = await fetch(`${baseUrl}/${path}${qs}`, {
    headers: { 'X-Api-Key': svc.apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`Overseerr ${res.status}`)
  return res.json()
}

async function enrichWithTitles(svc, items) {
  const seen = new Set()
  const lookups = []
  for (const item of items) {
    if (!item.media?.tmdbId) continue
    const key = `${item.media.mediaType}-${item.media.tmdbId}`
    if (!seen.has(key)) {
      seen.add(key)
      lookups.push({ key, mediaType: item.media.mediaType, tmdbId: item.media.tmdbId })
    }
  }

  const titleMap = {}
  await Promise.allSettled(
    lookups.map(async ({ key, mediaType, tmdbId }) => {
      try {
        const path = mediaType === 'movie' ? `api/v1/movie/${tmdbId}` : `api/v1/tv/${tmdbId}`
        const info = await callOverseerr(svc, path)
        titleMap[key] = {
          title: mediaType === 'movie' ? (info.title ?? info.originalTitle) : (info.name ?? info.originalName),
          originalTitle: mediaType === 'movie' ? info.originalTitle : info.originalName,
        }
      } catch {
        // leave absent; frontend falls back to 'Unknown'
      }
    })
  )

  return items.map(item => ({
    ...item,
    media: {
      ...item.media,
      ...(titleMap[`${item.media?.mediaType}-${item.media?.tmdbId}`] ?? {}),
    },
  }))
}

export default async function overseerrRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/requests', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services?.overseerr
    if (!svc?.enabled) return reply.status(400).send({ error: 'Overseerr not enabled' })

    const { filter = 'all', take = 25, skip = 0, sort = 'added' } = request.query
    let data
    try {
      data = await callOverseerr(svc, 'api/v1/request', { filter, take, skip, sort })
    } catch (err) {
      return reply.status(502).send({ error: err.message })
    }

    const enriched = await enrichWithTitles(svc, data.results ?? [])
    return { ...data, results: enriched }
  })

  fastify.get('/issues', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services?.overseerr
    if (!svc?.enabled) return reply.status(400).send({ error: 'Overseerr not enabled' })

    const { take = 50, skip = 0, filter = 'open', sort = 'added' } = request.query
    let data
    try {
      data = await callOverseerr(svc, 'api/v1/issue', { take, skip, filter, sort })
    } catch (err) {
      return reply.status(502).send({ error: err.message })
    }

    const enriched = await enrichWithTitles(svc, data.results ?? [])
    return { ...data, results: enriched }
  })
}
