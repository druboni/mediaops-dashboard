import { useState, useMemo, Component } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

class CalendarErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null }
  static getDerivedStateFromError(err: Error) { return { error: err.message } }
  render() {
    if (this.state.error) {
      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold text-white mb-4">Calendar</h1>
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 text-sm font-mono">
            {this.state.error}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface SonarrEpisode {
  id: number
  title: string
  seasonNumber: number
  episodeNumber: number
  airDate: string
  hasFile: boolean
  series?: { id: number; title: string; network?: string }
  seriesTitle?: string
  overview?: string
}

interface RadarrMovie {
  id: number
  title: string
  year: number
  inCinemas?: string
  digitalRelease?: string
  physicalRelease?: string
  hasFile: boolean
  monitored: boolean
}

type CalendarRange = 7 | 14 | 30
type ReleaseType = 'Cinema' | 'Digital' | 'Physical'
type CalendarItem =
  | { kind: 'episode'; date: string; data: SonarrEpisode }
  | { kind: 'movie';   date: string; releaseType: ReleaseType; data: RadarrMovie }

// ── Helpers ────────────────────────────────────────────────────────────────

function toLocalDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(dateStr: string) {
  const d = new Date(dateStr + 'T12:00:00')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

// ── Row components ─────────────────────────────────────────────────────────

function EpisodeRow({ ep }: { ep: SonarrEpisode }) {
  const showTitle = ep.series?.title || ep.seriesTitle || 'Unknown Series'
  const network = ep.series?.network
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-green-900/60 text-green-300 shrink-0">TV</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white truncate">{showTitle}</p>
        <p className="text-xs text-gray-400 truncate">
          S{String(ep.seasonNumber ?? 0).padStart(2, '0')}E{String(ep.episodeNumber ?? 0).padStart(2, '0')}
          {ep.title ? ` · ${ep.title}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {network && (
          <span className="text-xs text-gray-600 hidden sm:block">{network}</span>
        )}
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
          ep.hasFile ? 'bg-green-900/40 text-green-400' : 'bg-gray-800 text-gray-500'
        }`}>
          {ep.hasFile ? 'Downloaded' : 'Expected'}
        </span>
      </div>
    </div>
  )
}

function MovieRow({ movie, releaseType }: { movie: RadarrMovie; releaseType: ReleaseType }) {
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-blue-900/60 text-blue-300 shrink-0">Movie</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white truncate">
          {movie.title}{movie.year ? ` (${movie.year})` : ''}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
          releaseType === 'Cinema'  ? 'bg-yellow-900/50 text-yellow-400' :
          releaseType === 'Digital' ? 'bg-purple-900/50 text-purple-400' :
                                      'bg-gray-800 text-gray-400'
        }`}>
          {releaseType}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
          movie.hasFile ? 'bg-green-900/40 text-green-400' : 'bg-gray-800 text-gray-500'
        }`}>
          {movie.hasFile ? 'Downloaded' : 'Expected'}
        </span>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function Calendar() {
  return <CalendarErrorBoundary><CalendarInner /></CalendarErrorBoundary>
}

function CalendarInner() {
  const { enabledServices } = useConfig()
  const hasSonarr = enabledServices.includes('sonarr')
  const hasRadarr = enabledServices.includes('radarr')
  const [range, setRange] = useState<CalendarRange>(14)

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const startStr = toLocalDateStr(today)
  const endDate = new Date(today); endDate.setDate(today.getDate() + range)
  const endStr = toLocalDateStr(endDate)

  const { data: episodes = [], isLoading: epLoading } = useQuery<SonarrEpisode[]>({
    queryKey: ['sonarr-calendar', startStr, endStr],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/calendar', {
      params: { start: startStr, end: endStr, unmonitored: false },
    })).data,
    enabled: hasSonarr,
    staleTime: 300_000,
  })

  const { data: movies = [], isLoading: movLoading } = useQuery<RadarrMovie[]>({
    queryKey: ['radarr-calendar', startStr, endStr],
    queryFn: async () => (await api.get('/proxy/radarr/api/v3/calendar', {
      params: { start: startStr, end: endStr, unmonitored: false },
    })).data,
    enabled: hasRadarr,
    staleTime: 300_000,
  })

  const grouped = useMemo(() => {
    const map = new Map<string, CalendarItem[]>()

    for (const ep of episodes) {
      if (!ep.airDate) continue
      const d = ep.airDate.split('T')[0]
      if (!map.has(d)) map.set(d, [])
      map.get(d)!.push({ kind: 'episode', date: d, data: ep })
    }

    const addMovie = (movie: RadarrMovie, dateField: string | undefined, releaseType: ReleaseType) => {
      if (!dateField) return
      const d = dateField.split('T')[0]
      if (d < startStr || d > endStr) return
      if (!map.has(d)) map.set(d, [])
      map.get(d)!.push({ kind: 'movie', date: d, releaseType, data: movie })
    }

    for (const movie of movies) {
      addMovie(movie, movie.inCinemas,       'Cinema')
      addMovie(movie, movie.digitalRelease,  'Digital')
      addMovie(movie, movie.physicalRelease, 'Physical')
    }

    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({ date, items }))
  }, [episodes, movies, startStr, endStr])

  const isLoading = (hasSonarr && epLoading) || (hasRadarr && movLoading)
  const totalItems = grouped.reduce((n, g) => n + g.items.length, 0)

  if (!hasSonarr && !hasRadarr) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Calendar</h1>
        <p className="text-gray-500">Enable Sonarr or Radarr in Settings to see the calendar.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">Calendar</h1>
          {!isLoading && totalItems > 0 && (
            <span className="text-xs text-gray-600">{totalItems} release{totalItems !== 1 ? 's' : ''}</span>
          )}
        </div>
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          {([7, 14, 30] as CalendarRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 transition-colors ${
                range === r ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
              }`}
            >
              {r === 7 ? '1 Week' : r === 14 ? '2 Weeks' : '1 Month'}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(6)].map((_, i) => <div key={i} className="h-16 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : grouped.length === 0 ? (
        <div className="text-center py-20 text-gray-600 text-sm">
          Nothing scheduled in the next {range} days
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(({ date, items }) => (
            <div key={date}>
              <div className="flex items-baseline gap-2 mb-2">
                <h2 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
                  {dayLabel(date)}
                </h2>
                <span className="text-xs text-gray-600">{date}</span>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800/60">
                {items.map((item, i) =>
                  item.kind === 'episode'
                    ? <EpisodeRow key={i} ep={item.data} />
                    : <MovieRow   key={i} movie={item.data} releaseType={item.releaseType} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
