import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

interface Library {
  key: string
  title: string
  type: string
  count: number | null
  thumb: string | null
}

interface LibrariesData {
  libraries: Library[]
}

interface MediaItem {
  key: string
  ratingKey: string
  title: string
  year: number | null
  type: string
  thumb: string | null
  summary: string | null
  rating: number | null
  audienceRating: number | null
  addedAt: string | null
  childCount: number | null
  leafCount: number | null
  duration: number | null
  genres: string[]
}

interface LibraryData {
  totalSize: number
  start: number
  size: number
  items: MediaItem[]
}

interface Season {
  ratingKey: string
  title: string
  index: number
  leafCount: number
  viewedLeafCount: number
  thumb: string | null
}

interface Episode {
  ratingKey: string
  title: string
  index: number
  parentIndex: number
  thumb: string | null
  duration: number | null
  summary: string | null
  airDate: string | null
  viewCount: number
  rating: number | null
}

interface ChildrenData {
  type: string
  parentTitle: string | null
  items: (Season | Episode)[]
}

const PAGE_SIZE = 50

function formatDuration(ms: number | null): string {
  if (!ms) return ''
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatAirDate(d: string | null): string {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }
  catch { return d }
}

function StarRating({ rating }: { rating: number | null }) {
  if (!rating) return null
  return <span className="text-yellow-500 text-xs">★ {rating.toFixed(1)}</span>
}

function typeIcon(type: string) {
  if (type === 'movie') return '🎬'
  if (type === 'show') return '📺'
  if (type === 'artist') return '🎵'
  return '📁'
}

function sortLabel(sort: string) {
  switch (sort) {
    case 'titleSort': return 'Title'
    case 'addedAt:desc': return 'Recently Added'
    case 'rating:desc': return 'Rating'
    case 'year:desc': return 'Year'
    default: return sort
  }
}

// ── Show detail: seasons + episodes ─────────────────────────────────────────

function SeasonPanel({ season, showRatingKey }: { season: Season; showRatingKey: string }) {
  const [open, setOpen] = useState(true)

  const { data, isLoading } = useQuery<ChildrenData>({
    queryKey: ['plex-children', season.ratingKey],
    queryFn: async () => (await api.get<ChildrenData>(`/plex/children/${season.ratingKey}`)).data,
    enabled: open,
    staleTime: 5 * 60_000,
  })

  const episodes = (data?.items ?? []) as Episode[]
  const watched = season.viewedLeafCount
  const total = season.leafCount

  return (
    <div className="mb-6">
      {/* Season header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-3 mb-3 group w-full text-left"
      >
        <span className="text-sm font-semibold text-white group-hover:text-blue-300 transition-colors">
          {season.title}
        </span>
        <span className="text-xs text-gray-600">{total} episodes</span>
        {total > 0 && (
          <span className="text-xs text-gray-600">
            · {watched}/{total} watched
          </span>
        )}
        <span className="text-gray-600 text-xs ml-auto">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {[...Array(Math.min(total, 6))].map((_, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-32 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {episodes.map((ep) => (
              <EpisodeCard key={ep.ratingKey} ep={ep} />
            ))}
          </div>
        )
      )}
    </div>
  )
}

function EpisodeCard({ ep }: { ep: Episode }) {
  const [expanded, setExpanded] = useState(false)
  const watched = ep.viewCount > 0

  return (
    <div
      onClick={() => setExpanded((e) => !e)}
      className={`bg-gray-900 border rounded-lg overflow-hidden cursor-pointer transition-colors ${
        expanded ? 'border-blue-600' : 'border-gray-800 hover:border-gray-600'
      }`}
    >
      {/* Thumbnail — 16:9 aspect */}
      <div className="relative w-full aspect-video bg-gray-800">
        {ep.thumb ? (
          <img
            src={ep.thumb}
            alt={ep.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-2xl">📺</div>
        )}
        {watched && (
          <div className="absolute top-1 right-1 bg-green-700/80 rounded-full p-0.5" title="Watched">
            <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </div>
        )}
      </div>

      <div className="p-2">
        <p className="text-[10px] text-gray-500 font-mono">
          S{String(ep.parentIndex).padStart(2,'0')}E{String(ep.index).padStart(2,'0')}
        </p>
        <p className="text-xs text-white font-medium truncate mt-0.5" title={ep.title}>{ep.title}</p>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-[10px] text-gray-600">{formatDuration(ep.duration)}</span>
          <StarRating rating={ep.rating} />
        </div>
        {ep.airDate && (
          <p className="text-[10px] text-gray-600 mt-0.5">{formatAirDate(ep.airDate)}</p>
        )}
      </div>

      {expanded && ep.summary && (
        <div className="px-2 pb-2">
          <p className="text-[10px] text-gray-400 line-clamp-4">{ep.summary}</p>
        </div>
      )}
    </div>
  )
}

function ShowDetail({
  show,
  onBack,
}: {
  show: MediaItem
  onBack: () => void
}) {
  const { data, isLoading } = useQuery<ChildrenData>({
    queryKey: ['plex-children', show.ratingKey],
    queryFn: async () => (await api.get<ChildrenData>(`/plex/children/${show.ratingKey}`)).data,
    staleTime: 5 * 60_000,
  })

  const seasons = (data?.items ?? []) as Season[]

  return (
    <div>
      {/* Show header */}
      <div className="flex gap-4 mb-6">
        {show.thumb && (
          <img
            src={show.thumb}
            alt={show.title}
            className="w-24 rounded-lg object-cover shrink-0 self-start"
          />
        )}
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-white">{show.title}</h2>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {show.year && <span className="text-sm text-gray-500">{show.year}</span>}
            {show.childCount !== null && (
              <span className="text-xs text-gray-600">{show.childCount} seasons · {show.leafCount} episodes</span>
            )}
            {show.audienceRating && (
              <StarRating rating={show.audienceRating} />
            )}
          </div>
          {show.genres.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {show.genres.map((g) => (
                <span key={g} className="text-[10px] px-1.5 py-0.5 bg-gray-800 text-gray-500 rounded">{g}</span>
              ))}
            </div>
          )}
          {show.summary && (
            <p className="text-xs text-gray-400 mt-2 line-clamp-3">{show.summary}</p>
          )}
        </div>
      </div>

      {/* Seasons */}
      {isLoading ? (
        <div className="space-y-6">
          {[...Array(2)].map((_, i) => (
            <div key={i}>
              <div className="h-5 w-24 bg-gray-800 rounded animate-pulse mb-3" />
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
                {[...Array(6)].map((_, j) => (
                  <div key={j} className="bg-gray-900 border border-gray-800 rounded-lg aspect-video animate-pulse" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div>
          {seasons.map((season) => (
            <SeasonPanel key={season.ratingKey} season={season} showRatingKey={show.ratingKey} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export default function PlexLibrary() {
  const { enabledServices } = useConfig()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState('titleSort')
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [selectedShow, setSelectedShow] = useState<MediaItem | null>(null)

  const hasPlex = enabledServices.includes('plex')

  const { data: libsData, isLoading: libsLoading } = useQuery<LibrariesData>({
    queryKey: ['plex-libraries'],
    queryFn: async () => (await api.get<LibrariesData>('/plex/libraries')).data,
    enabled: hasPlex,
  })

  const { data: itemsData, isLoading: itemsLoading } = useQuery<LibraryData>({
    queryKey: ['plex-library', selectedKey, page, sort],
    queryFn: async () =>
      (await api.get<LibraryData>(`/plex/library/${selectedKey}?start=${page * PAGE_SIZE}&size=${PAGE_SIZE}&sort=${sort}`)).data,
    enabled: !!selectedKey && !selectedShow,
  })

  const selectedLib = libsData?.libraries.find((l) => l.key === selectedKey)

  if (!hasPlex) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Plex Library</h1>
        <p className="text-gray-500">Enable Plex in Settings.</p>
      </div>
    )
  }

  const totalPages = itemsData ? Math.ceil(itemsData.totalSize / PAGE_SIZE) : 0

  const handleItemClick = (item: MediaItem) => {
    if (item.type === 'show') {
      setSelectedShow(item)
    } else {
      setExpandedItem(expandedItem === item.ratingKey ? null : item.ratingKey)
    }
  }

  return (
    <div className="p-6 max-w-7xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6 flex-wrap text-sm">
        <h1 className="text-2xl font-bold text-white">Plex Library</h1>
        {selectedLib && (
          <>
            <span className="text-gray-600">/</span>
            <button
              onClick={() => { setSelectedShow(null); setExpandedItem(null) }}
              className={`font-medium transition-colors ${selectedShow ? 'text-gray-400 hover:text-white' : 'text-white'}`}
            >
              {selectedLib.title}
            </button>
          </>
        )}
        {selectedShow && (
          <>
            <span className="text-gray-600">/</span>
            <span className="text-white font-medium truncate max-w-[200px]">{selectedShow.title}</span>
          </>
        )}
        {selectedKey && !selectedShow && (
          <button
            onClick={() => { setSelectedKey(null); setPage(0) }}
            className="ml-2 text-xs text-gray-500 hover:text-white transition-colors"
          >
            ← All libraries
          </button>
        )}
        {selectedShow && (
          <button
            onClick={() => setSelectedShow(null)}
            className="ml-2 text-xs text-gray-500 hover:text-white transition-colors"
          >
            ← Back
          </button>
        )}
      </div>

      {/* Show detail view */}
      {selectedShow ? (
        <ShowDetail show={selectedShow} onBack={() => setSelectedShow(null)} />
      ) : !selectedKey ? (
        /* Library picker */
        libsLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-24 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {(libsData?.libraries ?? []).map((lib) => (
              <button
                key={lib.key}
                onClick={() => { setSelectedKey(lib.key); setPage(0) }}
                className="bg-gray-900 border border-gray-800 hover:border-blue-600 rounded-lg p-4 text-left transition-colors group"
              >
                <div className="text-2xl mb-2">{typeIcon(lib.type)}</div>
                <p className="text-white font-medium group-hover:text-blue-300 transition-colors">{lib.title}</p>
                {lib.count !== null && (
                  <p className="text-xs text-gray-500 mt-0.5">{lib.count.toLocaleString()} items</p>
                )}
              </button>
            ))}
          </div>
        )
      ) : (
        /* Library items grid */
        <div>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <select
              value={sort}
              onChange={(e) => { setSort(e.target.value); setPage(0) }}
              className="bg-gray-900 border border-gray-700 text-gray-400 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500"
            >
              {['titleSort', 'addedAt:desc', 'rating:desc', 'year:desc'].map((s) => (
                <option key={s} value={s}>{sortLabel(s)}</option>
              ))}
            </select>
            {itemsData && (
              <span className="text-xs text-gray-600">{itemsData.totalSize.toLocaleString()} items total</span>
            )}
            {selectedLib?.type === 'show' && (
              <span className="text-xs text-gray-600">· Click a show to browse episodes</span>
            )}
          </div>

          {itemsLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {[...Array(20)].map((_, i) => (
                <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-48 animate-pulse" />
              ))}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {(itemsData?.items ?? []).map((item) => (
                  <div
                    key={item.ratingKey}
                    onClick={() => handleItemClick(item)}
                    className={`bg-gray-900 border rounded-lg overflow-hidden cursor-pointer transition-colors ${
                      expandedItem === item.ratingKey ? 'border-blue-600' :
                      item.type === 'show' ? 'border-gray-800 hover:border-blue-500' :
                      'border-gray-800 hover:border-gray-600'
                    }`}
                  >
                    {item.thumb ? (
                      <img
                        src={item.thumb}
                        alt={item.title}
                        className="w-full aspect-[2/3] object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full aspect-[2/3] bg-gray-800 flex items-center justify-center text-3xl">
                        {typeIcon(item.type)}
                      </div>
                    )}
                    <div className="p-2">
                      <p className="text-xs text-white font-medium truncate" title={item.title}>{item.title}</p>
                      <div className="flex items-center justify-between mt-0.5">
                        <span className="text-xs text-gray-600">{item.year || ''}</span>
                        <StarRating rating={item.audienceRating ?? item.rating} />
                      </div>
                      {item.type === 'show' && item.childCount !== null && (
                        <p className="text-xs text-gray-600 mt-0.5">{item.childCount}S · {item.leafCount}ep</p>
                      )}
                      {item.type === 'movie' && item.duration && (
                        <p className="text-xs text-gray-600 mt-0.5">{formatDuration(item.duration)}</p>
                      )}
                    </div>
                    {/* Expand summary for movies/artists only (shows navigate) */}
                    {expandedItem === item.ratingKey && item.summary && (
                      <div className="px-2 pb-2">
                        <p className="text-xs text-gray-400 line-clamp-4">{item.summary}</p>
                        {item.genres.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {item.genres.map((g) => (
                              <span key={g} className="text-[10px] px-1.5 py-0.5 bg-gray-800 text-gray-500 rounded">{g}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Show drill-in hint */}
                    {item.type === 'show' && (
                      <div className="px-2 pb-1.5">
                        <span className="text-[10px] text-blue-500">Browse episodes →</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-6">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    ← Prev
                  </button>
                  <span className="text-xs text-gray-500">Page {page + 1} of {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
