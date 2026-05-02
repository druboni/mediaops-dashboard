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
}

const LEVEL_COLOR: Record<string, string> = {
  error: 'text-red-400',
  warn:  'text-yellow-400',
  info:  'text-gray-300',
  debug: 'text-gray-500',
}

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function Logs() {
  const { data: logs = [], dataUpdatedAt } = useQuery<LogEntry[]>({
    queryKey: ['logs'],
    queryFn: () => api.get('/logs').then((r) => r.data),
    refetchInterval: 2000,
  })

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-white">Server Logs</h1>
        <span className="text-xs text-gray-500">
          auto-refresh · last updated {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '—'}
        </span>
      </div>

      <div className="flex-1 bg-gray-950 rounded-lg border border-gray-800 overflow-y-auto font-mono text-xs">
        {logs.length === 0 ? (
          <p className="p-4 text-gray-600">No log entries yet. Try testing a service connection.</p>
        ) : (
          <table className="w-full">
            <tbody>
              {logs.map((entry, i) => (
                <tr key={i} className="border-b border-gray-900 hover:bg-gray-900/40">
                  <td className="pl-4 pr-3 py-1.5 text-gray-600 whitespace-nowrap w-20">{fmt(entry.time)}</td>
                  <td className={`pr-3 py-1.5 w-12 font-bold uppercase whitespace-nowrap ${LEVEL_COLOR[entry.level] ?? 'text-gray-400'}`}>
                    {entry.level}
                  </td>
                  <td className={`pr-3 py-1.5 ${LEVEL_COLOR[entry.level] ?? 'text-gray-400'}`}>
                    {entry.msg}
                  </td>
                  <td className="pr-4 py-1.5 text-gray-600 text-right whitespace-nowrap">
                    {entry.body && (
                      <span className="mr-3 text-blue-500">body: {entry.body}</span>
                    )}
                    {entry.responseText && (
                      <span className="text-purple-400">resp: "{entry.responseText}"</span>
                    )}
                    {entry.error && (
                      <span className="text-red-500">{entry.error}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
