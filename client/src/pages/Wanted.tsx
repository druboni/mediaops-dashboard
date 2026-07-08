import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

interface WantedMovie {
  id: number
  tmdbId: number
  title: string
  year: number
  monitored: boolean
  releaseDate: string | null
  poster: string | null
}

interface WantedEpisode {
  id: number
  seriesId: number
  seriesTitle: string
  seasonNumber: number
  episodeNumber: number
  title: string
  monitored: boolean
  airDate: string | null
}

interface WantedData {
  movies: WantedMovie[]
  episodes: WantedEpisode[]
}

interface CutoffMovie {
  id: number
  title: string
  year: number
  currentQuality: string
  sizeOnDisk: number
}

interface CutoffEpisode {
  id: number
  seriesId: number
  seriesTitle: string
  seasonNumber: number
  episodeNumber: number
  title: string
  currentQuality: string
  sizeOnDisk: number
}

interface CutoffData {
  movies: CutoffMovie[]
  episodes: CutoffEpisode[]
  totals: { movies: number; episodes: number }
}

function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`
  return '—'
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days < 0) return `in ${Math.abs(days)}d`
  if (days === 0) return 'today'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function epCode(s: number, e: number) {
  return `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`
}

export default function Wanted() {
  const { enabledServices } = useConfig()
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'missing' | 'upgrades'>('missing')
  const [tab, setTab] = useState<'movies' | 'episodes'>('movies')
  const [searching, setSearching] = useState<Set<string>>(new Set())
  const [searched, setSearched] = useState<Set<string>>(new Set())

  const hasRadarr = enabledServices.includes('radarr')
  const hasSonarr = enabledServices.includes('sonarr')

  const { data, isLoading } = useQuery<WantedData>({
    queryKey: ['wanted'],
    queryFn: async () => (await api.get<WantedData>('/wanted')).data,
    refetchInterval: 60_000,
    enabled: hasRadarr || hasSonarr,
  })

  const { data: cutoffData, isLoading: cutoffLoading } = useQuery<CutoffData>({
    queryKey: ['wanted-cutoff'],
    queryFn: async () => (await api.get<CutoffData>('/wanted/cutoff')).data,
    refetchInterval: 300_000,
    enabled: (hasRadarr || hasSonarr) && mode === 'upgrades',
  })

  const searchMovie = useMutation({
    mutationFn: (id: number) => api.post('/wanted/search/movie', { id }),
    onMutate: (id) => setSearching((s) => new Set([...s, `movie-${id}`])),
    onSettled: (_, __, id) => {
      setSearching((s) => { const n = new Set(s); n.delete(`movie-${id}`); return n })
      setSearched((s) => new Set([...s, `movie-${id}`]))
    },
  })

  const searchEpisode = useMutation({
    mutationFn: (id: number) => api.post('/wanted/search/episode', { id }),
    onMutate: (id) => setSearching((s) => new Set([...s, `ep-${id}`])),
    onSettled: (_, __, id) => {
      setSearching((s) => { const n = new Set(s); n.delete(`ep-${id}`); return n })
      setSearched((s) => new Set([...s, `ep-${id}`]))
    },
  })

  const searchSeries = useMutation({
    mutationFn: (seriesId: number) => api.post('/wanted/search/series', { seriesId }),
    onMutate: (sid) => setSearching((s) => new Set([...s, `series-${sid}`])),
    onSettled: (_, __, sid) => {
      setSearching((s) => { const n = new Set(s); n.delete(`series-${sid}`); return n })
      setSearched((s) => new Set([...s, `series-${sid}`]))
      queryClient.invalidateQueries({ queryKey: ['wanted'] })
    },
  })

  const movies = data?.movies ?? []
  const episodes = data?.episodes ?? []

  // Group episodes by series
  const bySeriesMap = new Map<number, { seriesId: number; title: string; episodes: WantedEpisode[] }>()
  for (const ep of episodes) {
    if (!bySeriesMap.has(ep.seriesId)) bySeriesMap.set(ep.seriesId, { seriesId: ep.seriesId, title: ep.seriesTitle, episodes: [] })
    bySeriesMap.get(ep.seriesId)!.episodes.push(ep)
  }
  const bySeries = Array.from(bySeriesMap.values()).sort((a, b) => a.title.localeCompare(b.title))

  if (!hasRadarr && !hasSonarr) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Wanted / Missing</h1>
        <p className="text-gray-500">Enable Radarr or Sonarr in Settings.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Wanted / Missing</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {mode === 'missing' ? 'Monitored items not yet downloaded' : 'Items below quality cutoff, eligible for a better version'}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {mode === 'missing' && data && (
            <div className="text-xs text-gray-600 text-right">
              <div>{movies.length} movies missing</div>
              <div>{episodes.length} episodes missing</div>
            </div>
          )}
          {mode === 'upgrades' && cutoffData && (
            <div className="text-xs text-gray-600 text-right">
              <div>{cutoffData.totals.movies} movies below cutoff</div>
              <div>{cutoffData.totals.episodes} episodes below cutoff</div>
            </div>
          )}
          <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs shrink-0">
            {(['missing', 'upgrades'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 transition-colors capitalize ${
                  mode === m ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
                }`}
              >
                {m === 'missing' ? 'Missing' : 'Upgrades'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-gray-800">
        {([
          ['movies', 'Movies', mode === 'missing' ? movies.length : cutoffData?.movies.length ?? 0],
          ['episodes', 'TV Episodes', mode === 'missing' ? episodes.length : cutoffData?.episodes.length ?? 0],
        ] as const).map(([t, label, count]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            disabled={t === 'movies' ? !hasRadarr : !hasSonarr}
            className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 disabled:opacity-40 disabled:cursor-not-allowed ${
              tab === t ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {label}
            {!(mode === 'missing' ? isLoading : cutoffLoading) && (
              <span className="ml-1.5 text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded-full">{count}</span>
            )}
          </button>
        ))}
      </div>

      {mode === 'upgrades' ? (
        cutoffLoading ? (
          <div className="space-y-2">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-14 animate-pulse" />
            ))}
          </div>
        ) : tab === 'movies' ? (
          !cutoffData?.movies.length ? (
            <div className="text-center py-20 text-gray-600 text-sm">All movies meet their quality cutoff 🎉</div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5 font-medium">Movie</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Year</th>
                    <th className="text-left px-4 py-2.5 font-medium">Current Quality</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Size</th>
                    <th className="px-4 py-2.5 w-28" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {cutoffData.movies.map((m) => {
                    const key = `movie-${m.id}`
                    const isSearching = searching.has(key)
                    const wasSearched = searched.has(key)
                    return (
                      <tr key={m.id} className="hover:bg-gray-800/30 transition-colors group">
                        <td className="px-4 py-3">
                          <span className="text-white font-medium">{m.title}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs hidden sm:table-cell">{m.year || '—'}</td>
                        <td className="px-4 py-3">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-orange-900/40 text-orange-300">{m.currentQuality}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs tabular-nums hidden md:table-cell">{formatSize(m.sizeOnDisk)}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => searchMovie.mutate(m.id)}
                            disabled={isSearching || wasSearched}
                            className={`text-xs px-3 py-1 rounded transition-colors ${
                              wasSearched
                                ? 'bg-green-900/40 text-green-400 cursor-default'
                                : isSearching
                                ? 'bg-gray-700 text-gray-500 cursor-wait'
                                : 'bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white opacity-0 group-hover:opacity-100'
                            }`}
                          >
                            {wasSearched ? '✓ Searching' : isSearching ? '…' : 'Upgrade'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : (
          !cutoffData?.episodes.length ? (
            <div className="text-center py-20 text-gray-600 text-sm">All episodes meet their quality cutoff 🎉</div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5 font-medium">Episode</th>
                    <th className="text-left px-4 py-2.5 font-medium">Current Quality</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Size</th>
                    <th className="px-4 py-2.5 w-28" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {cutoffData.episodes.map((ep) => {
                    const key = `ep-${ep.id}`
                    const isSearching = searching.has(key)
                    const wasSearched = searched.has(key)
                    return (
                      <tr key={ep.id} className="hover:bg-gray-800/30 transition-colors group">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-white font-medium truncate">{ep.seriesTitle}</span>
                            <span className="text-xs text-gray-500 font-mono shrink-0">{epCode(ep.seasonNumber, ep.episodeNumber)}</span>
                            <span className="text-xs text-gray-500 truncate hidden lg:inline">{ep.title}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-orange-900/40 text-orange-300">{ep.currentQuality}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs tabular-nums hidden md:table-cell">{formatSize(ep.sizeOnDisk)}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => searchEpisode.mutate(ep.id)}
                            disabled={isSearching || wasSearched}
                            className={`text-xs px-3 py-1 rounded transition-colors ${
                              wasSearched
                                ? 'bg-green-900/40 text-green-400 cursor-default'
                                : isSearching
                                ? 'bg-gray-700 text-gray-500 cursor-wait'
                                : 'bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white opacity-0 group-hover:opacity-100'
                            }`}
                          >
                            {wasSearched ? '✓ Searching' : isSearching ? '…' : 'Upgrade'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        )
      ) : isLoading ? (
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-14 animate-pulse" />
          ))}
        </div>
      ) : tab === 'movies' ? (
        movies.length === 0 ? (
          <div className="text-center py-20 text-gray-600 text-sm">No missing movies 🎉</div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">Movie</th>
                  <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Year</th>
                  <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Release</th>
                  <th className="px-4 py-2.5 w-28" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {movies.map((m) => {
                  const key = `movie-${m.id}`
                  const isSearching = searching.has(key)
                  const wasSearched = searched.has(key)
                  return (
                    <tr key={m.id} className="hover:bg-gray-800/30 transition-colors group">
                      <td className="px-4 py-3">
                        <span className="text-white font-medium">{m.title}</span>
                        {!m.monitored && <span className="ml-2 text-xs text-gray-600">(unmonitored)</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden sm:table-cell">{m.year || '—'}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">{timeAgo(m.releaseDate)}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => searchMovie.mutate(m.id)}
                          disabled={isSearching || wasSearched}
                          className={`text-xs px-3 py-1 rounded transition-colors ${
                            wasSearched
                              ? 'bg-green-900/40 text-green-400 cursor-default'
                              : isSearching
                              ? 'bg-gray-700 text-gray-500 cursor-wait'
                              : 'bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white opacity-0 group-hover:opacity-100'
                          }`}
                        >
                          {wasSearched ? '✓ Searching' : isSearching ? '…' : 'Search'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        bySeries.length === 0 ? (
          <div className="text-center py-20 text-gray-600 text-sm">No missing episodes 🎉</div>
        ) : (
          <div className="space-y-4">
            {bySeries.map(({ seriesId, title, episodes: eps }) => {
              const seriesKey = `series-${seriesId}`
              const isSearchingAll = searching.has(seriesKey)
              const wasSearchedAll = searched.has(seriesKey)
              return (
                <div key={seriesId} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between gap-3">
                    <div>
                      <span className="text-white font-semibold">{title}</span>
                      <span className="ml-2 text-xs text-gray-600">{eps.length} missing</span>
                    </div>
                    <button
                      onClick={() => searchSeries.mutate(seriesId)}
                      disabled={isSearchingAll || wasSearchedAll}
                      className={`text-xs px-3 py-1 rounded transition-colors shrink-0 ${
                        wasSearchedAll
                          ? 'bg-green-900/40 text-green-400 cursor-default'
                          : isSearchingAll
                          ? 'bg-gray-700 text-gray-500 cursor-wait'
                          : 'bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white'
                      }`}
                    >
                      {wasSearchedAll ? '✓ Searching all' : isSearchingAll ? '…' : 'Search all'}
                    </button>
                  </div>
                  <div className="divide-y divide-gray-800/40">
                    {eps.map((ep) => {
                      const epKey = `ep-${ep.id}`
                      const isSearching = searching.has(epKey)
                      const wasSearched = searched.has(epKey)
                      return (
                        <div key={ep.id} className="px-4 py-2.5 flex items-center justify-between gap-3 group hover:bg-gray-800/20">
                          <div className="min-w-0 flex items-center gap-3">
                            <span className="text-xs text-gray-500 font-mono shrink-0">{epCode(ep.seasonNumber, ep.episodeNumber)}</span>
                            <span className="text-sm text-gray-300 truncate">{ep.title}</span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-xs text-gray-600 hidden sm:block">{timeAgo(ep.airDate)}</span>
                            <button
                              onClick={() => searchEpisode.mutate(ep.id)}
                              disabled={isSearching || wasSearched || wasSearchedAll}
                              className={`text-xs px-2.5 py-1 rounded transition-colors ${
                                wasSearched || wasSearchedAll
                                  ? 'bg-green-900/40 text-green-400 cursor-default'
                                  : isSearching
                                  ? 'bg-gray-700 text-gray-500 cursor-wait'
                                  : 'bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white opacity-0 group-hover:opacity-100'
                              }`}
                            >
                              {wasSearched || wasSearchedAll ? '✓' : isSearching ? '…' : 'Search'}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}
