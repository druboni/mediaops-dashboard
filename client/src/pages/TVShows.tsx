import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'
import MediaDetail from '../components/MediaDetail'

// ── Types ──────────────────────────────────────────────────────────────────

interface SeriesImage { coverType: string; remoteUrl?: string }
interface SeasonStats { episodeFileCount: number; episodeCount: number; totalEpisodeCount: number; sizeOnDisk: number; percentOfEpisodes: number }
interface Season { seasonNumber: number; monitored: boolean; statistics?: SeasonStats }
interface SonarrSeries {
  id: number
  title: string
  year: number
  overview: string
  status: 'continuing' | 'ended' | 'upcoming' | 'deleted'
  monitored: boolean
  qualityProfileId: number
  path: string
  images: SeriesImage[]
  genres: string[]
  network?: string
  seasons: Season[]
  statistics: {
    episodeFileCount: number
    episodeCount: number
    totalEpisodeCount: number
    sizeOnDisk: number
    percentOfEpisodes: number
    previousAiring?: string
    nextAiring?: string
  }
  titleSlug: string
  tvdbId: number
  remotePoster?: string
  certification?: string
  runtime?: number
}
interface QualityProfile { id: number; name: string }
interface RootFolder { id: number; path: string }
// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(b: number) {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(0)} MB`
  return '—'
}

function posterUrl(s: Pick<SonarrSeries, 'images' | 'remotePoster'>) {
  return s.remotePoster || s.images?.find((i) => i.coverType === 'poster')?.remoteUrl || null
}

function seriesProgress(s: SonarrSeries) {
  const total = s.statistics?.episodeCount ?? 0
  const have = s.statistics?.episodeFileCount ?? 0
  return { have, total, pct: total > 0 ? have / total : 0 }
}

// ── Add Series Modal ───────────────────────────────────────────────────────

function AddSeriesModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selected, setSelected] = useState<SonarrSeries | null>(null)
  const [qualityProfileId, setQualityProfileId] = useState<number | null>(null)
  const [rootFolder, setRootFolder] = useState('')
  const [monitored, setMonitored] = useState(true)
  const [searchOnAdd, setSearchOnAdd] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(t)
  }, [search])

  const { data: results, isFetching } = useQuery<SonarrSeries[]>({
    queryKey: ['sonarr-lookup', debouncedSearch],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/series/lookup', { params: { term: debouncedSearch } })).data,
    enabled: debouncedSearch.length > 1,
    staleTime: 60_000,
  })

  const { data: profiles } = useQuery<QualityProfile[]>({
    queryKey: ['sonarr-profiles'],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/qualityprofile')).data,
    staleTime: 300_000,
  })

  const { data: rootFolders } = useQuery<RootFolder[]>({
    queryKey: ['sonarr-rootfolders'],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/rootfolder')).data,
    staleTime: 300_000,
  })

  useEffect(() => {
    if (profiles?.length && !qualityProfileId) setQualityProfileId(profiles[0].id)
  }, [profiles])

  useEffect(() => {
    if (rootFolders?.length && !rootFolder) setRootFolder(rootFolders[0].path)
  }, [rootFolders])

  const addMutation = useMutation({
    mutationFn: (series: SonarrSeries) =>
      api.post('/proxy/sonarr/api/v3/series', {
        ...series,
        qualityProfileId: qualityProfileId!,
        rootFolderPath: rootFolder,
        monitored,
        addOptions: {
          monitor: 'all',
          searchForMissingEpisodes: searchOnAdd,
        },
      }),
    onSuccess: () => { onAdded(); onClose() },
  })

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h3 className="text-white font-semibold">Add TV Show</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>
        <div className="px-5 py-3 border-b border-gray-800 shrink-0">
          <input
            autoFocus
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelected(null) }}
            placeholder="Search TV shows…"
            className="input w-full"
          />
        </div>

        <div className="overflow-y-auto flex-1">
          {isFetching && <div className="p-4 text-center text-gray-500 text-sm">Searching…</div>}
          {!isFetching && results && results.length === 0 && <div className="p-4 text-center text-gray-600 text-sm">No results</div>}
          {results?.map((r) => {
            const inLibrary = r.id > 0
            const isSelected = selected?.tvdbId === r.tvdbId
            const poster = posterUrl(r)
            return (
              <div key={r.tvdbId}>
                <button
                  onClick={() => setSelected(isSelected ? null : r)}
                  className={`w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-gray-800/50 transition-colors ${isSelected ? 'bg-gray-800/60' : ''}`}
                >
                  {poster
                    ? <img src={poster} alt="" className="w-10 h-14 rounded object-cover shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    : <div className="w-10 h-14 bg-gray-800 rounded shrink-0" />
                  }
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{r.title}</p>
                    <p className="text-xs text-gray-500">{r.year}{r.network ? ` · ${r.network}` : ''}</p>
                  </div>
                  {inLibrary && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/60 text-green-400 shrink-0">In Library</span>}
                </button>

                {isSelected && !inLibrary && (
                  <div className="px-5 pb-4 space-y-3 bg-gray-800/30">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">Quality</label>
                        <select value={qualityProfileId ?? ''} onChange={(e) => setQualityProfileId(Number(e.target.value))} className="input w-full text-xs">
                          {profiles?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">Root Folder</label>
                        <select value={rootFolder} onChange={(e) => setRootFolder(e.target.value)} className="input w-full text-xs">
                          {rootFolders?.map((f) => <option key={f.id} value={f.path}>{f.path}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                        <input type="checkbox" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} className="accent-blue-500" />
                        Monitored
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                        <input type="checkbox" checked={searchOnAdd} onChange={(e) => setSearchOnAdd(e.target.checked)} className="accent-blue-500" />
                        Search on add
                      </label>
                    </div>
                    <button
                      onClick={() => addMutation.mutate(r)}
                      disabled={addMutation.isPending || !qualityProfileId || !rootFolder}
                      className="w-full text-sm py-2 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
                    >
                      {addMutation.isPending ? 'Adding…' : 'Add Series'}
                    </button>
                    {addMutation.isError && (
                      <p className="text-xs text-red-400">{(addMutation.error as Error)?.message}</p>
                    )}
                  </div>
                )}
                {isSelected && inLibrary && (
                  <p className="px-5 pb-3 text-xs text-gray-500">Already in your Sonarr library.</p>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'continuing' | 'ended' | 'missing'
type SortKey = 'title-asc' | 'title-desc' | 'size-desc' | 'episodes-desc' | 'progress-asc' | 'progress-desc'

export default function TVShows() {
  const { enabledServices } = useConfig()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<SonarrSeries | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortKey>('title-asc')

  const enabled = enabledServices.includes('sonarr')

  const { data: series, isLoading } = useQuery<SonarrSeries[]>({
    queryKey: ['sonarr-series'],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/series')).data,
    enabled,
    staleTime: 60_000,
  })

  if (!enabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">TV Shows</h1>
        <p className="text-gray-500">Enable Sonarr in Settings to manage TV shows.</p>
      </div>
    )
  }

  const filtered = (series ?? [])
    .filter((s) => {
      if (search && !s.title.toLowerCase().includes(search.toLowerCase())) return false
      if (statusFilter === 'continuing' && s.status !== 'continuing') return false
      if (statusFilter === 'ended' && s.status !== 'ended') return false
      if (statusFilter === 'missing') {
        const p = seriesProgress(s)
        if (p.pct >= 1 || !s.monitored) return false
      }
      return true
    })
    .sort((a, b) => {
      switch (sort) {
        case 'title-desc': return b.title.localeCompare(a.title)
        case 'size-desc':  return (b.statistics?.sizeOnDisk ?? 0) - (a.statistics?.sizeOnDisk ?? 0)
        case 'episodes-desc': return (b.statistics?.episodeFileCount ?? 0) - (a.statistics?.episodeFileCount ?? 0)
        case 'progress-asc': return seriesProgress(a).pct - seriesProgress(b).pct
        case 'progress-desc': return seriesProgress(b).pct - seriesProgress(a).pct
        default: return a.title.localeCompare(b.title)
      }
    })

  const counts = {
    all: series?.length ?? 0,
    continuing: series?.filter((s) => s.status === 'continuing').length ?? 0,
    ended: series?.filter((s) => s.status === 'ended').length ?? 0,
    missing: series?.filter((s) => s.monitored && seriesProgress(s).pct < 1).length ?? 0,
  }

  return (
    <div className={`p-6 transition-all duration-200 ${selected ? 'sm:pr-[436px]' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">TV Shows</h1>
          {series && <p className="text-xs text-gray-500 mt-0.5">{series.length} series</p>}
        </div>
        <button onClick={() => setShowAdd(true)} className="text-sm px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">
          + Add Show
        </button>
      </div>

      {/* Search + filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search shows…"
          className="input w-64"
        />
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          {(['all', 'continuing', 'ended', 'missing'] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1.5 transition-colors capitalize ${
                statusFilter === f ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
              }`}
            >
              {f} <span className="opacity-60">({counts[f]})</span>
            </button>
          ))}
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="input text-xs py-1.5 pr-7">
          <option value="title-asc">Title A→Z</option>
          <option value="title-desc">Title Z→A</option>
          <option value="size-desc">Size ↓</option>
          <option value="episodes-desc">Episodes ↓</option>
          <option value="progress-desc">Progress ↓</option>
          <option value="progress-asc">Progress ↑</option>
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(10)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-600 text-sm">No shows found</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Title</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Status</th>
                <th className="text-left px-4 py-2.5 font-medium">Episodes</th>
                <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {filtered.map((show) => {
                const { have, total, pct } = seriesProgress(show)
                const isActive = selected?.id === show.id
                const statusDot = show.status === 'continuing'
                  ? 'bg-green-400'
                  : show.status === 'ended'
                    ? 'bg-gray-600'
                    : 'bg-yellow-400'
                return (
                  <tr
                    key={show.id}
                    onClick={() => setSelected(isActive ? null : show)}
                    className={`cursor-pointer transition-colors ${isActive ? 'bg-blue-900/20' : 'hover:bg-gray-800/40'}`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {!show.monitored && <span className="w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" />}
                        <span className="text-white text-sm truncate">{show.title}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 hidden sm:table-cell">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
                        <span className="text-xs text-gray-400 capitalize">{show.status}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-gray-800 rounded-full h-1">
                          <div className="bg-blue-500 h-1 rounded-full" style={{ width: `${Math.round(pct * 100)}%` }} />
                        </div>
                        <span className="text-xs text-gray-500 tabular-nums">{have}/{total}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 tabular-nums hidden lg:table-cell">
                      {formatBytes(show.statistics?.sizeOnDisk ?? 0)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Panel */}
      {selected && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setSelected(null)} />
          <MediaDetail
            kind="series"
            id={selected.id}
            onClose={() => setSelected(null)}
            onChanged={() => queryClient.invalidateQueries({ queryKey: ['sonarr-series'] })}
          />
        </>
      )}

      {/* Add Modal */}
      {showAdd && (
        <AddSeriesModal
          onClose={() => setShowAdd(false)}
          onAdded={() => queryClient.invalidateQueries({ queryKey: ['sonarr-series'] })}
        />
      )}
    </div>
  )
}
