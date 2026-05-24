import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

interface DownloadItem {
  id: string
  client: 'qbittorrent' | 'nzbget'
  name: string
  category: string
  size: number
  downloaded: number
  progress: number
  dlSpeed: number
  upSpeed: number
  eta: number
  status: string
  rawState: string
  canDeleteFiles: boolean
}

interface ImportingItem {
  id: string
  service: 'sonarr' | 'radarr'
  mediaTitle: string | null
  title: string
  state: 'importPending' | 'importing'
  downloadClient: string | null
  protocol: 'torrent' | 'usenet' | null
  size: number
  statusMessages: string[]
}

interface DownloadsData {
  queue: DownloadItem[]
  completed: DownloadItem[]
  importing: ImportingItem[]
  limits: {
    qbittorrent: { speedLimitMode: number } | null
    nzbget: { speedLimit: number } | null
  }
  errors: {
    qbittorrent: string | null
    nzbget: string | null
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return '0 B'
}

function formatSpeed(bps: number): string {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`
  return '0 B/s'
}

function formatEta(seconds: number): string {
  if (seconds < 0) return '—'
  if (seconds === 0) return '—'
  if (seconds >= 8640000) return '∞'  // qBit sentinel: 8640000s = 100 days = "no peers"
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${seconds}s`
}

function statusColor(status: string): string {
  if (status === 'downloading') return 'text-blue-400'
  if (status === 'seeding') return 'text-green-400'
  if (status.includes('paused')) return 'text-yellow-400'
  if (status === 'error') return 'text-red-400'
  if (status === 'queued') return 'text-gray-500'
  if (status === 'processing') return 'text-purple-400'
  if (status === 'stalled') return 'text-orange-400'
  if (status === 'success') return 'text-green-500'
  if (status === 'failure' || status === 'deleted') return 'text-red-500'
  return 'text-gray-400'
}

function ClientBadge({ client }: { client: 'qbittorrent' | 'nzbget' }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
      client === 'qbittorrent' ? 'bg-blue-900/60 text-blue-300' : 'bg-green-900/60 text-green-300'
    }`}>
      {client === 'qbittorrent' ? 'qBit' : 'NZB'}
    </span>
  )
}

// Track when each item first entered 'importing' state so we can show elapsed time + avg rate.
// Key = `${service}-${id}`, value = Date.now() when first seen as 'importing'.
function useImportingTimestamps(importing: ImportingItem[] | undefined) {
  const startTimes = useRef<Map<string, number>>(new Map())
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!importing) return
    const keys = new Set<string>()
    for (const item of importing) {
      const key = `${item.service}-${item.id}`
      keys.add(key)
      if (item.state === 'importing' && !startTimes.current.has(key)) {
        startTimes.current.set(key, Date.now())
      }
    }
    // Remove stale entries
    for (const k of startTimes.current.keys()) {
      if (!keys.has(k)) startTimes.current.delete(k)
    }
  }, [importing])

  // Tick every second while anything is actively importing
  useEffect(() => {
    const active = importing?.some((i) => i.state === 'importing') ?? false
    if (!active) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [importing])

  return (key: string) => startTimes.current.get(key) ?? null
}

export default function Downloads() {
  const { enabledServices } = useConfig()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'queue' | 'completed'>('queue')
  const [clientFilter, setClientFilter] = useState<'all' | 'qbittorrent' | 'nzbget'>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [deleteTarget, setDeleteTarget] = useState<DownloadItem | null>(null)

  const hasQbit = enabledServices.includes('qbittorrent')
  const hasNzb = enabledServices.includes('nzbget')

  const { data, isLoading } = useQuery<DownloadsData>({
    queryKey: ['downloads'],
    queryFn: async () => (await api.get<DownloadsData>('/downloads')).data,
    refetchInterval: 10_000,
    enabled: hasQbit || hasNzb,
  })

  const getImportStart = useImportingTimestamps(data?.importing)

  const qbitAction = useMutation({
    mutationFn: (body: { hash: string; action: string; deleteFiles?: boolean }) =>
      api.post('/downloads/qbittorrent/action', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['downloads'] }),
  })

  const nzbAction = useMutation({
    mutationFn: (body: { id: string; action: string }) =>
      api.post('/downloads/nzbget/action', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['downloads'] }),
  })

  const toggleQbitLimit = useMutation({
    mutationFn: () => api.post('/downloads/qbittorrent/toggle-limit'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['downloads'] }),
  })

  const setNzbLimit = useMutation({
    mutationFn: (limit: number) => api.post('/downloads/nzbget/set-limit', { limit }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['downloads'] }),
  })

  if (!hasQbit && !hasNzb) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Downloads</h1>
        <p className="text-gray-500">Enable qBittorrent or NZBGet in Settings to see downloads.</p>
      </div>
    )
  }

  const allItems = data ? [...data.queue, ...data.completed] : []
  const categories = ['all', ...Array.from(new Set(allItems.map((i) => i.category).filter(Boolean))).sort()]
  const items = tab === 'queue' ? (data?.queue || []) : (data?.completed || [])

  const filtered = items.filter((item) => {
    if (clientFilter !== 'all' && item.client !== clientFilter) return false
    if (categoryFilter !== 'all' && item.category !== categoryFilter) return false
    return true
  })

  const handleAction = (item: DownloadItem, action: 'pause' | 'resume' | 'delete', deleteFiles = false) => {
    if (item.client === 'qbittorrent') {
      qbitAction.mutate({ hash: item.id, action, deleteFiles })
    } else {
      nzbAction.mutate({ id: item.id, action })
    }
  }

  const isPaused = (item: DownloadItem) => item.status.includes('paused')

  const nzbSpeedLimit = data?.limits.nzbget?.speedLimit ?? 0
  const qbitLimited = (data?.limits.qbittorrent?.speedLimitMode ?? 0) === 1

  return (
    <div className="p-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Downloads</h1>
        <div className="flex items-center gap-2">
          {data?.limits.qbittorrent !== null && data?.limits.qbittorrent !== undefined && (
            <button
              onClick={() => toggleQbitLimit.mutate()}
              disabled={toggleQbitLimit.isPending}
              title={qbitLimited ? 'Alt speed ON — click to remove limit' : 'Click to enable alt speed limit'}
              className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                qbitLimited
                  ? 'bg-yellow-900/40 border-yellow-700 text-yellow-300 hover:bg-yellow-900/60'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              qBit {qbitLimited ? 'Limited' : 'Full Speed'}
            </button>
          )}
          {data?.limits.nzbget !== null && data?.limits.nzbget !== undefined && (
            <button
              onClick={() => setNzbLimit.mutate(nzbSpeedLimit > 0 ? 0 : 1024)}
              disabled={setNzbLimit.isPending}
              title={nzbSpeedLimit > 0 ? `NZBGet limited to ${nzbSpeedLimit} KB/s — click to remove` : 'Click to limit NZBGet to 1 MB/s'}
              className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                nzbSpeedLimit > 0
                  ? 'bg-yellow-900/40 border-yellow-700 text-yellow-300 hover:bg-yellow-900/60'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              NZB {nzbSpeedLimit > 0 ? `Limited (${nzbSpeedLimit >= 1024 ? `${Math.round(nzbSpeedLimit / 1024)} MB/s` : `${nzbSpeedLimit} KB/s`})` : 'Full Speed'}
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-gray-800">
        {(['queue', 'completed'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
              tab === t
                ? 'border-blue-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t === 'queue' ? 'Queue' : 'Completed'}
            {t === 'queue' && data && (
              <span className="ml-1.5 text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded-full">
                {data.queue.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Importing panel */}
      {data && data.importing.length > 0 && (
        <div className="mb-5 bg-violet-950/30 border border-violet-800/50 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-violet-800/40">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-violet-500" />
            </span>
            <span className="text-xs font-semibold text-violet-300 uppercase tracking-wide">
              Importing to Library
            </span>
            <span className="ml-auto text-xs text-violet-500">
              {data.importing.length} item{data.importing.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="divide-y divide-violet-800/20">
            {data.importing.map((item) => {
              const key = `${item.service}-${item.id}`
              const startedAt = getImportStart(key)
              const elapsedSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0
              // Estimated avg rate: size / elapsed (only meaningful after a few seconds)
              const avgRate = item.state === 'importing' && elapsedSec >= 3 && item.size > 0
                ? item.size / elapsedSec
                : null

              return (
                <div key={key} className="px-4 py-3 space-y-2">
                  {/* Top row: badge + titles + state pill */}
                  <div className="flex items-start gap-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${
                      item.service === 'sonarr'
                        ? 'bg-blue-900/60 text-blue-300'
                        : 'bg-yellow-900/60 text-yellow-300'
                    }`}>
                      {item.service === 'sonarr' ? 'TV' : 'Movie'}
                    </span>
                    <div className="flex-1 min-w-0">
                      {item.mediaTitle && (
                        <div className="text-white text-sm font-medium truncate">{item.mediaTitle}</div>
                      )}
                      <div className={`truncate ${item.mediaTitle ? 'text-xs text-violet-300/60' : 'text-sm text-white'}`}>
                        {item.title}
                      </div>
                      {item.statusMessages.length > 0 && (
                        <div className="text-xs text-amber-400 mt-0.5 truncate">{item.statusMessages[0]}</div>
                      )}
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 font-medium ${
                      item.state === 'importing'
                        ? 'bg-violet-700/60 text-violet-200'
                        : 'bg-gray-700/60 text-gray-400'
                    }`}>
                      {item.state === 'importing' ? 'Copying…' : 'Pending'}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="relative h-1.5 rounded-full overflow-hidden bg-gray-800">
                    {item.state === 'importing' ? (
                      // Indeterminate shimmer — we don't have byte-level copy progress from Sonarr/Radarr
                      <div className="absolute inset-0 rounded-full bg-gradient-to-r from-violet-600 via-violet-400 to-violet-600 bg-[length:200%_100%] animate-shimmer" />
                    ) : (
                      <div className="h-full w-0 bg-gray-700 rounded-full" />
                    )}
                  </div>

                  {/* Bottom row: size · elapsed · avg rate */}
                  {item.state === 'importing' && (
                    <div className="flex items-center gap-3 text-xs text-gray-500 tabular-nums">
                      {item.size > 0 && <span>{formatBytes(item.size)}</span>}
                      {elapsedSec > 0 && (
                        <span className="text-violet-400/70">
                          {elapsedSec < 60
                            ? `${elapsedSec}s`
                            : elapsedSec < 3600
                            ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
                            : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`}
                        </span>
                      )}
                      {avgRate !== null && (
                        <span className="text-green-400/80">≈ {formatSpeed(avgRate)}</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Filters + errors */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {hasQbit && hasNzb && (
          <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
            {(['all', 'qbittorrent', 'nzbget'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setClientFilter(f)}
                className={`px-3 py-1.5 transition-colors ${
                  clientFilter === f ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
                }`}
              >
                {f === 'all' ? 'All' : f === 'qbittorrent' ? 'qBit' : 'NZBGet'}
              </button>
            ))}
          </div>
        )}
        {categories.length > 1 && (
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="bg-gray-900 border border-gray-700 text-gray-400 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500"
          >
            {categories.map((c) => (
              <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>
            ))}
          </select>
        )}
        {data?.errors.qbittorrent && (
          <span className="text-xs text-red-400">qBit: {data.errors.qbittorrent}</span>
        )}
        {data?.errors.nzbget && (
          <span className="text-xs text-red-400">NZBGet: {data.errors.nzbget}</span>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-14 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-600 text-sm">
          {tab === 'queue' ? 'No active downloads' : 'No completed downloads'}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Category</th>
                <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Size</th>
                {tab === 'queue' && <th className="text-left px-4 py-2.5 font-medium">Progress</th>}
                {tab === 'queue' && <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Speed</th>}
                {tab === 'queue' && <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">ETA</th>}
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 w-28" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {filtered.map((item) => (
                <tr
                  key={`${item.client}-${item.id}`}
                  className="hover:bg-gray-800/30 transition-colors group"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <ClientBadge client={item.client} />
                      <span className="text-white truncate max-w-xs" title={item.name}>{item.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">
                    {item.category || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs tabular-nums hidden lg:table-cell">
                    {item.size > 0 ? formatBytes(item.size) : '—'}
                  </td>
                  {tab === 'queue' && (
                    <td className="px-4 py-3 min-w-[130px]">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-gray-800 rounded-full h-1.5 min-w-[80px]">
                          <div
                            className="bg-blue-500 h-1.5 rounded-full transition-all"
                            style={{ width: `${Math.round(item.progress * 100)}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 tabular-nums w-8 text-right shrink-0">
                          {Math.round(item.progress * 100)}%
                        </span>
                      </div>
                    </td>
                  )}
                  {tab === 'queue' && (
                    <td className="px-4 py-3 text-xs tabular-nums hidden sm:table-cell">
                      {item.dlSpeed > 0 && <div className="text-green-400">↓ {formatSpeed(item.dlSpeed)}</div>}
                      {item.upSpeed > 0 && <div className="text-blue-400">↑ {formatSpeed(item.upSpeed)}</div>}
                      {item.dlSpeed === 0 && item.upSpeed === 0 && <span className="text-gray-600">—</span>}
                    </td>
                  )}
                  {tab === 'queue' && (
                    <td className="px-4 py-3 text-xs text-gray-400 tabular-nums hidden sm:table-cell">
                      {formatEta(item.eta)}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <span className={`text-xs capitalize ${statusColor(item.status)}`}>{item.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    {tab === 'queue' && (
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                        <button
                          onClick={() => handleAction(item, isPaused(item) ? 'resume' : 'pause')}
                          disabled={qbitAction.isPending || nzbAction.isPending}
                          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-50"
                        >
                          {isPaused(item) ? 'Resume' : 'Pause'}
                        </button>
                        <button
                          onClick={() => setDeleteTarget(item)}
                          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-red-700 text-gray-300 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-white font-semibold mb-1">Delete download?</h3>
            <p className="text-gray-400 text-sm mb-5 break-words">{deleteTarget.name}</p>
            <div className="flex gap-2 justify-end flex-wrap">
              <button
                onClick={() => setDeleteTarget(null)}
                className="text-sm px-4 py-2 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { handleAction(deleteTarget, 'delete', false); setDeleteTarget(null) }}
                className="text-sm px-4 py-2 rounded bg-red-800 hover:bg-red-700 text-white transition-colors"
              >
                Remove
              </button>
              {deleteTarget.canDeleteFiles && (
                <button
                  onClick={() => { handleAction(deleteTarget, 'delete', true); setDeleteTarget(null) }}
                  className="text-sm px-4 py-2 rounded bg-red-950 hover:bg-red-900 text-red-300 border border-red-800 transition-colors"
                >
                  Delete + Files
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
