import { getConfig } from './config.js'

// The one route deliberately reachable without the dashboard's session.
//
// It backs the shareable read-only calendar page (/share/calendar/:secret),
// so someone you send the link to can see what's coming up without getting
// the dashboard itself. Two things keep that from becoming a hole:
//
// - It's gated by a random secret in the path, the same scheme the webhook
//   receivers use, and only answers while the share is switched on in
//   Settings. A wrong secret or a disabled share is a 404, not a 403, so a
//   near-miss reveals nothing.
// - It returns calendar-shaped data only, built server-side. It is never a
//   passthrough to the *arr APIs — opening /api/proxy to this link would hand
//   out delete/search/edit on Sonarr and Radarr along with it.

const arrH = (key) => ({ 'X-Api-Key': key })
const trim = (u) => String(u || '').replace(/\/$/, '')
const DAY = 86_400_000

// A month grid spans 42 days; this leaves slack for that without letting the
// endpoint be asked for years of releases at a time.
const MAX_RANGE_DAYS = 62
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function safeFetch(url, options = {}, timeout = 8000) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

const settled = (r) => (r.status === 'fulfilled' ? r.value : null)

export default async function publicCalendarRoutes(fastify) {
  // Deliberately no requireAuth hook — see the note at the top of the file.

  fastify.get('/:secret', async (request, reply) => {
    const config = await getConfig()
    const share = config.publicCalendar

    if (!share?.enabled || !share.secret || request.params.secret !== share.secret) {
      return reply.status(404).send({ error: 'Not found' })
    }

    const { start, end } = request.query ?? {}
    if (!DATE_RE.test(start ?? '') || !DATE_RE.test(end ?? '')) {
      return reply.status(400).send({ error: 'start and end are required as YYYY-MM-DD' })
    }
    const span = (Date.parse(end) - Date.parse(start)) / DAY
    if (!(span >= 0) || span > MAX_RANGE_DAYS) {
      return reply.status(400).send({ error: `Range must be between 0 and ${MAX_RANGE_DAYS} days` })
    }

    const { sonarr, radarr } = config.services
    const range = `start=${start}&end=${end}&unmonitored=false`

    const [episodesR, moviesR] = await Promise.allSettled([
      // includeSeries embeds each episode's show, so this is one call rather
      // than a calendar fetch plus a full series list on every page load.
      sonarr?.enabled
        ? safeFetch(`${trim(sonarr.url)}/api/v3/calendar?${range}&includeSeries=true`, { headers: arrH(sonarr.apiKey) })
        : Promise.resolve(null),
      radarr?.enabled
        ? safeFetch(`${trim(radarr.url)}/api/v3/calendar?${range}`, { headers: arrH(radarr.apiKey) })
        : Promise.resolve(null),
    ])

    const episodesRes = settled(episodesR)
    const moviesRes = settled(moviesR)

    // Only the fields the calendar draws. Everything else Sonarr and Radarr
    // return — file paths, ids, profiles, overviews — stays on the server.
    const episodes = episodesRes?.ok && Array.isArray(episodesRes.data)
      ? episodesRes.data
          .filter((e) => e.airDate)
          .map((e) => ({
            title: e.title ?? '',
            seasonNumber: e.seasonNumber ?? 0,
            episodeNumber: e.episodeNumber ?? 0,
            airDate: e.airDate,
            hasFile: !!e.hasFile,
            series: e.series ? { title: e.series.title ?? 'Unknown Series', network: e.series.network ?? undefined } : undefined,
          }))
      : []

    const movies = moviesRes?.ok && Array.isArray(moviesRes.data)
      ? moviesRes.data.map((m) => ({
          title: m.title ?? 'Unknown Movie',
          year: m.year ?? undefined,
          inCinemas: m.inCinemas ?? undefined,
          digitalRelease: m.digitalRelease ?? undefined,
          physicalRelease: m.physicalRelease ?? undefined,
          hasFile: !!m.hasFile,
        }))
      : []

    return {
      sonarr: !!sonarr?.enabled,
      radarr: !!radarr?.enabled,
      episodes,
      movies,
    }
  })
}
