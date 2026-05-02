import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

// ── Types ──────────────────────────────────────────────────────────────────

interface HuntApp {
  status?: string
  next_run?: string
  last_run?: string
  missing_processed?: number
  upgrade_processed?: number
  enabled?: boolean
}

interface HuntStatus {
  running?: boolean
  apps?: Record<string, HuntApp>
  version?: string
  cycle_count?: number
}

interface LogEntry {
  timestamp?: string
  time?: string
  message?: string
  level?: string
  app?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(d?: string) {
  if (!d) return '—'
  const diff = Date.now() - new Date(d).getTime()
  if (isNaN(diff)) return d
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const APP_COLORS: Record<string, string> = {
  sonarr: 'text-blue-400',
  radarr: 'text-yellow-400',
  lidarr: 'text-purple-400',
  readarr: 'text-green-400',
}

const LEVEL_COLORS: Record<string, string> = {
  ERROR: 'text-red-400',
  WARNING: 'text-yellow-400',
  WARN: 'text-yellow-400',
  INFO: 'text-gray-300',
  DEBUG: 'text-gray-600',
}

// ── Log Viewer ─────────────────────────────────────────────────────────────

function LogViewer() {
  // Try both common Huntarr log endpoints
  const { data: logs, isLoading, isError } = useQuery<LogEntry[] | { logs: LogEntry[] }>({
    queryKey: ['huntarr-logs'],
    queryFn: async () => (await api.get('/proxy/huntarr/api/logs/huntarr', {
      params: { lines: 100 },
    })).data,
    staleTime: 15_000,
    refetchInterval: 30_000,
  })

  const entries: LogEntry[] = Array.isArray(logs)
    ? logs
    : (logs as { logs?: LogEntry[] })?.logs ?? []

  if (isLoading) {
    return (
      <div className="space-y-1">
        {[...Array(8)].map((_, i) => <div key={i} className="h-6 bg-gray-800 rounded animate-pulse" />)}
      </div>
    )
  }

  if (isError || entries.length === 0) {
    return (
      <p className="text-xs text-gray-600 py-4 text-center">
        {isError ? 'Could not load logs — check Huntarr connection' : 'No log entries'}
      </p>
    )
  }

  return (
    <div className="bg-gray-950 rounded-lg border border-gray-800 p-3 font-mono text-xs space-y-0.5 max-h-96 overflow-y-auto">
      {[...entries].reverse().map((entry, i) => {
        const ts = entry.timestamp || entry.time
        const level = entry.level?.toUpperCase() ?? 'INFO'
        const appName = entry.app
        return (
          <div key={i} className="flex items-start gap-2 leading-relaxed">
            <span className="text-gray-600 shrink-0 tabular-nums">{ts ? new Date(ts).toLocaleTimeString() : ''}</span>
            {level && <span className={`shrink-0 w-12 ${LEVEL_COLORS[level] ?? 'text-gray-500'}`}>{level}</span>}
            {appName && <span className={`shrink-0 w-14 ${APP_COLORS[appName.toLowerCase()] ?? 'text-gray-400'}`}>{appName}</span>}
            <span className="text-gray-300 break-all">{entry.message}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function Hunt() {
  const { enabledServices } = useConfig()
  const [triggeredApp, setTriggeredApp] = useState<string | null>(null)

  const enabled = enabledServices.includes('huntarr')

  const { data: status, isError: statusError } = useQuery<HuntStatus>({
    queryKey: ['huntarr-status'],
    queryFn: async () => (await api.get('/proxy/huntarr/api/status')).data,
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
  })

  const trigger = useMutation({
    mutationFn: (app: string) => api.post(`/proxy/huntarr/api/manual/${app}`, {}),
    onMutate: (app) => setTriggeredApp(app),
    onSettled: () => setTimeout(() => setTriggeredApp(null), 3000),
  })

  if (!enabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Hunt</h1>
        <p className="text-gray-500">Enable Huntarr in Settings to use hunt features.</p>
      </div>
    )
  }

  const apps = status?.apps
    ? Object.entries(status.apps)
    : ([] as [string, HuntApp][])

  const huntTargets = ['sonarr', 'radarr', 'lidarr'].filter((a) =>
    enabledServices.includes(a as 'sonarr' | 'radarr' | 'lidarr')
  )

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Hunt</h1>
          {status?.version && <p className="text-xs text-gray-500 mt-0.5">Huntarr v{status.version}</p>}
        </div>
        {status?.running !== undefined && (
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${status.running ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
            <span className="text-sm text-gray-400">{status.running ? 'Running' : 'Idle'}</span>
          </div>
        )}
      </div>

      {statusError && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-950/40 border border-red-900 text-red-400 text-sm">
          Could not reach Huntarr. Verify the URL and API key in Settings.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* App Status Cards */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">App Status</h2>
          {apps.length > 0 ? (
            <div className="grid gap-3">
              {apps.map(([name, app]) => (
                <div key={name} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className={`text-sm font-semibold capitalize ${APP_COLORS[name] ?? 'text-white'}`}>{name}</span>
                    {app.status && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        app.status === 'running' ? 'bg-green-900/60 text-green-400' :
                        app.status === 'idle' ? 'bg-gray-800 text-gray-500' :
                        'bg-yellow-900/60 text-yellow-400'
                      }`}>
                        {app.status}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {app.missing_processed !== undefined && (
                      <div>
                        <p className="text-gray-600">Missing processed</p>
                        <p className="text-white font-medium">{app.missing_processed}</p>
                      </div>
                    )}
                    {app.upgrade_processed !== undefined && (
                      <div>
                        <p className="text-gray-600">Upgrades processed</p>
                        <p className="text-white font-medium">{app.upgrade_processed}</p>
                      </div>
                    )}
                    {app.last_run && (
                      <div>
                        <p className="text-gray-600">Last run</p>
                        <p className="text-gray-400">{timeAgo(app.last_run)}</p>
                      </div>
                    )}
                    {app.next_run && (
                      <div>
                        <p className="text-gray-600">Next run</p>
                        <p className="text-gray-400">{timeAgo(app.next_run)}</p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Fallback: simple stat card when status has no apps breakdown */
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              {status?.cycle_count !== undefined ? (
                <div className="text-center">
                  <p className="text-3xl font-bold text-white tabular-nums">{status.cycle_count}</p>
                  <p className="text-xs text-gray-500 mt-1">cycles completed</p>
                </div>
              ) : (
                <p className="text-xs text-gray-600 text-center py-2">
                  {statusError ? 'Status unavailable' : 'Connected — no detailed stats available'}
                </p>
              )}
            </div>
          )}

          {/* Manual Triggers */}
          {huntTargets.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Manual Trigger</h2>
              <div className="grid grid-cols-3 gap-2">
                {huntTargets.map((app) => {
                  const isTriggered = triggeredApp === app
                  return (
                    <button
                      key={app}
                      onClick={() => trigger.mutate(app)}
                      disabled={trigger.isPending}
                      className={`py-2.5 rounded-lg text-xs font-medium capitalize transition-all border ${
                        isTriggered
                          ? 'bg-green-900/40 border-green-700 text-green-400'
                          : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white'
                      }`}
                    >
                      {isTriggered ? '✓ Triggered' : `Hunt ${app}`}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-gray-600">Sends an immediate hunt request to Huntarr for the selected app.</p>
            </div>
          )}
        </div>

        {/* Log Viewer */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Logs</h2>
          <LogViewer />
        </div>
      </div>
    </div>
  )
}
