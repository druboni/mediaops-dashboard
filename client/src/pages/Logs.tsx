import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../services/api'

interface LogEntry {
  time: number
  level: 'info' | 'warn' | 'error' | 'debug'
  msg: string
  service?: string
  status?: number
  url?: string
  body?: string
  responseText?: string
  error?: string
  duration?: number
}

const LEVEL_BG: Record<string, string> = {
  error: 'bg-red-900/70 text-red-300',
  warn:  'bg-yellow-900/70 text-yellow-300',
  info:  'bg-gray-800 text-gray-400',
  debug: 'bg-gray-900 text-gray-600',
}

const LEVEL_ROW: Record<string, string> = {
  error: 'border-l-2 border-red-700',
  warn:  'border-l-2 border-yellow-700',
  info:  'border-l-transparent border-l-2',
  debug: 'border-l-transparent border-l-2 opacity-60',
}

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function urlPath(url?: string) {
  if (!url) return null
  try { const u = new URL(url); return u.pathname + u.search } catch { return url }
}

export default function Logs() {
  const [levelFilter, setLevelFilter] = useState<string>('all')
  const [serviceFilter, setServiceFilter] = useState<string>('all')
  const [expanded, setExpanded] = useState<number | null>(null)

  const { data: logs = [], dataUpdatedAt } = useQuery<LogEntry[]>({
    queryKey: ['logs'],
    queryFn: () => api.get('/logs').then((r) => r.data),
    refetchInterval: 2000,
  })

  const services = [...new Set(logs.map((l) => l.service).filter(Boolean))] as string[]

  const filtered = logs.filter((l) => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false
    if (serviceFilter !== 'all' && l.service !== serviceFilter) return false
    return true
  })

  const levels = ['all', 'error', 'warn', 'info', 'debug']
  const levelCounts = { error: 0, warn: 0, info: 0, debug: 0 }
  for (const l of logs) if (l.level in levelCounts) levelCounts[l.level as keyof typeof levelCounts]++

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <h1 className="text-2xl font-bold text-white">Logs</h1>
        <span className="text-xs text-gray-500">
          auto-refresh · {filtered.length} / {logs.length} entries
          {dataUpdatedAt > 0 && <> · updated {new Date(dataUpdatedAt).toLocaleTimeString()}</>}
        </span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 shrink-0 flex-wrap">
        {/* Level filter */}
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          {levels.map((l) => (
            <button
              key={l}
              onClick={() => setLevelFilter(l)}
              className={`px-3 py-1.5 transition-colors capitalize ${
                levelFilter === l ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
              }`}
            >
              {l === 'all' ? `All (${logs.length})` : `${l} (${levelCounts[l as keyof typeof levelCounts]})`}
            </button>
          ))}
        </div>

        {/* Service filter */}
        {services.length > 0 && (
          <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
            <button
              onClick={() => setServiceFilter('all')}
              className={`px-3 py-1.5 transition-colors ${serviceFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'}`}
            >
              All services
            </button>
            {services.map((s) => (
              <button
                key={s}
                onClick={() => setServiceFilter(s)}
                className={`px-3 py-1.5 transition-colors capitalize ${serviceFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'}`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Log table */}
      <div className="flex-1 bg-gray-950 rounded-lg border border-gray-800 overflow-y-auto font-mono text-xs">
        {filtered.length === 0 ? (
          <p className="p-4 text-gray-600">No log entries match the current filter.</p>
        ) : (
          <div>
            {filtered.map((entry, i) => {
              const path = urlPath(entry.url)
              const isExpanded = expanded === i
              const hasDetail = entry.body || entry.responseText || entry.error || entry.url
              return (
                <div key={i} className={`border-b border-gray-900 ${LEVEL_ROW[entry.level] ?? ''}`}>
                  {/* Main row */}
                  <div
                    className={`flex items-start gap-3 px-3 py-1.5 ${hasDetail ? 'cursor-pointer hover:bg-gray-900/50' : ''} ${isExpanded ? 'bg-gray-900/40' : ''}`}
                    onClick={() => hasDetail && setExpanded(isExpanded ? null : i)}
                  >
                    <span className="text-gray-600 whitespace-nowrap w-[70px] shrink-0 pt-px">{fmt(entry.time)}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase whitespace-nowrap shrink-0 ${LEVEL_BG[entry.level] ?? 'bg-gray-800 text-gray-400'}`}>
                      {entry.level}
                    </span>
                    {entry.service && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400 whitespace-nowrap shrink-0">
                        {entry.service}
                      </span>
                    )}
                    <span className={`flex-1 min-w-0 pt-px ${entry.level === 'error' ? 'text-red-300' : entry.level === 'warn' ? 'text-yellow-300' : 'text-gray-300'}`}>
                      {entry.msg}
                    </span>
                    {entry.duration !== undefined && (
                      <span className="text-gray-600 shrink-0 tabular-nums pt-px">{entry.duration}ms</span>
                    )}
                    {hasDetail && (
                      <span className="text-gray-700 shrink-0 pt-px">{isExpanded ? '▲' : '▼'}</span>
                    )}
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-3 pb-2 space-y-1 bg-gray-900/30 border-t border-gray-800/50">
                      {path && (
                        <div className="flex gap-2 pt-1">
                          <span className="text-gray-600 w-20 shrink-0">URL</span>
                          <span className="text-blue-400 break-all">{path}</span>
                        </div>
                      )}
                      {entry.body && (
                        <div className="flex gap-2">
                          <span className="text-gray-600 w-20 shrink-0">Request</span>
                          <span className="text-gray-300 break-all">{entry.body}</span>
                        </div>
                      )}
                      {entry.responseText && (
                        <div className="flex gap-2">
                          <span className="text-gray-600 w-20 shrink-0">Response</span>
                          <span className="text-purple-300 break-all">{entry.responseText}</span>
                        </div>
                      )}
                      {entry.error && (
                        <div className="flex gap-2">
                          <span className="text-gray-600 w-20 shrink-0">Error</span>
                          <span className="text-red-400 break-all">{entry.error}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
