import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

const arrH = (key) => ({ 'X-Api-Key': key })

async function safeFetch(url, options = {}, timeout = 8000) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export default async function wantedRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async () => {
    const config = await getConfig()
    const { radarr, sonarr } = config.services

    const [moviesRes, episodesRes] = await Promise.allSettled([
      radarr?.enabled
        ? safeFetch(
            `${radarr.url.replace(/\/$/, '')}/api/v3/wanted/missing?pageSize=50&sortKey=releaseDate&sortDirection=descending`,
            { headers: arrH(radarr.apiKey) }
          )
        : Promise.resolve({ ok: true, data: { records: [] } }),
      sonarr?.enabled
        ? Promise.all([
            safeFetch(`${sonarr.url.replace(/\/$/, '')}/api/v3/wanted/missing?pageSize=50&sortKey=airDateUtc&sortDirection=descending`, { headers: arrH(sonarr.apiKey) }),
            safeFetch(`${sonarr.url.replace(/\/$/, '')}/api/v3/series`, { headers: arrH(sonarr.apiKey) }),
          ])
        : Promise.resolve([{ ok: true, data: { records: [] } }, { ok: true, data: [] }]),
    ])

    const movies = moviesRes.status === 'fulfilled' && moviesRes.value.ok
      ? (moviesRes.value.data.records || []).map((m) => ({
          id: m.id,
          tmdbId: m.tmdbId,
          title: m.title,
          year: m.year,
          monitored: m.monitored,
          releaseDate: m.digitalRelease || m.physicalRelease || m.inCinemas || null,
          poster: m.images?.find((i) => i.coverType === 'poster')?.remoteUrl || null,
        }))
      : []

    let episodes = []
    if (episodesRes.status === 'fulfilled') {
      const [wantedRes, seriesRes] = episodesRes.value
      const seriesMap = new Map(
        seriesRes.ok && Array.isArray(seriesRes.data)
          ? seriesRes.data.map((s) => [s.id, s.title])
          : []
      )
      if (wantedRes.ok) {
        episodes = (wantedRes.data.records || []).map((e) => ({
          id: e.id,
          seriesId: e.seriesId,
          seriesTitle: e.series?.title || seriesMap.get(e.seriesId) || 'Unknown',
          seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber,
          title: e.title,
          monitored: e.monitored,
          airDate: e.airDateUtc || null,
        }))
      }
    }

    return { movies, episodes }
  })

  fastify.post('/search/movie', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.radarr
    if (!svc?.enabled) return reply.status(400).send({ error: 'Radarr not enabled' })
    const { id } = request.body ?? {}
    if (!id) return reply.status(400).send({ error: 'id required' })
    const url = svc.url.replace(/\/$/, '')
    const res = await safeFetch(`${url}/api/v3/command`, {
      method: 'POST',
      headers: { ...arrH(svc.apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MoviesSearch', movieIds: [Number(id)] }),
    })
    return res.ok ? { ok: true } : reply.status(502).send({ error: res.error })
  })

  fastify.post('/search/episode', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.sonarr
    if (!svc?.enabled) return reply.status(400).send({ error: 'Sonarr not enabled' })
    const { id } = request.body ?? {}
    if (!id) return reply.status(400).send({ error: 'id required' })
    const url = svc.url.replace(/\/$/, '')
    const res = await safeFetch(`${url}/api/v3/command`, {
      method: 'POST',
      headers: { ...arrH(svc.apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'EpisodeSearch', episodeIds: [Number(id)] }),
    })
    return res.ok ? { ok: true } : reply.status(502).send({ error: res.error })
  })

  fastify.post('/search/series', async (request, reply) => {
    const config = await getConfig()
    const svc = config.services.sonarr
    if (!svc?.enabled) return reply.status(400).send({ error: 'Sonarr not enabled' })
    const { seriesId } = request.body ?? {}
    if (!seriesId) return reply.status(400).send({ error: 'seriesId required' })
    const url = svc.url.replace(/\/$/, '')
    const res = await safeFetch(`${url}/api/v3/command`, {
      method: 'POST',
      headers: { ...arrH(svc.apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SeriesSearch', seriesId: Number(seriesId) }),
    })
    return res.ok ? { ok: true } : reply.status(502).send({ error: res.error })
  })
}
