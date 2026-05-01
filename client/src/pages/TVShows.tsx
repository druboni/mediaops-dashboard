import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

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
interface HistoryRecord {
  id: number
  eventType: string
  date: string
  sourceTitle: string
  quality?: { quality: { name: string } }
  series?: { title: string }
  episode?: { seasonNumber: number; episodeNumber: number; title: string }
}

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

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const EVENT_LABEL: Record<string, string> = {
  grabbed: 'Grabbed',
  downloadFolderImported: 'Imported',
  downloadFailed: 'Failed',
  episodeFileDeleted: 'Deleted',
  episodeFileRenamed: 'Renamed',
  seriesAdd: 'Added',
  ignored: 'Ignored',
}

// ── Detail Panel ───────────────────────────────────────────────────────────

function SeriesDetailPanel({
  series, profiles, onClose, onUpdate, onDelete, onSearch, onSeasonToggle,
}: {
  series: SonarrSeries
  profiles: QualityProfile[]
  onClose: () => void
  onUpdate: (s: SonarrSeries) => void
  onDelete: (s: SonarrSeries, files: boolean) => void
  onSearch: (s: SonarrSeries) => void
  onSeasonToggle: (s: SonarrSeries, seasonNumber: number) => void
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const profileName = profiles.find((p) => p.id === series.qualityProfileId)?.name ?? '—'
  const { have, total } = seriesProgress(series)
  const poster = posterUrl(series)

  const { data: history } = useQuery<{ records: HistoryRecord[] }>({
    queryKey: ['sonarr-series-history', series.id],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/history', {
      params: { seriesId: series.id, pageSize: 8, sortKey: 'date', sortDirection: 'descending' },
    })).data,
    staleTime: 30_000,
  })

  const displaySeasons = [...(series.seasons ?? [])]
    .filter((s) => s.seasonNumber > 0)
    .sort((a, b) => b.seasonNumber - a.seasonNumber)

  return (
    <div className="fixed right-0 top-0 h-screen w-[420px] bg-gray-900 border-l border-gray-800 flex flex-col z-40 overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
        <span className="text-sm font-semibold text-white truncate pr-2">{series.title}</span>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors shrink-0">✕</button>
      </div>

      <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
        {/* Poster + meta */}
        <div className="flex gap-4">
          {poster ? (
            <img src={poster} alt="" className="w-20 rounded-md shrink-0 object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <div className="w-20 h-28 bg-gray-800 rounded-md shrink-0 flex items-center justify-center text-gray-600 text-xs">No poster</div>
          )}
          <div className="min-w-0">
            <p className="text-white font-semibold text-sm">{series.title}</p>
            <p className="text-gray-500 text-xs mt-0.5">{series.year}{series.network ? ` · ${series.network}` : ''}{series.runtime ? ` · ${series.runtime}m` : ''}</p>
            <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-medium mt-1 ${
              series.status === 'continuing' ? 'bg-green-900/60 text-green-400' :
              series.status === 'ended' ? 'bg-gray-800 text-gray-400' :
              'bg-yellow-900/60 text-yellow-400'
            }`}>
              {series.status.charAt(0).toUpperCase() + series.status.slice(1)}
            </span>
            <p className="text-xs text-gray-500 mt-1">{profileName}</p>
            <p className="text-xs text-gray-500 mt-0.5">{have} / {total} episodes · {formatBytes(series.statistics?.sizeOnDisk ?? 0)}</p>
          </div>
        </div>

        {/* Overview */}
        {series.overview && (
          <p className="text-xs text-gray-400 leading-relaxed line-clamp-4">{series.overview}</p>
        )}

        {/* Seasons */}
        {displaySeasons.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Seasons</p>
            <div className="space-y-1">
              {displaySeasons.map((season) => {
                const stats = season.statistics
                const have = stats?.episodeFileCount ?? 0
                const total = stats?.episodeCount ?? 0
                const pct = total > 0 ? have / total : 0
                return (
                  <div key={season.seasonNumber} className="flex items-center gap-3 bg-gray-800/40 rounded-lg px-3 py-2">
                    <button
                      onClick={() => onSeasonToggle(series, season.seasonNumber)}
                      title={season.monitored ? 'Click to unmonitor' : 'Click to monitor'}
                      className={`w-3 h-3 rounded-full shrink-0 border-2 transition-colors ${
                        season.monitored ? 'bg-blue-500 border-blue-500' : 'bg-transparent border-gray-600 hover:border-gray-400'
                      }`}
                    />
                    <span className="text-xs text-gray-300 w-16 shrink-0">Season {season.seasonNumber}</span>
                    <div className="flex-1 bg-gray-700 rounded-full h-1">
                      <div className="bg-blue-500 h-1 rounded-full" style={{ width: `${Math.round(pct * 100)}%` }} />
                    </div>
                    <span className="text-xs text-gray-500 tabular-nums shrink-0">{have}/{total}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* History */}
        {history?.records && history.records.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">History</p>
            <div className="space-y-1">
              {history.records.slice(0, 6).map((h) => (
                <div key={h.id} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                      h.eventType === 'downloadFolderImported' ? 'bg-green-900/60 text-green-400' :
                      h.eventType === 'downloadFailed' ? 'bg-red-900/60 text-red-400' :
                      h.eventType === 'grabbed' ? 'bg-blue-900/60 text-blue-400' :
                      'bg-gray-800 text-gray-500'
                    }`}>
                      {EVENT_LABEL[h.eventType] ?? h.eventType}
                    </span>
                    {h.episode && (
                      <span className="text-xs text-gray-500 truncate">
                        S{String(h.episode.seasonNumber).padStart(2,'0')}E{String(h.episode.episodeNumber).padStart(2,'0')}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-600 shrink-0">{timeAgo(h.date)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-5 py-4 border-t border-gray-800 shrink-0 space-y-2">
        {showDeleteConfirm ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-400">Remove series from Sonarr?</p>
            <div className="flex gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 text-xs py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={() => { onDelete(series, false); setShowDeleteConfirm(false) }} className="flex-1 text-xs py-1.5 rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Remove</button>
              <button onClick={() => { onDelete(series, true); setShowDeleteConfirm(false) }} className="flex-1 text-xs py-1.5 rounded bg-red-950 border border-red-800 text-red-300 hover:bg-red-900 transition-colors">+Files</button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => onSearch(series)} className="flex-1 text-xs py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors">Search</button>
            <button
              onClick={() => onUpdate({ ...series, monitored: !series.monitored })}
              className={`flex-1 text-xs py-1.5 rounded border transition-colors ${
                series.monitored
                  ? 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  : 'bg-yellow-900/30 border-yellow-700 text-yellow-400 hover:bg-yellow-900/50'
              }`}
            >
              {series.monitored ? 'Monitored' : 'Unmonitored'}
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 border border-gray-700 hover:border-red-800 transition-colors"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  )
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

export default function TVShows() {
  const { enabledServices } = useConfig()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<SonarrSeries | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const enabled = enabledServices.includes('sonarr')

  const { data: series, isLoading } = useQuery<SonarrSeries[]>({
    queryKey: ['sonarr-series'],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/series')).data,
    enabled,
    staleTime: 60_000,
  })

  const { data: profiles = [] } = useQuery<QualityProfile[]>({
    queryKey: ['sonarr-profiles'],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/qualityprofile')).data,
    enabled,
    staleTime: 300_000,
  })

  const updateSeries = useMutation({
    mutationFn: (s: SonarrSeries) => api.put(`/proxy/sonarr/api/v3/series/${s.id}`, s),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['sonarr-series'] }); setSelected(null) },
  })

  const deleteSeries = useMutation({
    mutationFn: ({ s, deleteFiles }: { s: SonarrSeries; deleteFiles: boolean }) =>
      api.delete(`/proxy/sonarr/api/v3/series/${s.id}`, { params: { deleteFiles } }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['sonarr-series'] }); setSelected(null) },
  })

  const triggerSearch = useMutation({
    mutationFn: (s: SonarrSeries) =>
      api.post('/proxy/sonarr/api/v3/command', { name: 'SeriesSearch', seriesId: s.id }),
  })

  const toggleSeason = useMutation({
    mutationFn: ({ s, seasonNumber }: { s: SonarrSeries; seasonNumber: number }) => {
      const updated = {
        ...s,
        seasons: s.seasons.map((season) =>
          season.seasonNumber === seasonNumber ? { ...season, monitored: !season.monitored } : season
        ),
      }
      return api.put(`/proxy/sonarr/api/v3/series/${s.id}`, updated)
    },
    onSuccess: (_, { s, seasonNumber }) => {
      queryClient.invalidateQueries({ queryKey: ['sonarr-series'] })
      // Optimistically update selected series so the panel reflects the change immediately
      if (selected?.id === s.id) {
        setSelected((prev) => prev ? {
          ...prev,
          seasons: prev.seasons.map((season) =>
            season.seasonNumber === seasonNumber ? { ...season, monitored: !season.monitored } : season
          ),
        } : null)
      }
    },
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
    .sort((a, b) => a.title.localeCompare(b.title))

  const counts = {
    all: series?.length ?? 0,
    continuing: series?.filter((s) => s.status === 'continuing').length ?? 0,
    ended: series?.filter((s) => s.status === 'ended').length ?? 0,
    missing: series?.filter((s) => s.monitored && seriesProgress(s).pct < 1).length ?? 0,
  }

  return (
    <div className={`p-6 transition-all duration-200 ${selected ? 'pr-[436px]' : ''}`}>
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
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(10)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-600 text-sm">No shows found</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
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
          <SeriesDetailPanel
            series={selected}
            profiles={profiles}
            onClose={() => setSelected(null)}
            onUpdate={(s) => updateSeries.mutate(s)}
            onDelete={(s, files) => deleteSeries.mutate({ s, deleteFiles: files })}
            onSearch={(s) => triggerSearch.mutate(s)}
            onSeasonToggle={(s, seasonNumber) => toggleSeason.mutate({ s, seasonNumber })}
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
