import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

async function plexFetch(url, token, timeout = 8000) {
  try {
    const res = await fetch(url, {
      headers: { 'X-Plex-Token': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export default async function plexRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  // List all libraries
  fastify.get('/libraries', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.plex
    if (!svc?.enabled) return reply.status(400).send({ error: 'Plex not enabled' })

    const base = svc.url.replace(/\/$/, '')
    const res = await plexFetch(`${base}/library/sections`, svc.apiKey)
    if (!res.ok) return reply.status(502).send({ error: res.error })

    const sections = res.data?.MediaContainer?.Directory ?? []
    return {
      libraries: sections.map((s) => ({
        key: s.key,
        title: s.title,
        type: s.type,  // 'movie' | 'show' | 'artist'
        count: s.leafCount ?? null,
        thumb: s.thumb ?? null,
      })),
    }
  })

  // Get items in a library (paginated)
  fastify.get('/library/:key', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.plex
    if (!svc?.enabled) return reply.status(400).send({ error: 'Plex not enabled' })

    const { key } = request.params
    const start = parseInt(request.query.start) || 0
    const size  = Math.min(parseInt(request.query.size) || 50, 100)
    const sort  = request.query.sort || 'titleSort'

    const base = svc.url.replace(/\/$/, '')
    const res = await plexFetch(
      `${base}/library/sections/${key}/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}&sort=${sort}`,
      svc.apiKey
    )
    if (!res.ok) return reply.status(502).send({ error: res.error })

    const mc = res.data?.MediaContainer ?? {}
    const items = (mc.Metadata ?? []).map((m) => ({
      key: m.key,
      ratingKey: m.ratingKey,
      title: m.title,
      year: m.year ?? null,
      type: m.type,  // 'movie' | 'show' | 'artist'
      thumb: m.thumb ? `${base}${m.thumb}?X-Plex-Token=${svc.apiKey}` : null,
      summary: m.summary ?? null,
      rating: m.rating ?? null,
      audienceRating: m.audienceRating ?? null,
      addedAt: m.addedAt ? new Date(m.addedAt * 1000).toISOString() : null,
      // For shows
      childCount: m.childCount ?? null,
      leafCount: m.leafCount ?? null,
      // For movies
      duration: m.duration ?? null,
      // Genres
      genres: (m.Genre ?? []).map((g) => g.tag).slice(0, 3),
    }))

    return {
      totalSize: mc.totalSize ?? mc.size ?? items.length,
      start,
      size: items.length,
      items,
    }
  })
}
