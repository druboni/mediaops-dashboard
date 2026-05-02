import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'
import type { ServiceName } from '../types'

interface HealthEntry { ok: boolean; version?: string; error?: string }
interface HealthAlert { service: string; level: 'warning' | 'error'; source: string; message: string }
interface IndexerStatus { indexerId: number; mostRecentFailure: string; initialFailure: string; disabledTill: string }
interface HealthData { alerts: HealthAlert[]; indexerStatus: IndexerStatus[] }

interface DashboardData {
  health: Partial<Record<ServiceName, HealthEntry>>
  stats: {
    movies: number | null
    shows: number | null
    episodes: number | null
    artists: number | null
    albums: number | null
    plexStreams: number | null
    pendingRequests: number | null
  }
  downloads: {
    qbittorrent: { ok: boolean; dlSpeed: number; upSpeed: number; active: number } | null
    nzbget: { ok: boolean; dlSpeed: number; active: number } | null
  }
  plexStreams: { title: string; user: string; player: string; state: string }[]
  recentlyAdded: { title: string; subtitle?: string; year?: number; type: string; service: string; date: string }[]
  recentlyPlayed: { title: string; subtitle?: string; type: string; user: string; date: string }[]
  pendingRequests: { id: number; title: string; type: string; requestedBy: string }[]
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1_048_576) return `${(bytesPerSec / 1_048_576).toFixed(1)} MB/s`
  if (bytesPerSec >= 1024) return `${Math.round(bytesPerSec / 1024)} KB/s`
  if (bytesPerSec > 0) return `${bytesPerSec} B/s`
  return '0'
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const SERVICE_LABELS: Partial<Record<ServiceName, string>> = {
  plex: 'Plex', sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr',
  bazarr: 'Bazarr', overseerr: 'Overseerr', prowlarr: 'Prowlarr',
  jackett: 'Jackett', qbittorrent: 'qBittorrent', nzbget: 'NZBGet',
  huntarr: 'Huntarr', requestrr: 'Requestrr', tautulli: 'Tautulli',
}

export default function Dashboard() {
  const { enabledServices, isLoading: configLoading } = useConfig()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!configLoading && enabledServices.length === 0) navigate('/settings')
  }, [configLoading, enabledServices, navigate])

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: async () => (await api.get<HealthData>('/health')).data,
    refetchInterval: 60_000,
    enabled: enabledServices.length > 0,
  })

  const { data, isLoading, dataUpdatedAt } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const res = await api.get<DashboardData>('/dashboard')
      return res.data
    },
    refetchInterval: 10_000,
    enabled: enabledServices.length > 0,
  })

  const approveMutation = useMutation({
    mutationFn: (id: number) => api.post(`/services/overseerr/requests/${id}/approve`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  })

  const declineMutation = useMutation({
    mutationFn: (id: number) => api.post(`/services/overseerr/requests/${id}/decline`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  })

  if (configLoading || isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-8">
          {enabledServices.map((s) => (
            <div key={s} className="bg-gray-900 border border-gray-800 rounded-lg p-3 animate-pulse h-16" />
          ))}
        </div>
      </div>
    )
  }

  if (!data) return null

  const hasDownloads = data.downloads.qbittorrent !== null || data.downloads.nzbget !== null
  const hasPending = data.pendingRequests.length > 0
  const hasStreams = data.plexStreams.length > 0

  return (
    <div className="p-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        {dataUpdatedAt > 0 && (
          <span className="text-xs text-gray-600">
            Updated {timeAgo(new Date(dataUpdatedAt).toISOString())}
          </span>
        )}
      </div>

      {/* Alerts Banner */}
      {healthData && (healthData.alerts.length > 0 || healthData.indexerStatus.length > 0) && (
        <section className="mb-6 space-y-1.5">
          {healthData.indexerStatus.map((s) => (
            <div key={s.indexerId} className="flex items-start gap-3 bg-orange-900/20 border border-orange-800/50 rounded-lg px-4 py-2.5 text-sm">
              <span className="text-orange-400 shrink-0 mt-0.5">⚠</span>
              <div className="min-w-0">
                <span className="text-orange-300 font-medium">Prowlarr indexer disabled</span>
                <span className="text-orange-400/80 ml-2 text-xs">
                  Re-enables {new Date(s.disabledTill) <= new Date() ? 'soon' : `at ${new Date(s.disabledTill).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                </span>
              </div>
            </div>
          ))}
          {healthData.alerts.map((a, i) => (
            <div key={i} className={`flex items-start gap-3 rounded-lg px-4 py-2.5 text-sm border ${
              a.level === 'error'
                ? 'bg-red-900/20 border-red-800/50'
                : 'bg-yellow-900/20 border-yellow-800/50'
            }`}>
              <span className={`shrink-0 mt-0.5 ${a.level === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>
                {a.level === 'error' ? '✕' : '⚠'}
              </span>
              <div className="min-w-0">
                <span className={`font-medium capitalize mr-2 ${a.level === 'error' ? 'text-red-300' : 'text-yellow-300'}`}>
                  {a.service}
                </span>
                <span className={`text-xs ${a.level === 'error' ? 'text-red-400/80' : 'text-yellow-400/80'}`}>
                  {a.message}
                </span>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Health Grid */}
      <section className="mb-8">
        <h2 className="section-label">Service Health</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {(Object.entries(data.health) as [ServiceName, HealthEntry][]).map(([name, h]) => (
            <div
              key={name}
              title={h.ok ? (h.version ? `v${h.version}` : 'Online') : h.error}
              className={`bg-gray-900 border rounded-lg px-3 py-2.5 flex items-center gap-2 ${
                h.ok ? 'border-gray-700' : 'border-red-900/60'
              }`}
            >
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

      {/* Stats Row */}
      <section className="mb-8">
        <h2 className="section-label">Library</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <StatCard label="Movies"   value={data.stats.movies}   />
          <StatCard label="Shows"    value={data.stats.shows}    />
          <StatCard label="Episodes" value={data.stats.episodes} />
          <StatCard label="Artists"  value={data.stats.artists}  />
          <StatCard label="Albums"   value={data.stats.albums}   />
          <StatCard label="Streams"  value={data.stats.plexStreams} highlight={!!data.stats.plexStreams} />
          <StatCard label="Requests" value={data.stats.pendingRequests} highlight={!!data.stats.pendingRequests} />
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Downloads */}
        {hasDownloads && (
          <section>
            <h2 className="section-label">Downloads</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
              {data.downloads.qbittorrent && (
                <DownloadRow
                  label="qBittorrent"
                  ok={data.downloads.qbittorrent.ok}
                  dlSpeed={data.downloads.qbittorrent.dlSpeed}
                  upSpeed={data.downloads.qbittorrent.upSpeed}
                  active={data.downloads.qbittorrent.active}
                />
              )}
              {data.downloads.nzbget && (
                <DownloadRow
                  label="NZBGet"
                  ok={data.downloads.nzbget.ok}
                  dlSpeed={data.downloads.nzbget.dlSpeed}
                  active={data.downloads.nzbget.active}
                />
              )}
            </div>
          </section>
        )}

        {/* Plex Streams */}
        {hasStreams && (
          <section>
            <h2 className="section-label">Active Streams</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
              {data.plexStreams.map((s, i) => (
                <div key={i} className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{s.title}</p>
                    <p className="text-xs text-gray-500">{s.user} · {s.player}</p>
                  </div>
                  <span className={`text-xs shrink-0 mt-0.5 ${s.state === 'playing' ? 'text-green-400' : 'text-yellow-400'}`}>
                    {s.state}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Pending Requests */}
        {hasPending && (
          <section>
            <h2 className="section-label">Pending Requests</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
              {data.pendingRequests.map((req) => (
                <div key={req.id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{req.title}</p>
                    <p className="text-xs text-gray-500 capitalize">{req.type} · {req.requestedBy}</p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      onClick={() => approveMutation.mutate(req.id)}
                      disabled={approveMutation.isPending}
                      className="text-xs bg-green-700 hover:bg-green-600 text-white px-2.5 py-1 rounded transition-colors disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => declineMutation.mutate(req.id)}
                      disabled={declineMutation.isPending}
                      className="text-xs bg-gray-700 hover:bg-red-700 text-white px-2.5 py-1 rounded transition-colors disabled:opacity-50"
                    >
                      Decline
                    </button>
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
                  <span className={`text-xs shrink-0 px-1.5 py-0.5 rounded font-medium ${
                    item.type === 'movie'   ? 'bg-blue-900/60 text-blue-300' :
                    item.type === 'episode' ? 'bg-green-900/60 text-green-300' :
                                             'bg-purple-900/60 text-purple-300'
                  }`}>
                    {item.type === 'movie' ? 'Movie' : item.type === 'episode' ? 'TV' : 'Music'}
                  </span>
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

      {/* Recently Added */}
      {data.recentlyAdded.length > 0 && (
        <section>
          <h2 className="section-label">Recently Added</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
            {data.recentlyAdded.map((item, i) => (
              <div key={i} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`text-xs shrink-0 px-1.5 py-0.5 rounded font-medium ${
                    item.type === 'movie'  ? 'bg-blue-900/60 text-blue-300' :
                    item.type === 'album'  ? 'bg-purple-900/60 text-purple-300' :
                                            'bg-green-900/60 text-green-300'
                  }`}>
                    {item.type === 'movie' ? 'Movie' : item.type === 'album' ? 'Music' : 'TV'}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">
                      {item.title}{item.year ? ` (${item.year})` : ''}
                    </p>
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

function StatCard({ label, value, highlight = false }: { label: string; value: number | null; highlight?: boolean }) {
  const display = value === null ? '—' : value.toLocaleString()
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
      <p className={`text-2xl font-bold tabular-nums ${highlight && value ? 'text-blue-400' : 'text-white'}`}>
        {display}
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
        {idle ? (
          <span className="text-gray-600">Idle</span>
        ) : (
          <>
            <span className="text-green-400">↓ {formatSpeed(dlSpeed)}</span>
            {upSpeed !== undefined && <span className="text-blue-400">↑ {formatSpeed(upSpeed)}</span>}
          </>
        )}
      </div>
    </div>
  )
}
