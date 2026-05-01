import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

// ── Types ──────────────────────────────────────────────────────────────────

interface MissingSubtitle { code2: string; name: string; hi: boolean; forced: boolean }

interface WantedMovie {
  radarrId: number
  title: string
  missing_subtitles: MissingSubtitle[]
}

interface WantedEpisode {
  sonarrSeriesId: number
  sonarrEpisodeId: number
  seriesTitle: string
  season_number: number
  episode_number: number
  title: string
  missing_subtitles: MissingSubtitle[]
}

interface SubtitleHistoryItem {
  id: number
  action: number
  timestamp: string
  description: string
  video_path?: string
  provider?: string
  language?: { code2: string; name: string }
}

interface Provider {
  name: string
  status: boolean
  last_query?: string
  last_failure?: string
  total_count?: number
  errors?: string[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function basename(path?: string) {
  if (!path) return ''
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

// ── Wanted Movies ──────────────────────────────────────────────────────────

function WantedMovies() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(0)
  const PAGE = 25

  const { data, isLoading } = useQuery<{ data: WantedMovie[]; total: number }>({
    queryKey: ['bazarr-wanted-movies', page],
    queryFn: async () => (await api.get('/proxy/bazarr/api/movies/wanted', {
      params: { start: page * PAGE, length: PAGE },
    })).data,
    staleTime: 30_000,
  })

  const searchSub = useMutation({
    mutationFn: ({ radarrId, sub }: { radarrId: number; sub: MissingSubtitle }) =>
      api.patch('/proxy/bazarr/api/movies/subtitles', {
        radarrid: String(radarrId),
        language: sub.code2,
        hi: sub.hi,
        forced: sub.forced,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bazarr-wanted-movies'] }),
  })

  const total = data?.total ?? 0
  const pages = Math.ceil(total / PAGE)

  if (isLoading) {
    return (
      <div className="space-y-1.5">
        {[...Array(8)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
      </div>
    )
  }

  if (!data?.data?.length) {
    return <div className="text-center py-20 text-gray-600 text-sm">No missing movie subtitles</div>
  }

  return (
    <div className="space-y-3">
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">Movie</th>
              <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Language</th>
              <th className="text-right px-4 py-2.5 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {data.data.map((movie) =>
              (movie.missing_subtitles ?? []).map((sub, si) => (
                <tr key={`${movie.radarrId}-${si}`} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <span className="text-white text-sm truncate">{movie.title}</span>
                  </td>
                  <td className="px-4 py-2.5 hidden sm:table-cell">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-300">{sub.name || sub.code2}</span>
                      {sub.hi && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-900/60 text-blue-400">HI</span>}
                      {sub.forced && <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-900/60 text-yellow-400">Forced</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => searchSub.mutate({ radarrId: movie.radarrId, sub })}
                      disabled={searchSub.isPending}
                      className="text-xs px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
                    >
                      Search
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{total} total</span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              ‹ Prev
            </button>
            <span className="px-2.5 py-1">{page + 1} / {pages}</span>
            <button
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              className="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              Next ›
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Wanted Episodes ────────────────────────────────────────────────────────

function WantedEpisodes() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(0)
  const PAGE = 25

  const { data, isLoading } = useQuery<{ data: WantedEpisode[]; total: number }>({
    queryKey: ['bazarr-wanted-episodes', page],
    queryFn: async () => (await api.get('/proxy/bazarr/api/episodes/wanted', {
      params: { start: page * PAGE, length: PAGE },
    })).data,
    staleTime: 30_000,
  })

  const searchSub = useMutation({
    mutationFn: ({ ep, sub }: { ep: WantedEpisode; sub: MissingSubtitle }) =>
      api.patch('/proxy/bazarr/api/episodes/subtitles', {
        seriesid: String(ep.sonarrSeriesId),
        episodeid: String(ep.sonarrEpisodeId),
        language: sub.code2,
        hi: sub.hi,
        forced: sub.forced,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bazarr-wanted-episodes'] }),
  })

  const total = data?.total ?? 0
  const pages = Math.ceil(total / PAGE)

  if (isLoading) {
    return (
      <div className="space-y-1.5">
        {[...Array(8)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
      </div>
    )
  }

  if (!data?.data?.length) {
    return <div className="text-center py-20 text-gray-600 text-sm">No missing episode subtitles</div>
  }

  return (
    <div className="space-y-3">
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">Series</th>
              <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Episode</th>
              <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Language</th>
              <th className="text-right px-4 py-2.5 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {data.data.map((ep) =>
              (ep.missing_subtitles ?? []).map((sub, si) => (
                <tr key={`${ep.sonarrEpisodeId}-${si}`} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <p className="text-white text-sm truncate">{ep.seriesTitle}</p>
                    <p className="text-xs text-gray-500">{ep.title}</p>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-400 hidden md:table-cell tabular-nums">
                    S{String(ep.season_number).padStart(2, '0')}E{String(ep.episode_number).padStart(2, '0')}
                  </td>
                  <td className="px-4 py-2.5 hidden sm:table-cell">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-300">{sub.name || sub.code2}</span>
                      {sub.hi && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-900/60 text-blue-400">HI</span>}
                      {sub.forced && <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-900/60 text-yellow-400">Forced</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => searchSub.mutate({ ep, sub })}
                      disabled={searchSub.isPending}
                      className="text-xs px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
                    >
                      Search
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{total} total</span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              ‹ Prev
            </button>
            <span className="px-2.5 py-1">{page + 1} / {pages}</span>
            <button
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              className="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 transition-colors"
            >
              Next ›
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── History ────────────────────────────────────────────────────────────────

function History() {
  const [subTab, setSubTab] = useState<'movies' | 'episodes'>('movies')
  const [moviePage, setMoviePage] = useState(0)
  const [epPage, setEpPage] = useState(0)
  const PAGE = 25

  const { data: movieHistory, isLoading: mlLoading } = useQuery<{ data: SubtitleHistoryItem[]; total: number }>({
    queryKey: ['bazarr-history-movies', moviePage],
    queryFn: async () => (await api.get('/proxy/bazarr/api/movies/history', {
      params: { start: moviePage * PAGE, length: PAGE },
    })).data,
    enabled: subTab === 'movies',
    staleTime: 30_000,
  })

  const { data: epHistory, isLoading: elLoading } = useQuery<{ data: SubtitleHistoryItem[]; total: number }>({
    queryKey: ['bazarr-history-episodes', epPage],
    queryFn: async () => (await api.get('/proxy/bazarr/api/episodes/history', {
      params: { start: epPage * PAGE, length: PAGE },
    })).data,
    enabled: subTab === 'episodes',
    staleTime: 30_000,
  })

  const items = subTab === 'movies' ? movieHistory : epHistory
  const isLoading = subTab === 'movies' ? mlLoading : elLoading
  const page = subTab === 'movies' ? moviePage : epPage
  const setPage = subTab === 'movies' ? setMoviePage : setEpPage
  const total = items?.total ?? 0
  const pages = Math.ceil(total / PAGE)

  return (
    <div className="space-y-3">
      <div className="flex gap-1 text-xs">
        {(['movies', 'episodes'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            className={`px-3 py-1.5 rounded-lg capitalize transition-colors ${
              subTab === t ? 'bg-blue-600 text-white' : 'bg-gray-900 border border-gray-700 text-gray-400 hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(8)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : !items?.data?.length ? (
        <div className="text-center py-20 text-gray-600 text-sm">No history</div>
      ) : (
        <div className="space-y-3">
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">File</th>
                  <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Language</th>
                  <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Provider</th>
                  <th className="text-right px-4 py-2.5 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {items.data.map((h) => (
                  <tr key={h.id} className="hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-2.5">
                      <p className="text-white text-xs truncate max-w-xs">{basename(h.video_path) || h.description}</p>
                      {basename(h.video_path) && <p className="text-[10px] text-gray-600 truncate max-w-xs">{h.description}</p>}
                    </td>
                    <td className="px-4 py-2.5 hidden sm:table-cell">
                      {h.language && (
                        <span className="text-xs text-gray-300">{h.language.name || h.language.code2}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 hidden md:table-cell">
                      {h.provider || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-gray-600 tabular-nums">
                      {h.timestamp ? timeAgo(h.timestamp) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>{total} total</span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 transition-colors"
                >
                  ‹ Prev
                </button>
                <span className="px-2.5 py-1">{page + 1} / {pages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                  disabled={page >= pages - 1}
                  className="px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 transition-colors"
                >
                  Next ›
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Providers ──────────────────────────────────────────────────────────────

function Providers() {
  const { data, isLoading } = useQuery<Provider[]>({
    queryKey: ['bazarr-providers'],
    queryFn: async () => (await api.get('/proxy/bazarr/api/providers')).data,
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {[...Array(8)].map((_, i) => <div key={i} className="h-20 bg-gray-900 rounded-lg animate-pulse" />)}
      </div>
    )
  }

  if (!data?.length) {
    return <div className="text-center py-20 text-gray-600 text-sm">No providers configured</div>
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {data.map((p) => (
        <div key={p.name} className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-white font-medium truncate">{p.name}</span>
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${p.status ? 'bg-green-400' : 'bg-red-500'}`} />
          </div>
          {p.total_count !== undefined && (
            <p className="text-xs text-gray-500">{p.total_count.toLocaleString()} subs</p>
          )}
          {p.last_query && (
            <p className="text-[10px] text-gray-600">Last: {timeAgo(p.last_query)}</p>
          )}
          {p.errors && p.errors.length > 0 && (
            <p className="text-[10px] text-red-500 truncate">{p.errors[0]}</p>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

type Tab = 'wanted-movies' | 'wanted-episodes' | 'history' | 'providers'

export default function Subtitles() {
  const { enabledServices } = useConfig()
  const [tab, setTab] = useState<Tab>('wanted-movies')

  const enabled = enabledServices.includes('bazarr')

  if (!enabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Subtitles</h1>
        <p className="text-gray-500">Enable Bazarr in Settings to manage subtitles.</p>
      </div>
    )
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'wanted-movies', label: 'Wanted Movies' },
    { id: 'wanted-episodes', label: 'Wanted Episodes' },
    { id: 'history', label: 'History' },
    { id: 'providers', label: 'Providers' },
  ]

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-white mb-5">Subtitles</h1>

      {/* Tab bar */}
      <div className="flex gap-1 mb-5 border-b border-gray-800 pb-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-blue-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'wanted-movies' && <WantedMovies />}
      {tab === 'wanted-episodes' && <WantedEpisodes />}
      {tab === 'history' && <History />}
      {tab === 'providers' && <Providers />}
    </div>
  )
}
