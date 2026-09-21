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

// The title behind a tmdb id doesn't change, but this runs on every Requests
// page load and — since open issues were added to it — on every dashboard poll,
// which refetches every 10 seconds. Without a cache a handful of open issues
// means a steady stream of TMDB lookups through Overseerr forever.
const titleCache = new Map() // `${mediaType}-${tmdbId}` -> { title, originalTitle, at }
const TITLE_TTL = 24 * 60 * 60 * 1000
const TITLE_CACHE_MAX = 500

function cachedTitle(key) {
  const hit = titleCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > TITLE_TTL) {
    titleCache.delete(key)
    return null
  }
  return hit
}

function cacheTitle(key, value) {
  // Plain insertion-order eviction — this only ever holds short strings, and
  // the cap is about not growing without bound, not about hit rate.
  if (titleCache.size >= TITLE_CACHE_MAX) {
    titleCache.delete(titleCache.keys().next().value)
  }
  titleCache.set(key, { ...value, at: Date.now() })
}

export async function enrichWithTitles(svc, items) {
  const titleMap = {}
  const seen = new Set()
  const lookups = []

  for (const item of items) {
    if (!item.media?.tmdbId) continue
    const key = `${item.media.mediaType}-${item.media.tmdbId}`
    if (seen.has(key)) continue
    seen.add(key)

    const hit = cachedTitle(key)
    if (hit) titleMap[key] = { title: hit.title, originalTitle: hit.originalTitle }
    else lookups.push({ key, mediaType: item.media.mediaType, tmdbId: item.media.tmdbId })
  }

  await Promise.allSettled(
    lookups.map(async ({ key, mediaType, tmdbId }) => {
      try {
        const path = mediaType === 'movie' ? `api/v1/movie/${tmdbId}` : `api/v1/tv/${tmdbId}`
        const info = await callOverseerr(svc, path)
        const value = {
          title: mediaType === 'movie' ? (info.title ?? info.originalTitle) : (info.name ?? info.originalName),
          originalTitle: mediaType === 'movie' ? info.originalTitle : info.originalName,
        }
        // Only cache a real answer — a miss shouldn't be remembered for a day.
        if (value.title) cacheTitle(key, value)
        titleMap[key] = value
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

  fastify.post('/request', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services?.overseerr
    if (!svc?.enabled) return reply.status(400).send({ error: 'Overseerr not enabled' })

    const { mediaType, tmdbId, is4k = false } = request.body ?? {}
    if (!mediaType || !tmdbId) return reply.status(400).send({ error: 'mediaType and tmdbId required' })

    const payload = {
      mediaType,
      mediaId: Number(tmdbId),
      is4k: !!is4k,
      ...(mediaType === 'tv' ? { seasons: [] } : {}),
    }

    try {
      const baseUrl = svc.url.replace(/\/$/, '')
      const res = await fetch(`${baseUrl}/api/v1/request`, {
        method: 'POST',
        headers: { 'X-Api-Key': svc.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) return reply.status(res.status).send({ error: json.message || `Overseerr ${res.status}` })
      return { ok: true, request: json }
    } catch (err) {
      return reply.status(502).send({ error: err.message })
    }
  })
}
