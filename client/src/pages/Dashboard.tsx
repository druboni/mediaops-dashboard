import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'
import type { ServiceName } from '../types'

// ── Types ──────────────────────────────────────────────────────────────
interface HealthEntry { ok: boolean; version?: string; error?: string }
interface HealthAlert { service: string; level: 'warning' | 'error'; source: string; message: string }
interface IndexerStatus { indexerId: number; mostRecentFailure: string; initialFailure: string; disabledTill: string }
interface HealthData { alerts: HealthAlert[]; indexerStatus: IndexerStatus[] }

interface DashboardData {
  health: Partial<Record<ServiceName, HealthEntry>>
  stats: {
    movies: number | null; shows: number | null; episodes: number | null
    artists: number | null; albums: number | null
    plexStreams: number | null; pendingRequests: number | null
  }
  downloads: {
    qbittorrent: { ok: boolean; dlSpeed: number; upSpeed: number; active: number } | null
    nzbget:      { ok: boolean; dlSpeed: number; active: number } | null
  }
  plexStreams: {
    title: string; user: string; player: string; platform: string | null; state: string
    viewOffset: number; duration: number | null
    videoCodec: string | null; videoResolution: string | null; audioCodec: string | null
    playMethod: string
  }[]
  recentlyAdded:      { title: string; subtitle?: string; year?: number; type: string; service: string; date: string }[]
  recentlyDownloaded: { name: string; date: string; size: number; client: string }[]
  recentlyPlayed:     { title: string; subtitle?: string; type: string; user: string; date: string }[]
  pendingRequests:    { id: number; title: string; type: string; requestedBy: string }[]
}

interface QueueItem {
  id: string; client: 'qbittorrent' | 'nzbget'; name: string
  size: number; downloaded: number; progress: number
  dlSpeed: number; upSpeed: number; eta: number; status: string
}
interface ImportingItem {
  id: string; service: string; mediaTitle: string | null; title: string; state: string; size: number
}
interface DownloadsData {
  queue: QueueItem[]; completed: QueueItem[]
  importing: ImportingItem[]; arrQueueHashes: string[]
}

// ── Helpers ────────────────────────────────────────────────────────────
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`
}
function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(0)} MB`
  return `${Math.round(bytes / 1024)} KB`
}
function formatSpeed(bps: number): string {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`
  if (bps >= 1024)      return `${Math.round(bps / 1024)} KB/s`
  return bps > 0 ? `${bps} B/s` : '0'
}
function formatEta(sec: number): string {
  if (sec < 0 || sec > 86400 * 7) return '∞'
  if (sec < 60)   return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}
function timeAgo(dateStr: string): string {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`
}

const SERVICE_LABELS: Partial<Record<ServiceName, string>> = {
  plex: 'Plex', sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr',
  bazarr: 'Bazarr', overseerr: 'Overseerr', prowlarr: 'Prowlarr',
  jackett: 'Jackett', qbittorrent: 'qBittorrent', nzbget: 'NZBGet',
  huntarr: 'Huntarr', requestrr: 'Requestrr', tautulli: 'Tautulli',
}

// ── Hooks ──────────────────────────────────────────────────────────────
function useDownloadNotifications(items: { name: string; date: string; client: string }[]) {
  useEffect(() => {
    if (!items.length || typeof Notification === 'undefined') return
    if (Notification.permission === 'default') { Notification.requestPermission(); return }
    if (Notification.permission !== 'granted') return
    const key = 'mediaops_seen_downloads'
    const seen = new Set<string>(JSON.parse(localStorage.getItem(key) ?? '[]'))
    const fresh = items.filter(i => !seen.has(`${i.client}-${i.name}-${i.date}`))
    if (!fresh.length) return
    fresh.forEach(i => new Notification('MediaOps — Download Complete', { body: i.name, icon: '/favicon.ico', tag: `${i.client}-${i.name}`, silent: false }))
    localStorage.setItem(key, JSON.stringify([...seen, ...fresh.map(i => `${i.client}-${i.name}-${i.date}`)].slice(-100)))
  }, [items])
}

// ── Sub-components ─────────────────────────────────────────────────────
function AlertsBanner({ healthData, dismissed, onDismiss }: {
  healthData: HealthData
  dismissed: Set<string>
  onDismiss: (key: string) => void
}) {
  const indexerAlerts = healthData.indexerStatus.filter(s => !dismissed.has(`indexer-${s.indexerId}`))
  const healthAlerts  = healthData.alerts.filter(a => !dismissed.has(`alert-${a.source}-${a.service}-${a.message}`))
  if (!indexerAlerts.length && !healthAlerts.length) return null
  return (
    <section className="mb-6 space-y-1.5">
      {indexerAlerts.map(s => (
        <div key={s.indexerId} className="flex items-center gap-3 bg-orange-900/20 border border-orange-800/50 rounded-lg px-4 py-2.5 text-sm">
          <span className="text-orange-400 shrink-0">⚠</span>
          <div className="min-w-0 flex-1">
            <span className="text-orange-300 font-medium">Prowlarr indexer disabled</span>
            <span className="text-orange-400/80 ml-2 text-xs">
              Re-enables {new Date(s.disabledTill) <= new Date() ? 'soon' : `at ${new Date(s.disabledTill).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
            </span>
          </div>
          <button onClick={() => onDismiss(`indexer-${s.indexerId}`)} className="text-orange-600 hover:text-orange-400 shrink-0 text-base leading-none transition-colors" title="Dismiss">✕</button>
        </div>
      ))}
      {healthAlerts.map((a, i) => (
        <div key={i} className={`flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm border ${a.level === 'error' ? 'bg-red-900/20 border-red-800/50' : 'bg-yellow-900/20 border-yellow-800/50'}`}>
          <span className={`shrink-0 ${a.level === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>⚠</span>
          <div className="min-w-0 flex-1">
            <span className={`font-medium capitalize mr-2 ${a.level === 'error' ? 'text-red-300' : 'text-yellow-300'}`}>{a.service}</span>
            <span className={`text-xs ${a.level === 'error' ? 'text-red-400/80' : 'text-yellow-400/80'}`}>{a.message}</span>
          </div>
          <button onClick={() => onDismiss(`alert-${a.source}-${a.service}-${a.message}`)} className={`shrink-0 text-base leading-none transition-colors ${a.level === 'error' ? 'text-red-700 hover:text-red-400' : 'text-yellow-700 hover:text-yellow-400'}`} title="Dismiss">✕</button>
        </div>
      ))}
    </section>
  )
}

const ACTIVE_STATUSES = new Set(['downloading', 'stalled', 'queued', 'checking', 'processing'])

function ActiveDownloads({ data }: { data: DownloadsData | undefined }) {
  const active    = data?.queue?.filter(i => ACTIVE_STATUSES.has(i.status)) ?? []
  const importing = data?.importing ?? []
  if (!active.length && !importing.length) return null
  return (
    <section className="mb-8">
      <h2 className="section-label">Active Downloads</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
        {active.map(item => {
          const pct = Math.round(item.progress * 100)
          const barColor = item.status === 'stalled' ? 'bg-yellow-500' : item.status === 'error' ? 'bg-red-500' : 'bg-blue-500'
          const statusColor = item.status === 'downloading' ? 'text-green-400' : item.status === 'stalled' ? 'text-yellow-400' : item.status === 'error' ? 'text-red-400' : 'text-gray-500'
          return (
            <div key={item.id} className="px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-[10px] shrink-0 px-1.5 py-0.5 rounded font-medium ${item.client === 'qbittorrent' ? 'bg-blue-900/60 text-blue-300' : 'bg-orange-900/60 text-orange-300'}`}>
                    {item.client === 'qbittorrent' ? 'qBit' : 'NZB'}
                  </span>
                  <p className="text-sm text-white truncate">{item.name}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  <span className={`capitalize ${statusColor}`}>{item.status}</span>
                  <span className="text-gray-500 tabular-nums">{pct}%</span>
                </div>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-1">
                <div className={`h-1 rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex justify-between text-xs text-gray-600">
                <span>{formatSize(item.downloaded)} / {formatSize(item.size)}</span>
                <div className="flex gap-3">
                  {item.dlSpeed > 0 && <span className="text-green-400/80">↓ {formatSpeed(item.dlSpeed)}</span>}
                  {item.eta > 0     && <span>ETA {formatEta(item.eta)}</span>}
                </div>
              </div>
            </div>
          )
        })}
        {importing.map(item => (
          <div key={item.id} className="px-4 py-3 space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] shrink-0 px-1.5 py-0.5 rounded font-medium bg-violet-900/60 text-violet-300">
                  {item.service === 'sonarr' ? 'TV' : 'Movie'}
                </span>
                <p className="text-sm text-white truncate">
                  {item.mediaTitle ? `${item.mediaTitle} — ` : ''}{item.title}
                </p>
              </div>
              <span className="text-xs text-violet-400 shrink-0 capitalize">
                {item.state === 'importPending' ? 'pending' : item.state}
              </span>
            </div>
            {item.state === 'importing' ? (
              <div className="w-full bg-gray-800 rounded-full h-1 overflow-hidden">
                <div className="h-1 rounded-full animate-shimmer" style={{ background: 'linear-gradient(90deg, transparent 0%, #8B5CF6 40%, #A78BFA 50%, #8B5CF6 60%, transparent 100%)', backgroundSize: '200% 100%' }} />
              </div>
            ) : (
              <div className="w-full bg-gray-800 rounded-full h-1">
                <div className="h-1 rounded-full bg-violet-900/60 w-full" />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Page ───────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { enabledServices, isLoading: configLoading } = useConfig()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!configLoading && enabledServices.length === 0) navigate('/settings')
  }, [configLoading, enabledServices, navigate])

  const enabled = enabledServices.length > 0

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: async () => (await api.get<HealthData>('/health')).data,
    refetchInterval: 60_000, enabled,
  })
  const { data, isLoading, dataUpdatedAt } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => (await api.get<DashboardData>('/dashboard')).data,
    refetchInterval: 10_000, enabled,
  })
  const { data: downloadsData } = useQuery<DownloadsData>({
    queryKey: ['downloads'],
    queryFn: async () => (await api.get<DownloadsData>('/downloads')).data,
    refetchInterval: 5_000, enabled,
  })

  const approveMutation = useMutation({
    mutationFn: (id: number) => api.post(`/services/overseerr/requests/${id}/approve`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  })
  const declineMutation = useMutation({
    mutationFn: (id: number) => api.post(`/services/overseerr/requests/${id}/decline`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  })

  useDownloadNotifications(data?.recentlyDownloaded ?? [])

  if (configLoading || isLoading) return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {enabledServices.map(s => <div key={s} className="bg-gray-900 border border-gray-800 rounded-lg p-3 animate-pulse h-16" />)}
      </div>
    </div>
  )

  if (!data) return null

  return (
    <div className="p-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        {dataUpdatedAt > 0 && <span className="text-xs text-gray-600">Updated {timeAgo(new Date(dataUpdatedAt).toISOString())}</span>}
      </div>

      {/* Alerts */}
      {healthData && <AlertsBanner healthData={healthData} dismissed={dismissed} onDismiss={k => setDismissed(p => new Set([...p, k]))} />}

      {/* Service Health */}
      <section className="mb-8">
        <h2 className="section-label">Service Health</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {(Object.entries(data.health) as [ServiceName, HealthEntry][]).map(([name, h]) => (
            <div key={name} title={h.ok ? (h.version ? `v${h.version}` : 'Online') : h.error} className={`bg-gray-900 border rounded-lg px-3 py-2.5 flex items-center gap-2 ${h.ok ? 'border-gray-700' : 'border-red-900/60'}`}>
              <span className={`w-2 h-2 rounded-full shrink-0 ${h.ok ? 'bg-green-400' : 'bg-red-500'}`} />
              <div className="min-w-0">
                <p className="text-xs font-medium text-white truncate">{SERVICE_LABELS[name] ?? name}</p>
                {h.version && <p className="text-[10px] text-gray-600">v{h.version}</p>}
                {!h.ok && <p className="text-[10px] text-red-500 truncate">{h.error}</p>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Library Stats */}
      <section className="mb-8">
        <h2 className="section-label">Library</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <StatCard label="Movies"   value={data.stats.movies} />
          <StatCard label="Shows"    value={data.stats.shows} />
          <StatCard label="Episodes" value={data.stats.episodes} />
          <StatCard label="Streams"  value={data.stats.plexStreams}      highlight={!!data.stats.plexStreams} />
          <StatCard label="Requests" value={data.stats.pendingRequests}  highlight={!!data.stats.pendingRequests} />
        </div>
      </section>

      {/* Active Streams — above downloads */}
      {data.plexStreams.length > 0 && (
        <section className="mb-8">
          <h2 className="section-label">Active Streams</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
              {data.plexStreams.map((s, i) => {
                const pct = s.duration ? Math.round((s.viewOffset / s.duration) * 100) : null
                const res = s.videoResolution === '4k' ? '4K' : s.videoResolution ? `${s.videoResolution}p` : null
                const codec = [res, s.videoCodec?.toUpperCase(), s.audioCodec?.toUpperCase()].filter(Boolean).join(' · ')
                const methodColor = s.playMethod === 'direct play' ? 'text-green-400' : s.playMethod === 'transcode' ? 'text-yellow-400' : 'text-blue-400'
                return (
                  <div key={i} className="px-4 py-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-white truncate">{s.title}</p>
                        <p className="text-xs text-gray-500">{s.user} · {s.player}{s.platform ? ` (${s.platform})` : ''}</p>
                      </div>
                      <span className={`text-xs shrink-0 mt-0.5 ${s.state === 'playing' ? 'text-green-400' : 'text-yellow-400'}`}>{s.state}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
                      <div className="flex items-center gap-3">
                        {codec && <span>{codec}</span>}
                        <span className={`capitalize ${methodColor}`}>{s.playMethod}</span>
                      </div>
                      {s.duration && <span className="shrink-0 tabular-nums">{formatDuration(s.viewOffset)} / {formatDuration(s.duration)}</span>}
                    </div>
                    {pct !== null && (
                      <div className="w-full bg-gray-800 rounded-full h-0.5">
                        <div className="bg-blue-500 h-0.5 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

      {/* Active Downloads */}
      <ActiveDownloads data={downloadsData} />

      {/* 2-col grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Download clients overview */}
        {(data.downloads.qbittorrent || data.downloads.nzbget) && (
          <section>
            <h2 className="section-label">Downloads</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
              {data.downloads.qbittorrent && <DownloadRow label="qBittorrent" {...data.downloads.qbittorrent} />}
              {data.downloads.nzbget      && <DownloadRow label="NZBGet"      {...data.downloads.nzbget} />}
            </div>
          </section>
        )}

        {/* Pending Requests */}
        {data.pendingRequests.length > 0 && (
          <section>
            <h2 className="section-label">Pending Requests</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
              {data.pendingRequests.map(req => (
                <div key={req.id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{req.title}</p>
                    <p className="text-xs text-gray-500 capitalize">{req.type} · {req.requestedBy}</p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button onClick={() => approveMutation.mutate(req.id)} disabled={approveMutation.isPending} className="text-xs bg-green-700 hover:bg-green-600 text-white px-2.5 py-1 rounded transition-colors disabled:opacity-50">Approve</button>
                    <button onClick={() => declineMutation.mutate(req.id)}  disabled={declineMutation.isPending}  className="text-xs bg-gray-700  hover:bg-red-700  text-white px-2.5 py-1 rounded transition-colors disabled:opacity-50">Decline</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Recently Played */}
      {data.recentlyPlayed.length > 0 && (
        <section className="mb-8">
          <h2 className="section-label">Recently Played</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {data.recentlyPlayed.map((item, i) => (
              <div key={i} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <TypeBadge type={item.type} />
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{item.title}</p>
                    {item.subtitle && <p className="text-xs text-gray-500 truncate">{item.subtitle}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-600 hidden sm:block">{item.user}</span>
                  <span className="text-xs text-gray-600">{timeAgo(item.date)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recently Downloaded */}
      {data.recentlyDownloaded.length > 0 && (
        <section className="mb-8">
          <h2 className="section-label">Recently Downloaded</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {data.recentlyDownloaded.map((item, i) => (
              <div key={i} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`text-xs shrink-0 px-1.5 py-0.5 rounded font-medium ${item.client === 'qbittorrent' ? 'bg-blue-900/60 text-blue-300' : 'bg-orange-900/60 text-orange-300'}`}>
                    {item.client === 'qbittorrent' ? 'qBit' : 'NZB'}
                  </span>
                  <p className="text-sm text-white truncate">{item.name}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-600 hidden sm:block">{formatSize(item.size)}</span>
                  <span className="text-xs text-gray-600">{timeAgo(item.date)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recently Added */}
      {data.recentlyAdded.length > 0 && (
        <section>
          <h2 className="section-label">Recently Added</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {data.recentlyAdded.map((item, i) => (
              <div key={i} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <TypeBadge type={item.type === 'album' ? 'music' : item.type} />
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{item.title}{item.year ? ` (${item.year})` : ''}</p>
                    {item.subtitle && <p className="text-xs text-gray-500 truncate">{item.subtitle}</p>}
                  </div>
                </div>
                <span className="text-xs text-gray-600 shrink-0">{timeAgo(item.date)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// ── Small components ───────────────────────────────────────────────────
function StatCard({ label, value, highlight = false }: { label: string; value: number | null; highlight?: boolean }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
      <p className={`text-2xl font-bold tabular-nums ${highlight && value ? 'text-blue-400' : 'text-white'}`}>
        {value === null ? '—' : value.toLocaleString()}
      </p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </div>
  )
}

function DownloadRow({ label, ok, dlSpeed, upSpeed, active }: {
  label: string; ok: boolean; dlSpeed: number; upSpeed?: number; active: number
}) {
  const idle = active === 0 && dlSpeed === 0
  return (
    <div className="px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-400' : 'bg-red-500'}`} />
        <span className="text-sm text-white">{label}</span>
        {!idle && <span className="text-xs text-gray-500">{active} active</span>}
      </div>
      <div className="flex gap-4 text-xs">
        {idle
          ? <span className="text-gray-600">Idle</span>
          : <>
              <span className="text-green-400">↓ {formatSpeed(dlSpeed)}</span>
              {upSpeed !== undefined && <span className="text-blue-400">↑ {formatSpeed(upSpeed)}</span>}
            </>
        }
      </div>
    </div>
  )
}

const TYPE_BADGE: Record<string, string> = {
  movie:   'bg-blue-900/60 text-blue-300',
  episode: 'bg-green-900/60 text-green-300',
  music:   'bg-purple-900/60 text-purple-300',
}
const TYPE_LABEL: Record<string, string> = { movie: 'Movie', episode: 'TV', music: 'Music' }

function TypeBadge({ type }: { type: string }) {
  return (
    <span className={`text-xs shrink-0 px-1.5 py-0.5 rounded font-medium ${TYPE_BADGE[type] ?? 'bg-gray-800 text-gray-400'}`}>
      {TYPE_LABEL[type] ?? type}
    </span>
  )
}
