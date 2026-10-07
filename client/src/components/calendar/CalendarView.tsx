import { useState, useMemo } from 'react'
import type { ReactNode } from 'react'

// The calendar's state and rendering, shared by the in-app Calendar page and
// the public read-only share page. Only where the data comes from differs
// between the two — the authenticated page reads Sonarr/Radarr through the
// proxy, the share page reads the trimmed public endpoint — so everything
// about how a release is drawn lives here once.

// ── Types ──────────────────────────────────────────────────────────────────

// The fields the calendar actually draws. The in-app page passes full
// Sonarr/Radarr records (a superset), the share page passes exactly these.
export interface CalEpisode {
  title: string
  seasonNumber: number
  episodeNumber: number
  airDate: string
  hasFile: boolean
  series?: { title: string; network?: string }
}

export interface CalMovie {
  title: string
  year?: number
  inCinemas?: string
  digitalRelease?: string
  physicalRelease?: string
  hasFile: boolean
}

export type CalendarRange = 7 | 14 | 30
export type ViewMode = 'list' | 'month'
type ReleaseType = 'Cinema' | 'Digital' | 'Physical'
type CalendarItem =
  | { kind: 'episode'; date: string; data: CalEpisode }
  | { kind: 'movie';   date: string; releaseType: ReleaseType; data: CalMovie }

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ── Status coloring ───────────────────────────────────────────────────────
// Every calendar item (episode or movie release) reduces to one of three
// states, colored consistently everywhere it appears:
//   downloaded  → already have the file
//   upcoming    → release/air date hasn't happened yet
//   missing     → date has passed and we still don't have the file

type ItemStatus = 'downloaded' | 'upcoming' | 'missing'

const STATUS_STYLES: Record<ItemStatus, {
  border: string; dot: string; badgeBg: string; badgeText: string; label: string
}> = {
  downloaded: { border: 'border-l-green-500',  dot: 'bg-green-500',  badgeBg: 'bg-green-900/40',  badgeText: 'text-green-400',  label: 'Downloaded' },
  upcoming:   { border: 'border-l-yellow-500', dot: 'bg-yellow-500', badgeBg: 'bg-yellow-900/40', badgeText: 'text-yellow-400', label: 'Not released yet' },
  missing:    { border: 'border-l-purple-500', dot: 'bg-purple-500', badgeBg: 'bg-purple-900/40', badgeText: 'text-purple-400', label: 'Out, not downloaded' },
}

function getItemStatus(item: CalendarItem, todayStr: string): ItemStatus {
  if (item.data.hasFile) return 'downloaded'
  return item.date > todayStr ? 'upcoming' : 'missing'
}

function StatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 mb-4">
      {(Object.entries(STATUS_STYLES) as [ItemStatus, typeof STATUS_STYLES[ItemStatus]][]).map(([key, s]) => (
        <div key={key} className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${s.dot}`} />
          {s.label}
        </div>
      ))}
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function toLocalDateStr(d: Date) {
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

// ── State ──────────────────────────────────────────────────────────────────

// View, range and month position, plus the date window they imply. Each page
// calls this itself so it can key its own data query on startStr/endStr.
export function useCalendarState() {
  // Recomputed every render, as the original page did, so a calendar left open
  // past midnight moves its "today" highlight on the next render.
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const [range, setRange] = useState<CalendarRange>(14)
  const [view, setView] = useState<ViewMode>('month')
  const [monthCursor, setMonthCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const gridDays = useMemo(() => getMonthGridDays(monthCursor), [monthCursor])

  const listEndDate = new Date(today); listEndDate.setDate(today.getDate() + range)
  const startStr = view === 'month' ? toLocalDateStr(gridDays[0]) : toLocalDateStr(today)
  const endStr = view === 'month' ? toLocalDateStr(gridDays[gridDays.length - 1]) : toLocalDateStr(listEndDate)

  return {
    today, todayStr: toLocalDateStr(today),
    range, setRange, view, setView, monthCursor, setMonthCursor, gridDays,
    startStr, endStr,
  }
}

export type CalendarState = ReturnType<typeof useCalendarState>

// ── Row components ─────────────────────────────────────────────────────────

function EpisodeRow({ item, todayStr }: { item: Extract<CalendarItem, { kind: 'episode' }>; todayStr: string }) {
  const ep = item.data
  const showTitle = ep.series?.title || 'Unknown Series'
  const network = ep.series?.network
  const s = STATUS_STYLES[getItemStatus(item, todayStr)]
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-sky-900/60 text-sky-300 shrink-0">TV</span>
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
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${s.badgeBg} ${s.badgeText}`}>
          {s.label}
        </span>
      </div>
    </div>
  )
}

function MovieRow({ item, todayStr }: { item: Extract<CalendarItem, { kind: 'movie' }>; todayStr: string }) {
  const movie = item.data
  const s = STATUS_STYLES[getItemStatus(item, todayStr)]
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-indigo-900/60 text-indigo-300 shrink-0">Movie</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white truncate">
          {movie.title}{movie.year ? ` (${movie.year})` : ''}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-800 text-gray-400">
          {item.releaseType}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${s.badgeBg} ${s.badgeText}`}>
          {s.label}
        </span>
      </div>
    </div>
  )
}

function chipBorderColor(item: CalendarItem, todayStr: string) {
  return STATUS_STYLES[getItemStatus(item, todayStr)].border
}

function chipLabel(item: CalendarItem) {
  if (item.kind === 'episode') {
    const ep = item.data
    const show = ep.series?.title || 'Unknown Series'
    return `${show} · S${String(ep.seasonNumber ?? 0).padStart(2, '0')}E${String(ep.episodeNumber ?? 0).padStart(2, '0')}`
  }
  return `${item.data.title}${item.data.year ? ` (${item.data.year})` : ''}`
}

function MonthDayCell({ date, isCurrentMonth, isToday, items, todayStr }: {
  date: Date
  isCurrentMonth: boolean
  isToday: boolean
  items: CalendarItem[]
  todayStr: string
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
            className={`text-[10px] leading-tight truncate border-l-2 pl-1 ${chipBorderColor(item, todayStr)} ${
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

// ── Body ───────────────────────────────────────────────────────────────────

export function CalendarBody({ cal, episodes, movies, isLoading, title = 'Calendar', headerExtra }: {
  cal: CalendarState
  episodes: CalEpisode[]
  movies: CalMovie[]
  isLoading: boolean
  title?: string
  /** Rendered next to the title — the share page uses it for its "read-only" tag. */
  headerExtra?: ReactNode
}) {
  const { today, todayStr, range, setRange, view, setView, monthCursor, setMonthCursor, gridDays, startStr, endStr } = cal

  const grouped = useMemo(() => {
    const map = new Map<string, CalendarItem[]>()

    for (const ep of episodes) {
      if (!ep.airDate) continue
      const d = ep.airDate.split('T')[0]
      if (!map.has(d)) map.set(d, [])
      map.get(d)!.push({ kind: 'episode', date: d, data: ep })
    }

    const addMovie = (movie: CalMovie, dateField: string | undefined, releaseType: ReleaseType) => {
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

  const groupedMap = useMemo(() => new Map(grouped.map((g) => [g.date, g.items])), [grouped])
  const totalItems = grouped.reduce((n, g) => n + g.items.length, 0)
  const monthLabel = monthCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className={view === 'month' ? 'p-6' : 'p-6 max-w-4xl'}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          {headerExtra}
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

      <StatusLegend />

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
                    todayStr={todayStr}
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
                    ? <EpisodeRow key={i} item={item} todayStr={todayStr} />
                    : <MovieRow   key={i} item={item} todayStr={todayStr} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
