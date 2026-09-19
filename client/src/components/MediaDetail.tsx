import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../services/api'

// A single slide-over that shows everything the stack knows about one title.
//
// Movies.tsx and TVShows.tsx each grew their own detail panel, but both could
// only show their own service's data. This one reads /api/media/{kind}/{id},
// which merges Radarr/Sonarr with Tautulli watch history, Bazarr subtitle state
// and Overseerr request info — so the panel can answer "has anyone actually
// watched this?" and "who asked for it?" alongside the file and quality.
//
// Every merged section is independently optional: a disabled or unreachable
// service just means that section doesn't render.

// ── Types ──────────────────────────────────────────────────────────────────

export type MediaKind = 'movie' | 'series'

interface WatchUser {
  name: string
  plays: number
  lastPlayed: string | null
  thumb: string | null
}

interface WatchPlay {
  id: string | number
  user: string
  date: string | null
  player: string | null
  platform: string | null
  transcodeDecision: string | null
  percentComplete: number | null
  watched: boolean
  episode: string | null
  episodeTitle: string | null
}

interface SubLanguage {
  code: string
  name: string
  forced: boolean
  hi: boolean
}

interface MediaDetailData {
  kind: MediaKind
  id: number
  title: string
  year: number | null
  overview: string | null
  poster: string | null
  runtime: number | null
  genres: string[]
  certification: string | null
  ratings?: { imdb?: { value: number }; tmdb?: { value: number } } | null
  monitored: boolean
  hasFile: boolean
  isAvailable?: boolean
  path: string | null
  sizeOnDisk: number
  qualityProfileName: string | null
  tmdbId: number | null
  imdbId?: string | null

  // Movie only
  file: {
    quality: string | null
    size: number
    relativePath: string | null
    videoCodec: string | null
    resolution: string | null
    audioCodec: string | null
    dateAdded: string | null
  } | null

  // Series only
  seasons?: {
    seasonNumber: number
    monitored: boolean
    episodeFileCount: number
    episodeCount: number
    totalEpisodeCount: number
    sizeOnDisk: number
    percentOfEpisodes: number
  }[]
  status?: string | null
  ended?: boolean
  network?: string | null
  seasonCount?: number | null
  episodeCount?: number | null
  episodeFileCount?: number | null
  totalEpisodeCount?: number | null

  arrHistory: {
    id: number
    eventType: string
    date: string
    sourceTitle: string | null
    quality: string | null
  }[]

  watch: {
    available: boolean
    ratingKey?: string | null
    totalPlays?: number
    lastPlayed?: string | null
    users?: WatchUser[]
    history?: WatchPlay[]
  }
  subtitles: {
    available: boolean
    tracked?: boolean
    have?: SubLanguage[]
    missing?: SubLanguage[]
    episodeFileCount?: number | null
    episodeMissingCount?: number | null
  }
  request: {
    available: boolean
    mediaStatus?: string | null
    requests?: {
      id: number
      status: string
      requestedBy: string
      requestedAt: string | null
      is4k: boolean
    }[]
  }
  plex: {
    available: boolean
    ratingKey?: string | null
    webUrl?: string | null
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(b: number) {
  if (!b) return '0 B'
  if (b >= 1_099_511_627_776) return `${(b / 1_099_511_627_776).toFixed(2)} TB`
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${Math.round(b / 1024)} KB`
}

function formatRuntime(mins: number | null) {
  if (!mins) return null
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

function timeAgo(d: string | null) {
  if (!d) return '—'
  const diff = Date.now() - new Date(d).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

const EVENT_LABEL: Record<string, string> = {
  grabbed: 'Grabbed',
  downloadFolderImported: 'Imported',
  downloadFailed: 'Failed',
  movieFileDeleted: 'File Deleted',
  movieFileRenamed: 'Renamed',
  movieAdded: 'Added',
  episodeFileDeleted: 'File Deleted',
  episodeFileRenamed: 'Renamed',
  seriesAdded: 'Added',
  ignored: 'Ignored',
}

const eventClass = (type: string) =>
  type === 'downloadFolderImported'
    ? 'bg-green-900/60 text-green-400'
    : type === 'downloadFailed'
      ? 'bg-red-900/60 text-red-400'
      : type === 'grabbed'
        ? 'bg-blue-900/60 text-blue-400'
        : 'bg-gray-800 text-gray-500'

// Tautulli reports 'transcode', 'copy' (direct stream) or 'direct play'.
// Transcodes are the ones worth flagging — they're the expensive case.
const transcodeLabel = (d: string | null) =>
  d === 'transcode' ? 'Transcode' : d === 'copy' ? 'Direct Stream' : d === 'direct play' ? 'Direct Play' : null

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{label}</p>
      {children}
    </div>
  )
}

function LangChip({ lang, missing }: { lang: SubLanguage; missing?: boolean }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
        missing ? 'bg-gray-800 text-gray-500 line-through' : 'bg-green-900/60 text-green-400'
      }`}
      title={`${lang.name}${lang.forced ? ' (forced)' : ''}${lang.hi ? ' (HI)' : ''}`}
    >
      {lang.code.toUpperCase()}
      {lang.forced ? '·F' : ''}
      {lang.hi ? '·HI' : ''}
    </span>
  )
}

// ── Component ──────────────────────────────────────────────────────────────

export default function MediaDetail({
  kind,
  id,
  onClose,
  onChanged,
}: {
  kind: MediaKind
  id: number
  onClose: () => void
  onChanged?: () => void
}) {
  const queryClient = useQueryClient()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [searchQueued, setSearchQueued] = useState(false)

  const arrApp = kind === 'movie' ? 'radarr' : 'sonarr'
  const arrPath = kind === 'movie' ? 'movie' : 'series'

  const { data, isLoading, error } = useQuery<MediaDetailData>({
    queryKey: ['media-detail', kind, id],
    queryFn: async () => (await api.get(`/media/${kind}/${id}`)).data,
    staleTime: 30_000,
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['media-detail', kind, id] })
    onChanged?.()
  }

  // The *arr APIs want the whole object back on a PUT, and the merged payload
  // above is a reshaped subset — so re-read the raw record before editing it.
  const toggleMonitor = useMutation({
    mutationFn: async () => {
      const raw = (await api.get(`/proxy/${arrApp}/api/v3/${arrPath}/${id}`)).data
      return api.put(`/proxy/${arrApp}/api/v3/${arrPath}/${id}`, { ...raw, monitored: !raw.monitored })
    },
    onSuccess: refresh,
  })

  const toggleSeason = useMutation({
    mutationFn: async (seasonNumber: number) => {
      const raw = (await api.get(`/proxy/sonarr/api/v3/series/${id}`)).data
      return api.put(`/proxy/sonarr/api/v3/series/${id}`, {
        ...raw,
        seasons: raw.seasons.map((season: { seasonNumber: number; monitored: boolean }) =>
          season.seasonNumber === seasonNumber ? { ...season, monitored: !season.monitored } : season
        ),
      })
    },
    onSuccess: refresh,
  })

  const triggerSearch = useMutation({
    mutationFn: () =>
      api.post(`/proxy/${arrApp}/api/v3/command`,
        kind === 'movie' ? { name: 'MoviesSearch', movieIds: [id] } : { name: 'SeriesSearch', seriesId: id }),
    onSuccess: () => {
      setSearchQueued(true)
      setTimeout(() => setSearchQueued(false), 3000)
    },
  })

  const remove = useMutation({
    mutationFn: (deleteFiles: boolean) =>
      api.delete(`/proxy/${arrApp}/api/v3/${arrPath}/${id}`, {
        params: { deleteFiles, addImportExclusion: false },
      }),
    onSuccess: () => {
      onChanged?.()
      onClose()
    },
  })

  const panel = (children: React.ReactNode) => (
    <div className="fixed right-0 top-0 h-screen w-full sm:w-[420px] bg-gray-900 border-l border-gray-800 flex flex-col z-40 overflow-hidden shadow-2xl">
      {children}
    </div>
  )

  if (isLoading) {
    return panel(
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">Loading…</div>
    )
  }

  if (error || !data) {
    return panel(
      <>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <span className="text-sm font-semibold text-white">Detail</span>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>
        <div className="flex items-center justify-center flex-1 text-red-400 text-sm px-5 text-center">
          Couldn't load this title.
        </div>
      </>
    )
  }

  const { watch, subtitles, request, plex } = data
  const neverPlayed = watch.available && (watch.totalPlays ?? 0) === 0
  const size = kind === 'movie' ? data.file?.size ?? 0 : data.sizeOnDisk

  const statusLabel = !data.monitored
    ? { label: 'Unmonitored', color: 'text-gray-500' }
    : data.hasFile
      ? { label: kind === 'movie' ? 'Downloaded' : `${data.episodeFileCount}/${data.episodeCount} episodes`, color: 'text-green-400' }
      : { label: 'Missing', color: 'text-red-400' }

  return panel(
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
        <span className="text-sm font-semibold text-white truncate pr-2">{data.title}</span>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors shrink-0">✕</button>
      </div>

      <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
        {/* Poster + meta */}
        <div className="flex gap-4">
          {data.poster ? (
            <img
              src={data.poster}
              alt=""
              className="w-20 rounded-md shrink-0 object-cover self-start"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div className="w-20 h-28 bg-gray-800 rounded-md shrink-0 flex items-center justify-center text-gray-600 text-xs">
              No poster
            </div>
          )}
          <div className="min-w-0">
            <p className="text-white font-semibold text-sm">{data.title}</p>
            <p className="text-gray-500 text-xs mt-0.5">
              {data.year}
              {data.runtime ? ` · ${formatRuntime(data.runtime)}` : ''}
              {data.certification ? ` · ${data.certification}` : ''}
            </p>
            <p className={`text-xs mt-1 font-medium ${statusLabel.color}`}>{statusLabel.label}</p>
            {data.qualityProfileName && <p className="text-xs text-gray-500 mt-0.5">{data.qualityProfileName}</p>}
            {kind === 'series' && data.network && (
              <p className="text-xs text-gray-600 mt-0.5">
                {data.network}
                {data.ended ? ' · Ended' : ''}
              </p>
            )}
            {data.genres?.length > 0 && (
              <p className="text-xs text-gray-600 mt-1">{data.genres.slice(0, 3).join(', ')}</p>
            )}
            {data.ratings?.imdb && (
              <p className="text-xs text-gray-500 mt-0.5">IMDb {data.ratings.imdb.value.toFixed(1)}</p>
            )}
          </div>
        </div>

        {/* Overview */}
        {data.overview && <p className="text-xs text-gray-400 leading-relaxed line-clamp-4">{data.overview}</p>}

        {/* File / library footprint */}
        {(data.file || size > 0) && (
          <div className="bg-gray-800/60 rounded-lg p-3 space-y-1">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
              {kind === 'movie' ? 'File' : 'On Disk'}
            </p>
            {data.file ? (
              <>
                <p className="text-xs text-gray-300">{data.file.quality ?? 'Unknown quality'}</p>
                {data.file.videoCodec && (
                  <p className="text-xs text-gray-500">
                    {[data.file.videoCodec, data.file.resolution, data.file.audioCodec].filter(Boolean).join(' · ')}
                  </p>
                )}
                <p className="text-xs text-gray-500">{formatBytes(data.file.size)}</p>
                {data.file.relativePath && (
                  <p className="text-xs text-gray-600 truncate" title={data.file.relativePath}>
                    {data.file.relativePath}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-xs text-gray-300">{formatBytes(size)}</p>
                <p className="text-xs text-gray-500">
                  {data.seasonCount} season{data.seasonCount === 1 ? '' : 's'} · {data.episodeFileCount} file
                  {data.episodeFileCount === 1 ? '' : 's'}
                </p>
              </>
            )}
          </div>
        )}

        {/* Seasons — Sonarr only */}
        {kind === 'series' && (data.seasons ?? []).length > 0 && (
          <Section label="Seasons">
            <div className="space-y-1">
              {(data.seasons ?? [])
                .filter((season) => season.seasonNumber > 0)
                .sort((a, b) => a.seasonNumber - b.seasonNumber)
                .map((season) => (
                  <div key={season.seasonNumber} className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => toggleSeason.mutate(season.seasonNumber)}
                      disabled={toggleSeason.isPending}
                      className={`text-xs transition-colors disabled:opacity-60 ${
                        season.monitored ? 'text-gray-300 hover:text-white' : 'text-gray-600 hover:text-gray-400'
                      }`}
                      title={season.monitored ? 'Monitored — click to unmonitor' : 'Unmonitored — click to monitor'}
                    >
                      {season.monitored ? '◉' : '○'} Season {season.seasonNumber}
                    </button>
                    <span className="text-xs text-gray-600 shrink-0 tabular-nums">
                      {season.episodeFileCount}/{season.episodeCount}
                      {season.sizeOnDisk ? ` · ${formatBytes(season.sizeOnDisk)}` : ''}
                    </span>
                  </div>
                ))}
            </div>
          </Section>
        )}

        {/* Watch history — the section none of the existing pages could show */}
        {watch.available && (
          <Section label="Watched By">
            {neverPlayed ? (
              <div className="bg-yellow-900/20 border border-yellow-900/60 rounded-lg px-3 py-2">
                <p className="text-xs text-yellow-400 font-medium">Never played</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  No play history in Tautulli{size > 0 ? ` · ${formatBytes(size)} on disk` : ''}
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-gray-500 mb-2">
                  {watch.totalPlays} play{watch.totalPlays === 1 ? '' : 's'} · last {timeAgo(watch.lastPlayed ?? null)}
                </p>
                <div className="space-y-1">
                  {(watch.users ?? []).slice(0, 6).map((u) => (
                    <div key={u.name} className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-300 truncate">{u.name}</span>
                      <span className="text-xs text-gray-600 shrink-0">
                        {u.plays}×{u.lastPlayed ? ` · ${timeAgo(u.lastPlayed)}` : ''}
                      </span>
                    </div>
                  ))}
                </div>

                {(watch.history ?? []).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-800 space-y-1">
                    {(watch.history ?? []).slice(0, 5).map((p) => {
                      const tc = transcodeLabel(p.transcodeDecision)
                      return (
                        <div key={p.id} className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {p.episode && <span className="text-[10px] text-gray-600 shrink-0">{p.episode}</span>}
                            <span className="text-xs text-gray-500 truncate">{p.user}</span>
                            {tc && (
                              <span
                                className={`text-[10px] px-1 py-0.5 rounded shrink-0 ${
                                  p.transcodeDecision === 'transcode'
                                    ? 'bg-orange-900/60 text-orange-400'
                                    : 'bg-gray-800 text-gray-600'
                                }`}
                              >
                                {tc}
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-gray-600 shrink-0">{timeAgo(p.date)}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </Section>
        )}

        {/* Subtitles */}
        {subtitles.available && (
          <Section label="Subtitles">
            {kind === 'series' ? (
              <p className="text-xs text-gray-500">
                {subtitles.episodeFileCount ?? 0} tracked
                {subtitles.episodeMissingCount ? ` · ${subtitles.episodeMissingCount} missing subtitles` : ' · none missing'}
              </p>
            ) : !subtitles.tracked ? (
              <p className="text-xs text-gray-600">Not tracked by Bazarr</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {(subtitles.have ?? []).map((l, i) => <LangChip key={`h${i}`} lang={l} />)}
                {(subtitles.missing ?? []).map((l, i) => <LangChip key={`m${i}`} lang={l} missing />)}
                {!(subtitles.have ?? []).length && !(subtitles.missing ?? []).length && (
                  <span className="text-xs text-gray-600">None</span>
                )}
              </div>
            )}
          </Section>
        )}

        {/* Overseerr request provenance */}
        {request.available && (request.requests ?? []).length > 0 && (
          <Section label="Requested By">
            <div className="space-y-1">
              {(request.requests ?? []).map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs text-gray-300 truncate">{r.requestedBy}</span>
                    {r.is4k && <span className="text-[10px] px-1 py-0.5 rounded bg-purple-900/60 text-purple-400 shrink-0">4K</span>}
                  </div>
                  <span className="text-xs text-gray-600 shrink-0">
                    {r.status} · {timeAgo(r.requestedAt)}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Grab / import history */}
        {data.arrHistory.length > 0 && (
          <Section label="History">
            <div className="space-y-1">
              {data.arrHistory.slice(0, 6).map((h) => (
                <div key={h.id} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${eventClass(h.eventType)}`}>
                      {EVENT_LABEL[h.eventType] ?? h.eventType}
                    </span>
                    {h.quality && <span className="text-xs text-gray-500 truncate">{h.quality}</span>}
                  </div>
                  <span className="text-xs text-gray-600 shrink-0">{timeAgo(h.date)}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {plex.webUrl && (
          <a
            href={plex.webUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Open in Plex ↗
          </a>
        )}
      </div>

      {/* Actions */}
      <div className="px-5 py-4 border-t border-gray-800 shrink-0">
        {showDeleteConfirm ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-400">
              Delete from {kind === 'movie' ? 'Radarr' : 'Sonarr'}?
              {size > 0 && <span className="text-gray-500"> Frees {formatBytes(size)}.</span>}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 text-xs py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => remove.mutate(false)}
                className="flex-1 text-xs py-1.5 rounded bg-red-800 hover:bg-red-700 text-white transition-colors"
              >
                Remove
              </button>
              {data.hasFile && (
                <button
                  onClick={() => remove.mutate(true)}
                  className="flex-1 text-xs py-1.5 rounded bg-red-950 border border-red-800 text-red-300 hover:bg-red-900 transition-colors"
                >
                  +Files
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => triggerSearch.mutate()}
              disabled={triggerSearch.isPending}
              className={`flex-1 text-xs py-1.5 rounded text-white transition-colors disabled:opacity-60 ${
                searchQueued ? 'bg-green-700' : 'bg-blue-700 hover:bg-blue-600'
              }`}
            >
              {triggerSearch.isPending ? 'Searching…' : searchQueued ? 'Queued!' : 'Search'}
            </button>
            <button
              onClick={() => toggleMonitor.mutate()}
              disabled={toggleMonitor.isPending}
              className={`flex-1 text-xs py-1.5 rounded border transition-colors disabled:opacity-60 ${
                data.monitored
                  ? 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  : 'bg-yellow-900/30 border-yellow-700 text-yellow-400 hover:bg-yellow-900/50'
              }`}
            >
              {data.monitored ? 'Monitored' : 'Unmonitored'}
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-300 border border-gray-700 hover:border-red-800 transition-colors"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </>
  )
}
