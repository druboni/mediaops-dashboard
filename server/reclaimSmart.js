// The "smarter" half of Reclaim: watch history at season level, who requested
// what and whether they watched it, a regret-weighted ranking, keep tags, and the
// actions (delete / keep / downgrade) that do every step a deletion needs so the
// thing doesn't simply come back.
//
// Everything here is keyed by Plex rating key, which media.js already resolves for
// each Radarr/Sonarr item from its tmdb/tvdb/imdb ids.

const DAY = 86_400_000
const GB = 1_073_741_824
const trim = (u) => String(u || '').replace(/\/$/, '')
const arrH = (key) => ({ 'X-Api-Key': key, 'Content-Type': 'application/json' })

async function getJson(url, opts = {}, timeout = 30000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

// ── Watch history (Tautulli) ────────────────────────────────────────────────

/**
 * Every play Tautulli has recorded, folded into:
 *   movies:  ratingKey → { plays, last, users:Set<plexUserId> }
 *   shows:   showRatingKey → { plays, last, users, maxSeason, seasons: Map<n, { plays, last, users }> }
 * One call (~12k rows takes ~1.5 s); grouping=1 merges a resumed session into one play.
 */
export async function watchHistory(tautulli) {
  const base = `${trim(tautulli.url)}/api/v2?apikey=${encodeURIComponent(tautulli.apiKey)}`
  const body = await getJson(`${base}&cmd=get_history&grouping=1&length=200000`, {}, 60000)
  const rows = body?.response?.data?.data ?? []
  const movies = new Map()
  const shows = new Map()
  const bump = (rec, ms, user) => {
    rec.plays += 1
    if (ms > rec.last) rec.last = ms
    if (user != null) rec.users.add(String(user))
  }
  for (const r of rows) {
    const ms = Number(r.date) * 1000 || 0
    if (r.media_type === 'movie' && r.rating_key) {
      const k = String(r.rating_key)
      if (!movies.has(k)) movies.set(k, { plays: 0, last: 0, users: new Set() })
      bump(movies.get(k), ms, r.user_id)
    } else if (r.media_type === 'episode' && r.grandparent_rating_key) {
      const k = String(r.grandparent_rating_key)
      if (!shows.has(k)) shows.set(k, { plays: 0, last: 0, users: new Set(), maxSeason: -1, seasons: new Map() })
      const show = shows.get(k)
      bump(show, ms, r.user_id)
      const n = Number(r.parent_media_index)
      if (Number.isFinite(n)) {
        if (!show.seasons.has(n)) show.seasons.set(n, { plays: 0, last: 0, users: new Set() })
        bump(show.seasons.get(n), ms, r.user_id)
        if (n > 0 && n > show.maxSeason) show.maxSeason = n
      }
    }
  }
  return { movies, shows, rows: rows.length }
}

// ── Requests (Overseerr) ────────────────────────────────────────────────────

/** `movie:<tmdbId>` / `tv:<tvdbId>` → { mediaId, requests: [{ by, plexId, at }] } */
export async function overseerrRequests(overseerr) {
  const base = trim(overseerr.url)
  const out = new Map()
  for (let skip = 0; skip < 20000; skip += 100) {
    const page = await getJson(`${base}/api/v1/request?take=100&skip=${skip}&filter=all&sort=added`, { headers: { 'X-Api-Key': overseerr.apiKey } })
    for (const r of page?.results ?? []) {
      const m = r.media || {}
      const key = m.mediaType === 'movie' ? `movie:${m.tmdbId}` : m.tvdbId ? `tv:${m.tvdbId}` : null
      if (!key) continue
      if (!out.has(key)) out.set(key, { mediaId: m.id, requests: [] })
      out.get(key).requests.push({
        by: r.requestedBy?.displayName || r.requestedBy?.plexUsername || r.requestedBy?.username || 'someone',
        plexId: r.requestedBy?.plexId != null ? String(r.requestedBy.plexId) : null,
        at: r.createdAt ? Date.parse(r.createdAt) : null,
      })
    }
    if ((page?.results ?? []).length < 100) break
  }
  return out
}

/** Who asked for it, and did any of them actually watch it? */
export function requestInfo(overseerrIdx, kind, raw, watchedBy) {
  if (!overseerrIdx) return null
  const hit = overseerrIdx.get(kind === 'movie' ? `movie:${raw.tmdbId}` : `tv:${raw.tvdbId}`)
  if (!hit) return null
  const names = [...new Set(hit.requests.map((r) => r.by))]
  const requesterIds = hit.requests.map((r) => r.plexId).filter(Boolean)
  const requesterWatched = requesterIds.length ? requesterIds.some((id) => watchedBy?.has(id)) : null
  const lastRequested = Math.max(...hit.requests.map((r) => r.at || 0)) || null
  return { mediaId: hit.mediaId, requestedBy: names, requesterWatched, lastRequested }
}

// ── Keep tags ───────────────────────────────────────────────────────────────

export const KEEP_LABEL = 'keep'

/** The id of the "keep" tag in an *arr instance, or null if it has none. */
export async function keepTagId(svc) {
  const tags = await getJson(`${trim(svc.url)}/api/v3/tag`, { headers: arrH(svc.apiKey) }, 15000).catch(() => [])
  return (tags || []).find((t) => String(t.label).toLowerCase() === KEEP_LABEL)?.id ?? null
}

// ── Regret, ranking, explanations ───────────────────────────────────────────

const ago = (ms, now) => {
  const d = Math.floor((now - ms) / DAY)
  if (d < 60) return `${d} days ago`
  const mo = Math.round(d / 30)
  return mo < 24 ? `${mo} months ago` : `${Math.round(d / 365)} years ago`
}

/**
 * How much someone would miss this, 0 (nobody) … 1 (definitely). Never-played
 * things are cheap to lose; things watched recently or requested recently aren't.
 */
export function regret({ plays, last, requestedAt, requesterWatched, viewers }, now) {
  let r
  if (!plays) r = 0.08
  else {
    const days = last ? (now - last) / DAY : 3650
    // Fades from ~0.75 just after a watch to ~0.15 after two years.
    r = 0.15 + 0.6 * Math.exp(-days / 300)
    // Lots of plays, or several people, means it's a favourite.
    r += 0.12 * Math.min(plays, 10) / 10 + 0.08 * Math.min(viewers || 0, 4) / 4
  }
  // Asked for recently: give it a fair chance.
  if (requestedAt && now - requestedAt < 120 * DAY) r = Math.max(r, 0.55)
  // Asked for, and the requester never watched it: they've lost interest.
  if (requesterWatched === false && requestedAt && now - requestedAt > 120 * DAY) r *= 0.7
  return Math.min(1, Math.max(0, r))
}

export const scoreFor = (bytes, r) => (bytes / GB) * (1 - r)

export function explain(c, now) {
  const bits = []
  if (c.unit === 'season') bits.push(c.reasonSeason)
  else if (!c.playCount) bits.push(c.addedMs ? `Never played since it was added ${ago(c.addedMs, now)}` : 'Never played')
  else bits.push(`Last watched ${ago(c.lastPlayedMs, now)} (${c.playCount} play${c.playCount === 1 ? '' : 's'}${c.viewers ? `, ${c.viewers} viewer${c.viewers === 1 ? '' : 's'}` : ''})`)
  if (c.requestedBy?.length) {
    bits.push(`Requested by ${c.requestedBy.join(', ')}${c.requesterWatched === false ? ', who never watched it' : c.requesterWatched ? ', who watched it' : ''}`)
  }
  return bits.join(' · ')
}

// ── Seasons ─────────────────────────────────────────────────────────────────

/**
 * Season-level candidates for a show someone has watched (wholly unwatched shows
 * are handled as a whole). Two kinds:
 *   - never reached: no plays in this season, nobody got this far, and nobody is
 *     mid-binge (the show wasn't played in the last 60 days, or this season is
 *     more than one past the furthest anyone got);
 *   - watched long ago: plays in this season, but none for `staleMonths`.
 */
export function seasonCandidates(raw, showHist, { now, staleBefore, neverPlayedBefore }) {
  if (!showHist || !showHist.plays) return []
  const out = []
  const recentlyActive = showHist.last && now - showHist.last < 60 * DAY
  const added = raw.added ? Date.parse(raw.added) : null
  for (const s of raw.seasons ?? []) {
    const n = s.seasonNumber
    const size = s.statistics?.sizeOnDisk ?? 0
    if (!size || !(s.statistics?.episodeFileCount > 0)) continue
    const h = showHist.seasons.get(n)
    const label = n === 0 ? 'Specials' : `Season ${n}`
    if (!h || !h.plays) {
      if (added && added > neverPlayedBefore) continue // too new to judge
      if (n > 0 && n <= showHist.maxSeason) continue // skipped, but later seasons were watched: odd, leave it
      if (recentlyActive && n <= showHist.maxSeason + 1) continue // someone may be about to start it
      out.push({
        seasonNumber: n, label, size, episodeFileCount: s.statistics.episodeFileCount, monitored: !!s.monitored,
        playCount: 0, lastPlayedMs: null, viewers: 0,
        reasonSeason: n === 0
          ? `Specials nobody has watched; show last watched ${ago(showHist.last, now)}`
          : showHist.maxSeason > 0
            ? `Nobody watched past season ${showHist.maxSeason}; show last watched ${ago(showHist.last, now)}`
            : `Nobody has watched the regular seasons; show last watched ${ago(showHist.last, now)}`,
      })
    } else if (h.last && h.last <= staleBefore) {
      out.push({
        seasonNumber: n, label, size, episodeFileCount: s.statistics.episodeFileCount, monitored: !!s.monitored,
        playCount: h.plays, lastPlayedMs: h.last, viewers: h.users.size,
        reasonSeason: `Season last watched ${ago(h.last, now)} (${h.plays} play${h.plays === 1 ? '' : 's'})`,
      })
    }
  }
  return out
}

// ── Downgrade ───────────────────────────────────────────────────────────────

// A typical 1080p WEB-DL runs ~3.3 GB an hour; generous so savings aren't oversold.
const EST_1080P_PER_MIN = 0.065 * GB
const isPremium = (quality) => /2160|remux|uhd/i.test(quality || '')

/** A big 4K/remux movie that's rarely watched: worth keeping, at 1080p. */
export function downgradeCandidate(c, raw, now) {
  if (c.kind !== 'movie' || !isPremium(c.quality)) return null
  // Something added a few weeks ago hasn't had its chance to be watched yet.
  if (c.addedMs && now - c.addedMs < 60 * DAY) return null
  const runtime = Number(raw.runtime) || 120
  const estimate = runtime * EST_1080P_PER_MIN
  const saving = c.size - estimate
  if (saving < 5 * GB) return null
  const rarely = !c.playCount || c.playCount <= 1 || (c.lastPlayedMs && now - c.lastPlayedMs > 180 * DAY)
  if (!rarely) return null
  return { saving: Math.round(saving), estimate: Math.round(estimate), movieFileId: raw.movieFile?.id ?? null }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function arr(svc, method, path, body, timeout = 30000) {
  const res = await fetch(`${trim(svc.url)}${path}`, {
    method, headers: arrH(svc.apiKey), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '')
    throw new Error(`${method} ${path.split('?')[0]} → ${res.status} ${text.slice(0, 120)}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** Clear Overseerr's record so the title can be requested again later. Best effort. */
async function clearOverseerr(overseerr, mediaId) {
  if (!overseerr?.enabled || !mediaId) return false
  const res = await fetch(`${trim(overseerr.url)}/api/v1/media/${mediaId}`, {
    method: 'DELETE', headers: { 'X-Api-Key': overseerr.apiKey }, signal: AbortSignal.timeout(15000),
  }).catch(() => null)
  return !!res?.ok
}

async function ensureKeepTag(svc) {
  const existing = await keepTagId(svc)
  if (existing != null) return existing
  return (await arr(svc, 'POST', '/api/v3/tag', { label: KEEP_LABEL })).id
}

/**
 * Performs one action on one candidate. `svc` is the Radarr/Sonarr instance the
 * candidate came from; `overseerr` may be null.
 *   delete   movie/series: remove + files + import exclusion, clear Overseerr
 *            season: delete that season's files and unmonitor the season
 *   keep     tag the movie/series "keep" so Reclaim never suggests it again
 *   downgrade (movie): switch to `profileId`, delete the big file, search 1080p
 */
export async function performAction({ action, unit, kind, arrId, seasonNumber, mediaId, profileId }, svc, overseerr) {
  const path = kind === 'movie' ? 'movie' : 'series'

  if (action === 'keep') {
    const tagId = await ensureKeepTag(svc)
    const item = await arr(svc, 'GET', `/api/v3/${path}/${arrId}`)
    if (!item.tags.includes(tagId)) await arr(svc, 'PUT', `/api/v3/${path}/${arrId}`, { ...item, tags: [...item.tags, tagId] })
    return { done: 'Tagged "keep"' }
  }

  if (action === 'delete' && unit === 'season') {
    const files = await arr(svc, 'GET', `/api/v3/episodefile?seriesId=${arrId}`)
    const ids = (files || []).filter((f) => f.seasonNumber === seasonNumber).map((f) => f.id)
    if (ids.length) await arr(svc, 'DELETE', '/api/v3/episodefile/bulk', { episodeFileIds: ids }, 120000)
    const series = await arr(svc, 'GET', `/api/v3/series/${arrId}`)
    const seasons = series.seasons.map((s) => (s.seasonNumber === seasonNumber ? { ...s, monitored: false } : s))
    await arr(svc, 'PUT', `/api/v3/series/${arrId}`, { ...series, seasons })
    return { done: `Deleted ${ids.length} episode file${ids.length === 1 ? '' : 's'}, season unmonitored` }
  }

  if (action === 'delete') {
    const exclusion = kind === 'movie' ? 'addImportExclusion=true' : 'addImportListExclusion=true'
    await arr(svc, 'DELETE', `/api/v3/${path}/${arrId}?deleteFiles=true&${exclusion}`, undefined, 120000)
    const cleared = await clearOverseerr(overseerr, mediaId)
    return { done: `Deleted with files, excluded from re-adding${cleared ? ', Overseerr request cleared' : ''}` }
  }

  if (action === 'downgrade') {
    if (kind !== 'movie') throw new Error('Downgrade is for movies')
    if (!profileId) throw new Error('Pick a quality profile to downgrade to')
    const movie = await arr(svc, 'GET', `/api/v3/movie/${arrId}`)
    await arr(svc, 'PUT', `/api/v3/movie/${arrId}`, { ...movie, qualityProfileId: profileId, monitored: true })
    if (movie.movieFile?.id) await arr(svc, 'DELETE', `/api/v3/moviefile/${movie.movieFile.id}`)
    await arr(svc, 'POST', '/api/v3/command', { name: 'MoviesSearch', movieIds: [arrId] })
    return { done: 'Switched to the new profile, old file deleted, searching for a smaller copy' }
  }

  throw new Error(`Unknown action: ${action}`)
}
