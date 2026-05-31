import { useState, useRef } from 'react'
import api from '../services/api'

interface SearchResult {
  id: string | number
  tmdbId?: number | null
  title: string
  year?: number | null
  overview?: string | null
  poster?: string | null
  status?: string | null
  inPlex?: boolean       // file(s) confirmed present
  partialPlex?: boolean  // some episodes present, not all (shows only)
  monitored?: boolean    // tracked by arr but not yet downloaded
  seasons?: number | null
  type?: string | null   // mediaType for Overseerr results ('movie' | 'tv')
}

interface SearchResults {
  movies:   SearchResult[]
  shows:    SearchResult[]
  artists:  SearchResult[]
  requests: SearchResult[]
}

type Tab = 'movies' | 'shows' | 'artists' | 'requests'

const TABS: { key: Tab; label: string }[] = [
  { key: 'movies',   label: 'Movies' },
  { key: 'shows',    label: 'TV Shows' },
  { key: 'artists',  label: 'Music' },
  { key: 'requests', label: 'Overseerr' },
]

type ReqState = 'idle' | 'loading' | 'done' | 'error'

// Overseerr status strings that mean "already handled"
const SEERR_ACTIVE_STATUSES = new Set([
  'pending', 'processing', 'available', 'partially_available',
])

export default function Search() {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('movies')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Per-item request state: key = `${tab}-${index}`
  const [reqState, setReqState]   = useState<Record<string, ReqState>>({})
  const [reqError, setReqError]   = useState<Record<string, string>>({})

  const setItem = (key: string, s: ReqState, err = '') => {
    setReqState(p => ({ ...p, [key]: s }))
    setReqError(p => ({ ...p, [key]: err }))
  }

  const doSearch = async (q: string) => {
    if (q.length < 2) { setResults(null); return }
    setLoading(true)
    setError(null)
    setReqState({})
    setReqError({})
    try {
      const res = await api.get<SearchResults>(`/search?q=${encodeURIComponent(q)}`)
      setResults(res.data)
      const first = TABS.find(t => (res.data[t.key] || []).length > 0)
      if (first) setActiveTab(first.key)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val.trim()), 500)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    doSearch(query.trim())
  }

  const submitRequest = async (key: string, tmdbId: number, mediaType: 'movie' | 'tv', is4k: boolean) => {
    setItem(key, 'loading')
    try {
      await api.post('/overseerr/request', { tmdbId, mediaType, is4k })
      setItem(key, 'done')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed'
      setItem(key, 'error', msg)
    }
  }

  const totalCount = results
    ? results.movies.length + results.shows.length + results.artists.length + results.requests.length
    : 0

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white mb-1">Search</h1>
        <p className="text-sm text-gray-500">Search across Radarr, Sonarr, Lidarr, and Overseerr</p>
      </div>

      {/* Search bar */}
      <form onSubmit={handleSubmit} className="mb-6">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">🔍</span>
          <input
            type="text"
            value={query}
            onChange={handleInput}
            placeholder="Search for movies, shows, music…"
            autoFocus
            className="w-full bg-gray-900 border border-gray-700 rounded-lg py-3 pl-10 pr-4 text-white placeholder-gray-600 focus:outline-none focus:border-gray-500 transition-colors text-sm"
          />
          {loading && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs animate-pulse">Searching…</span>
          )}
        </div>
      </form>

      {error && (
        <div className="mb-4 bg-red-900/20 border border-red-800/50 rounded-lg px-4 py-3 text-sm text-red-400">{error}</div>
      )}

      {results && totalCount === 0 && !loading && (
        <div className="text-center py-16 text-gray-600">
          <p className="text-lg">No results found for "{query}"</p>
          <p className="text-sm mt-1">Try a different search term</p>
        </div>
      )}

      {results && totalCount > 0 && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 mb-4 border-b border-gray-800">
            {TABS.map(({ key, label }) => {
              const count = results[key].length
              if (count === 0) return null
              return (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                    activeTab === key
                      ? 'border-blue-500 text-white'
                      : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {label}
                  <span className="ml-1.5 text-xs text-gray-600">({count})</span>
                </button>
              )
            })}
          </div>

          {/* Results */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {activeTab === 'movies' && results.movies.map((m, i) => (
              <ResultRow
                key={i}
                item={m}
                type="movie"
                mediaType="movie"
                tmdbId={m.tmdbId ?? (typeof m.id === 'number' ? m.id : null)}
                reqKey={`movies-${i}`}
                reqState={reqState[`movies-${i}`] ?? 'idle'}
                reqErr={reqError[`movies-${i}`] ?? ''}
                onRequest={(is4k) => {
                  const tid = m.tmdbId ?? (typeof m.id === 'number' ? m.id : null)
                  if (tid) submitRequest(`movies-${i}`, tid, 'movie', is4k)
                }}
              />
            ))}
            {activeTab === 'shows' && results.shows.map((s, i) => (
              <ResultRow
                key={i}
                item={s}
                type="show"
                mediaType="tv"
                tmdbId={s.tmdbId ?? null}
                reqKey={`shows-${i}`}
                reqState={reqState[`shows-${i}`] ?? 'idle'}
                reqErr={reqError[`shows-${i}`] ?? ''}
                onRequest={(is4k) => {
                  if (s.tmdbId) submitRequest(`shows-${i}`, s.tmdbId, 'tv', is4k)
                }}
              />
            ))}
            {activeTab === 'artists' && results.artists.map((a, i) => (
              <ResultRow key={i} item={a} type="artist" mediaType={null} tmdbId={null}
                reqKey={`artists-${i}`} reqState="idle" reqErr="" onRequest={() => {}} />
            ))}
            {activeTab === 'requests' && results.requests.map((r, i) => (
              <ResultRow
                key={i}
                item={r}
                type="request"
                mediaType={r.type === 'movie' ? 'movie' : r.type === 'tv' ? 'tv' : null}
                tmdbId={typeof r.id === 'number' ? r.id : null}
                reqKey={`requests-${i}`}
                reqState={reqState[`requests-${i}`] ?? 'idle'}
                reqErr={reqError[`requests-${i}`] ?? ''}
                onRequest={(is4k) => {
                  const tid = typeof r.id === 'number' ? r.id : null
                  const mt = r.type === 'movie' ? 'movie' : r.type === 'tv' ? 'tv' : null
                  if (tid && mt) submitRequest(`requests-${i}`, tid, mt, is4k)
                }}
              />
            ))}
          </div>
        </>
      )}

      {!results && !loading && query.length === 0 && (
        <div className="text-center py-20 text-gray-700">
          <p className="text-5xl mb-4">🔍</p>
          <p className="text-sm">Start typing to search your media library</p>
        </div>
      )}
    </div>
  )
}

interface ResultRowProps {
  item: SearchResult
  type: string
  mediaType: 'movie' | 'tv' | null
  tmdbId: number | null
  reqKey: string
  reqState: ReqState
  reqErr: string
  onRequest: (is4k: boolean) => void
}

function ResultRow({ item, type, mediaType, tmdbId, reqState, reqErr, onRequest }: ResultRowProps) {
  // For Overseerr tab: 'available' / 'partially_available' means it's in Plex
  const serrAvailable = item.status === 'available' || item.status === 'partially_available'
  const inPlex = item.inPlex || serrAvailable
  const canRequest = !!mediaType && !!tmdbId && !inPlex && !SEERR_ACTIVE_STATUSES.has(item.status ?? '')

  const statusText = type === 'show' && item.seasons != null
    ? `${item.seasons} season${item.seasons !== 1 ? 's' : ''}`
    : item.status ?? null

  const typeColors: Record<string, string> = {
    movie:   'bg-blue-900/60 text-blue-300',
    show:    'bg-green-900/60 text-green-300',
    artist:  'bg-purple-900/60 text-purple-300',
    request: 'bg-orange-900/60 text-orange-300',
  }
  const typeLabels: Record<string, string> = {
    movie: 'Movie', show: 'TV', artist: 'Music',
    request: item.type === 'movie' ? 'Movie' : item.type === 'tv' ? 'TV' : 'Media',
  }

  // Overseerr status badge (pending/processing only — available handled by In Plex badge)
  const serrStatusLabel: Record<string, string> = {
    pending: 'Pending approval',
    processing: 'Downloading',
  }
  const serrStatus = item.status ? serrStatusLabel[item.status] ?? null : null

  return (
    <div className="px-4 py-3 flex items-start gap-3">
      {/* Poster */}
      {item.poster ? (
        <img
          src={item.poster}
          alt=""
          className="w-10 h-14 object-cover rounded shrink-0 bg-gray-800"
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : (
        <div className="w-10 h-14 rounded shrink-0 bg-gray-800 flex items-center justify-center text-gray-700 text-xs">?</div>
      )}

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${typeColors[type] ?? 'bg-gray-800 text-gray-400'}`}>
                {typeLabels[type] ?? type}
              </span>
              <p className="text-sm text-white font-medium truncate">
                {item.title}{item.year ? ` (${item.year})` : ''}
              </p>
              {inPlex && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/60 text-green-400 shrink-0">
                  {item.partialPlex ? 'Partially in Plex' : 'In Plex'}
                </span>
              )}
              {!inPlex && item.monitored && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-900/60 text-yellow-400 shrink-0">Monitored</span>
              )}
              {serrStatus && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 shrink-0">{serrStatus}</span>
              )}
            </div>
            {item.overview && (
              <p className="text-xs text-gray-500 line-clamp-2">{item.overview}</p>
            )}
            {statusText && !serrStatus && !inPlex && (
              <p className="text-xs text-gray-600 mt-0.5 capitalize">{statusText}</p>
            )}
            {reqState === 'error' && reqErr && (
              <p className="text-xs text-red-400 mt-0.5">{reqErr}</p>
            )}
          </div>

          {/* Request controls */}
          {canRequest && (
            <div className="shrink-0 flex items-center gap-1.5 mt-0.5">
              {reqState === 'idle' && (
                <>
                  <button
                    onClick={() => onRequest(false)}
                    className="text-xs px-2.5 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                  >
                    Request
                  </button>
                  <button
                    onClick={() => onRequest(true)}
                    className="text-xs px-2 py-1 rounded bg-gray-800 hover:bg-purple-800 text-gray-400 hover:text-purple-300 border border-gray-700 hover:border-purple-700 transition-colors"
                    title="Request in 4K"
                  >
                    4K
                  </button>
                </>
              )}
              {reqState === 'loading' && (
                <span className="text-xs text-gray-500 animate-pulse">Requesting…</span>
              )}
              {reqState === 'done' && (
                <span className="text-xs text-green-400">✓ Requested</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
