import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

// One title, every service that knows something about it.
//
// The dashboard already talks to Radarr, Sonarr, Tautulli, Bazarr, Overseerr and
// Plex individually — but each page only ever shows its own service's slice. This
// route fans out to all of them for a single item and merges the answers, so the
// UI can show file quality, who actually watched it, whether it has subtitles and
// who requested it in one panel.
//
// tmdbId is the join key: Radarr and Sonarr both carry one, Overseerr indexes by
// it, Bazarr addresses items by their radarrId/sonarrId directly, and Plex rating
// keys come back from Tautulli's history. Every source is optional and fails
// independently — a disabled or broken service just leaves its section absent.

const arrH = (key) => ({ 'X-Api-Key': key })
const trim = (u) => String(u || '').replace(/\/$/, '')

async function safeFetch(url, options = {}, timeout = 8000) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Unwrap Promise.allSettled results down to the payload, or null if anything
// along the way failed. Keeps the merge below free of status-checking noise.
const settled = (r) => (r.status === 'fulfilled' ? r.value : null)

const epochToIso = (s) => (s ? new Date(Number(s) * 1000).toISOString() : null)

// Loose title comparison for matching Tautulli rows back to *arr titles —
// punctuation and case differ constantly between metadata sources.
const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

// ── Tautulli ───────────────────────────────────────────────────────────────

const tautulliBase = (svc) => `${trim(svc.url)}/api/v2?apikey=${encodeURIComponent(svc.apiKey)}`

// Tautulli has no "look up by tmdb id" call, so we search history by title and
// then filter the rows ourselves. For movies we also require the year to match
// when both sides report one, which is enough to separate remakes.
async function tautulliWatch(svc, { title, year, kind, plexRatingKey = null }) {
  const base = tautulliBase(svc)
  const mediaType = kind === 'movie' ? 'movie' : 'episode'

  // When Plex has resolved the rating key from the item's tmdb/tvdb/imdb id we
  // can ask Tautulli for exactly that item. Falling back to a title search is
  // what used to mismatch alternate editions and year-suffixed show titles.
  const keyParam = kind === 'movie' ? 'rating_key' : 'grandparent_rating_key'
  const query = plexRatingKey
    ? `${keyParam}=${encodeURIComponent(plexRatingKey)}`
    : `search=${encodeURIComponent(title)}`

  const res = await safeFetch(
    `${base}&cmd=get_history&media_type=${mediaType}&${query}` +
      `&length=200&order_column=date&order_dir=desc`
  )
  if (!res.ok) return { available: false }

  const rows = res.data?.response?.data?.data ?? []
  const want = normalize(stripYearSuffix(title))

  // An exact rating-key query needs no further filtering; a title search does.
  const matched = plexRatingKey
    ? rows
    : rows.filter((r) => {
        const rowTitle = kind === 'movie' ? r.title || r.full_title : r.grandparent_title
        if (normalize(stripYearSuffix(rowTitle)) !== want) return false
        if (kind === 'movie' && year && r.year && Number(r.year) !== Number(year)) return false
        return true
      })

  // A show's rating key lives on the grandparent (the series), not the episode row.
  const ratingKey =
    plexRatingKey ??
    (kind === 'movie' ? matched[0]?.rating_key ?? null : matched[0]?.grandparent_rating_key ?? null)

  // History is capped, so for anything long-running the per-user totals derived
  // from it would undercount. When we have a rating key, Tautulli can give us the
  // real totals instead.
  let userStats = null
  if (ratingKey) {
    const statsRes = await safeFetch(`${base}&cmd=get_item_user_stats&rating_key=${ratingKey}`)
    if (statsRes.ok) userStats = statsRes.data?.response?.data ?? null
  }

  const byUser = new Map()
  for (const r of matched) {
    const name = r.friendly_name || r.user || 'Unknown'
    const entry = byUser.get(name) ?? { name, plays: 0, lastPlayed: null, thumb: r.user_thumb || null }
    entry.plays += 1
    const at = r.date ? Number(r.date) * 1000 : null
    if (at && (!entry.lastPlayed || at > entry.lastPlayed)) entry.lastPlayed = at
    byUser.set(name, entry)
  }

  const historyUsers = [...byUser.values()]
    .map((u) => ({ ...u, lastPlayed: u.lastPlayed ? new Date(u.lastPlayed).toISOString() : null }))
    .sort((a, b) => b.plays - a.plays)

  const users =
    Array.isArray(userStats) && userStats.length
      ? userStats
          .map((u) => {
            const name = u.friendly_name || u.username || u.user || 'Unknown'
            return {
              name,
              plays: u.total_plays ?? 0,
              thumb: u.user_thumb || null,
              // get_item_user_stats has no last-played field, so keep the one we
              // derived from history when that user appears there.
              lastPlayed: historyUsers.find((h) => h.name === name)?.lastPlayed ?? null,
            }
          })
          .sort((a, b) => b.plays - a.plays)
      : historyUsers

  const lastPlayedEpoch = matched.reduce((max, r) => Math.max(max, Number(r.date) || 0), 0)

  return {
    available: true,
    ratingKey,
    totalPlays: users.reduce((sum, u) => sum + (u.plays || 0), 0),
    lastPlayed: lastPlayedEpoch ? epochToIso(lastPlayedEpoch) : null,
    users: users.slice(0, 12),
    history: matched.slice(0, 15).map((r) => ({
      id: r.id ?? `${r.rating_key}-${r.date}`,
      user: r.friendly_name || r.user || 'Unknown',
      date: epochToIso(r.date),
      player: r.player || null,
      platform: r.platform || null,
      // 'direct play' | 'copy' (direct stream) | 'transcode'
      transcodeDecision: r.transcode_decision || null,
      percentComplete: r.percent_complete ?? null,
      watched: r.watched_status === 1 || r.watched_status === '1',
      episode:
        kind === 'series' && r.parent_media_index != null && r.media_index != null
          ? `S${String(r.parent_media_index).padStart(2, '0')}E${String(r.media_index).padStart(2, '0')}`
          : null,
      episodeTitle: kind === 'series' ? r.title || null : null,
    })),
  }
}

// ── Bazarr ─────────────────────────────────────────────────────────────────

const bazarrH = (key) => ({ 'X-API-KEY': key, Accept: 'application/json' })

// Bazarr lists a language in `subtitles` whether or not it's actually downloaded —
// entries without a path are desired-but-absent, which is what `missing_subtitles`
// separately reports. We only count the ones with a path as present.
const mapSubs = (list) =>
  (list ?? [])
    .filter((s) => s.path)
    .map((s) => ({
      code: s.code2 || s.code3 || '??',
      name: s.name || s.code2 || 'Unknown',
      forced: !!s.forced,
      hi: !!s.hi,
    }))

const mapMissingSubs = (list) =>
  (list ?? []).map((s) => ({
    code: s.code2 || s.code3 || '??',
    name: s.name || s.code2 || 'Unknown',
    forced: !!s.forced,
    hi: !!s.hi,
  }))

async function bazarrMovie(svc, radarrId) {
  const res = await safeFetch(`${trim(svc.url)}/api/movies?radarrid[]=${radarrId}`, { headers: bazarrH(svc.apiKey) })
  if (!res.ok) return { available: false }
  const m = (res.data?.data ?? [])[0]
  if (!m) return { available: true, tracked: false, have: [], missing: [] }
  return {
    available: true,
    tracked: true,
    have: mapSubs(m.subtitles),
    missing: mapMissingSubs(m.missing_subtitles),
  }
}

async function bazarrSeries(svc, sonarrId) {
  const res = await safeFetch(`${trim(svc.url)}/api/series?seriesid[]=${sonarrId}`, { headers: bazarrH(svc.apiKey) })
  if (!res.ok) return { available: false }
  const s = (res.data?.data ?? [])[0]
  if (!s) return { available: true, tracked: false, have: [], missing: [] }
  return {
    available: true,
    tracked: true,
    // Series-level Bazarr data is counts, not per-file language lists.
    episodeFileCount: s.episodeFileCount ?? null,
    episodeMissingCount: s.episodeMissingCount ?? null,
    have: (s.languages ?? []).map((l) => ({
      code: l.code2 || '??',
      name: l.name || l.code2 || 'Unknown',
      forced: !!l.forced,
      hi: !!l.hi,
    })),
    missing: [],
  }
}

// ── Overseerr ──────────────────────────────────────────────────────────────

// Overseerr's per-title endpoint carries mediaInfo.requests inline, which saves
// paging the whole request list looking for a tmdb id.
const REQUEST_STATUS = { 1: 'Pending', 2: 'Approved', 3: 'Declined', 4: 'Failed' }
const MEDIA_STATUS = { 1: 'Unknown', 2: 'Pending', 3: 'Processing', 4: 'Partially Available', 5: 'Available' }

async function overseerrInfo(svc, kind, tmdbId) {
  if (!tmdbId) return { available: false }
  const path = kind === 'movie' ? `api/v1/movie/${tmdbId}` : `api/v1/tv/${tmdbId}`
  const res = await safeFetch(`${trim(svc.url)}/${path}`, {
    headers: { 'X-Api-Key': svc.apiKey, Accept: 'application/json' },
  })
  if (!res.ok) return { available: false }

  const mediaInfo = res.data?.mediaInfo
  const requests = mediaInfo?.requests ?? []

  return {
    available: true,
    mediaStatus: mediaInfo?.status ? MEDIA_STATUS[mediaInfo.status] ?? null : null,
    requests: requests.map((r) => ({
      id: r.id,
      status: REQUEST_STATUS[r.status] ?? 'Unknown',
      requestedBy: r.requestedBy?.displayName || r.requestedBy?.plexUsername || r.requestedBy?.email || 'Unknown',
      requestedAt: r.createdAt ?? null,
      is4k: !!r.is4k,
    })),
  }
}

// ── Plex ───────────────────────────────────────────────────────────────────

// The machine identifier is needed to build app.plex.tv deep links and never
// changes, so it's worth caching rather than re-fetching per detail open.
let machineIdCache = { value: null, at: 0 }

async function plexMachineId(svc) {
  if (machineIdCache.value && Date.now() - machineIdCache.at < 3_600_000) return machineIdCache.value
  const res = await safeFetch(`${trim(svc.url)}/identity`, {
    headers: { 'X-Plex-Token': svc.apiKey, Accept: 'application/json' },
  })
  if (!res.ok) return null
  const id = res.data?.MediaContainer?.machineIdentifier ?? null
  if (id) machineIdCache = { value: id, at: Date.now() }
  return id
}

const plexWebUrl = (machineId, ratingKey) =>
  machineId && ratingKey
    ? `https://app.plex.tv/desktop#!/server/${machineId}/details?key=${encodeURIComponent(
        `/library/metadata/${ratingKey}`
      )}`
    : null

// ── Shared assembly ────────────────────────────────────────────────────────

// Runs the four optional lookups that are identical for movies and series, so
// both handlers below stay focused on their own *arr-specific shape.
async function gatherSecondary(config, { kind, title, year, tmdbId, tvdbId, imdbId, arrId }) {
  const { tautulli, bazarr, overseerr, plex } = config.services

  // Cached — the detail panel is opened far more often than the library changes.
  const guidIndex = plex?.enabled ? await plexGuidIndex(plex).catch(() => null) : null
  const plexRatingKey = resolveRatingKey(guidIndex, kind, { title, year, tmdbId, tvdbId, imdbId })

  const [watchR, subsR, requestR, machineR] = await Promise.allSettled([
    tautulli?.enabled
      ? tautulliWatch(tautulli, { title, year, kind, plexRatingKey })
      : Promise.resolve({ available: false }),
    bazarr?.enabled
      ? kind === 'movie'
        ? bazarrMovie(bazarr, arrId)
        : bazarrSeries(bazarr, arrId)
      : Promise.resolve({ available: false }),
    overseerr?.enabled ? overseerrInfo(overseerr, kind, tmdbId) : Promise.resolve({ available: false }),
    plex?.enabled ? plexMachineId(plex) : Promise.resolve(null),
  ])

  const watch = settled(watchR) ?? { available: false }
  const machineId = settled(machineR)

  // Plex's own answer beats one inferred from play history — it's present even
  // for something nobody has ever played.
  const ratingKey = plexRatingKey ?? watch.ratingKey ?? null

  return {
    watch,
    subtitles: settled(subsR) ?? { available: false },
    request: settled(requestR) ?? { available: false },
    plex: {
      available: !!(plex?.enabled && ratingKey),
      ratingKey,
      inLibrary: guidIndex ? !!plexRatingKey : null,
      webUrl: plexWebUrl(machineId, ratingKey),
    },
  }
}

const EMPTY_SECONDARY = {
  watch: { available: false },
  subtitles: { available: false },
  request: { available: false },
  plex: { available: false },
}

const mapArrHistory = (records) =>
  (Array.isArray(records) ? records : records?.records ?? []).slice(0, 10).map((h) => ({
    id: h.id,
    eventType: h.eventType,
    date: h.date,
    sourceTitle: h.sourceTitle ?? null,
    quality: h.quality?.quality?.name ?? null,
  }))


// ── Reclaim ────────────────────────────────────────────────────────────────

// "What can I safely delete?" — the one question the dashboard couldn't answer.
//
// Radarr and Sonarr know what each title costs in bytes; Tautulli knows whether
// anyone ever pressed play on it. Neither is useful alone, and nothing in the app
// joined them until now. Tautulli's get_library_media_info returns file_size,
// play_count and last_played for a whole library in a single call, which makes it
// the natural spine for this.
//
// Matching is by normalized title (plus year for movies), because Tautulli indexes
// by Plex rating key and has no idea what a tmdb id is. A title that matches
// nothing is reported as an orphan rather than silently assumed unwatched.

const MS_PER_DAY = 86_400_000

// Plex routinely disambiguates a title with a trailing year — "Yellowstone (2018)"
// — where the *arr title is just "Yellowstone". Normalizing naively turns those
// into "yellowstone2018" vs "yellowstone" and they never match, so strip the
// suffix and keep the year as a separate, more precise key.
const stripYearSuffix = (title) => String(title || '').replace(/\s*\((?:19|20)\d{2}\)\s*$/, '')

// Keys are tried most-specific first: title+year, then bare title, then the
// unstripped form in case an *arr title really does carry the year.
const watchKeys = (title, year) => {
  const bare = normalize(stripYearSuffix(title))
  const full = normalize(title)
  const keys = []
  if (year) keys.push(`${bare}|${year}`)
  keys.push(bare)
  if (full !== bare) keys.push(full)
  return keys
}


// Plex is the only service that can state authoritatively what's in the library
// and what external ids it maps to. /library/sections/{id}/all?includeGuids=1
// returns the whole section with an imdb/tmdb/tvdb triple per item in one call,
// which is the exact join Radarr and Sonarr need — no title guessing.
//
// Cached because the detail panel hits it per open; Reclaim forces a rebuild
// since a scan is a deliberate, user-initiated action.
let guidIndexCache = { value: null, at: 0 }
const GUID_INDEX_TTL = 600_000

async function plexGuidIndex(svc, { force = false } = {}) {
  if (!force && guidIndexCache.value && Date.now() - guidIndexCache.at < GUID_INDEX_TTL) {
    return guidIndexCache.value
  }

  const base = trim(svc.url)
  const headers = { 'X-Plex-Token': svc.apiKey, Accept: 'application/json' }

  const secRes = await safeFetch(`${base}/library/sections`, { headers }, 15000)
  if (!secRes.ok) return null

  const sections = (secRes.data?.MediaContainer?.Directory ?? []).filter(
    (d) => d.type === 'movie' || d.type === 'show'
  )
  if (!sections.length) return null

  const results = await Promise.allSettled(
    sections.map((d) =>
      safeFetch(
        `${base}/library/sections/${d.key}/all?includeGuids=1` +
          `&X-Plex-Container-Start=0&X-Plex-Container-Size=10000`,
        { headers },
        30000
      )
    )
  )

  const movie = new Map()
  const show = new Map()
  const titles = { movie: new Map(), show: new Map() }
  let anyOk = false

  sections.forEach((section, i) => {
    const r = settled(results[i])
    if (!r?.ok) return
    anyOk = true
    const guidTarget = section.type === 'movie' ? movie : show
    const titleTarget = titles[section.type]

    for (const item of r.data?.MediaContainer?.Metadata ?? []) {
      const ratingKey = String(item.ratingKey)
      for (const g of item.Guid ?? []) {
        if (g.id && !guidTarget.has(g.id)) guidTarget.set(g.id, ratingKey)
      }
      // Title keys as a backstop for anything Plex has without a usable guid.
      for (const key of watchKeys(item.title, item.year)) {
        if (!titleTarget.has(key)) titleTarget.set(key, ratingKey)
      }
    }
  })

  if (!anyOk) return null
  const index = { movie, show, titles }
  guidIndexCache = { value: index, at: Date.now() }
  return index
}

// The external ids each app can offer, most reliable first. Sonarr is a tvdb-first
// application, Radarr a tmdb-first one, so the orders differ deliberately.
const guidCandidates = (kind, item) =>
  (kind === 'movie'
    ? [item.tmdbId && `tmdb://${item.tmdbId}`, item.imdbId && `imdb://${item.imdbId}`]
    : [
        item.tvdbId && `tvdb://${item.tvdbId}`,
        item.tmdbId && `tmdb://${item.tmdbId}`,
        item.imdbId && `imdb://${item.imdbId}`,
      ]
  ).filter(Boolean)

// Resolve an *arr record to its Plex rating key: exact id match first, then the
// title backstop for the handful of items Plex holds without a matching guid.
function resolveRatingKey(guidIndex, kind, item) {
  if (!guidIndex) return null
  const guidMap = kind === 'movie' ? guidIndex.movie : guidIndex.show
  for (const g of guidCandidates(kind, item)) {
    const hit = guidMap.get(g)
    if (hit) return hit
  }
  const titleMap = kind === 'movie' ? guidIndex.titles.movie : guidIndex.titles.show
  for (const key of watchKeys(item.title, item.year)) {
    const hit = titleMap.get(key)
    if (hit) return hit
  }
  return null
}

async function tautulliLibraryIndex(svc) {
  const base = tautulliBase(svc)
  const libsRes = await safeFetch(`${base}&cmd=get_libraries`, {}, 15000)
  if (!libsRes.ok) return null

  const libraries = (libsRes.data?.response?.data ?? []).filter(
    (l) => l.section_type === 'movie' || l.section_type === 'show'
  )
  if (!libraries.length) return null

  const results = await Promise.allSettled(
    libraries.map((l) =>
      safeFetch(
        // refresh=true matters: without it Tautulli returns whatever is already
        // in its media_info_table, which on a real library is a fraction of the
        // whole thing (904 of 1595 movies on the server this was built against).
        // Everything missing would otherwise be misreported as an orphan.
        `${base}&cmd=get_library_media_info&section_id=${l.section_id}&length=10000` +
          `&order_column=file_size&order_dir=desc&refresh=true`,
        {},
        30000
      )
    )
  )

  const movies = new Map()
  const shows = new Map()
  const byRatingKey = new Map()
  let anyOk = false

  libraries.forEach((lib, i) => {
    const r = settled(results[i])
    if (!r?.ok) return
    anyOk = true
    const target = lib.section_type === 'movie' ? movies : shows
    for (const row of r.data?.response?.data?.data ?? []) {
      if (!row.title) continue
      const entry = {
        ratingKey: row.rating_key != null ? String(row.rating_key) : null,
        playCount: Number(row.play_count) || 0,
        lastPlayed: row.last_played ? Number(row.last_played) * 1000 : null,
        fileSize: Number(row.file_size) || 0,
        library: lib.section_name,
      }
      // Rating key is the exact join with Plex; the title keys below are only
      // a backstop for when the Plex index is unavailable.
      if (entry.ratingKey) byRatingKey.set(entry.ratingKey, entry)
      // First write wins — the list is size-ordered, so on a duplicate title
      // that keeps the bigger copy, which is the one worth reporting on.
      for (const key of watchKeys(row.title, row.year)) {
        if (!target.has(key)) target.set(key, entry)
      }
    }
  })

  return anyOk ? { movies, shows, byRatingKey } : null
}

// Resolution order: Plex guid -> rating key -> Tautulli row (exact), then a
// title match against Tautulli directly (fuzzy, and only when Plex is absent).
//
// The `inPlex` distinction matters: an item Plex holds but Tautulli has no row
// for has simply never been played, and must not be reported as an orphan.
function lookupWatch({ guidIndex, tautulli }, kind, item) {
  const ratingKey = resolveRatingKey(guidIndex, kind, item)

  if (ratingKey) {
    const row = tautulli?.byRatingKey.get(ratingKey)
    return row
      ? { ...row, inPlex: true }
      : { ratingKey, playCount: 0, lastPlayed: null, fileSize: 0, inPlex: true }
  }

  // Plex says it isn't there — but only trust that if we actually had an index.
  if (guidIndex) return { inPlex: false }

  if (!tautulli) return undefined
  const target = kind === 'movie' ? tautulli.movies : tautulli.shows
  for (const key of watchKeys(item.title, item.year)) {
    const hit = target.get(key)
    if (hit) return { ...hit, inPlex: true }
  }
  return { inPlex: false }
}

// Every configured Radarr/Sonarr, primary and secondary, as a uniform list. The
// proxyBase is what the browser will call to act on the item, so it has to match
// the two shapes proxy.js serves.
function reclaimTargets(config) {
  const targets = []
  const { radarr, sonarr } = config.services
  const extra = config.additionalInstances ?? {}

  if (radarr?.enabled) targets.push({ kind: 'movie', name: 'Radarr', proxyBase: 'radarr', svc: radarr })
  for (const i of extra.radarr ?? []) {
    targets.push({ kind: 'movie', name: i.name || 'Radarr (secondary)', proxyBase: `instance/radarr/${i.id}`, svc: i })
  }

  if (sonarr?.enabled) targets.push({ kind: 'series', name: 'Sonarr', proxyBase: 'sonarr', svc: sonarr })
  for (const i of extra.sonarr ?? []) {
    targets.push({ kind: 'series', name: i.name || 'Sonarr (secondary)', proxyBase: `instance/sonarr/${i.id}`, svc: i })
  }

  return targets
}

export default async function mediaRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)


  // ── Reclaim candidates ───────────────────────────────────────────────────
  fastify.get('/reclaim', async (request, reply) => {
    const config = await getConfig()
    const targets = reclaimTargets(config)
    if (!targets.length) return reply.status(400).send({ error: 'Enable Radarr or Sonarr to use Reclaim' })

    // Nonsense input falls back to the default rather than clamping, so a stray
    // negative can't silently turn "not played in a year" into "not played today".
    const intParam = (raw, fallback, min) => {
      const n = parseInt(raw, 10)
      return Number.isFinite(n) && n >= min ? n : fallback
    }
    const neverPlayedDays = intParam(request.query.neverPlayedDays, 90, 0)
    const staleMonths = intParam(request.query.staleMonths, 12, 1)
    const limit = Math.min(intParam(request.query.limit, 400, 1), 1000)

    const { tautulli, plex } = config.services

    const [arrResults, guidResult, tautulliResult] = await Promise.all([
      Promise.allSettled(
        targets.map((t) =>
          safeFetch(
            `${trim(t.svc.url)}/api/v3/${t.kind === 'movie' ? 'movie' : 'series'}`,
            { headers: arrH(t.svc.apiKey) },
            25000
          )
        )
      ),
      // A scan is deliberate, so rebuild the Plex index rather than serving a
      // cached one that could be up to ten minutes stale.
      plex?.enabled ? plexGuidIndex(plex, { force: true }).catch(() => null) : Promise.resolve(null),
      tautulli?.enabled ? tautulliLibraryIndex(tautulli).catch(() => null) : Promise.resolve(null),
    ])

    const guidIndex = guidResult
    const tautulliIndex = tautulliResult
    const watchIndex = guidIndex || tautulliIndex ? { guidIndex, tautulli: tautulliIndex } : null
    const now = Date.now()
    const neverPlayedBefore = now - neverPlayedDays * MS_PER_DAY
    const staleBefore = now - staleMonths * 30 * MS_PER_DAY

    const items = []
    const reachable = []

    targets.forEach((t, i) => {
      const res = settled(arrResults[i])
      if (!res?.ok || !Array.isArray(res.data)) return
      reachable.push(t.name)

      for (const raw of res.data) {
        const isMovie = t.kind === 'movie'
        const size = isMovie ? raw.movieFile?.size ?? raw.sizeOnDisk ?? 0 : raw.statistics?.sizeOnDisk ?? 0
        const hasFile = isMovie ? !!raw.hasFile : (raw.statistics?.episodeFileCount ?? 0) > 0

        // Nothing on disk means nothing to reclaim.
        if (!hasFile || size <= 0) continue

        const watch = watchIndex ? lookupWatch(watchIndex, t.kind, raw) : undefined
        const added = raw.added ? new Date(raw.added).getTime() : null

        items.push({
          key: `${t.proxyBase}:${raw.id}`,
          kind: t.kind,
          arrId: raw.id,
          proxyBase: t.proxyBase,
          instance: t.name,
          title: raw.title,
          year: raw.year ?? null,
          tmdbId: raw.tmdbId ?? null,
          size,
          added: raw.added ?? null,
          addedMs: added,
          monitored: !!raw.monitored,
          quality: isMovie ? raw.movieFile?.quality?.quality?.name ?? null : null,
          ended: isMovie ? null : !!raw.ended,
          episodeFileCount: isMovie ? null : raw.statistics?.episodeFileCount ?? null,
          playCount: watch?.inPlex ? watch.playCount ?? 0 : null,
          lastPlayed: watch?.lastPlayed ? new Date(watch.lastPlayed).toISOString() : null,
          lastPlayedMs: watch?.lastPlayed ?? null,
          inPlex: watch ? watch.inPlex : null,
          lenses: [],
        })
      }
    })

    // ── Lens assignment ────────────────────────────────────────────────────

    // Duplicates: the same tmdb id held by more than one instance, which is what
    // a separate 4K library looks like from here.
    const byTmdb = new Map()
    for (const item of items) {
      if (!item.tmdbId) continue
      const key = `${item.kind}:${item.tmdbId}`
      if (!byTmdb.has(key)) byTmdb.set(key, [])
      byTmdb.get(key).push(item)
    }
    for (const group of byTmdb.values()) {
      if (group.length < 2) continue
      for (const item of group) {
        item.lenses.push('duplicates')
        item.note = `Also in ${group.filter((g) => g !== item).map((g) => g.instance).join(', ')}`
      }
    }

    for (const item of items) {
      if (item.inPlex === false) {
        // Present in *arr with files, absent from Plex — usually a failed import
        // or a library that needs a rescan. Needs only the Plex index, not Tautulli.
        item.lenses.push('orphans')
        continue
      }
      if (!tautulliIndex || item.inPlex !== true) continue
      if (item.playCount === 0) {
        // Brand-new additions aren't stale, they just haven't had their chance yet.
        if (item.addedMs == null || item.addedMs <= neverPlayedBefore) item.lenses.push('never-played')
      } else if (item.lastPlayedMs != null && item.lastPlayedMs <= staleBefore) {
        item.lenses.push('stale')
      }
    }

    // Largest: the top slice by size, regardless of watch state.
    const bySize = [...items].sort((a, b) => b.size - a.size)
    for (const item of bySize.slice(0, 50)) item.lenses.push('largest')

    // Cap per lens rather than globally. A single global cut ordered by size
    // silently drops the tail of a small lens — a 6-item orphan list showing 5
    // rows while its tab still said 6 — because large items from other lenses
    // fill the budget first.
    const LENSES = ['never-played', 'stale', 'largest', 'duplicates', 'orphans']
    const selected = new Map()
    for (const lens of LENSES) {
      for (const item of bySize.filter((i) => i.lenses.includes(lens)).slice(0, limit)) {
        selected.set(item.key, item)
      }
    }
    const candidates = [...selected.values()].sort((a, b) => b.size - a.size)

    // `shown` is counted off the final candidate list, not off each lens's own
    // slice: the list is a union, so an item pulled in by one lens still shows
    // under every other lens it matches. Counting the slice would understate it.
    const lensTotals = {}
    for (const lens of LENSES) {
      const matching = items.filter((i) => i.lenses.includes(lens))
      lensTotals[lens] = {
        count: matching.length,
        bytes: matching.reduce((sum, i) => sum + i.size, 0),
        // Lets the UI say "showing the largest 400 of 900" rather than quietly
        // disagreeing with its own tab count.
        shown: candidates.filter((i) => i.lenses.includes(lens)).length,
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      sources: {
        instances: reachable,
        tautulli: !!tautulliIndex,
        plex: !!guidIndex,
        // The UI uses these to explain why a lens is unavailable rather than
        // showing it as merely empty. Orphans only needs Plex to say what's in
        // the library; never-played and stale need Tautulli's play counts.
        watchLensesAvailable: !!tautulliIndex,
        orphanLensAvailable: !!guidIndex || !!tautulliIndex,
        // Exact id matching, rather than the title fallback.
        exactMatching: !!guidIndex,
      },
      settings: { neverPlayedDays, staleMonths },
      totals: {
        scanned: items.length,
        bytesOnDisk: items.reduce((sum, i) => sum + i.size, 0),
      },
      lensTotals,
      candidates: candidates.map(({ addedMs, lastPlayedMs, ...rest }) => rest),
    }
  })

  // ── Movie detail ─────────────────────────────────────────────────────────
  fastify.get('/movie/:id', async (request, reply) => {
    const config = await getConfig()
    const radarr = config.services.radarr
    if (!radarr?.enabled) return reply.status(400).send({ error: 'Radarr not enabled' })

    const id = Number(request.params.id)
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid movie id' })

    const base = trim(radarr.url)
    const movieRes = await safeFetch(`${base}/api/v3/movie/${id}`, { headers: arrH(radarr.apiKey) })
    if (!movieRes.ok) return reply.status(502).send({ error: movieRes.error })
    const m = movieRes.data

    const [historyR, profilesR, secondaryR] = await Promise.allSettled([
      safeFetch(`${base}/api/v3/history/movie?movieId=${id}`, { headers: arrH(radarr.apiKey) }),
      safeFetch(`${base}/api/v3/qualityprofile`, { headers: arrH(radarr.apiKey) }),
      gatherSecondary(config, {
        kind: 'movie', title: m.title, year: m.year,
        tmdbId: m.tmdbId, imdbId: m.imdbId, arrId: id,
      }),
    ])

    const historyRes = settled(historyR)
    const profilesRes = settled(profilesR)
    const profileName = profilesRes?.ok
      ? (profilesRes.data ?? []).find((p) => p.id === m.qualityProfileId)?.name ?? null
      : null

    const file = m.movieFile
      ? {
          quality: m.movieFile.quality?.quality?.name ?? null,
          size: m.movieFile.size ?? 0,
          relativePath: m.movieFile.relativePath ?? null,
          videoCodec: m.movieFile.mediaInfo?.videoCodec ?? null,
          resolution: m.movieFile.mediaInfo?.resolution ?? null,
          audioCodec: m.movieFile.mediaInfo?.audioCodec ?? null,
          dateAdded: m.movieFile.dateAdded ?? null,
        }
      : null

    return {
      kind: 'movie',
      id: m.id,
      title: m.title,
      year: m.year ?? null,
      overview: m.overview ?? null,
      poster: m.images?.find((i) => i.coverType === 'poster')?.remoteUrl ?? null,
      runtime: m.runtime ?? null,
      genres: m.genres ?? [],
      certification: m.certification ?? null,
      ratings: m.ratings ?? null,
      monitored: !!m.monitored,
      hasFile: !!m.hasFile,
      isAvailable: !!m.isAvailable,
      path: m.path ?? null,
      sizeOnDisk: m.sizeOnDisk ?? 0,
      qualityProfileId: m.qualityProfileId ?? null,
      qualityProfileName: profileName,
      tmdbId: m.tmdbId ?? null,
      imdbId: m.imdbId ?? null,
      file,
      arrHistory: historyRes?.ok ? mapArrHistory(historyRes.data) : [],
      ...(settled(secondaryR) ?? EMPTY_SECONDARY),
    }
  })

  // ── Series detail ────────────────────────────────────────────────────────
  fastify.get('/series/:id', async (request, reply) => {
    const config = await getConfig()
    const sonarr = config.services.sonarr
    if (!sonarr?.enabled) return reply.status(400).send({ error: 'Sonarr not enabled' })

    const id = Number(request.params.id)
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid series id' })

    const base = trim(sonarr.url)
    const seriesRes = await safeFetch(`${base}/api/v3/series/${id}`, { headers: arrH(sonarr.apiKey) })
    if (!seriesRes.ok) return reply.status(502).send({ error: seriesRes.error })
    const s = seriesRes.data

    const [historyR, profilesR, secondaryR] = await Promise.allSettled([
      safeFetch(`${base}/api/v3/history/series?seriesId=${id}`, { headers: arrH(sonarr.apiKey) }),
      safeFetch(`${base}/api/v3/qualityprofile`, { headers: arrH(sonarr.apiKey) }),
      gatherSecondary(config, {
        kind: 'series', title: s.title, year: s.year,
        tmdbId: s.tmdbId, tvdbId: s.tvdbId, imdbId: s.imdbId, arrId: id,
      }),
    ])

    const historyRes = settled(historyR)
    const profilesRes = settled(profilesR)
    const profileName = profilesRes?.ok
      ? (profilesRes.data ?? []).find((p) => p.id === s.qualityProfileId)?.name ?? null
      : null

    const stats = s.statistics ?? {}

    return {
      kind: 'series',
      id: s.id,
      title: s.title,
      year: s.year ?? null,
      overview: s.overview ?? null,
      poster: s.images?.find((i) => i.coverType === 'poster')?.remoteUrl ?? null,
      runtime: s.runtime ?? null,
      genres: s.genres ?? [],
      certification: s.certification ?? null,
      ratings: s.ratings ?? null,
      monitored: !!s.monitored,
      status: s.status ?? null,
      ended: !!s.ended,
      network: s.network ?? null,
      path: s.path ?? null,
      sizeOnDisk: stats.sizeOnDisk ?? 0,
      seasonCount: stats.seasonCount ?? (s.seasons ?? []).filter((x) => x.seasonNumber > 0).length,
      // Carried through so the detail panel can keep Sonarr's per-season
      // monitor toggles, which the page-local panel it replaces already had.
      seasons: (s.seasons ?? []).map((season) => ({
        seasonNumber: season.seasonNumber,
        monitored: !!season.monitored,
        episodeFileCount: season.statistics?.episodeFileCount ?? 0,
        episodeCount: season.statistics?.episodeCount ?? 0,
        totalEpisodeCount: season.statistics?.totalEpisodeCount ?? 0,
        sizeOnDisk: season.statistics?.sizeOnDisk ?? 0,
        percentOfEpisodes: season.statistics?.percentOfEpisodes ?? 0,
      })),
      episodeCount: stats.episodeCount ?? null,
      episodeFileCount: stats.episodeFileCount ?? null,
      totalEpisodeCount: stats.totalEpisodeCount ?? null,
      qualityProfileId: s.qualityProfileId ?? null,
      qualityProfileName: profileName,
      tmdbId: s.tmdbId ?? null,
      tvdbId: s.tvdbId ?? null,
      imdbId: s.imdbId ?? null,
      file: null,
      hasFile: (stats.episodeFileCount ?? 0) > 0,
      arrHistory: historyRes?.ok ? mapArrHistory(historyRes.data) : [],
      ...(settled(secondaryR) ?? EMPTY_SECONDARY),
    }
  })
}
