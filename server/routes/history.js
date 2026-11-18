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

const EVENT_LABELS = {
  grabbed:               'Grabbed',
  downloadFolderImported:'Imported',
  downloadFailed:        'Failed',
  movieFileDeleted:      'Deleted',
  episodeFileDeleted:    'Deleted',
  trackFileDeleted:      'Deleted',
  movieFileRenamed:      'Renamed',
}

// Listenarr event type -> the *arr one it corresponds to.
const LISTENARR_EVENTS = {
  Grabbed: 'grabbed',
  Imported: 'downloadFolderImported',
  DownloadFailed: 'downloadFailed',
  ImportFailed: 'downloadFailed',
  Failed: 'downloadFailed',
}

export default async function historyRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async (request) => {
    const config = await getConfig()
    const { radarr, sonarr, lidarr } = config.services
    const pageSize = parseInt(request.query.pageSize) || 50

    const [radarrRes, sonarrRes, lidarrRes] = await Promise.allSettled([
      radarr?.enabled
        ? safeFetch(
            `${radarr.url.replace(/\/$/, '')}/api/v3/history?pageSize=${pageSize}&sortKey=date&sortDirection=descending`,
            { headers: arrH(radarr.apiKey) }
          )
        : null,
      sonarr?.enabled
        ? safeFetch(
            `${sonarr.url.replace(/\/$/, '')}/api/v3/history?pageSize=${pageSize}&sortKey=date&sortDirection=descending&includeEpisode=true&includeSeries=true`,
            { headers: arrH(sonarr.apiKey) }
          )
        : null,
      lidarr?.enabled
        ? safeFetch(
            `${lidarr.url.replace(/\/$/, '')}/api/v1/history?pageSize=${pageSize}&sortKey=date&sortDirection=descending`,
            { headers: arrH(lidarr.apiKey) }
          )
        : null,
    ])

    const items = []

    if (radarrRes.status === 'fulfilled' && radarrRes.value?.ok) {
      for (const r of radarrRes.value.data.records || []) {
        items.push({
          id: `radarr-${r.id}`,
          service: 'radarr',
          type: 'movie',
          event: r.eventType,
          eventLabel: EVENT_LABELS[r.eventType] || r.eventType,
          title: r.movie?.title || r.sourceTitle || '—',
          year: r.movie?.year || null,
          quality: r.quality?.quality?.name || null,
          date: r.date,
          successful: r.eventType !== 'downloadFailed',
        })
      }
    }

    if (sonarrRes.status === 'fulfilled' && sonarrRes.value?.ok) {
      for (const r of sonarrRes.value.data.records || []) {
        const ep = r.episode
        const subtitle = ep
          ? `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')} – ${ep.title}`
          : null
        items.push({
          id: `sonarr-${r.id}`,
          service: 'sonarr',
          type: 'episode',
          event: r.eventType,
          eventLabel: EVENT_LABELS[r.eventType] || r.eventType,
          title: r.series?.title || r.sourceTitle || '—',
          subtitle,
          quality: r.quality?.quality?.name || null,
          date: r.date,
          successful: r.eventType !== 'downloadFailed',
        })
      }
    }

    if (lidarrRes.status === 'fulfilled' && lidarrRes.value?.ok) {
      for (const r of lidarrRes.value.data.records || []) {
        items.push({
          id: `lidarr-${r.id}`,
          service: 'lidarr',
          type: 'music',
          event: r.eventType,
          eventLabel: EVENT_LABELS[r.eventType] || r.eventType,
          title: r.artist?.artistName || r.sourceTitle || '—',
          subtitle: r.album?.title || null,
          quality: r.quality?.quality?.name || null,
          date: r.date,
          successful: r.eventType !== 'downloadFailed',
        })
      }
    }

    // Listenarr (both instances). Its history is mostly file/scan bookkeeping;
    // only the events that match the *arr ones are shown, under the same keys.
    const audiobookResults = await Promise.allSettled(
      ['listenarr', 'listenarrMam']
        .filter((n) => config.services[n]?.enabled)
        .map(async (n) => {
          const svc = config.services[n]
          const res = await safeFetch(`${svc.url.replace(/\/$/, '')}/api/v1/history?pageSize=${Math.max(pageSize, 200)}`, { headers: arrH(svc.apiKey) })
          return { n, records: res.ok ? res.data?.history ?? [] : [] }
        })
    )
    for (const r of audiobookResults) {
      if (r.status !== 'fulfilled') continue
      for (const h of r.value.records) {
        const event = LISTENARR_EVENTS[h.eventType]
        if (!event) continue
        items.push({
          id: `${r.value.n}-${h.id}`,
          service: r.value.n,
          type: 'audiobook',
          event,
          eventLabel: EVENT_LABELS[event],
          title: h.audiobookTitle || h.sourceTitle || '—',
          subtitle: r.value.n === 'listenarrMam' ? 'MAM' : null,
          quality: null,
          // Listenarr's timestamps are UTC without a zone.
          date: /[zZ]|[+-]\d\d:?\d\d$/.test(h.timestamp) ? h.timestamp : `${h.timestamp}Z`,
          successful: event !== 'downloadFailed' && h.outcome !== 'Failed',
        })
      }
    }

    items.sort((a, b) => new Date(b.date) - new Date(a.date))

    return { items: items.slice(0, 100) }
  })
}
