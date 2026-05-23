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
            `${sonarr.url.replace(/\/$/, '')}/api/v3/history?pageSize=${pageSize}&sortKey=date&sortDirection=descending`,
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

    items.sort((a, b) => new Date(b.date) - new Date(a.date))

    return { items: items.slice(0, 100) }
  })
}
