import { useState, useRef } from 'react'
import api from '../services/api'

interface SearchResult {
  id: string | number
  title: string
  year?: number | null
  overview?: string | null
  poster?: string | null
  status?: string | null
  inLibrary?: boolean
  hasFile?: boolean
  monitored?: boolean
  seasons?: number | null
  type?: string | null
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
  { key: 'requests', label: 'Requests' },
]

export default function Search() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('movies')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doSearch = async (q: string) => {
    if (q.length < 2) { setResults(null); return }
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<SearchResults>(`/search?q=${encodeURIComponent(q)}`)
      setResults(res.data)
      // Auto-select first non-empty tab
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
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
            🔍
          </span>
          <input
            type="text"
            value={query}
            onChange={handleInput}
            placeholder="Search for movies, shows, music…"
            autoFocus
            className="w-full bg-gray-900 border border-gray-700 rounded-lg py-3 pl-10 pr-4 text-white placeholder-gray-600 focus:outline-none focus:border-gray-500 transition-colors text-sm"
          />
          {loading && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs animate-pulse">
              Searching…
            </span>
          )}
        </div>
      </form>

      {error && (
        <div className="mb-4 bg-red-900/20 border border-red-800/50 rounded-lg px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {results && totalCount === 0 && !loading && (
        <div className="text-center py-16 text-gray-600">
          <p className="text-lg">No results found for "{query}"</p>
          <p className="text-sm mt-1">Try a different search term</p>
        </div>
      )}

      {results && totalCount > 0 && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 mb-4 border-b border-gray-800 pb-0">
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

          {/* Tab content */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {activeTab === 'movies' && results.movies.map((m, i) => (
              <ResultRow key={i} item={m} type="movie" />
            ))}
            {activeTab === 'shows' && results.shows.map((s, i) => (
              <ResultRow key={i} item={s} type="show" />
            ))}
            {activeTab === 'artists' && results.artists.map((a, i) => (
              <ResultRow key={i} item={a} type="artist" />
            ))}
            {activeTab === 'requests' && results.requests.map((r, i) => (
              <ResultRow key={i} item={r} type="request" />
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

function ResultRow({ item, type }: { item: SearchResult; type: string }) {
  const inLib = item.inLibrary
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
    movie: 'Movie', show: 'TV', artist: 'Music', request: item.type ?? 'Request'
  }

  return (
    <div className="px-4 py-3 flex items-start gap-3">
      {item.poster && (
        <img
          src={item.poster}
          alt=""
          className="w-10 h-14 object-cover rounded shrink-0 bg-gray-800"
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      )}
      {!item.poster && (
        <div className="w-10 h-14 rounded shrink-0 bg-gray-800 flex items-center justify-center text-gray-700 text-xs">
          ?
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2 flex-wrap">
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${typeColors[type] ?? 'bg-gray-800 text-gray-400'}`}>
            {typeLabels[type] ?? type}
          </span>
          <p className="text-sm text-white font-medium truncate">
            {item.title}{item.year ? ` (${item.year})` : ''}
          </p>
          {inLib && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/60 text-green-400 shrink-0">
              In Library
            </span>
          )}
        </div>
        {item.overview && (
          <p className="text-xs text-gray-500 mt-1 line-clamp-2">{item.overview}</p>
        )}
        {statusText && (
          <p className="text-xs text-gray-600 mt-0.5 capitalize">{statusText}</p>
        )}
      </div>
    </div>
  )
}
