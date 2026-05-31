import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

interface StatRow {
  title: string
  year: number | null
  plays: number
  users: number | null
  thumb: string | null
  mediaType: string | null
}

interface UserRow {
  userId: number
  username: string
  thumb: string | null
  plays: number
  duration: number
  lastSeen: string | null
}

interface ChartData {
  dates: string[]
  movies: number[]
  shows: number[]
  music: number[]
}

interface Highlight {
  topContent: { title: string; year: number | null; type: string; plays: number } | null
  topUser:    { name: string; plays: number; duration: number } | null
}

interface StatsData {
  available: boolean
  range: number
  highlights: { week: Highlight; month: Highlight }
  topMovies: StatRow[]
  topShows: StatRow[]
  topMusic: StatRow[]
  popularMovies: StatRow[]
  popularShows: StatRow[]
  recentUsers: UserRow[]
  chart: ChartData
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function HighlightsCard({ highlights }: { highlights: { week: Highlight; month: Highlight } }) {
  const cols: { label: string; data: Highlight }[] = [
    { label: 'This Week',  data: highlights.week  },
    { label: 'This Month', data: highlights.month },
  ]
  return (
    <div className="grid grid-cols-2 gap-4">
      {cols.map(({ label, data }) => (
        <div key={label} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{label}</h3>
          <div className="space-y-3">
            {/* Most watched content */}
            <div>
              <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-1">Most Watched</p>
              {data.topContent ? (
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                    data.topContent.type === 'movie' ? 'bg-blue-900/60 text-blue-300' : 'bg-green-900/60 text-green-300'
                  }`}>
                    {data.topContent.type === 'movie' ? 'Movie' : 'TV'}
                  </span>
                  <span className="text-sm text-white font-medium truncate">{data.topContent.title}</span>
                  {data.topContent.year && <span className="text-xs text-gray-600 shrink-0">{data.topContent.year}</span>}
                </div>
              ) : (
                <p className="text-xs text-gray-600">No data</p>
              )}
              {data.topContent && (
                <p className="text-xs text-gray-500 mt-0.5 ml-0.5">{data.topContent.plays} play{data.topContent.plays !== 1 ? 's' : ''}</p>
              )}
            </div>

            {/* Top viewer */}
            <div className="pt-2 border-t border-gray-800">
              <p className="text-[10px] text-gray-600 uppercase tracking-wide mb-1">Top Viewer</p>
              {data.topUser ? (
                <>
                  <p className="text-sm text-white font-medium">{data.topUser.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {data.topUser.plays} play{data.topUser.plays !== 1 ? 's' : ''}
                    {data.topUser.duration > 0 && ` · ${formatDuration(data.topUser.duration)}`}
                  </p>
                </>
              ) : (
                <p className="text-xs text-gray-600">No data</p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function MiniBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-800 rounded-full h-1">
        <div className="bg-blue-500 h-1 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-gray-400 w-8 text-right">{value}</span>
    </div>
  )
}

function StatList({ title, items, accent }: { title: string; items: StatRow[]; accent: string }) {
  const max = items[0]?.plays ?? 1
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-gray-600 py-2">No data</p>
      ) : (
        <div className="space-y-2.5">
          {items.slice(0, 8).map((item, i) => (
            <div key={i}>
              <div className="flex items-center justify-between mb-1 gap-2">
                <span className="text-sm text-white truncate flex-1">{item.title}</span>
                {item.year && <span className="text-xs text-gray-600 shrink-0">{item.year}</span>}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-gray-800 rounded-full h-1">
                  <div className={`h-1 rounded-full ${accent}`} style={{ width: `${Math.round((item.plays / max) * 100)}%` }} />
                </div>
                <span className="text-xs tabular-nums text-gray-400 w-12 text-right">
                  {item.plays} {item.users !== null ? `· ${item.users}u` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PlayChart({ chart, range }: { chart: ChartData; range: number }) {
  if (!chart.dates.length) return null

  const allValues = [...chart.movies, ...chart.shows, ...chart.music]
  const maxVal = Math.max(...allValues, 1)
  const chartH = 80

  // Show last N points based on range
  const show = Math.min(chart.dates.length, range <= 7 ? 7 : range <= 14 ? 14 : 30)
  const startIdx = chart.dates.length - show
  const dates = chart.dates.slice(startIdx)
  const movies = chart.movies.slice(startIdx)
  const shows = chart.shows.slice(startIdx)
  const music = chart.music.slice(startIdx)

  const totalPlays = [...chart.movies, ...chart.shows, ...chart.music].reduce((a, b) => a + b, 0)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Plays Over Time</h3>
        <span className="text-xs text-gray-600">{totalPlays} total plays</span>
      </div>
      <div className="flex items-end gap-0.5" style={{ height: chartH }}>
        {dates.map((date, i) => {
          const m = movies[i] || 0
          const s = shows[i] || 0
          const u = music[i] || 0
          const total = m + s + u
          const totalPct = (total / maxVal) * 100
          if (total === 0) return (
            <div key={date} className="flex-1 flex items-end justify-center" style={{ height: chartH }}>
              <div className="w-full bg-gray-800/40 rounded-sm" style={{ height: 2 }} />
            </div>
          )
          return (
            <div
              key={date}
              className="flex-1 flex flex-col justify-end rounded-sm overflow-hidden cursor-default"
              style={{ height: `${totalPct}%`, minHeight: 4 }}
              title={`${date}\nMovies: ${m}\nTV: ${s}\nMusic: ${u}`}
            >
              {u > 0 && <div className="bg-purple-500 opacity-80" style={{ flex: u }} />}
              {m > 0 && <div className="bg-blue-500 opacity-80" style={{ flex: m }} />}
              {s > 0 && <div className="bg-green-500 opacity-80" style={{ flex: s }} />}
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-4 mt-2">
        <span className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-2 h-2 rounded-sm bg-green-500 inline-block" />TV</span>
        <span className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-2 h-2 rounded-sm bg-blue-500 inline-block" />Movies</span>
        <span className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-2 h-2 rounded-sm bg-purple-500 inline-block" />Music</span>
      </div>
    </div>
  )
}

export default function Stats() {
  const { enabledServices } = useConfig()
  const [range, setRange] = useState(30)

  const hasTautulli = enabledServices.includes('tautulli')

  const { data, isLoading } = useQuery<StatsData>({
    queryKey: ['stats', range],
    queryFn: async () => (await api.get<StatsData>(`/stats?range=${range}`)).data,
    refetchInterval: 120_000,
    enabled: hasTautulli,
  })

  if (!hasTautulli) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Play Statistics</h1>
        <p className="text-gray-500">Enable Tautulli in Settings to see play statistics.</p>
      </div>
    )
  }

  if (!isLoading && data && !data.available) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Play Statistics</h1>
        <p className="text-gray-500">Tautulli not reachable.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Play Statistics</h1>
          <p className="text-sm text-gray-500 mt-0.5">Top content and user activity via Tautulli</p>
        </div>
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          {([7, 14, 30] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 transition-colors ${
                range === r ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-48 animate-pulse" />
          ))}
        </div>
      ) : data ? (
        <div className="space-y-6">
          {/* Week / Month highlights */}
          <HighlightsCard highlights={data.highlights} />

          {/* Play chart */}
          <PlayChart chart={data.chart} range={range} />

          {/* Top / Popular grids */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <StatList title="Most Watched TV" items={data.topShows} accent="bg-green-500" />
            <StatList title="Most Watched Movies" items={data.topMovies} accent="bg-blue-500" />
            <StatList title="Most Popular TV" items={data.popularShows} accent="bg-green-600" />
            <StatList title="Most Popular Movies" items={data.popularMovies} accent="bg-blue-600" />
            {data.topMusic.length > 0 && (
              <StatList title="Most Played Music" items={data.topMusic} accent="bg-purple-500" />
            )}
          </div>

          {/* Users */}
          {data.recentUsers.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Active Users</h3>
              <div className="space-y-2">
                {data.recentUsers.map((u) => (
                  <div key={u.userId} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white truncate">{u.username}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <MiniBar value={u.plays} max={data.recentUsers[0]?.plays ?? 1} />
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-gray-400">{formatDuration(u.duration)}</p>
                      <p className="text-xs text-gray-600">{timeAgo(u.lastSeen)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
