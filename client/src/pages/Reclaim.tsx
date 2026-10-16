import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'
import MediaDetail from '../components/MediaDetail'

// Disk reclaim — "what can I safely delete?"
//
// Reads /api/media/reclaim, which joins Radarr/Sonarr file sizes against
// Tautulli play counts. Each candidate carries the lenses it matched, so
// switching tabs here is pure client-side filtering over one fetch.
//
// Delete, keep and downgrade go through POST /api/media/reclaim/action, which
// does every step (import exclusion, Overseerr cleanup, season unmonitor) so a
// deleted title doesn't quietly come back. Each candidate carries its own
// proxyBase, so secondary instances (a separate 4K Radarr, say) act on the
// right server.

// ── Types ──────────────────────────────────────────────────────────────────

type Lens = 'recommended' | 'seasons' | 'never-played' | 'stale' | 'downgrade' | 'largest' | 'duplicates' | 'orphans'

interface Candidate {
  key: string
  unit: 'movie' | 'series' | 'season'
  seasonNumber?: number
  seasonLabel?: string
  viewers: number
  requestedBy: string[] | null
  requesterWatched: boolean | null
  mediaId: number | null
  why?: string
  score?: number
  regret?: number
  downgrade?: { saving: number; estimate: number; movieFileId: number | null }
  kind: 'movie' | 'series'
  arrId: number
  proxyBase: string
  instance: string
  title: string
  year: number | null
  tmdbId: number | null
  size: number
  added: string | null
  monitored: boolean
  quality: string | null
  ended: boolean | null
  episodeFileCount: number | null
  playCount: number | null
  lastPlayed: string | null
  inPlex: boolean | null
  lenses: Lens[]
  note?: string
}

interface ReclaimResponse {
  generatedAt: string
  sources: {
    instances: string[]
    tautulli: boolean
    plex: boolean
    history: boolean
    overseerr: boolean
    watchLensesAvailable: boolean
    orphanLensAvailable: boolean
    exactMatching: boolean
  }
  settings: { neverPlayedDays: number; staleMonths: number }
  totals: { scanned: number; bytesOnDisk: number; kept: number; keptBytes: number }
  lensTotals: Record<Lens, { count: number; bytes: number; shown: number }>
  downgradeProfiles: Record<string, { id: number; name: string }[]>
  candidates: Candidate[]
}

const TB = 1_099_511_627_776

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(b: number) {
  if (!b) return '0 B'
  if (b >= 1_099_511_627_776) return `${(b / 1_099_511_627_776).toFixed(2)} TB`
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${Math.round(b / 1024)} KB`
}

function timeAgo(d: string | null) {
  if (!d) return '—'
  const diff = Date.now() - new Date(d).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

type LensNeed = 'none' | 'watch' | 'library'

const LENS_META: Record<Lens, { label: string; blurb: string; needs: LensNeed }> = {
  recommended: {
    label: 'Recommended',
    blurb:
      'Never played, long unwatched, and seasons nobody reached — ranked by space freed against how much it would be missed (recent requests and recent viewers count against).',
    needs: 'watch',
  },
  seasons: {
    label: 'TV Seasons',
    blurb:
      "Seasons of shows people did watch, but that nobody got to, or finished long ago. Deleting a season removes its files and unmonitors it; the rest of the show stays.",
    needs: 'watch',
  },
  downgrade: {
    label: 'Downgrade',
    blurb:
      'Big 4K / remux movies that are rarely watched. Keep them at 1080p instead: switch the profile, delete the big file, and search. The size shown is the estimated saving.',
    needs: 'watch',
  },
  'never-played': {
    label: 'Never Played',
    blurb: 'Has files, zero plays in Tautulli, and old enough to have had a fair chance.',
    needs: 'watch',
  },
  stale: {
    label: 'Not Played Recently',
    blurb: 'Was watched once, but not for a long time.',
    needs: 'watch',
  },
  largest: {
    label: 'Largest Files',
    blurb: 'The biggest things on disk, regardless of whether anyone watches them.',
    needs: 'none',
  },
  duplicates: {
    label: 'Duplicates',
    blurb: 'The same title held by more than one instance — usually a 4K and a 1080p copy.',
    needs: 'none',
  },
  orphans: {
    label: 'Orphans',
    blurb: 'Files tracked by Radarr/Sonarr that Plex has no record of. Often a failed import.',
    needs: 'library',
  },
}

// 'watch' needs Tautulli's play counts; 'library' only needs something that can
// say what's actually in Plex, which either Plex or Tautulli can answer.
const lensBlocked = (lens: Lens, sources?: ReclaimResponse['sources']) => {
  if (!sources) return false
  const need = LENS_META[lens].needs
  if (need === 'watch') return !sources.watchLensesAvailable
  if (need === 'library') return !sources.orphanLensAvailable
  return false
}

const LENS_ORDER: Lens[] = ['recommended', 'seasons', 'never-played', 'stale', 'downgrade', 'largest', 'duplicates', 'orphans']

// ── Confirm modal ──────────────────────────────────────────────────────────

function ConfirmDelete({
  count,
  bytes,
  variant = 'delete',
  onCancel,
  onConfirm,
}: {
  count: number
  bytes: number
  variant?: 'delete' | 'downgrade'
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const word = variant === 'delete' ? 'DELETE' : 'DOWNGRADE'
  const armed = typed.trim().toUpperCase() === word

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <div
        className="bg-gray-900 border border-red-900 rounded-xl w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-800">
          <h3 className="text-white font-semibold">
            {variant === 'delete' ? 'Delete' : 'Downgrade'} {count} item{count === 1 ? '' : 's'}?
          </h3>
        </div>
        <div className="px-5 py-4 space-y-3">
          {variant === 'delete' ? (
            <p className="text-sm text-gray-400">
              Whole titles are removed from Radarr/Sonarr <span className="text-red-400">and their files deleted</span>,
              with an import-list exclusion so they don't come back, and their Overseerr request cleared so they can be
              requested again. Seasons have their files deleted and the season unmonitored. It cannot be undone.
            </p>
          ) : (
            <p className="text-sm text-gray-400">
              Each movie is switched to the chosen profile,{' '}
              <span className="text-red-400">its current file is deleted</span>, and Radarr searches for a smaller
              copy. Until that downloads, the movie is unavailable.
            </p>
          )}
          <p className="text-sm text-gray-300">
            Frees roughly <span className="text-white font-semibold">{formatBytes(bytes)}</span>.
          </p>
          <div>
            <label className="text-xs text-gray-500 block mb-1.5">Type {word} to confirm</label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={word}
              className="input w-full"
            />
          </div>
        </div>
        <div className="px-5 py-4 border-t border-gray-800 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 text-sm py-2 rounded-lg bg-gray-800 text-gray-300 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!armed}
            className="flex-1 text-sm py-2 rounded-lg bg-red-800 hover:bg-red-700 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {variant === 'delete' ? 'Delete & free space' : 'Downgrade'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sorting ────────────────────────────────────────────────────────────────

type SortKey = 'title' | 'instance' | 'lastPlayed' | 'added' | 'size' | 'score'
type SortDir = 'asc' | 'desc'

// Text columns default to A→Z on first click; everything else (dates, size)
// defaults to biggest/most-recent first, since that's the order Reclaim's
// whole premise cares about.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  title: 'asc',
  instance: 'asc',
  lastPlayed: 'desc',
  added: 'desc',
  size: 'desc',
  score: 'desc',
}

// What acting on a row actually frees: a downgrade keeps most of the title.
const freed = (c: Candidate, lens: Lens) => (lens === 'downgrade' && c.downgrade ? c.downgrade.saving : c.size)

// Each lens opens in the order that makes sense for it.
const lensSort = (l: Lens): SortKey => (l === 'recommended' ? 'score' : 'size')

// Never-played items have no lastPlayed date at all. Rather than let them land
// wherever a null happens to sort, they're pinned to the "never" end regardless
// of direction — descending still means "most recently played first", it's just
// that "never" is the natural end of that ordering, not an arbitrary null slot.
function compareCandidates(a: Candidate, b: Candidate, key: SortKey, dir: SortDir, lens: Lens): number {
  const sign = dir === 'asc' ? 1 : -1

  if (key === 'title') return sign * a.title.localeCompare(b.title)
  if (key === 'instance') return sign * a.instance.localeCompare(b.instance)
  if (key === 'size') return sign * (freed(a, lens) - freed(b, lens))
  if (key === 'score') return sign * ((a.score ?? 0) - (b.score ?? 0))

  const field = key === 'lastPlayed' ? 'lastPlayed' : 'added'
  const av = a[field] ? new Date(a[field] as string).getTime() : null
  const bv = b[field] ? new Date(b[field] as string).getTime() : null
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return sign * (av - bv)
}

function SortableHeader({
  label, columnKey, align = 'left', activeKey, sortDir, onSort, className = '',
}: {
  label: string
  columnKey: SortKey
  align?: 'left' | 'right'
  activeKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = activeKey === columnKey
  return (
    <th className={`px-4 py-2.5 font-medium ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      <button
        onClick={() => onSort(columnKey)}
        className={`inline-flex items-center gap-1 transition-colors ${
          align === 'right' ? 'flex-row-reverse' : ''
        } ${active ? 'text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
      >
        {label}
        <span className={`text-[10px] w-2.5 inline-block ${active ? 'opacity-100' : 'opacity-0'}`}>
          {active && sortDir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function Reclaim() {
  const { enabledServices } = useConfig()
  const queryClient = useQueryClient()

  const [lens, setLens] = useState<Lens>('recommended')
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<{ kind: 'movie' | 'series'; id: number } | null>(null)
  const [confirming, setConfirming] = useState<'delete' | 'downgrade' | null>(null)
  const [goalTb, setGoalTb] = useState('1')
  const [profileId, setProfileId] = useState<number | null>(null)
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [neverPlayedDays, setNeverPlayedDays] = useState(90)
  const [staleMonths, setStaleMonths] = useState(12)
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const enabled = enabledServices.includes('radarr') || enabledServices.includes('sonarr')

  const { data, isLoading, error, refetch, isFetching } = useQuery<ReclaimResponse>({
    queryKey: ['reclaim', neverPlayedDays, staleMonths],
    queryFn: async () =>
      (await api.get('/media/reclaim', { params: { neverPlayedDays, staleMonths } })).data,
    enabled,
    // The scan hits every *arr and the whole Tautulli library table, so it's
    // deliberately not on a refresh interval — it reruns when you ask it to.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const rows = useMemo(
    () =>
      (data?.candidates ?? [])
        .filter((c) => c.lenses.includes(lens))
        .sort((a, b) => compareCandidates(a, b, sortKey, sortDir, lens)),
    [data, lens, sortKey, sortDir]
  )

  // Clicking the active column flips direction; clicking a new one switches to
  // it at that column's natural default direction.
  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(DEFAULT_DIR[key]) }
  }

  const selected = useMemo(
    () => (data?.candidates ?? []).filter((c) => selectedKeys.has(c.key)),
    [data, selectedKeys]
  )
  const selectedBytes = selected.reduce((sum, c) => sum + freed(c, lens), 0)
  const hasSeasons = selected.some((c) => c.unit === 'season')
  const allDowngradable = selected.length > 0 && selected.every((c) => c.downgrade)

  // Downgrade targets come from the primary Radarr's profiles; 1080p first.
  const profiles = data?.downgradeProfiles?.radarr ?? Object.values(data?.downgradeProfiles ?? {})[0] ?? []
  const chosenProfile = profileId ?? profiles[0]?.id ?? null

  // "Free up X TB": take the best-ranked recommendations until the goal is met.
  const selectForGoal = () => {
    const goal = parseFloat(goalTb) * TB
    if (!Number.isFinite(goal) || goal <= 0) return
    const ranked = (data?.candidates ?? [])
      .filter((c) => c.lenses.includes('recommended'))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const next = new Set<string>()
    let total = 0
    for (const c of ranked) {
      if (total >= goal) break
      next.add(c.key)
      total += c.size
    }
    setSelectedKeys(next)
  }

  const toggle = (key: string) =>
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const allVisibleSelected = rows.length > 0 && rows.every((r) => selectedKeys.has(r.key))
  const toggleAllVisible = () =>
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) rows.forEach((r) => next.delete(r.key))
      else rows.forEach((r) => next.add(r.key))
      return next
    })

  const arrPath = (c: Candidate) => (c.kind === 'movie' ? 'movie' : 'series')

  const act = (action: 'delete' | 'keep' | 'downgrade', c: Candidate, extra: Record<string, unknown> = {}) =>
    api.post('/media/reclaim/action', {
      action, unit: c.unit, proxyBase: c.proxyBase, arrId: c.arrId,
      seasonNumber: c.seasonNumber, mediaId: c.mediaId, ...extra,
    })

  // Both bulk actions run sequentially rather than in parallel — a hundred
  // simultaneous deletes is a good way to make an *arr instance fall over.
  const runBulk = async (
    label: string,
    fn: (c: Candidate) => Promise<unknown>,
  ) => {
    setResult(null)
    setBusy({ done: 0, total: selected.length })
    let ok = 0
    const failed: string[] = []

    for (const c of selected) {
      try {
        await fn(c)
        ok += 1
      } catch {
        failed.push(c.title)
      }
      setBusy((b) => (b ? { ...b, done: b.done + 1 } : b))
    }

    setBusy(null)
    setSelectedKeys(new Set())
    setResult(
      failed.length
        ? `${label}: ${ok} succeeded, ${failed.length} failed (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''})`
        : `${label}: ${ok} item${ok === 1 ? '' : 's'}.`
    )
    // A rescan walks every *arr plus the whole Tautulli library table, so
    // invalidating is enough — calling refetch() as well would run it twice.
    queryClient.invalidateQueries({ queryKey: ['reclaim'] })
  }

  const unmonitorSelected = () =>
    runBulk('Unmonitored', async (c) => {
      const raw = (await api.get(`/proxy/${c.proxyBase}/api/v3/${arrPath(c)}/${c.arrId}`)).data
      return api.put(`/proxy/${c.proxyBase}/api/v3/${arrPath(c)}/${c.arrId}`, { ...raw, monitored: false })
    })

  const deleteSelected = async () => {
    setConfirming(null)
    await runBulk(`Deleted, freeing ${formatBytes(selectedBytes)}`, (c) => act('delete', c))
  }

  const downgradeSelected = async () => {
    setConfirming(null)
    await runBulk(`Downgrading, freeing about ${formatBytes(selectedBytes)}`, (c) =>
      act('downgrade', c, { profileId: chosenProfile })
    )
  }

  // Keep tags the whole title, so a season's "keep" protects its show.
  const keepSelected = () => runBulk('Tagged keep', (c) => act('keep', c))

  if (!enabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Reclaim</h1>
        <p className="text-gray-500">Enable Radarr or Sonarr in Settings to find reclaimable space.</p>
      </div>
    )
  }

  const meta = LENS_META[lens]
  const lensUnavailable = lensBlocked(lens, data?.sources)

  return (
    <div className={`p-6 transition-all duration-200 ${detail ? 'sm:pr-[436px]' : ''}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Reclaim</h1>
          {data && (
            <p className="text-xs text-gray-500 mt-0.5">
              {data.totals.scanned.toLocaleString()} titles with files · {formatBytes(data.totals.bytesOnDisk)} on disk
              {data.sources.instances.length > 0 && ` · ${data.sources.instances.join(', ')}`}
              {data.totals.kept > 0 && ` · ${data.totals.kept} tagged keep (${formatBytes(data.totals.keptBytes)}) hidden`}
            </p>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-sm px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-60"
        >
          {isFetching ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      {/* Source notices */}
      {data && !data.sources.tautulli && (
        <div className="mb-5 bg-yellow-900/20 border border-yellow-900/60 rounded-lg px-4 py-3">
          <p className="text-xs text-yellow-400 font-medium">Tautulli not connected</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Largest Files, Duplicates and Orphans still work. Never Played and Not Played Recently need Tautulli's
            watch history — connect it in Settings to enable them.
          </p>
        </div>
      )}
      {data && data.sources.tautulli && !data.sources.exactMatching && (
        <div className="mb-5 bg-yellow-900/20 border border-yellow-900/60 rounded-lg px-4 py-3">
          <p className="text-xs text-yellow-400 font-medium">Matching by title</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Plex isn't connected, so titles are matched by name rather than by ID. Alternate editions and
            year-suffixed show names can be misreported — Orphans especially. Connect Plex in Settings for exact
            matching.
          </p>
        </div>
      )}

      {/* Lens tabs */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {LENS_ORDER.map((l) => {
          // Selection is cleared on switch, so an action never touches rows you can't see.
          const selectLens = () => { setLens(l); setSortKey(lensSort(l)); setSortDir('desc'); setSelectedKeys(new Set()) }
          const totals = data?.lensTotals?.[l]
          const disabled = lensBlocked(l, data?.sources)
          return (
            <button
              key={l}
              onClick={selectLens}
              disabled={disabled}
              className={`px-3 py-2 rounded-lg text-xs border transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed ${
                lens === l
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white hover:border-gray-600'
              }`}
            >
              <span className="block font-medium">{LENS_META[l].label}</span>
              <span className={`block mt-0.5 tabular-nums ${lens === l ? 'text-blue-200' : 'text-gray-600'}`}>
                {totals ? `${totals.count} · ${formatBytes(totals.bytes)}` : '—'}
              </span>
            </button>
          )
        })}
      </div>

      <p className="text-xs text-gray-500 mb-4">
        {meta.blurb}
        {data && data.lensTotals[lens].shown < data.lensTotals[lens].count && (
          <span className="text-gray-600">
            {' '}Showing the {lens === 'recommended' ? 'top-ranked' : 'largest'} {data.lensTotals[lens].shown} of{' '}
            {data.lensTotals[lens].count}.
          </span>
        )}
        {lens === 'recommended' && data && !data.sources.overseerr && (
          <span className="text-gray-600"> Connect Overseerr to factor in who requested what.</span>
        )}
      </p>

      {/* Goal */}
      {lens === 'recommended' && data && data.lensTotals.recommended.count > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap text-xs text-gray-500">
          Free up
          <input
            value={goalTb}
            onChange={(e) => setGoalTb(e.target.value)}
            inputMode="decimal"
            className="input text-xs py-1 w-16 text-right"
            aria-label="Goal in TB"
          />
          TB
          <button
            onClick={selectForGoal}
            className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Select best picks
          </button>
          <span className="text-gray-600">
            Up to {formatBytes(data.lensTotals.recommended.bytes)} available here.
          </span>
        </div>
      )}

      {/* Thresholds */}
      {(lens === 'never-played' || lens === 'stale' || lens === 'recommended') && (
        <div className="flex items-center gap-4 mb-4 flex-wrap">
          {(lens === 'never-played' || lens === 'recommended') && (
            <label className="flex items-center gap-2 text-xs text-gray-500">
              Added more than
              <select
                value={neverPlayedDays}
                onChange={(e) => setNeverPlayedDays(Number(e.target.value))}
                className="input text-xs py-1 pr-7"
              >
                {[30, 60, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>{d} days</option>
                ))}
              </select>
              ago
            </label>
          )}
          {(lens === 'stale' || lens === 'recommended') && (
            <label className="flex items-center gap-2 text-xs text-gray-500">
              Not played in over
              <select
                value={staleMonths}
                onChange={(e) => setStaleMonths(Number(e.target.value))}
                className="input text-xs py-1 pr-7"
              >
                {[3, 6, 12, 18, 24].map((m) => (
                  <option key={m} value={m}>{m} months</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {/* Result / progress banner */}
      {busy && (
        <div className="mb-4 bg-blue-900/20 border border-blue-900/60 rounded-lg px-4 py-2.5">
          <p className="text-xs text-blue-300">
            Working… {busy.done} of {busy.total}
          </p>
        </div>
      )}
      {result && !busy && (
        <div className="mb-4 bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-2.5 flex items-center justify-between gap-3">
          <p className="text-xs text-gray-300">{result}</p>
          <button onClick={() => setResult(null)} className="text-gray-600 hover:text-white text-xs shrink-0">
            ✕
          </button>
        </div>
      )}

      {/* Selection action bar */}
      {selected.length > 0 && (
        <div className="mb-4 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-white">
            {selected.length} selected ·{' '}
            <span className="text-green-400 font-semibold">{formatBytes(selectedBytes)}</span> reclaimable
          </p>
          <div className="flex gap-2 flex-wrap items-center">
            <button
              onClick={() => setSelectedKeys(new Set())}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors"
            >
              Clear
            </button>
            <button
              onClick={keepSelected}
              disabled={!!busy}
              title="Tag &quot;keep&quot; in Radarr/Sonarr — Reclaim won't suggest it again"
              className="text-xs px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-60"
            >
              Keep
            </button>
            {!hasSeasons && (
              <button
                onClick={unmonitorSelected}
                disabled={!!busy}
                className="text-xs px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-60"
              >
                Unmonitor
              </button>
            )}
            {lens === 'downgrade' && allDowngradable && profiles.length > 0 && (
              <>
                <select
                  value={chosenProfile ?? ''}
                  onChange={(e) => setProfileId(Number(e.target.value))}
                  className="input text-xs py-1 pr-7"
                  aria-label="Downgrade to profile"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => setConfirming('downgrade')}
                  disabled={!!busy}
                  className="text-xs px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-white transition-colors disabled:opacity-60"
                >
                  Downgrade
                </button>
              </>
            )}
            {lens !== 'downgrade' && (
              <button
                onClick={() => setConfirming('delete')}
                disabled={!!busy}
                className="text-xs px-3 py-1.5 rounded bg-red-800 hover:bg-red-700 text-white transition-colors disabled:opacity-60"
              >
                Delete &amp; free space
              </button>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(10)].map((_, i) => (
            <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-20 text-red-400 text-sm">Couldn't run the scan.</div>
      ) : lensUnavailable ? (
        <div className="text-center py-20 text-gray-600 text-sm">This lens needs Tautulli.</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-20 text-gray-600 text-sm">Nothing matches this lens. Good housekeeping.</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    className="cursor-pointer"
                    aria-label="Select all visible"
                  />
                </th>
                <SortableHeader label="Title"       columnKey="title"      activeKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortableHeader label="Instance"    columnKey="instance"   activeKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden md:table-cell" />
                <SortableHeader label="Last Played" columnKey="lastPlayed" activeKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden lg:table-cell" />
                <SortableHeader label="Added"       columnKey="added"      activeKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden lg:table-cell" />
                <SortableHeader label="Size"         columnKey="size"      activeKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {rows.map((c) => {
                const isSelected = selectedKeys.has(c.key)
                return (
                  <tr
                    key={c.key}
                    className={`transition-colors ${isSelected ? 'bg-blue-900/20' : 'hover:bg-gray-800/40'}`}
                  >
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(c.key)}
                        className="cursor-pointer"
                        aria-label={`Select ${c.title}`}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => setDetail({ kind: c.kind, id: c.arrId })}
                        className="text-left min-w-0 group"
                      >
                        <span className="text-white text-sm group-hover:text-blue-400 transition-colors">
                          {c.title}
                        </span>
                        {c.year && <span className="text-gray-600 text-xs ml-1.5">{c.year}</span>}
                        {!c.monitored && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">
                            Unmonitored
                          </span>
                        )}
                        {c.unit === 'season' && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/60 text-indigo-300">
                            {c.seasonLabel}
                          </span>
                        )}
                        {c.kind === 'series' && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">
                            {c.episodeFileCount} eps
                          </span>
                        )}
                        {c.note && <span className="block text-xs text-gray-600 mt-0.5">{c.note}</span>}
                        {c.why && <span className="block text-xs text-gray-500 mt-0.5">{c.why}</span>}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 hidden md:table-cell">
                      {c.instance}
                      {c.quality && <span className="text-gray-600"> · {c.quality}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs hidden lg:table-cell">
                      {c.inPlex === false ? (
                        <span className="text-orange-400">Not in Plex</span>
                      ) : c.playCount === 0 ? (
                        <span className="text-yellow-400">Never</span>
                      ) : (
                        <span className="text-gray-500">
                          {timeAgo(c.lastPlayed)}
                          {c.playCount ? <span className="text-gray-600"> · {c.playCount}×</span> : null}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 hidden lg:table-cell">{timeAgo(c.added)}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-300 tabular-nums text-right whitespace-nowrap">
                      {lens === 'downgrade' && c.downgrade ? (
                        <>
                          <span className="text-green-400">−{formatBytes(c.downgrade.saving)}</span>
                          <span className="block text-gray-600">of {formatBytes(c.size)}</span>
                        </>
                      ) : (
                        formatBytes(c.size)
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail panel */}
      {detail && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setDetail(null)} />
          <MediaDetail
            kind={detail.kind}
            id={detail.id}
            onClose={() => setDetail(null)}
            onChanged={() => refetch()}
          />
        </>
      )}

      {confirming && (
        <ConfirmDelete
          count={selected.length}
          bytes={selectedBytes}
          variant={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={confirming === 'delete' ? deleteSelected : downgradeSelected}
        />
      )}
    </div>
  )
}
