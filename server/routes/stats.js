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

    const [homeStats, weekStats, monthStats, playsByDate, users] = await Promise.allSettled([
      safeFetch(`${base}&cmd=get_home_stats&time_range=${range}&stats_count=10`),
      safeFetch(`${base}&cmd=get_home_stats&time_range=7&stats_count=5`),
      safeFetch(`${base}&cmd=get_home_stats&time_range=30&stats_count=5`),
      safeFetch(`${base}&cmd=get_plays_by_date&time_range=${range}`),
      safeFetch(`${base}&cmd=get_users_table&length=10&order_column=last_seen&order_dir=desc`),
    ])

    const homeData  = homeStats.status  === 'fulfilled' && homeStats.value.ok  ? homeStats.value.data?.response?.data  ?? [] : []
    const weekData  = weekStats.status  === 'fulfilled' && weekStats.value.ok  ? weekStats.value.data?.response?.data  ?? [] : []
    const monthData = monthStats.status === 'fulfilled' && monthStats.value.ok ? monthStats.value.data?.response?.data ?? [] : []

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

    const findStat   = (data, id) => data.find((s) => s.stat_id === id)
    const mapStatRows = (stat) =>
      (stat?.rows ?? []).map((r) => ({
        title: r.title || r.grandparent_title || r.full_title || '—',
        year: r.year || null,
        plays: r.total_plays ?? r.plays ?? 0,
        users: r.users_watched || null,
        thumb: r.thumb || r.grandparent_thumb || null,
        mediaType: r.media_type || null,
      }))

    // Compute highlight (most watched content + top user) for a given time window
    const extractHighlight = (data) => {
      const movieRow = findStat(data, 'top_movies')?.rows?.[0]
      const tvRow    = findStat(data, 'top_tv')?.rows?.[0]
      const userRow  = findStat(data, 'top_users')?.rows?.[0]

      let topContent = null
      const mPlays = movieRow?.total_plays ?? 0
      const tPlays = tvRow?.total_plays    ?? 0
      if (movieRow || tvRow) {
        const r = (mPlays >= tPlays && movieRow) ? movieRow : (tvRow ?? movieRow)
        topContent = {
          title: r.title || r.grandparent_title || r.full_title || '—',
          year:  r.year || null,
          type:  (mPlays >= tPlays && movieRow) ? 'movie' : 'tv',
          plays: Math.max(mPlays, tPlays),
        }
      }

      const topUser = userRow ? {
        name:     userRow.friendly_name || userRow.username || 'Unknown',
        plays:    userRow.total_plays    ?? 0,
        duration: userRow.total_duration ?? 0,
      } : null

      return { topContent, topUser }
    }

    // Build plays-by-date chart data
    let chartDates = [], chartMovies = [], chartShows = [], chartMusic = []
    if (playsData) {
      chartDates  = playsData.categories ?? []
      const series = playsData.series ?? []
      chartMovies = series.find((s) => s.name === 'Movies')?.data ?? Array(chartDates.length).fill(0)
      chartShows  = series.find((s) => s.name === 'TV')?.data     ?? Array(chartDates.length).fill(0)
      chartMusic  = series.find((s) => s.name === 'Music')?.data  ?? Array(chartDates.length).fill(0)
    }

    return {
      available: true,
      range,
      highlights: { week: extractHighlight(weekData), month: extractHighlight(monthData) },
      topMovies:     mapStatRows(findStat(homeData, 'top_movies')),
      topShows:      mapStatRows(findStat(homeData, 'top_tv')),
      topMusic:      mapStatRows(findStat(homeData, 'top_music')),
      popularMovies: mapStatRows(findStat(homeData, 'popular_movies')),
      popularShows:  mapStatRows(findStat(homeData, 'popular_tv')),
      recentUsers:   usersData,
      chart: { dates: chartDates, movies: chartMovies, shows: chartShows, music: chartMusic },
    }
  })
}
