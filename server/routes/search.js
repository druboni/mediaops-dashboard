import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

const arrH = (key) => ({ 'X-Api-Key': key })

async function safeFetch(url, headers = {}, timeout = 6000) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
}

export default async function searchRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async (request, reply) => {
    const q = (request.query.q || '').trim()
    if (!q || q.length < 2) return reply.status(400).send({ error: 'Query too short' })

    const config = await getConfig()
    const svcs = config.services
    const on = (n) => svcs[n]?.enabled
    const at = (n) => ({ url: svcs[n].url.replace(/\/$/, ''), key: svcs[n].apiKey })

    const enc = encodeURIComponent(q)

    const [movies, shows, artists, requests] = await Promise.allSettled([
      on('radarr')
        ? safeFetch(`${at('radarr').url}/api/v3/movie/lookup?term=${enc}`, arrH(at('radarr').key))
        : [],
      on('sonarr')
        ? safeFetch(`${at('sonarr').url}/api/v3/series/lookup?term=${enc}`, arrH(at('sonarr').key))
        : [],
      on('lidarr')
        ? safeFetch(`${at('lidarr').url}/api/v1/artist/lookup?term=${enc}`, arrH(at('lidarr').key))
        : [],
      on('overseerr')
        ? safeFetch(`${at('overseerr').url}/api/v1/search?query=${enc}&page=1`, { 'X-Api-Key': at('overseerr').key })
        : { results: [] },
    ])

    const movRes = movies.status === 'fulfilled' ? movies.value : []
    const tvRes  = shows.status  === 'fulfilled' ? shows.value  : []
    const musRes = artists.status === 'fulfilled' ? artists.value : []
    const reqRes = requests.status === 'fulfilled' ? (requests.value?.results || []) : []

    return {
      movies: Array.isArray(movRes) ? movRes.slice(0, 8).map(m => ({
        id: m.tmdbId || m.id,
        tmdbId: m.tmdbId || null,
        title: m.title,
        year: m.year,
        overview: m.overview,
        poster: m.remotePoster || null,
        status: m.status,
        inLibrary: !!m.id && m.hasFile !== undefined,
        hasFile: m.hasFile,
        monitored: m.monitored,
      })) : [],

      shows: Array.isArray(tvRes) ? tvRes.slice(0, 8).map(s => ({
        id: s.tvdbId || s.id,
        tmdbId: s.tmdbId || null,
        title: s.title,
        year: s.year,
        overview: s.overview,
        poster: s.remotePoster || null,
        status: s.status,
        inLibrary: !!s.id && s.statistics !== undefined,
        seasons: s.statistics?.seasonCount,
        monitored: s.monitored,
      })) : [],

      artists: Array.isArray(musRes) ? musRes.slice(0, 8).map(a => ({
        id: a.foreignArtistId || a.id,
        title: a.artistName,
        overview: a.overview,
        poster: a.remotePoster || null,
        status: a.status,
        inLibrary: !!a.id && a.statistics !== undefined,
      })) : [],

      requests: Array.isArray(reqRes) ? reqRes.slice(0, 8).map(r => ({
        id: r.id,
        title: r.title || r.name,
        year: r.releaseDate ? new Date(r.releaseDate).getFullYear() : null,
        overview: r.overview,
        poster: r.posterPath ? `https://image.tmdb.org/t/p/w200${r.posterPath}` : null,
        type: r.mediaType,
        status: r.mediaInfo?.status,
      })) : [],
    }
  })
}
