import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../services/api'

// GPU re-encode UI for Reclaim: the confirm dialog that previews which files a
// selection covers, and the live job list. Jobs run on the encode sidecar
// (scripts/encode-sidecar.py) one at a time; see server/encode.js.

export interface EncodeItem {
  proxyBase: string
  arrId: number
  unit: 'movie' | 'series' | 'season'
  seasonNumber?: number
}

interface EncodeJob {
  id: string
  path: string
  label: string
  cq: number
  status: 'queued' | 'copying' | 'encoding' | 'verifying' | 'replacing' | 'done' | 'skipped' | 'failed' | 'cancelled'
  created: number
  started: number | null
  finished: number | null
  progress: number | null
  speed: string | null
  eta: number | null
  error: string | null
  origSize: number | null
  newSize: number | null
}

export interface EncodeStatus {
  configured: boolean
  reachable?: boolean
  server?: string
  error?: string
  presets: { movie: number; tv: number }
  jobs?: EncodeJob[]
  workFree?: number
}

interface PreviewFile {
  label: string
  path: string
  size: number
  codec: string | null
  warnings: string[]
  kind: 'movie' | 'tv'
}

const ACTIVE = ['copying', 'encoding', 'verifying', 'replacing']

function formatBytes(b: number) {
  if (!b) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1)
  return `${(b / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`
}

function formatEta(s: number | null) {
  if (s == null) return ''
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

export function useEncodeStatus() {
  return useQuery<EncodeStatus>({
    queryKey: ['encode-status'],
    queryFn: async () => (await api.get('/encode/status')).data,
    // Fast while something is moving, slow otherwise.
    refetchInterval: (q) => (q.state.data?.jobs?.some((j) => j.status === 'queued' || ACTIVE.includes(j.status)) ? 3000 : 30000),
  })
}

// ── Confirm dialog ─────────────────────────────────────────────────────────

export function ReencodeDialog({
  items,
  presets,
  onCancel,
  onQueued,
}: {
  items: EncodeItem[]
  presets: { movie: number; tv: number }
  onCancel: () => void
  onQueued: (msg: string) => void
}) {
  const queryClient = useQueryClient()
  // The parent rebuilds `items` on every render (it re-renders as jobs poll), so
  // pin the selection the dialog was opened with.
  const [frozen] = useState(items)
  const [preview, setPreview] = useState<{ files: PreviewFile[]; errors: string[]; truncated: boolean } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cqMovie, setCqMovie] = useState(String(presets.movie))
  const [cqTv, setCqTv] = useState(String(presets.tv))
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api.post('/encode/preview', { items: frozen })
      .then((r) => setPreview(r.data))
      .catch((e) => setLoadError(e.response?.data?.error ?? e.message))
  }, [frozen])

  const files = preview?.files ?? []
  const total = files.reduce((s, f) => s + f.size, 0)
  const warned = files.filter((f) => f.warnings.length)
  const hasMovies = files.some((f) => f.kind === 'movie')
  const hasTv = files.some((f) => f.kind === 'tv')

  const submit = async () => {
    setSubmitting(true)
    try {
      const r = await api.post('/encode/queue', { items: frozen, cq: { movie: Number(cqMovie), tv: Number(cqTv) } })
      const { queued, errors } = r.data as { queued: number; errors: string[] }
      onQueued(
        errors.length
          ? `Queued ${queued} file${queued === 1 ? '' : 's'} for re-encode; ${errors.length} couldn't be queued (${errors.slice(0, 2).join('; ')}${errors.length > 2 ? '…' : ''})`
          : `Queued ${queued} file${queued === 1 ? '' : 's'} for re-encode.`
      )
      queryClient.invalidateQueries({ queryKey: ['encode-status'] })
    } catch (e: any) {
      setLoadError(e.response?.data?.error ?? e.message)
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-800">
          <h3 className="text-white font-semibold">Re-encode with the GPU</h3>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <p className="text-sm text-gray-400">
            Each file is copied to the encode server's NVMe, re-encoded to HEVC (audio and subtitles kept as they are),
            checked, and copied back <span className="text-amber-300">over the original</span>. If the result fails a
            check, or isn't at least 5% smaller, the original is left alone. Jobs run one at a time.
          </p>

          {loadError && <p className="text-sm text-red-400">{loadError}</p>}
          {!preview && !loadError && <p className="text-sm text-gray-500">Finding files…</p>}

          {preview && (
            <>
              <p className="text-sm text-gray-300">
                <span className="text-white font-semibold">{files.length}</span> file{files.length === 1 ? '' : 's'},{' '}
                <span className="text-white font-semibold">{formatBytes(total)}</span>
                {preview.truncated && <span className="text-amber-400"> (capped at {files.length}; run the rest after)</span>}
              </p>

              {warned.length > 0 && (
                <div className="bg-amber-900/20 border border-amber-900/60 rounded-lg px-3 py-2">
                  <p className="text-xs text-amber-300 font-medium mb-1">
                    {warned.length} file{warned.length === 1 ? '' : 's'} may not shrink much
                  </p>
                  <ul className="text-xs text-gray-400 space-y-0.5 max-h-32 overflow-y-auto">
                    {warned.slice(0, 50).map((f) => (
                      <li key={f.path} className="truncate">
                        {f.label} <span className="text-amber-400/80">— {f.warnings.join(', ')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.errors.length > 0 && (
                <ul className="text-xs text-red-400 space-y-0.5">
                  {preview.errors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}

              <div className="flex gap-4 flex-wrap">
                {hasMovies && (
                  <label className="flex items-center gap-2 text-xs text-gray-400">
                    Movie quality (CQ)
                    <input value={cqMovie} onChange={(e) => setCqMovie(e.target.value)} inputMode="numeric" className="input text-xs py-1 w-14 text-right" />
                  </label>
                )}
                {hasTv && (
                  <label className="flex items-center gap-2 text-xs text-gray-400">
                    TV quality (CQ)
                    <input value={cqTv} onChange={(e) => setCqTv(e.target.value)} inputMode="numeric" className="input text-xs py-1 w-14 text-right" />
                  </label>
                )}
              </div>
              <p className="text-[11px] text-gray-600">
                Lower CQ = better quality, bigger file. Defaults are what your earlier batches used: {presets.movie} for movies,{' '}
                {presets.tv} for TV.
              </p>
            </>
          )}
        </div>
        <div className="px-5 py-4 border-t border-gray-800 flex gap-2">
          <button onClick={onCancel} className="flex-1 text-sm py-2 rounded-lg bg-gray-800 text-gray-300 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!files.length || submitting}
            className="flex-1 text-sm py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Queuing…' : `Re-encode ${files.length || ''} file${files.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Job list ───────────────────────────────────────────────────────────────

const PHASE: Record<string, string> = {
  queued: 'Queued',
  copying: 'Copying to NVMe',
  encoding: 'Encoding',
  verifying: 'Checking',
  replacing: 'Copying back',
  done: 'Done',
  skipped: 'Kept original',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function EncodeJobs({ status }: { status: EncodeStatus }) {
  const queryClient = useQueryClient()
  const [showFinished, setShowFinished] = useState(false)
  const jobs = status.jobs ?? []
  const active = jobs.filter((j) => ACTIVE.includes(j.status))
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.created - b.created)
  const finished = jobs.filter((j) => !ACTIVE.includes(j.status) && j.status !== 'queued')
  const saved = finished.filter((j) => j.status === 'done').reduce((s, j) => s + ((j.origSize ?? 0) - (j.newSize ?? 0)), 0)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['encode-status'] })
  const cancel = (id: string) => api.post(`/encode/jobs/${id}/cancel`).finally(refresh)
  const forget = (id: string) => api.delete(`/encode/jobs/${id}`).finally(refresh)

  if (!status.reachable) {
    return (
      <div className="mb-4 bg-yellow-900/20 border border-yellow-900/60 rounded-lg px-4 py-2.5">
        <p className="text-xs text-yellow-400">Encoder on {status.server} isn't reachable: {status.error}</p>
      </div>
    )
  }
  if (!jobs.length) return null

  return (
    <div className="mb-4 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-gray-400">
          <span className="text-white font-medium">Re-encode</span> on {status.server}
          {queued.length > 0 && <> · {queued.length} queued</>}
          {saved > 0 && <> · <span className="text-green-400">{formatBytes(saved)} saved</span></>}
          {status.workFree != null && <span className="text-gray-600"> · {formatBytes(status.workFree)} free on NVMe</span>}
        </p>
        {finished.length > 0 && (
          <button onClick={() => setShowFinished((v) => !v)} className="text-xs text-gray-500 hover:text-white">
            {showFinished ? 'Hide' : 'Show'} finished ({finished.length})
          </button>
        )}
      </div>

      {active.map((j) => (
        <div key={j.id}>
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-gray-200 truncate">{j.label}</span>
            <span className="text-gray-500 shrink-0 tabular-nums">
              {PHASE[j.status]}
              {j.progress != null && ` ${Math.round(j.progress * 100)}%`}
              {j.speed && ` · ${j.speed}`}
              {j.eta != null && ` · ${formatEta(j.eta)} left`}
              <button onClick={() => cancel(j.id)} className="ml-3 text-gray-600 hover:text-red-400">Cancel</button>
            </span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded mt-1 overflow-hidden">
            <div
              className={`h-full transition-all ${j.status === 'encoding' ? 'bg-emerald-500' : 'bg-blue-500'} ${j.progress == null ? 'animate-pulse w-full opacity-40' : ''}`}
              style={j.progress != null ? { width: `${Math.max(j.progress * 100, 1)}%` } : undefined}
            />
          </div>
        </div>
      ))}

      {queued.length > 0 && (
        <ul className="text-xs text-gray-500 space-y-0.5 max-h-28 overflow-y-auto">
          {queued.map((j) => (
            <li key={j.id} className="flex justify-between gap-3">
              <span className="truncate">{j.label}</span>
              <span className="shrink-0">
                {formatBytes(j.origSize ?? 0)}
                <button onClick={() => cancel(j.id)} className="ml-3 text-gray-600 hover:text-red-400">✕</button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {showFinished && (
        <ul className="text-xs space-y-0.5 max-h-48 overflow-y-auto border-t border-gray-800 pt-2">
          {finished.map((j) => (
            <li key={j.id} className="flex justify-between gap-3">
              <span className="truncate text-gray-400" title={j.error ?? j.path}>
                {j.label}
                {j.error && <span className="text-gray-600"> — {j.error}</span>}
              </span>
              <span className="shrink-0 tabular-nums">
                {j.status === 'done' ? (
                  <span className="text-green-400">
                    {formatBytes(j.origSize ?? 0)} → {formatBytes(j.newSize ?? 0)}
                  </span>
                ) : (
                  <span className={j.status === 'failed' ? 'text-red-400' : 'text-gray-500'}>{PHASE[j.status]}</span>
                )}
                <button onClick={() => forget(j.id)} className="ml-3 text-gray-600 hover:text-white" title="Remove from list">✕</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
