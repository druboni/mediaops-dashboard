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

interface SonarrSeries {
  id: number
  title: string
  network?: string
}

interface SonarrEpisode {
  id: number
  seriesId: number
  title: string
  seasonNumber: number
  episodeNumber: number
  airDate: string
  hasFile: boolean
  series?: SonarrSeries
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
type ViewMode = 'list' | 'month'
type ReleaseType = 'Cinema' | 'Digital' | 'Physical'
type CalendarItem =
  | { kind: 'episode'; date: string; data: SonarrEpisode }
  | { kind: 'movie';   date: string; releaseType: ReleaseType; data: RadarrMovie }

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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

function getMonthGridDays(monthCursor: Date): Date[] {
  const year = monthCursor.getFullYear()
  const month = monthCursor.getMonth()
  const firstOfMonth = new Date(year, month, 1)
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay())
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    return d
  })
}

// ── Row components ─────────────────────────────────────────────────────────

function EpisodeRow({ ep }: { ep: SonarrEpisode }) {
  const showTitle = ep.series?.title || 'Unknown Series'
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

function chipBorderColor(item: CalendarItem) {
  if (item.kind === 'episode') return item.data.hasFile ? 'border-l-green-500' : 'border-l-emerald-700'
  if (item.releaseType === 'Cinema') return 'border-l-yellow-500'
  if (item.releaseType === 'Digital') return 'border-l-purple-500'
  return 'border-l-gray-500'
}

function chipLabel(item: CalendarItem) {
  if (item.kind === 'episode') {
    const ep = item.data
    const show = ep.series?.title || 'Unknown Series'
    return `${show} · S${String(ep.seasonNumber ?? 0).padStart(2, '0')}E${String(ep.episodeNumber ?? 0).padStart(2, '0')}`
  }
  return `${item.data.title}${item.data.year ? ` (${item.data.year})` : ''}`
}

function MonthDayCell({ date, isCurrentMonth, isToday, items }: {
  date: Date
  isCurrentMonth: boolean
  isToday: boolean
  items: CalendarItem[]
}) {
  return (
    <div className={`border-r border-b border-gray-800 last:border-r-0 p-1.5 min-h-[92px] ${
      isCurrentMonth ? 'bg-gray-950' : 'bg-gray-950/40'
    }`}>
      <div className={`text-xs mb-1 inline-flex items-center justify-center ${
        isToday
          ? 'w-5 h-5 rounded-full bg-blue-600 text-white font-semibold'
          : isCurrentMonth ? 'text-gray-300' : 'text-gray-700'
      }`}>
        {date.getDate()}
      </div>
      <div className="space-y-0.5">
        {items.map((item, i) => (
          <div
            key={i}
            title={chipLabel(item)}
            className={`text-[10px] leading-tight truncate border-l-2 pl-1 ${chipBorderColor(item)} ${
              isCurrentMonth ? 'text-gray-300' : 'text-gray-600'
            }`}
          >
            {chipLabel(item)}
          </div>
        ))}
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
  const [view, setView] = useState<ViewMode>('month')

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const [monthCursor, setMonthCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const gridDays = useMemo(() => getMonthGridDays(monthCursor), [monthCursor])

  const listStartStr = toLocalDateStr(today)
  const listEndDate = new Date(today); listEndDate.setDate(today.getDate() + range)
  const listEndStr = toLocalDateStr(listEndDate)

  const startStr = view === 'month' ? toLocalDateStr(gridDays[0]) : listStartStr
  const endStr = view === 'month' ? toLocalDateStr(gridDays[gridDays.length - 1]) : listEndStr

  const { data: seriesList = [], isLoading: seriesLoading } = useQuery<SonarrSeries[]>({
    queryKey: ['sonarr-series'],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/series')).data,
    enabled: hasSonarr,
    staleTime: 3_600_000,
  })

  const seriesMap = useMemo(() => {
    const m = new Map<number, SonarrSeries>()
    for (const s of seriesList) m.set(s.id, s)
    return m
  }, [seriesList])

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
      const enriched = { ...ep, series: seriesMap.get(ep.seriesId) ?? ep.series }
      map.get(d)!.push({ kind: 'episode', date: d, data: enriched })
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
  }, [episodes, movies, seriesMap, startStr, endStr])

  const groupedMap = useMemo(() => new Map(grouped.map((g) => [g.date, g.items])), [grouped])
  const isLoading = (hasSonarr && (epLoading || seriesLoading)) || (hasRadarr && movLoading)
  const totalItems = grouped.reduce((n, g) => n + g.items.length, 0)
  const todayStr = toLocalDateStr(today)
  const monthLabel = monthCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  if (!hasSonarr && !hasRadarr) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Calendar</h1>
        <p className="text-gray-500">Enable Sonarr or Radarr in Settings to see the calendar.</p>
      </div>
    )
  }

  return (
    <div className={view === 'month' ? 'p-6' : 'p-6 max-w-4xl'}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">Calendar</h1>
          {!isLoading && totalItems > 0 && (
            <span className="text-xs text-gray-600">{totalItems} release{totalItems !== 1 ? 's' : ''}</span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {view === 'month' ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                className="w-7 h-7 flex items-center justify-center rounded-md border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                aria-label="Previous month"
              >
                ‹
              </button>
              <span className="text-sm font-medium text-gray-200 w-36 text-center">{monthLabel}</span>
              <button
                onClick={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                className="w-7 h-7 flex items-center justify-center rounded-md border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                aria-label="Next month"
              >
                ›
              </button>
              <button
                onClick={() => setMonthCursor(new Date(today.getFullYear(), today.getMonth(), 1))}
                className="px-2.5 py-1 rounded-md border border-gray-700 text-xs text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              >
                Today
              </button>
            </div>
          ) : (
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
          )}

          <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
            {(['month', 'list'] as ViewMode[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 capitalize transition-colors ${
                  view === v ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === 'month' ? (
        isLoading ? (
          <div className="grid grid-cols-7 gap-px bg-gray-800 border border-gray-800 rounded-lg overflow-hidden">
            {[...Array(42)].map((_, i) => <div key={i} className="h-[92px] bg-gray-950 animate-pulse" />)}
          </div>
        ) : (
          <div className="border border-gray-800 rounded-lg overflow-hidden">
            <div className="grid grid-cols-7 bg-gray-900 border-b border-gray-800">
              {WEEKDAY_LABELS.map((w) => (
                <div key={w} className="px-2 py-1.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wider text-center">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {gridDays.map((date) => {
                const dateStr = toLocalDateStr(date)
                return (
                  <MonthDayCell
                    key={dateStr}
                    date={date}
                    isCurrentMonth={date.getMonth() === monthCursor.getMonth()}
                    isToday={dateStr === todayStr}
                    items={groupedMap.get(dateStr) ?? []}
                  />
                )
              })}
            </div>
          </div>
        )
      ) : isLoading ? (
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
