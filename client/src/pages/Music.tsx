import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

// ── Types ──────────────────────────────────────────────────────────────────

interface LidarrImage { coverType: string; remoteUrl?: string; url?: string }
interface LidarrAlbum {
  id: number
  title: string
  releaseDate?: string
  monitored: boolean
  artistId: number
  albumType?: string
  images: LidarrImage[]
  statistics?: { trackCount: number; trackFileCount: number; sizeOnDisk: number; percentOfTracks: number }
  foreignAlbumId: string
}
interface LidarrArtist {
  id: number
  artistName: string
  sortName: string
  status: 'continuing' | 'ended'
  overview?: string
  monitored: boolean
  qualityProfileId: number
  metadataProfileId: number
  path: string
  genres: string[]
  images: LidarrImage[]
  statistics?: { albumCount: number; trackCount: number; trackFileCount: number; sizeOnDisk: number; percentOfTracks: number }
  foreignArtistId: string
}
interface QualityProfile { id: number; name: string }
interface MetadataProfile { id: number; name: string }
interface RootFolder { id: number; path: string }
interface HistoryRecord {
  id: number
  eventType: string
  date: string
  sourceTitle: string
  quality?: { quality: { name: string } }
  album?: { title: string }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(b: number) {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(0)} MB`
  return '—'
}

function artistImage(a: Pick<LidarrArtist, 'images'>, type: 'poster' | 'fanart' | 'cover') {
  return a.images?.find((i) => i.coverType === type)?.remoteUrl
    || a.images?.find((i) => i.coverType === 'cover')?.remoteUrl
    || null
}

function albumCover(a: Pick<LidarrAlbum, 'images'>) {
  return a.images?.find((i) => i.coverType === 'cover')?.remoteUrl || null
}

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function releaseYear(d?: string) {
  if (!d) return ''
  return new Date(d).getFullYear().toString()
}

const EVENT_LABEL: Record<string, string> = {
  grabbed: 'Grabbed',
  downloadImported: 'Imported',
  downloadFailed: 'Failed',
  trackFileDeleted: 'Deleted',
  trackFileRenamed: 'Renamed',
  artistAdded: 'Added',
  ignored: 'Ignored',
}

// ── Detail Panel ───────────────────────────────────────────────────────────

function ArtistDetailPanel({
  artist, profiles, metaProfiles, albums, albumsLoading,
  onClose, onUpdate, onDelete, onSearch, onAlbumToggle,
}: {
  artist: LidarrArtist
  profiles: QualityProfile[]
  metaProfiles: MetadataProfile[]
  albums: LidarrAlbum[]
  albumsLoading: boolean
  onClose: () => void
  onUpdate: (a: LidarrArtist) => void
  onDelete: (a: LidarrArtist, files: boolean) => void
  onSearch: (a: LidarrArtist) => void
  onAlbumToggle: (album: LidarrAlbum) => void
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const profileName = profiles.find((p) => p.id === artist.qualityProfileId)?.name ?? '—'
  const metaName = metaProfiles.find((p) => p.id === artist.metadataProfileId)?.name ?? '—'
  const poster = artistImage(artist, 'poster')
  const trackHave = artist.statistics?.trackFileCount ?? 0
  const trackTotal = artist.statistics?.trackCount ?? 0

  const { data: history } = useQuery<{ records: HistoryRecord[] }>({
    queryKey: ['lidarr-artist-history', artist.id],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/history', {
      params: { artistId: artist.id, pageSize: 8, sortKey: 'date', sortDirection: 'descending' },
    })).data,
    staleTime: 30_000,
  })

  const sortedAlbums = [...albums].sort((a, b) => {
    const ya = releaseYear(a.releaseDate)
    const yb = releaseYear(b.releaseDate)
    return yb.localeCompare(ya)
  })

  return (
    <div className="fixed right-0 top-0 h-screen w-[420px] bg-gray-900 border-l border-gray-800 flex flex-col z-40 overflow-hidden shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
        <span className="text-sm font-semibold text-white truncate pr-2">{artist.artistName}</span>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors shrink-0">✕</button>
      </div>

      <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
        {/* Poster + meta */}
        <div className="flex gap-4">
          {poster ? (
            <img src={poster} alt="" className="w-20 rounded-md shrink-0 object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <div className="w-20 h-28 bg-gray-800 rounded-md shrink-0 flex items-center justify-center text-gray-600 text-xs text-center">No image</div>
          )}
          <div className="min-w-0">
            <p className="text-white font-semibold text-sm">{artist.artistName}</p>
            <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-medium mt-1 ${
              artist.status === 'continuing' ? 'bg-green-900/60 text-green-400' : 'bg-gray-800 text-gray-400'
            }`}>
              {artist.status.charAt(0).toUpperCase() + artist.status.slice(1)}
            </span>
            {artist.genres?.length > 0 && (
              <p className="text-xs text-gray-500 mt-1">{artist.genres.slice(0, 3).join(', ')}</p>
            )}
            <p className="text-xs text-gray-500 mt-0.5">{profileName} · {metaName}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {artist.statistics?.albumCount ?? 0} albums · {trackHave}/{trackTotal} tracks · {formatBytes(artist.statistics?.sizeOnDisk ?? 0)}
            </p>
          </div>
        </div>

        {/* Overview */}
        {artist.overview && (
          <p className="text-xs text-gray-400 leading-relaxed line-clamp-4">{artist.overview}</p>
        )}

        {/* Albums */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Albums</p>
          {albumsLoading ? (
            <div className="space-y-1">
              {[...Array(4)].map((_, i) => <div key={i} className="h-10 bg-gray-800 rounded-lg animate-pulse" />)}
            </div>
          ) : sortedAlbums.length === 0 ? (
            <p className="text-xs text-gray-600">No albums found</p>
          ) : (
            <div className="space-y-1">
              {sortedAlbums.map((album) => {
                const have = album.statistics?.trackFileCount ?? 0
                const total = album.statistics?.trackCount ?? 0
                const pct = total > 0 ? have / total : 0
                const cover = albumCover(album)
                return (
                  <div key={album.id} className="flex items-center gap-3 bg-gray-800/40 rounded-lg px-3 py-2">
                    {cover ? (
                      <img src={cover} alt="" className="w-8 h-8 rounded shrink-0 object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    ) : (
                      <div className="w-8 h-8 bg-gray-700 rounded shrink-0" />
                    )}
                    <button
                      onClick={() => onAlbumToggle(album)}
                      title={album.monitored ? 'Click to unmonitor' : 'Click to monitor'}
                      className={`w-3 h-3 rounded-full shrink-0 border-2 transition-colors ${
                        album.monitored ? 'bg-blue-500 border-blue-500' : 'bg-transparent border-gray-600 hover:border-gray-400'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-300 truncate">{album.title}</p>
                      <p className="text-[10px] text-gray-600">{releaseYear(album.releaseDate)}{album.albumType ? ` · ${album.albumType}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <div className="w-10 bg-gray-700 rounded-full h-1">
                        <div className="bg-blue-500 h-1 rounded-full" style={{ width: `${Math.round(pct * 100)}%` }} />
                      </div>
                      <span className="text-[10px] text-gray-600 tabular-nums">{have}/{total}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* History */}
        {history?.records && history.records.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">History</p>
            <div className="space-y-1">
              {history.records.slice(0, 6).map((h) => (
                <div key={h.id} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                      h.eventType === 'downloadImported' ? 'bg-green-900/60 text-green-400' :
                      h.eventType === 'downloadFailed' ? 'bg-red-900/60 text-red-400' :
                      h.eventType === 'grabbed' ? 'bg-blue-900/60 text-blue-400' :
                      'bg-gray-800 text-gray-500'
                    }`}>
                      {EVENT_LABEL[h.eventType] ?? h.eventType}
                    </span>
                    {h.album && <span className="text-xs text-gray-500 truncate">{h.album.title}</span>}
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
            <p className="text-xs text-gray-400">Remove artist from Lidarr?</p>
            <div className="flex gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 text-xs py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={() => { onDelete(artist, false); setShowDeleteConfirm(false) }} className="flex-1 text-xs py-1.5 rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Remove</button>
              <button onClick={() => { onDelete(artist, true); setShowDeleteConfirm(false) }} className="flex-1 text-xs py-1.5 rounded bg-red-950 border border-red-800 text-red-300 hover:bg-red-900 transition-colors">+Files</button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button onClick={() => onSearch(artist)} className="flex-1 text-xs py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors">Search</button>
            <button
              onClick={() => onUpdate({ ...artist, monitored: !artist.monitored })}
              className={`flex-1 text-xs py-1.5 rounded border transition-colors ${
                artist.monitored
                  ? 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  : 'bg-yellow-900/30 border-yellow-700 text-yellow-400 hover:bg-yellow-900/50'
              }`}
            >
              {artist.monitored ? 'Monitored' : 'Unmonitored'}
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

// ── Add Artist Modal ───────────────────────────────────────────────────────

function AddArtistModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selected, setSelected] = useState<LidarrArtist | null>(null)
  const [qualityProfileId, setQualityProfileId] = useState<number | null>(null)
  const [metadataProfileId, setMetadataProfileId] = useState<number | null>(null)
  const [rootFolder, setRootFolder] = useState('')
  const [monitored, setMonitored] = useState(true)
  const [searchOnAdd, setSearchOnAdd] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(t)
  }, [search])

  const { data: results, isFetching } = useQuery<LidarrArtist[]>({
    queryKey: ['lidarr-lookup', debouncedSearch],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/artist/lookup', { params: { term: debouncedSearch } })).data,
    enabled: debouncedSearch.length > 1,
    staleTime: 60_000,
  })

  const { data: profiles } = useQuery<QualityProfile[]>({
    queryKey: ['lidarr-profiles'],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/qualityprofile')).data,
    staleTime: 300_000,
  })

  const { data: metaProfiles } = useQuery<MetadataProfile[]>({
    queryKey: ['lidarr-metaprofiles'],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/metadataprofile')).data,
    staleTime: 300_000,
  })

  const { data: rootFolders } = useQuery<RootFolder[]>({
    queryKey: ['lidarr-rootfolders'],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/rootfolder')).data,
    staleTime: 300_000,
  })

  useEffect(() => { if (profiles?.length && !qualityProfileId) setQualityProfileId(profiles[0].id) }, [profiles])
  useEffect(() => { if (metaProfiles?.length && !metadataProfileId) setMetadataProfileId(metaProfiles[0].id) }, [metaProfiles])
  useEffect(() => { if (rootFolders?.length && !rootFolder) setRootFolder(rootFolders[0].path) }, [rootFolders])

  const addMutation = useMutation({
    mutationFn: (artist: LidarrArtist) =>
      api.post('/proxy/lidarr/api/v1/artist', {
        ...artist,
        qualityProfileId: qualityProfileId!,
        metadataProfileId: metadataProfileId!,
        rootFolderPath: rootFolder,
        monitored,
        addOptions: {
          monitor: 'all',
          searchForMissingAlbums: searchOnAdd,
        },
      }),
    onSuccess: () => { onAdded(); onClose() },
  })

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h3 className="text-white font-semibold">Add Artist</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>
        <div className="px-5 py-3 border-b border-gray-800 shrink-0">
          <input
            autoFocus
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelected(null) }}
            placeholder="Search artists…"
            className="input w-full"
          />
        </div>

        <div className="overflow-y-auto flex-1">
          {isFetching && <div className="p-4 text-center text-gray-500 text-sm">Searching…</div>}
          {!isFetching && results && results.length === 0 && <div className="p-4 text-center text-gray-600 text-sm">No results</div>}
          {results?.map((r) => {
            const inLibrary = r.id > 0
            const isSelected = selected?.foreignArtistId === r.foreignArtistId
            const img = artistImage(r, 'poster')
            return (
              <div key={r.foreignArtistId}>
                <button
                  onClick={() => setSelected(isSelected ? null : r)}
                  className={`w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-gray-800/50 transition-colors ${isSelected ? 'bg-gray-800/60' : ''}`}
                >
                  {img
                    ? <img src={img} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    : <div className="w-10 h-10 bg-gray-800 rounded-full shrink-0" />
                  }
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{r.artistName}</p>
                    {r.genres?.length > 0 && <p className="text-xs text-gray-500">{r.genres.slice(0, 2).join(', ')}</p>}
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
                        <label className="text-xs text-gray-500 mb-1 block">Metadata</label>
                        <select value={metadataProfileId ?? ''} onChange={(e) => setMetadataProfileId(Number(e.target.value))} className="input w-full text-xs">
                          {metaProfiles?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Root Folder</label>
                      <select value={rootFolder} onChange={(e) => setRootFolder(e.target.value)} className="input w-full text-xs">
                        {rootFolders?.map((f) => <option key={f.id} value={f.path}>{f.path}</option>)}
                      </select>
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
                      disabled={addMutation.isPending || !qualityProfileId || !metadataProfileId || !rootFolder}
                      className="w-full text-sm py-2 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
                    >
                      {addMutation.isPending ? 'Adding…' : 'Add Artist'}
                    </button>
                    {addMutation.isError && (
                      <p className="text-xs text-red-400">{(addMutation.error as Error)?.message}</p>
                    )}
                  </div>
                )}
                {isSelected && inLibrary && (
                  <p className="px-5 pb-3 text-xs text-gray-500">Already in your Lidarr library.</p>
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

type StatusFilter = 'all' | 'monitored' | 'missing'

export default function Music() {
  const { enabledServices } = useConfig()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<LidarrArtist | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const enabled = enabledServices.includes('lidarr')

  const { data: artists, isLoading } = useQuery<LidarrArtist[]>({
    queryKey: ['lidarr-artists'],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/artist')).data,
    enabled,
    staleTime: 60_000,
  })

  const { data: profiles = [] } = useQuery<QualityProfile[]>({
    queryKey: ['lidarr-profiles'],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/qualityprofile')).data,
    enabled,
    staleTime: 300_000,
  })

  const { data: metaProfiles = [] } = useQuery<MetadataProfile[]>({
    queryKey: ['lidarr-metaprofiles'],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/metadataprofile')).data,
    enabled,
    staleTime: 300_000,
  })

  const { data: albums = [], isLoading: albumsLoading } = useQuery<LidarrAlbum[]>({
    queryKey: ['lidarr-albums', selected?.id],
    queryFn: async () => (await api.get('/proxy/lidarr/api/v1/album', { params: { artistId: selected!.id } })).data,
    enabled: !!selected,
    staleTime: 60_000,
  })

  const updateArtist = useMutation({
    mutationFn: (a: LidarrArtist) => api.put(`/proxy/lidarr/api/v1/artist/${a.id}`, a),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['lidarr-artists'] }); setSelected(null) },
  })

  const deleteArtist = useMutation({
    mutationFn: ({ a, deleteFiles }: { a: LidarrArtist; deleteFiles: boolean }) =>
      api.delete(`/proxy/lidarr/api/v1/artist/${a.id}`, { params: { deleteFiles } }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['lidarr-artists'] }); setSelected(null) },
  })

  const triggerSearch = useMutation({
    mutationFn: (a: LidarrArtist) =>
      api.post('/proxy/lidarr/api/v1/command', { name: 'ArtistSearch', artistId: a.id }),
  })

  const toggleAlbum = useMutation({
    mutationFn: (album: LidarrAlbum) =>
      api.put('/proxy/lidarr/api/v1/album/monitor', { albumIds: [album.id], monitored: !album.monitored }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lidarr-albums', selected?.id] })
    },
  })

  if (!enabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Music</h1>
        <p className="text-gray-500">Enable Lidarr in Settings to manage music.</p>
      </div>
    )
  }

  const filtered = (artists ?? [])
    .filter((a) => {
      if (search && !a.artistName.toLowerCase().includes(search.toLowerCase())) return false
      if (statusFilter === 'monitored' && !a.monitored) return false
      if (statusFilter === 'missing') {
        const pct = a.statistics?.percentOfTracks ?? 100
        if (pct >= 100 || !a.monitored) return false
      }
      return true
    })
    .sort((a, b) => a.sortName.localeCompare(b.sortName))

  const counts = {
    all: artists?.length ?? 0,
    monitored: artists?.filter((a) => a.monitored).length ?? 0,
    missing: artists?.filter((a) => a.monitored && (a.statistics?.percentOfTracks ?? 100) < 100).length ?? 0,
  }

  return (
    <div className={`p-6 transition-all duration-200 ${selected ? 'pr-[436px]' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Music</h1>
          {artists && <p className="text-xs text-gray-500 mt-0.5">{artists.length} artists</p>}
        </div>
        <button onClick={() => setShowAdd(true)} className="text-sm px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">
          + Add Artist
        </button>
      </div>

      {/* Search + filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search artists…"
          className="input w-64"
        />
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          {(['all', 'monitored', 'missing'] as StatusFilter[]).map((f) => (
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
        <div className="text-center py-20 text-gray-600 text-sm">No artists found</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Artist</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Albums</th>
                <th className="text-left px-4 py-2.5 font-medium">Tracks</th>
                <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {filtered.map((artist) => {
                const pct = (artist.statistics?.percentOfTracks ?? 0) / 100
                const have = artist.statistics?.trackFileCount ?? 0
                const total = artist.statistics?.trackCount ?? 0
                const isActive = selected?.id === artist.id
                return (
                  <tr
                    key={artist.id}
                    onClick={() => setSelected(isActive ? null : artist)}
                    className={`cursor-pointer transition-colors ${isActive ? 'bg-blue-900/20' : 'hover:bg-gray-800/40'}`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {!artist.monitored && <span className="w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" />}
                        <span className="text-white text-sm truncate">{artist.artistName}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 hidden sm:table-cell">
                      {artist.statistics?.albumCount ?? 0}
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
                      {formatBytes(artist.statistics?.sizeOnDisk ?? 0)}
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
          <ArtistDetailPanel
            artist={selected}
            profiles={profiles}
            metaProfiles={metaProfiles}
            albums={albums}
            albumsLoading={albumsLoading}
            onClose={() => setSelected(null)}
            onUpdate={(a) => updateArtist.mutate(a)}
            onDelete={(a, files) => deleteArtist.mutate({ a, deleteFiles: files })}
            onSearch={(a) => triggerSearch.mutate(a)}
            onAlbumToggle={(album) => toggleAlbum.mutate(album)}
          />
        </>
      )}

      {/* Add Modal */}
      {showAdd && (
        <AddArtistModal
          onClose={() => setShowAdd(false)}
          onAdded={() => queryClient.invalidateQueries({ queryKey: ['lidarr-artists'] })}
        />
      )}
    </div>
  )
}
