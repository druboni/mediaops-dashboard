import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

// ── Types ──────────────────────────────────────────────────────────────────

interface MovieImage { coverType: string; remoteUrl?: string }
interface MovieFile {
  id: number
  relativePath: string
  size: number
  quality: { quality: { name: string } }
  mediaInfo?: { videoCodec: string; resolution: string; audioCodec: string }
}
interface RadarrMovie {
  id: number
  title: string
  year: number
  overview: string
  status: string
  hasFile: boolean
  monitored: boolean
  qualityProfileId: number
  sizeOnDisk: number
  path: string
  images: MovieImage[]
  movieFile?: MovieFile
  tmdbId: number
  imdbId?: string
  genres: string[]
  runtime: number
  ratings: { imdb?: { value: number }; tmdb?: { value: number } }
  titleSlug: string
  isAvailable: boolean
  certification?: string
  remotePoster?: string
}
interface QualityProfile { id: number; name: string }
interface RootFolder { id: number; path: string; freeSpace: number }
interface HistoryRecord {
  id: number
  eventType: string
  date: string
  sourceTitle: string
  quality?: { quality: { name: string } }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(b: number) {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${Math.round(b / 1024)} KB`
}

function formatRuntime(mins: number) {
  if (!mins) return null
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

function posterUrl(movie: Pick<RadarrMovie, 'images' | 'remotePoster'>) {
  return movie.remotePoster || movie.images?.find((i) => i.coverType === 'poster')?.remoteUrl || null
}

function movieStatus(m: RadarrMovie): { label: string; color: string } {
  if (!m.monitored) return { label: 'Unmonitored', color: 'text-gray-500' }
  if (m.hasFile) return { label: 'Downloaded', color: 'text-green-400' }
  if (!m.isAvailable) return { label: 'Not Available', color: 'text-gray-500' }
  return { label: 'Missing', color: 'text-red-400' }
}

const EVENT_LABEL: Record<string, string> = {
  grabbed: 'Grabbed',
  downloadFolderImported: 'Imported',
  downloadFailed: 'Failed',
  movieFileDeleted: 'File Deleted',
  movieFileRenamed: 'Renamed',
  movieAdded: 'Added',
  ignored: 'Ignored',
}

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Detail Panel ───────────────────────────────────────────────────────────

function MovieDetailPanel({
  movie, profiles, onClose, onUpdate, onDelete, onSearch, isSearching, searchQueued,
}: {
  movie: RadarrMovie
  profiles: QualityProfile[]
  onClose: () => void
  onUpdate: (m: RadarrMovie) => void
  onDelete: (m: RadarrMovie, files: boolean) => void
  onSearch: (m: RadarrMovie) => void
  isSearching: boolean
  searchQueued: boolean
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const profileName = profiles.find((p) => p.id === movie.qualityProfileId)?.name ?? '—'

  const { data: history } = useQuery<HistoryRecord[]>({
    queryKey: ['radarr-movie-history', movie.id],
    queryFn: async () => {
      const r = await api.get(`/proxy/radarr/api/v3/history/movie`, { params: { movieId: movie.id, pageSize: 8 } })
      return r.data
    },
    staleTime: 30_000,
  })

  const poster = posterUrl(movie)
  const { label: statusLabel, color: statusColor } = movieStatus(movie)

  return (
    <div className="fixed right-0 top-0 h-screen w-[420px] bg-gray-900 border-l border-gray-800 flex flex-col z-40 overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
        <span className="text-sm font-semibold text-white truncate pr-2">{movie.title}</span>
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
            <p className="text-white font-semibold text-sm">{movie.title}</p>
            <p className="text-gray-500 text-xs mt-0.5">{movie.year}{movie.runtime ? ` · ${formatRuntime(movie.runtime)}` : ''}{movie.certification ? ` · ${movie.certification}` : ''}</p>
            <p className={`text-xs mt-1 font-medium ${statusColor}`}>{statusLabel}</p>
            <p className="text-xs text-gray-500 mt-0.5">{profileName}</p>
            {movie.genres?.length > 0 && (
              <p className="text-xs text-gray-600 mt-1">{movie.genres.slice(0, 3).join(', ')}</p>
            )}
            {movie.ratings?.imdb && (
              <p className="text-xs text-gray-500 mt-0.5">IMDb {movie.ratings.imdb.value.toFixed(1)}</p>
            )}
          </div>
        </div>

        {/* Overview */}
        {movie.overview && (
          <p className="text-xs text-gray-400 leading-relaxed line-clamp-4">{movie.overview}</p>
        )}

        {/* File info */}
        {movie.movieFile && (
          <div className="bg-gray-800/60 rounded-lg p-3 space-y-1">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">File</p>
            <p className="text-xs text-gray-300">{movie.movieFile.quality.quality.name}</p>
            {movie.movieFile.mediaInfo && (
              <p className="text-xs text-gray-500">{movie.movieFile.mediaInfo.videoCodec} · {movie.movieFile.mediaInfo.resolution} · {movie.movieFile.mediaInfo.audioCodec}</p>
            )}
            <p className="text-xs text-gray-500">{formatBytes(movie.movieFile.size)}</p>
            <p className="text-xs text-gray-600 truncate" title={movie.movieFile.relativePath}>{movie.movieFile.relativePath}</p>
          </div>
        )}

        {/* History */}
        {history && history.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">History</p>
            <div className="space-y-1">
              {history.slice(0, 6).map((h) => (
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
                    {h.quality && <span className="text-xs text-gray-500 truncate">{h.quality.quality.name}</span>}
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
            <p className="text-xs text-gray-400">Delete from Radarr?</p>
            <div className="flex gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 text-xs py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={() => { onDelete(movie, false); setShowDeleteConfirm(false) }} className="flex-1 text-xs py-1.5 rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Remove</button>
              {movie.hasFile && (
                <button onClick={() => { onDelete(movie, true); setShowDeleteConfirm(false) }} className="flex-1 text-xs py-1.5 rounded bg-red-950 border border-red-800 text-red-300 hover:bg-red-900 transition-colors">+Files</button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => onSearch(movie)}
              disabled={isSearching}
              className={`flex-1 text-xs py-1.5 rounded text-white transition-colors ${
                searchQueued ? 'bg-green-700' : 'bg-blue-700 hover:bg-blue-600'
              } disabled:opacity-60`}
            >
              {isSearching ? 'Searching…' : searchQueued ? 'Queued!' : 'Search'}
            </button>
            <button
              onClick={() => onUpdate({ ...movie, monitored: !movie.monitored })}
              className={`flex-1 text-xs py-1.5 rounded border transition-colors ${
                movie.monitored
                  ? 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  : 'bg-yellow-900/30 border-yellow-700 text-yellow-400 hover:bg-yellow-900/50'
              }`}
            >
              {movie.monitored ? 'Monitored' : 'Unmonitored'}
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

// ── Add Movie Modal ────────────────────────────────────────────────────────

function AddMovieModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selected, setSelected] = useState<RadarrMovie | null>(null)
  const [qualityProfileId, setQualityProfileId] = useState<number | null>(null)
  const [rootFolder, setRootFolder] = useState('')
  const [monitored, setMonitored] = useState(true)
  const [searchOnAdd, setSearchOnAdd] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(t)
  }, [search])

  const { data: results, isFetching } = useQuery<RadarrMovie[]>({
    queryKey: ['radarr-lookup', debouncedSearch],
    queryFn: async () => {
      const r = await api.get('/proxy/radarr/api/v3/movie/lookup', { params: { term: debouncedSearch } })
      return r.data
    },
    enabled: debouncedSearch.length > 1,
    staleTime: 60_000,
  })

  const { data: profiles } = useQuery<QualityProfile[]>({
    queryKey: ['radarr-profiles'],
    queryFn: async () => (await api.get('/proxy/radarr/api/v3/qualityprofile')).data,
    staleTime: 300_000,
  })

  const { data: rootFolders } = useQuery<RootFolder[]>({
    queryKey: ['radarr-rootfolders'],
    queryFn: async () => (await api.get('/proxy/radarr/api/v3/rootfolder')).data,
    staleTime: 300_000,
  })

  useEffect(() => {
    if (profiles?.length && !qualityProfileId) setQualityProfileId(profiles[0].id)
  }, [profiles])

  useEffect(() => {
    if (rootFolders?.length && !rootFolder) setRootFolder(rootFolders[0].path)
  }, [rootFolders])

  const addMutation = useMutation({
    mutationFn: (movie: RadarrMovie) =>
      api.post('/proxy/radarr/api/v3/movie', {
        ...movie,
        qualityProfileId: qualityProfileId!,
        rootFolderPath: rootFolder,
        monitored,
        addOptions: { searchForMovie: searchOnAdd },
      }),
    onSuccess: () => { onAdded(); onClose() },
  })

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h3 className="text-white font-semibold">Add Movie</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>

        <div className="px-5 py-3 border-b border-gray-800 shrink-0">
          <input
            autoFocus
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelected(null) }}
            placeholder="Search movies…"
            className="input w-full"
          />
        </div>

        <div className="overflow-y-auto flex-1">
          {isFetching && (
            <div className="p-4 text-center text-gray-500 text-sm">Searching…</div>
          )}
          {!isFetching && results && results.length === 0 && (
            <div className="p-4 text-center text-gray-600 text-sm">No results</div>
          )}
          {results && results.map((r) => {
            const inLibrary = r.id > 0
            const isSelected = selected?.tmdbId === r.tmdbId
            const poster = posterUrl(r)
            return (
              <div key={r.tmdbId}>
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
                    <p className="text-xs text-gray-500">{r.year}</p>
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
                      {addMutation.isPending ? 'Adding…' : 'Add Movie'}
                    </button>
                    {addMutation.isError && (
                      <p className="text-xs text-red-400">{(addMutation.error as Error)?.message}</p>
                    )}
                  </div>
                )}
                {isSelected && inLibrary && (
                  <p className="px-5 pb-3 text-xs text-gray-500">Already in your Radarr library.</p>
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

type StatusFilter = 'all' | 'downloaded' | 'missing' | 'unmonitored'
type SortKey = 'title-asc' | 'title-desc' | 'size-desc' | 'year-desc' | 'year-asc' | 'rating-desc'

export default function Movies() {
  const { enabledServices } = useConfig()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<RadarrMovie | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortKey>('title-asc')

  const enabled = enabledServices.includes('radarr')

  const { data: movies, isLoading } = useQuery<RadarrMovie[]>({
    queryKey: ['radarr-movies'],
    queryFn: async () => (await api.get('/proxy/radarr/api/v3/movie')).data,
    enabled,
    staleTime: 60_000,
  })

  const { data: profiles = [] } = useQuery<QualityProfile[]>({
    queryKey: ['radarr-profiles'],
    queryFn: async () => (await api.get('/proxy/radarr/api/v3/qualityprofile')).data,
    enabled,
    staleTime: 300_000,
  })

  const updateMovie = useMutation({
    mutationFn: (m: RadarrMovie) => api.put(`/proxy/radarr/api/v3/movie/${m.id}`, m),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['radarr-movies'] })
      setSelected(null)
    },
  })

  const deleteMovie = useMutation({
    mutationFn: ({ movie, deleteFiles }: { movie: RadarrMovie; deleteFiles: boolean }) =>
      api.delete(`/proxy/radarr/api/v3/movie/${movie.id}`, { params: { deleteFiles } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['radarr-movies'] })
      setSelected(null)
    },
  })

  const triggerSearch = useMutation({
    mutationFn: (movie: RadarrMovie) =>
      api.post('/proxy/radarr/api/v3/command', { name: 'MoviesSearch', movieIds: [movie.id] }),
  })

  if (!enabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Movies</h1>
        <p className="text-gray-500">Enable Radarr in Settings to manage movies.</p>
      </div>
    )
  }

  const filtered = (movies ?? [])
    .filter((m) => {
      if (search && !m.title.toLowerCase().includes(search.toLowerCase())) return false
      if (statusFilter === 'downloaded' && !m.hasFile) return false
      if (statusFilter === 'missing' && (m.hasFile || !m.monitored)) return false
      if (statusFilter === 'unmonitored' && m.monitored) return false
      return true
    })
    .sort((a, b) => {
      switch (sort) {
        case 'title-desc': return b.title.localeCompare(a.title)
        case 'size-desc':  return (b.sizeOnDisk ?? 0) - (a.sizeOnDisk ?? 0)
        case 'year-desc':  return (b.year ?? 0) - (a.year ?? 0)
        case 'year-asc':   return (a.year ?? 0) - (b.year ?? 0)
        case 'rating-desc': return (b.ratings?.tmdb?.value ?? b.ratings?.imdb?.value ?? 0) - (a.ratings?.tmdb?.value ?? a.ratings?.imdb?.value ?? 0)
        default: return a.title.localeCompare(b.title)
      }
    })

  const counts = {
    all: movies?.length ?? 0,
    downloaded: movies?.filter((m) => m.hasFile).length ?? 0,
    missing: movies?.filter((m) => !m.hasFile && m.monitored).length ?? 0,
    unmonitored: movies?.filter((m) => !m.monitored).length ?? 0,
  }

  return (
    <div className={`p-6 transition-all duration-200 ${selected ? 'pr-[436px]' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Movies</h1>
          {movies && <p className="text-xs text-gray-500 mt-0.5">{movies.length} movies</p>}
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="text-sm px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          + Add Movie
        </button>
      </div>

      {/* Search + filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search movies…"
          className="input w-64"
        />
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          {(['all', 'downloaded', 'missing', 'unmonitored'] as StatusFilter[]).map((f) => (
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
          <option value="year-desc">Year ↓</option>
          <option value="year-asc">Year ↑</option>
          <option value="rating-desc">Rating ↓</option>
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(10)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-600 text-sm">No movies found</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Title</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Year</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Quality</th>
                <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {filtered.map((movie) => {
                const { label, color } = movieStatus(movie)
                const isActive = selected?.id === movie.id
                return (
                  <tr
                    key={movie.id}
                    onClick={() => setSelected(isActive ? null : movie)}
                    className={`cursor-pointer transition-colors ${
                      isActive ? 'bg-blue-900/20' : 'hover:bg-gray-800/40'
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          color === 'text-green-400' ? 'bg-green-400' :
                          color === 'text-red-400' ? 'bg-red-500' : 'bg-gray-600'
                        }`} />
                        <span className="text-white text-sm truncate">{movie.title}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs hidden sm:table-cell">{movie.year}</td>
                    <td className={`px-4 py-2.5 text-xs ${color}`}>{label}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 hidden md:table-cell">
                      {movie.movieFile?.quality.quality.name ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 tabular-nums hidden lg:table-cell">
                      {movie.sizeOnDisk ? formatBytes(movie.sizeOnDisk) : '—'}
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
          <MovieDetailPanel
            movie={selected}
            profiles={profiles}
            onClose={() => setSelected(null)}
            onUpdate={(m) => updateMovie.mutate(m)}
            onDelete={(m, files) => deleteMovie.mutate({ movie: m, deleteFiles: files })}
            onSearch={(m) => triggerSearch.mutate(m)}
            isSearching={triggerSearch.isPending}
            searchQueued={triggerSearch.isSuccess && triggerSearch.variables?.id === selected.id}
          />
        </>
      )}

      {/* Add Modal */}
      {showAdd && (
        <AddMovieModal
          onClose={() => setShowAdd(false)}
          onAdded={() => queryClient.invalidateQueries({ queryKey: ['radarr-movies'] })}
        />
      )}
    </div>
  )
}
