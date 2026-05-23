import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

interface HistoryItem {
  id: string
  service: 'radarr' | 'sonarr' | 'lidarr'
  type: 'movie' | 'episode' | 'music'
  event: string
  eventLabel: string
  title: string
  subtitle?: string | null
  year?: number | null
  quality?: string | null
  date: string
  successful: boolean
}

interface HistoryData {
  items: HistoryItem[]
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

const EVENT_COLORS: Record<string, string> = {
  grabbed:               'text-blue-400',
  downloadFolderImported:'text-green-400',
  downloadFailed:        'text-red-400',
  movieFileDeleted:      'text-orange-400',
  episodeFileDeleted:    'text-orange-400',
  trackFileDeleted:      'text-orange-400',
  movieFileRenamed:      'text-yellow-400',
}

const TYPE_BADGE: Record<string, string> = {
  movie:   'bg-blue-900/60 text-blue-300',
  episode: 'bg-green-900/60 text-green-300',
  music:   'bg-purple-900/60 text-purple-300',
}

const SERVICE_BADGE: Record<string, string> = {
  radarr: 'bg-yellow-900/40 text-yellow-400',
  sonarr: 'bg-blue-900/40 text-blue-400',
  lidarr: 'bg-green-900/40 text-green-400',
}

export default function History() {
  const { enabledServices } = useConfig()
  const [eventFilter, setEventFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const enabled = enabledServices.some((s) => ['radarr', 'sonarr', 'lidarr'].includes(s))

  const { data, isLoading } = useQuery<HistoryData>({
    queryKey: ['history'],
    queryFn: async () => (await api.get<HistoryData>('/history')).data,
    refetchInterval: 30_000,
    enabled,
  })

  if (!enabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">History</h1>
        <p className="text-gray-500">Enable Radarr, Sonarr, or Lidarr in Settings.</p>
      </div>
    )
  }

  const items = data?.items ?? []
  const filtered = items.filter((i) => {
    if (eventFilter !== 'all' && i.event !== eventFilter) return false
    if (typeFilter !== 'all' && i.type !== typeFilter) return false
    return true
  })

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">History</h1>
          <p className="text-sm text-gray-500 mt-0.5">Recent activity across Radarr, Sonarr, and Lidarr</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          {(['all', 'movie', 'episode', 'music'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 transition-colors capitalize ${
                typeFilter === t ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
              }`}
            >
              {t === 'all' ? 'All types' : t === 'episode' ? 'TV' : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
          {([
            ['all', 'All events'],
            ['downloadFolderImported', 'Imported'],
            ['grabbed', 'Grabbed'],
            ['downloadFailed', 'Failed'],
          ] as const).map(([e, label]) => (
            <button
              key={e}
              onClick={() => setEventFilter(e)}
              className={`px-3 py-1.5 transition-colors ${
                eventFilter === e ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-1">
          {[...Array(10)].map((_, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-14 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-600 text-sm">No history entries</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800/50">
          {filtered.map((item) => (
            <div key={item.id} className="px-4 py-3 flex items-center gap-3">
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${TYPE_BADGE[item.type]}`}>
                  {item.type === 'episode' ? 'TV' : item.type === 'music' ? 'Music' : 'Movie'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-white truncate font-medium">{item.title}</span>
                  {item.year && <span className="text-xs text-gray-600 shrink-0">{item.year}</span>}
                </div>
                {item.subtitle && (
                  <p className="text-xs text-gray-500 truncate mt-0.5">{item.subtitle}</p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {item.quality && (
                  <span className="text-xs text-gray-600 hidden lg:block">{item.quality}</span>
                )}
                <span className={`text-xs font-medium ${EVENT_COLORS[item.event] ?? 'text-gray-400'}`}>
                  {item.eventLabel}
                </span>
                <span className="text-xs text-gray-600 hidden sm:block">{timeAgo(item.date)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
