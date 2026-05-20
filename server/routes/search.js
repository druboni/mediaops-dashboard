import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

const arrH = (key) => ({ 'X-Api-Key': key })

// Overseerr MediaStatus enum (numeric) → string
// 1=Unknown 2=Pending 3=Processing 4=PartiallyAvailable 5=Available
const SEERR_STATUS = { 1: 'unknown', 2: 'pending', 3: 'processing', 4: 'partially_available', 5: 'available' }
const seerrStr = (n) => SEERR_STATUS[n] ?? null

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

    // Build Overseerr status map keyed by tmdbId — use ALL results, not just the 8 we display.
    // Overseerr syncs directly with Plex so its status is the definitive source of truth.
    // Note: mediaInfo.status is a NUMBER (1-5), normalise to string with seerrStr().
    const seerrMap = new Map()
    for (const r of reqRes) {
      if (r.id && r.mediaInfo?.status) seerrMap.set(r.id, seerrStr(r.mediaInfo.status))
    }

    return {
      movies: Array.isArray(movRes) ? movRes.slice(0, 8).map(m => {
        const seerrStatus = seerrMap.get(m.tmdbId) ?? null
        const inPlex = m.hasFile === true || seerrStatus === 'available'
        return {
          id: m.tmdbId || m.id,
          tmdbId: m.tmdbId || null,
          title: m.title,
          year: m.year,
          overview: m.overview,
          poster: m.remotePoster || null,
          status: seerrStatus,   // use Overseerr status (pending/processing) over Radarr's "released" etc.
          inPlex,
          monitored: !!m.id && m.monitored === true && !inPlex,
        }
      }) : [],

      shows: Array.isArray(tvRes) ? tvRes.slice(0, 8).map(s => {
        const seerrStatus = seerrMap.get(s.tmdbId) ?? null
        const hasFiles = (s.statistics?.episodeFileCount ?? 0) > 0
        const inPlex = hasFiles || seerrStatus === 'available'
        const partialPlex = (hasFiles || seerrStatus === 'partially_available') &&
                            !inPlex &&
                            seerrStatus !== 'available'
        return {
          id: s.tvdbId || s.id,
          tmdbId: s.tmdbId || null,
          title: s.title,
          year: s.year,
          overview: s.overview,
          poster: s.remotePoster || null,
          status: seerrStatus,
          inPlex,
          partialPlex: hasFiles && seerrStatus !== 'available' &&
                       (s.statistics?.episodeFileCount ?? 0) < (s.statistics?.totalEpisodeCount ?? 1),
          monitored: !!s.id && s.monitored === true && !inPlex,
          seasons: s.statistics?.seasonCount,
        }
      }) : [],

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
        status: seerrStr(r.mediaInfo?.status),  // normalise number → string
      })) : [],
    }
  })
}
