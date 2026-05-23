import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

async function safeFetch(url, timeout = 8000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return { ok: false }
    return { ok: true, data: await res.json() }
  } catch {
    return { ok: false }
  }
}

export default async function statsRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async (request) => {
    const config = await getConfig()
    const svc = config.services.tautulli
    if (!svc?.enabled) return { available: false }

    const base = `${svc.url.replace(/\/$/, '')}/api/v2?apikey=${encodeURIComponent(svc.apiKey)}`
    const range = parseInt(request.query.range) || 30

    const [homeStats, playsByDate, users] = await Promise.allSettled([
      safeFetch(`${base}&cmd=get_home_stats&time_range=${range}&stats_count=10`),
      safeFetch(`${base}&cmd=get_plays_by_date&time_range=${range}`),
      safeFetch(`${base}&cmd=get_users_table&length=10&order_column=last_seen&order_dir=desc`),
    ])

    const homeData = homeStats.status === 'fulfilled' && homeStats.value.ok
      ? homeStats.value.data?.response?.data ?? []
      : []

    const playsData = playsByDate.status === 'fulfilled' && playsByDate.value.ok
      ? playsByDate.value.data?.response?.data ?? null
      : null

    const usersData = users.status === 'fulfilled' && users.value.ok
      ? (users.value.data?.response?.data?.data ?? []).map((u) => ({
          userId: u.user_id,
          username: u.friendly_name || u.username,
          thumb: u.user_thumb || null,
          plays: u.plays,
          duration: u.duration,
          lastSeen: u.last_seen ? new Date(u.last_seen * 1000).toISOString() : null,
        }))
      : []

    // Parse home stats into structured sections
    const findStat = (id) => homeData.find((s) => s.stat_id === id)

    const mapStatRows = (stat) =>
      (stat?.rows ?? []).map((r) => ({
        title: r.title || r.grandparent_title || r.full_title || '—',
        year: r.year || null,
        plays: r.total_plays ?? r.plays ?? 0,
        users: r.users_watched ?? null,
        thumb: r.thumb || r.grandparent_thumb || null,
        mediaType: r.media_type || null,
      }))

    // Build plays-by-date chart data
    let chartDates = []
    let chartMovies = []
    let chartShows = []
    let chartMusic = []
    if (playsData) {
      chartDates = playsData.categories ?? []
      const series = playsData.series ?? []
      chartMovies = series.find((s) => s.name === 'Movies')?.data ?? Array(chartDates.length).fill(0)
      chartShows  = series.find((s) => s.name === 'TV')?.data    ?? Array(chartDates.length).fill(0)
      chartMusic  = series.find((s) => s.name === 'Music')?.data ?? Array(chartDates.length).fill(0)
    }

    return {
      available: true,
      range,
      topMovies:    mapStatRows(findStat('top_movies')),
      topShows:     mapStatRows(findStat('top_tv')),
      topMusic:     mapStatRows(findStat('top_music')),
      popularMovies: mapStatRows(findStat('popular_movies')),
      popularShows:  mapStatRows(findStat('popular_tv')),
      recentUsers:  usersData,
      chart: { dates: chartDates, movies: chartMovies, shows: chartShows, music: chartMusic },
    }
  })
}
