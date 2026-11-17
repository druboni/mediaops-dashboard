import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../services/api'

// Wanted → Wrong Language: seasons and movies whose files have no audio track
// in the title's original language (server/routes/language.js).

interface LanguageItem {
  key: string
  ignoreKey: string
  app: 'sonarr' | 'radarr'
  reason: 'audio' | 'subs'
  title: string
  seasonNumber?: number
  originalLanguage: string
  audio: string[]
  fileCount: number
  sample: string
  size: number
}

interface LanguageData {
  scannedAt: number
  errors: string[]
  items: LanguageItem[]
  ignored: { key: string; title: string }[]
}

type Outcome = { ok: boolean; message: string }

function formatSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`
  return '—'
}

function errorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string }
  return e.response?.data?.error ?? e.message ?? 'Failed'
}

export default function WrongLanguage() {
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({})
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)

  const { data, isLoading, isFetching, error } = useQuery<LanguageData>({
    queryKey: ['wanted-language'],
    queryFn: async () => (await api.get<LanguageData>('/language')).data,
    staleTime: 5 * 60_000,
  })

  const rescan = async () => {
    const fresh = (await api.get<LanguageData>('/language', { params: { refresh: 1 } })).data
    queryClient.setQueryData(['wanted-language'], fresh)
    setOutcome({})
  }

  // Checks for an acceptable release first and keeps the files if there is none,
  // so this can take a minute per item.
  const replaceOne = async (item: LanguageItem) => {
    setBusy(item.key)
    setConfirm(null)
    try {
      const res = (await api.post<{ replaced: boolean; message: string }>('/language/replace', { key: item.key })).data
      setOutcome((o) => ({ ...o, [item.key]: { ok: res.replaced, message: res.message } }))
    } catch (err) {
      setOutcome((o) => ({ ...o, [item.key]: { ok: false, message: errorMessage(err) } }))
    } finally {
      setBusy(null)
    }
  }

  const replaceAll = async (items: LanguageItem[]) => {
    setConfirmAll(false)
    setBulk({ done: 0, total: items.length })
    for (const [i, item] of items.entries()) {
      await replaceOne(item)
      setBulk({ done: i + 1, total: items.length })
    }
    setBulk(null)
  }

  const ignore = useMutation({
    mutationFn: (item: LanguageItem) => api.post('/language/ignore', { key: item.ignoreKey, title: item.title }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wanted-language'] }),
  })
  const unignore = useMutation({
    mutationFn: (key: string) => api.delete(`/language/ignore/${encodeURIComponent(key)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wanted-language'] }),
  })

  if (isLoading) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-gray-500 mb-3">Reading every file's audio tracks from Sonarr and Radarr — the first scan takes a minute.</p>
        {[...Array(6)].map((_, i) => <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg h-14 animate-pulse" />)}
      </div>
    )
  }
  if (error) return <p className="text-red-400 text-sm">Scan failed: {errorMessage(error)}</p>

  const items = data?.items ?? []
  const pending = items.filter((i) => !outcome[i.key]?.ok)
  const files = items.reduce((n, i) => n + i.fileCount, 0)

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-xs text-gray-500">
          {items.length
            ? <>{files} file{files === 1 ? '' : 's'} in {items.length} season{items.length === 1 ? '' : 's'}/movie{items.length === 1 ? '' : 's'} with no audio in English or the original language, or original audio with no English subtitles.</>
            : 'Every file has English audio, or original audio with English subtitles.'}
          {data?.scannedAt && <span className="text-gray-600"> Scanned {new Date(data.scannedAt).toLocaleTimeString()}.</span>}
          <span className="block text-gray-600 mt-0.5">Replacements are dated back to their air date in Plex, so they don't show up in Recently Added.</span>
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={rescan} disabled={isFetching || !!bulk} className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-50">
            Rescan
          </button>
          {pending.length > 0 && (bulk ? (
            <span className="text-xs text-blue-300 animate-pulse">Replacing {bulk.done + 1} of {bulk.total}…</span>
          ) : confirmAll ? (
            <span className="flex items-center gap-1">
              <button onClick={() => replaceAll(pending)} className="text-xs px-3 py-1 rounded bg-red-700 hover:bg-red-600 text-white font-medium">
                Delete & re-download all {pending.length}
              </button>
              <button onClick={() => setConfirmAll(false)} className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-400 hover:text-white">✕</button>
            </span>
          ) : (
            <button onClick={() => setConfirmAll(true)} disabled={!!busy} className="text-xs px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50">
              Replace all
            </button>
          ))}
        </div>
      </div>

      {data?.errors.map((e) => <p key={e} className="text-xs text-red-400 mb-2">{e}</p>)}

      {items.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800/50">
          {items.map((item) => {
            const result = outcome[item.key]
            return (
              <div key={item.key} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 uppercase">{item.app === 'sonarr' ? 'TV' : 'Movie'}</span>
                    <span className="text-white font-medium">{item.title}</span>
                    {item.seasonNumber != null && <span className="text-xs text-gray-500 font-mono">S{String(item.seasonNumber).padStart(2, '0')}</span>}
                    <span className="text-xs text-gray-500">{item.fileCount} file{item.fileCount === 1 ? '' : 's'} · {formatSize(item.size)}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    {item.audio.map((a) => (
                      <span key={a} className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/40 text-orange-300 font-mono">{a}</span>
                    ))}
                    <span className="text-[11px] text-gray-500">
                      {item.reason === 'subs' ? 'audio, no English subtitles' : `instead of ${item.originalLanguage}`}
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-600 truncate mt-0.5 font-mono" title={item.sample}>{item.sample}</div>
                  {result && <div className={`text-xs mt-1 ${result.ok ? 'text-green-400' : 'text-yellow-400'}`}>{result.message}</div>}
                </div>
                {!result?.ok && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {busy === item.key ? (
                      <span className="text-xs text-blue-300 animate-pulse">Checking releases…</span>
                    ) : confirm === item.key ? (
                      <>
                        <button onClick={() => replaceOne(item)} className="text-xs px-3 py-1 rounded bg-red-700 hover:bg-red-600 text-white font-medium">
                          Delete {item.fileCount} & re-download
                        </button>
                        <button onClick={() => setConfirm(null)} className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-400 hover:text-white">✕</button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => setConfirm(item.key)}
                          disabled={!!busy || !!bulk}
                          title={item.reason === 'subs'
                            ? 'Only deletes the files if a release without foreign tags (MULTi, VOSTFR…) is available'
                            : `Only deletes the files if a ${item.originalLanguage} release is available`}
                          className="text-xs px-3 py-1 rounded bg-gray-700 hover:bg-blue-700 text-gray-300 hover:text-white disabled:opacity-50"
                        >
                          Replace
                        </button>
                        <button
                          onClick={() => ignore.mutate(item)}
                          disabled={!!bulk}
                          title={item.app === 'sonarr' ? 'Hide this show (all seasons) from the list' : 'Hide this movie from the list'}
                          className="text-xs px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-500 hover:text-gray-300 disabled:opacity-50"
                        >
                          Ignore
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {(data?.ignored.length ?? 0) > 0 && (
        <div className="mt-4">
          <button onClick={() => setShowIgnored((v) => !v)} className="text-xs text-gray-500 hover:text-gray-300">
            {showIgnored ? '▾' : '▸'} {data!.ignored.length} ignored
          </button>
          {showIgnored && (
            <div className="mt-2 flex flex-wrap gap-2">
              {data!.ignored.map((i) => (
                <span key={i.key} className="text-xs px-2 py-1 rounded bg-gray-900 border border-gray-800 text-gray-400 flex items-center gap-1.5">
                  {i.title}
                  <button onClick={() => unignore.mutate(i.key)} className="text-gray-600 hover:text-white" title="Show it in the list again">✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
