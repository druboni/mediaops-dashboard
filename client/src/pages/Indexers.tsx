import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

// ── Types ──────────────────────────────────────────────────────────────────

interface IndexerCategory { id: number; name: string; subCategories?: IndexerCategory[] }
interface ProwlarrIndexer {
  id: number
  name: string
  enable: boolean
  supportsRss: boolean
  supportsSearch: boolean
  protocol: 'usenet' | 'torrent'
  privacy: 'public' | 'private' | 'semiPrivate'
  priority: number
  categories: IndexerCategory[]
  tags: number[]
  language: string
  description?: string
  added: string
  // full config fields included for PUT
  [key: string]: unknown
}
interface ProwlarrIndexerStatus {
  indexerId: number
  mostRecentFailure: string
  initialFailure: string
  disabledTill: string
}

interface ProwlarrStat {
  indexerId: number
  indexerName: string
  averageResponseTime: number
  numberOfQueries: number
  numberOfGrabs: number
  numberOfFailedQueries: number
  numberOfFailedGrabs: number
}
interface ProwlarrSearchResult {
  guid: string
  indexerId: number
  indexer: string
  title: string
  size: number
  publishDate: string
  protocol: 'torrent' | 'usenet'
  seeders?: number
  leechers?: number
  downloadUrl?: string
  magnetUrl?: string
  categories: IndexerCategory[]
  imdbId?: string
  tmdbId?: number
}
interface JackettIndexer {
  id: string
  name: string
  description?: string
  type: string
  language: string
  configured: boolean
  last_error?: string | null
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(b: number) {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(0)} MB`
  if (b >= 1024) return `${Math.round(b / 1024)} KB`
  return `${b} B`
}

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  return new Date(d).toLocaleDateString()
}

function topCategories(cats: IndexerCategory[], max = 3): string {
  return cats.slice(0, max).map((c) => c.name).join(', ') + (cats.length > max ? ` +${cats.length - max}` : '')
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail'

// ── Prowlarr Section ───────────────────────────────────────────────────────

function ProwlarrSection() {
  const queryClient = useQueryClient()
  const [testStates, setTestStates] = useState<Record<number, TestState>>({})
  const [testAllState, setTestAllState] = useState<'idle' | 'testing' | 'done'>('idle')
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done'>('idle')
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)

  const { data: indexers, isLoading } = useQuery<ProwlarrIndexer[]>({
    queryKey: ['prowlarr-indexers'],
    queryFn: async () => (await api.get('/proxy/prowlarr/api/v1/indexer')).data,
    staleTime: 60_000,
  })

  const { data: statsData } = useQuery<{ indexers: ProwlarrStat[] }>({
    queryKey: ['prowlarr-stats'],
    queryFn: async () => (await api.get('/proxy/prowlarr/api/v1/indexerstats')).data,
    staleTime: 60_000,
  })

  const { data: statusData } = useQuery<ProwlarrIndexerStatus[]>({
    queryKey: ['prowlarr-indexerstatus'],
    queryFn: async () => (await api.get('/proxy/prowlarr/api/v1/indexerstatus')).data,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const statsMap = new Map<number, ProwlarrStat>(
    (statsData?.indexers ?? []).map((s) => [s.indexerId, s])
  )

  const disabledMap = new Map<number, ProwlarrIndexerStatus>(
    (statusData ?? []).map((s) => [s.indexerId, s])
  )

  const toggleEnable = useMutation({
    mutationFn: (indexer: ProwlarrIndexer) =>
      api.put(`/proxy/prowlarr/api/v1/indexer/${indexer.id}`, { ...indexer, enable: !indexer.enable }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['prowlarr-indexers'] }),
  })

  const deleteIndexer = useMutation({
    mutationFn: (id: number) => api.delete(`/proxy/prowlarr/api/v1/indexer/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prowlarr-indexers'] })
      setDeleteTarget(null)
    },
  })

  const testOne = async (id: number) => {
    setTestStates((s) => ({ ...s, [id]: 'testing' }))
    try {
      await api.post(`/proxy/prowlarr/api/v1/indexer/${id}/test`)
      setTestStates((s) => ({ ...s, [id]: 'ok' }))
    } catch {
      setTestStates((s) => ({ ...s, [id]: 'fail' }))
    }
  }

  const testAll = async () => {
    setTestAllState('testing')
    try {
      await api.post('/proxy/prowlarr/api/v1/indexer/testall')
      setTestAllState('done')
      queryClient.invalidateQueries({ queryKey: ['prowlarr-stats'] })
      setTimeout(() => setTestAllState('idle'), 3000)
    } catch {
      setTestAllState('idle')
    }
  }

  const syncApps = async () => {
    setSyncState('syncing')
    try {
      await api.post('/proxy/prowlarr/api/v1/command', { name: 'ApplicationIndexerSync' })
      setSyncState('done')
      setTimeout(() => setSyncState('idle'), 3000)
    } catch {
      setSyncState('idle')
    }
  }

  return (
    <div>
      {/* Actions */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={testAll}
          disabled={testAllState === 'testing'}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
        >
          {testAllState === 'testing' ? 'Testing…' : testAllState === 'done' ? '✓ Done' : 'Test All'}
        </button>
        <button
          onClick={syncApps}
          disabled={syncState === 'syncing'}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
        >
          {syncState === 'syncing' ? 'Syncing…' : syncState === 'done' ? '✓ Synced' : 'Sync Apps'}
        </button>
        {indexers && (
          <span className="text-xs text-gray-600 ml-1">{indexers.length} indexers</span>
        )}
      </div>

      {/* Disabled indexers banner */}
      {statusData && statusData.length > 0 && (
        <div className="mb-4 flex items-start gap-3 bg-orange-900/20 border border-orange-800/50 rounded-lg px-4 py-2.5 text-sm">
          <span className="text-orange-400 shrink-0 mt-0.5">⚠</span>
          <div>
            <span className="text-orange-300 font-medium">{statusData.length} indexer{statusData.length > 1 ? 's' : ''} temporarily disabled by Prowlarr due to failures.</span>
            <span className="text-orange-400/70 ml-2 text-xs">They will re-enable automatically — or use Test All to trigger re-check.</span>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(5)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : !indexers?.length ? (
        <p className="text-gray-600 text-sm py-8 text-center">No indexers configured in Prowlarr</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Categories</th>
                <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Stats</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Priority</th>
                <th className="px-4 py-2.5 w-36" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {indexers.map((idx) => {
                const stats = statsMap.get(idx.id)
                const disabled = disabledMap.get(idx.id)
                const testState = testStates[idx.id] ?? 'idle'
                const disabledTillDate = disabled ? new Date(disabled.disabledTill) : null
                const stillDisabled = disabledTillDate && disabledTillDate > new Date()
                return (
                  <tr key={idx.id} className={`hover:bg-gray-800/20 transition-colors group ${stillDisabled ? 'bg-orange-950/10' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <button
                          onClick={() => toggleEnable.mutate(idx)}
                          title={idx.enable ? 'Click to disable' : 'Click to enable'}
                          className={`w-2 h-2 rounded-full shrink-0 transition-colors ${
                            idx.enable ? 'bg-green-400' : 'bg-gray-600 hover:bg-gray-500'
                          }`}
                        />
                        <span className={`text-sm truncate ${idx.enable ? 'text-white' : 'text-gray-500'}`}>{idx.name}</span>
                        {stillDisabled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-orange-900/60 text-orange-300 shrink-0">
                            disabled until {disabledTillDate!.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                          idx.protocol === 'torrent' ? 'bg-blue-900/60 text-blue-300' : 'bg-green-900/60 text-green-300'
                        }`}>
                          {idx.protocol === 'torrent' ? 'TRK' : 'NZB'}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                          idx.privacy === 'public' ? 'bg-gray-800 text-gray-500' :
                          idx.privacy === 'private' ? 'bg-red-900/40 text-red-400' :
                          'bg-yellow-900/40 text-yellow-500'
                        }`}>
                          {idx.privacy === 'semiPrivate' ? 'semi' : idx.privacy}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 hidden md:table-cell">
                      {idx.categories?.length ? topCategories(idx.categories) : '—'}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {stats ? (
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-gray-400">{stats.numberOfGrabs} grabs</span>
                          <span className="text-gray-500">{stats.numberOfQueries} queries</span>
                          {stats.numberOfFailedQueries > 0 && (
                            <span className="text-red-500">{stats.numberOfFailedQueries} failed</span>
                          )}
                        </div>
                      ) : <span className="text-gray-600 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 hidden sm:table-cell">{idx.priority}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        {/* Test result indicator */}
                        {testState === 'ok' && <span className="text-green-400 text-xs">✓</span>}
                        {testState === 'fail' && <span className="text-red-400 text-xs">✗</span>}
                        <button
                          onClick={() => testOne(idx.id)}
                          disabled={testState === 'testing'}
                          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                        >
                          {testState === 'testing' ? '…' : 'Test'}
                        </button>
                        {deleteTarget === idx.id ? (
                          <>
                            <button
                              onClick={() => deleteIndexer.mutate(idx.id)}
                              className="text-xs px-2 py-1 rounded bg-red-800 hover:bg-red-700 text-white transition-colors"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setDeleteTarget(null)}
                              className="text-xs px-1.5 py-1 rounded bg-gray-700 text-gray-400 hover:text-white transition-colors"
                            >
                              ✕
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeleteTarget(idx.id)}
                            className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-red-800 text-gray-500 hover:text-red-300 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Jackett Section ────────────────────────────────────────────────────────

function JackettSection() {
  const { data: indexers, isLoading } = useQuery<JackettIndexer[]>({
    queryKey: ['jackett-indexers'],
    queryFn: async () => (await api.get('/proxy/jackett/api/v2.0/indexers')).data,
    staleTime: 60_000,
  })

  const configured = indexers?.filter((i) => i.configured) ?? []
  const unconfigured = indexers?.filter((i) => !i.configured) ?? []

  return (
    <div>
      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(5)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : !indexers?.length ? (
        <p className="text-gray-600 text-sm py-8 text-center">No indexers found in Jackett</p>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <span className="text-xs text-gray-600">{configured.length} configured · {unconfigured.length} available</span>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">Name</th>
                  <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Type</th>
                  <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Language</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {[...configured, ...unconfigured].map((idx) => (
                  <tr key={idx.id} className="hover:bg-gray-800/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          !idx.configured ? 'bg-gray-600' :
                          idx.last_error ? 'bg-red-500' : 'bg-green-400'
                        }`} />
                        <span className={`text-sm ${idx.configured ? 'text-white' : 'text-gray-500'}`}>{idx.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 capitalize hidden sm:table-cell">{idx.type}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 hidden md:table-cell">{idx.language}</td>
                    <td className="px-4 py-3">
                      {!idx.configured ? (
                        <span className="text-xs text-gray-600">Not configured</span>
                      ) : idx.last_error ? (
                        <span className="text-xs text-red-400 truncate max-w-xs block" title={idx.last_error}>Error: {idx.last_error}</span>
                      ) : (
                        <span className="text-xs text-green-400">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── Search Section ─────────────────────────────────────────────────────────

const CATEGORIES = [
  { id: 0,    label: 'All' },
  { id: 2000, label: 'Movies' },
  { id: 5000, label: 'TV' },
  { id: 3000, label: 'Music' },
  { id: 4000, label: 'PC / Software' },
  { id: 1000, label: 'Games' },
  { id: 7000, label: 'Books' },
  { id: 8000, label: 'Other' },
]

function SearchSection() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(0)
  const [submitted, setSubmitted] = useState('')
  const [submittedCat, setSubmittedCat] = useState(0)
  const [grabbing, setGrabbing] = useState<string | null>(null)

  const { data: results, isLoading, error } = useQuery<ProwlarrSearchResult[]>({
    queryKey: ['prowlarr-search', submitted, submittedCat],
    queryFn: async () => {
      let url = `/proxy/prowlarr/api/v1/search?query=${encodeURIComponent(submitted)}&indexerIds[]=-2&type=search&limit=100&offset=0`
      if (submittedCat > 0) url += `&categories[]=${submittedCat}`
      return (await api.get(url)).data
    },
    enabled: submitted.length > 0,
    staleTime: 120_000,
  })

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) { setSubmitted(query.trim()); setSubmittedCat(category) }
  }

  const handleGrab = async (result: ProwlarrSearchResult) => {
    if (!result.downloadUrl) return
    setGrabbing(result.guid)
    // Open the download URL in a new tab — lets the browser handle it
    window.open(result.downloadUrl, '_blank', 'noopener,noreferrer')
    setTimeout(() => setGrabbing(null), 1000)
  }

  return (
    <div>
      <form onSubmit={handleSearch} className="flex items-center gap-3 mb-6">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all indexers…"
          className="input flex-1"
        />
        <select
          value={category}
          onChange={(e) => setCategory(Number(e.target.value))}
          className="input w-36 shrink-0"
        >
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!query.trim() || isLoading}
          className="text-sm px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 shrink-0"
        >
          {isLoading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error && (
        <p className="text-red-400 text-sm mb-4">Search failed: {(error as Error).message}</p>
      )}

      {submitted && !isLoading && results !== undefined && (
        <div className="mb-3 text-xs text-gray-500">
          {results.length === 0 ? 'No results' : `${results.length} result${results.length === 1 ? '' : 's'} for "${submitted}"`}
        </div>
      )}

      {results && results.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Title</th>
                <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Indexer</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Size</th>
                <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Seeds</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Age</th>
                <th className="px-4 py-2.5 w-28" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {results.map((r) => (
                <tr key={r.guid} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                        r.protocol === 'torrent' ? 'bg-blue-900/60 text-blue-300' : 'bg-green-900/60 text-green-300'
                      }`}>
                        {r.protocol === 'torrent' ? 'TRK' : 'NZB'}
                      </span>
                      <span className="text-white text-xs truncate" title={r.title}>{r.title}</span>
                    </div>
                    {r.categories?.length > 0 && (
                      <p className="text-[10px] text-gray-600 mt-0.5 pl-9">{topCategories(r.categories, 2)}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 hidden md:table-cell">{r.indexer}</td>
                  <td className="px-4 py-3 text-xs text-gray-400 tabular-nums hidden sm:table-cell">
                    {r.size > 0 ? formatBytes(r.size) : '—'}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {r.protocol === 'torrent' && r.seeders !== undefined ? (
                      <span className={`text-xs tabular-nums ${r.seeders > 0 ? 'text-green-400' : 'text-red-500'}`}>
                        {r.seeders}
                      </span>
                    ) : <span className="text-gray-600 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 hidden sm:table-cell">
                    {timeAgo(r.publishDate)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {r.magnetUrl && (
                        <a
                          href={r.magnetUrl}
                          title="Open magnet link"
                          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-blue-800 text-gray-400 hover:text-blue-300 transition-colors"
                        >
                          Magnet
                        </a>
                      )}
                      {r.downloadUrl && (
                        <button
                          onClick={() => handleGrab(r)}
                          disabled={grabbing === r.guid}
                          className="text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
                        >
                          {grabbing === r.guid ? '…' : '⬇'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

type ActiveTab = 'prowlarr' | 'jackett' | 'search'

export default function Indexers() {
  const { enabledServices } = useConfig()
  const hasProwlarr = enabledServices.includes('prowlarr')
  const hasJackett = enabledServices.includes('jackett')

  const tabs: { key: ActiveTab; label: string }[] = [
    ...(hasProwlarr ? [{ key: 'prowlarr' as const, label: 'Prowlarr' }] : []),
    ...(hasJackett  ? [{ key: 'jackett'  as const, label: 'Jackett'  }] : []),
    ...(hasProwlarr ? [{ key: 'search'   as const, label: 'Search'   }] : []),
  ]

  const [activeTab, setActiveTab] = useState<ActiveTab>(
    hasProwlarr ? 'prowlarr' : hasJackett ? 'jackett' : 'search'
  )

  if (!hasProwlarr && !hasJackett) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Indexers</h1>
        <p className="text-gray-500">Enable Prowlarr or Jackett in Settings to manage indexers.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-6xl">
      <h1 className="text-2xl font-bold text-white mb-5">Indexers</h1>

      {/* Tabs */}
      {tabs.length > 1 && (
        <div className="flex items-center gap-1 mb-6 border-b border-gray-800">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
                activeTab === key
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {activeTab === 'prowlarr' && hasProwlarr && <ProwlarrSection />}
      {activeTab === 'jackett'  && hasJackett  && <JackettSection />}
      {activeTab === 'search'   && hasProwlarr && <SearchSection />}
    </div>
  )
}
