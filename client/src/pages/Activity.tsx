import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

// ── Types ──────────────────────────────────────────────────────────────────

type Source = 'radarr' | 'sonarr' | 'lidarr'
type EventFilter = 'all' | 'grabbed' | 'imported' | 'failed' | 'deleted'
type SourceFilter = 'all' | Source

interface NormalizedRecord {
  key: string
  source: Source
  eventType: string
  date: string
  title: string
  subtitle?: string
  quality?: string
  sourceTitle: string
}

// Raw *arr history record shapes (minimal)
interface RawRecord {
  id: number
  eventType: string
  date: string
  sourceTitle: string
  quality?: { quality: { name: string } }
  // Radarr
  movie?: { title: string }
  // Sonarr
  series?: { title: string }
  episode?: { seasonNumber: number; episodeNumber: number; title: string }
  // Lidarr
  artist?: { artistName: string }
  album?: { title: string }
  track?: { title: string }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d ago`
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function normalizeEvent(source: Source, r: RawRecord): NormalizedRecord {
  let title = ''
  let subtitle: string | undefined
  if (source === 'radarr') {
    title = r.movie?.title ?? r.sourceTitle
  } else if (source === 'sonarr') {
    title = r.series?.title ?? r.sourceTitle
    if (r.episode) {
      subtitle = `S${String(r.episode.seasonNumber).padStart(2,'0')}E${String(r.episode.episodeNumber).padStart(2,'0')}${r.episode.title ? ` · ${r.episode.title}` : ''}`
    }
  } else {
    title = r.artist?.artistName ?? r.sourceTitle
    if (r.album) subtitle = r.album.title
  }
  return {
    key: `${source}-${r.id}`,
    source,
    eventType: r.eventType,
    date: r.date,
    title,
    subtitle,
    quality: r.quality?.quality?.name,
    sourceTitle: r.sourceTitle,
  }
}

const EVENT_META: Record<string, { label: string; color: string }> = {
  grabbed:                   { label: 'Grabbed',   color: 'bg-blue-900/60 text-blue-400' },
  downloadFolderImported:    { label: 'Imported',  color: 'bg-green-900/60 text-green-400' },
  downloadImported:          { label: 'Imported',  color: 'bg-green-900/60 text-green-400' },
  downloadFailed:            { label: 'Failed',    color: 'bg-red-900/60 text-red-400' },
  movieFileDeleted:          { label: 'Deleted',   color: 'bg-gray-800 text-gray-500' },
  episodeFileDeleted:        { label: 'Deleted',   color: 'bg-gray-800 text-gray-500' },
  trackFileDeleted:          { label: 'Deleted',   color: 'bg-gray-800 text-gray-500' },
  movieFileRenamed:          { label: 'Renamed',   color: 'bg-gray-800 text-gray-500' },
  episodeFileRenamed:        { label: 'Renamed',   color: 'bg-gray-800 text-gray-500' },
  trackFileRenamed:          { label: 'Renamed',   color: 'bg-gray-800 text-gray-500' },
  ignored:                   { label: 'Ignored',   color: 'bg-gray-800 text-gray-600' },
}

function eventMeta(eventType: string) {
  return EVENT_META[eventType] ?? { label: eventType, color: 'bg-gray-800 text-gray-500' }
}

const SOURCE_COLORS: Record<Source, string> = {
  radarr: 'bg-yellow-900/50 text-yellow-400',
  sonarr: 'bg-blue-900/50 text-blue-400',
  lidarr: 'bg-purple-900/50 text-purple-400',
}

function eventMatchesFilter(eventType: string, filter: EventFilter) {
  if (filter === 'all') return true
  if (filter === 'grabbed') return eventType === 'grabbed'
  if (filter === 'imported') return eventType === 'downloadFolderImported' || eventType === 'downloadImported'
  if (filter === 'failed') return eventType === 'downloadFailed'
  if (filter === 'deleted') return eventType.includes('Deleted') || eventType.includes('Renamed')
  return true
}

// ── Main Page ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 50

export default function Activity() {
  const { enabledServices } = useConfig()
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [eventFilter, setEventFilter] = useState<EventFilter>('all')

  const radarrEnabled = enabledServices.includes('radarr')
  const sonarrEnabled = enabledServices.includes('sonarr')
  const lidarrEnabled = enabledServices.includes('lidarr')

  const anyEnabled = radarrEnabled || sonarrEnabled || lidarrEnabled

  const { data: radarrHistory } = useQuery<{ records: RawRecord[] }>({
    queryKey: ['activity-radarr'],
    queryFn: async () => (await api.get('/proxy/radarr/api/v3/history', {
      params: { pageSize: PAGE_SIZE, sortKey: 'date', sortDirection: 'descending' },
    })).data,
    enabled: radarrEnabled,
    staleTime: 60_000,
  })

  const { data: sonarrHistory } = useQuery<{ records: RawRecord[] }>({
    queryKey: ['activity-sonarr'],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/history', {
      params: { pageSize: PAGE_SIZE, sortKey: 'date', sortDirection: 'descending' },
    })).data,
    enabled: sonarrEnabled,
    staleTime: 60_000,
  })

  const { data: lidarrHistory } = useQuery<{ records: RawRecord[] }>({
    queryKey: ['activity-lidarr'],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/history', {
      params: { pageSize: PAGE_SIZE, sortKey: 'date', sortDirection: 'descending' },
    })).data,
    enabled: lidarrEnabled,
    staleTime: 60_000,
  })

  const merged: NormalizedRecord[] = useMemo(() => {
    const all: NormalizedRecord[] = []
    radarrHistory?.records?.forEach((r) => all.push(normalizeEvent('radarr', r)))
    sonarrHistory?.records?.forEach((r) => all.push(normalizeEvent('sonarr', r)))
    lidarrHistory?.records?.forEach((r) => all.push(normalizeEvent('lidarr', r)))
    return all.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  }, [radarrHistory, sonarrHistory, lidarrHistory])

  const filtered = useMemo(() =>
    merged.filter((r) => {
      if (sourceFilter !== 'all' && r.source !== sourceFilter) return false
      if (!eventMatchesFilter(r.eventType, eventFilter)) return false
      return true
    }),
    [merged, sourceFilter, eventFilter]
  )

  const isLoading = !radarrHistory && !sonarrHistory && !lidarrHistory && anyEnabled

  if (!anyEnabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Activity</h1>
        <p className="text-gray-500">Enable Radarr, Sonarr, or Lidarr in Settings to see activity.</p>
      </div>
    )
  }

  const enabledSources: Source[] = [
    ...(radarrEnabled ? ['radarr' as Source] : []),
    ...(sonarrEnabled ? ['sonarr' as Source] : []),
    ...(lidarrEnabled ? ['lidarr' as Source] : []),
  ]

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Activity</h1>
          {!isLoading && <p className="text-xs text-gray-500 mt-0.5">{filtered.length} events</p>}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        {/* Source filter */}
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          <button
            onClick={() => setSourceFilter('all')}
            className={`px-3 py-1.5 transition-colors ${sourceFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'}`}
          >
            All
          </button>
          {enabledSources.map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              className={`px-3 py-1.5 capitalize transition-colors ${sourceFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'}`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Event filter */}
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          {(['all', 'grabbed', 'imported', 'failed', 'deleted'] as EventFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setEventFilter(f)}
              className={`px-3 py-1.5 capitalize transition-colors ${eventFilter === f ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(12)].map((_, i) => <div key={i} className="h-12 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-600 text-sm">No activity found</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Title</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Event</th>
                <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Quality</th>
                <th className="text-right px-4 py-2.5 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {filtered.map((r) => {
                const meta = eventMeta(r.eventType)
                return (
                  <tr key={r.key} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-start gap-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${SOURCE_COLORS[r.source]}`}>
                          {r.source.charAt(0).toUpperCase() + r.source.slice(1)}
                        </span>
                        <div className="min-w-0">
                          <p className="text-white text-sm truncate">{r.title}</p>
                          {r.subtitle && <p className="text-xs text-gray-500 truncate">{r.subtitle}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 hidden sm:table-cell">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${meta.color}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 hidden md:table-cell">
                      {r.quality ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-gray-600 tabular-nums whitespace-nowrap">
                      {timeAgo(r.date)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
