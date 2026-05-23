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

const PAGE_SIZE = 50

function formatDuration(ms: number | null): string {
  if (!ms) return ''
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
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

export default function PlexLibrary() {
  const { enabledServices } = useConfig()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState('titleSort')
  const [expandedItem, setExpandedItem] = useState<string | null>(null)

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
    enabled: !!selectedKey,
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

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <h1 className="text-2xl font-bold text-white">Plex Library</h1>
        {selectedLib && (
          <>
            <span className="text-gray-600">/</span>
            <span className="text-white font-medium">{selectedLib.title}</span>
            <button
              onClick={() => { setSelectedKey(null); setPage(0) }}
              className="text-xs text-gray-500 hover:text-white transition-colors"
            >
              ← All libraries
            </button>
          </>
        )}
      </div>

      {!selectedKey ? (
        /* Library grid */
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
        /* Items view */
        <div>
          {/* Controls */}
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
                    onClick={() => setExpandedItem(expandedItem === item.ratingKey ? null : item.ratingKey)}
                    className={`bg-gray-900 border rounded-lg overflow-hidden cursor-pointer transition-colors ${
                      expandedItem === item.ratingKey ? 'border-blue-600' : 'border-gray-800 hover:border-gray-600'
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
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-6">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    ← Prev
                  </button>
                  <span className="text-xs text-gray-500">
                    Page {page + 1} of {totalPages}
                  </span>
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
