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
  // Thumbnail proxy — no JWT required because <img> tags can't send Authorization
  // headers. The Plex token is kept server-side so it's never exposed to the browser.
  fastify.get('/thumb', {
    config: { skipAuth: true },
    schema: { hide: true },
  }, async (request, reply) => {
    const { path: thumbPath } = request.query
    if (!thumbPath || !thumbPath.startsWith('/')) {
      return reply.status(400).send()
    }
    const config = await getConfig()
    const svc = config.services.plex
    if (!svc?.enabled) return reply.status(400).send()
    const url = `${svc.url.replace(/\/$/, '')}${thumbPath}?X-Plex-Token=${svc.apiKey}`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) return reply.status(res.status).send()
      reply.header('Content-Type', res.headers.get('content-type') || 'image/jpeg')
      reply.header('Cache-Control', 'public, max-age=86400')
      return reply.send(Buffer.from(await res.arrayBuffer()))
    } catch {
      return reply.status(502).send()
    }
  })

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

    // Fetch item counts for each library in parallel (sections API doesn't include counts)
    const countResults = await Promise.allSettled(
      sections.map((s) =>
        plexFetch(`${base}/library/sections/${s.key}/all?X-Plex-Container-Size=0&X-Plex-Container-Start=0`, svc.apiKey, 5000)
      )
    )

    return {
      libraries: sections.map((s, i) => {
        const cr = countResults[i]
        const count = cr.status === 'fulfilled' && cr.value.ok
          ? (cr.value.data?.MediaContainer?.totalSize ?? null)
          : null
        return {
          key: s.key,
          title: s.title,
          type: s.type,  // 'movie' | 'show' | 'artist'
          count,
          thumb: s.thumb ?? null,
        }
      }),
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
      thumb: m.thumb ? `/api/plex/thumb?path=${encodeURIComponent(m.thumb)}` : null,
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
