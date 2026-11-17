import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { addLog } from '../logBuffer.js'
import { trackReplacement } from '../plexAddedAt.js'

// Wrong-language files: episodes and movies whose audio has no track in the
// title's original language or in English (a German-only Stargate Universe, a
// Hebrew dub of a Disney show; an English dub of an anime is fine). Sonarr and
// Radarr already read every file's audio tracks (mediaInfo.audioLanguages), so
// the scan is API-only, no ffprobe.
//
// A file is listed only when every track has a real language tag and none is
// the original language or English. Untagged or "und" tracks may well be the
// original, so they never count against a file.
//
// A file with original-language audio but no English audio also needs English
// subtitles, in the file or next to it (Bazarr): a French MULTi anime release
// has Japanese audio and only French subs. Replacing one of those skips
// releases whose names mark them as foreign multi-audio (FOREIGN_SUBBED).
//
// Replacing first asks the *arr for releases (the same list as an interactive
// search) and only deletes the file when one exists that the profile would take
// (custom format score >= 0, rejected for nothing but "not an upgrade" over the
// file we're about to delete). Then it searches. Every replacement goes to
// language-replaced.jsonl next to config.json.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CONFIG_PATH ? dirname(process.env.CONFIG_PATH) : join(__dirname, '../../config')
const IGNORE_PATH = join(CONFIG_DIR, 'language-ignore.json')
const LOG_PATH = join(CONFIG_DIR, 'language-replaced.jsonl')

const SCAN_TTL_MS = 30 * 60_000
const RELEASE_TIMEOUT_MS = 180_000
// Rejections that only say "you already have a file", which won't be true once it's deleted.
const UPGRADE_ONLY = /existing file|upgrade|cutoff|already meets/i

// *arr language name -> the codes media files use for it.
const CODES = {
  English: ['eng', 'en'], Japanese: ['jpn', 'ja'], Korean: ['kor', 'ko'], Chinese: ['chi', 'zho', 'zh', 'cmn', 'yue'],
  French: ['fre', 'fra', 'fr'], German: ['ger', 'deu', 'de'], Spanish: ['spa', 'es'], Italian: ['ita', 'it'],
  Portuguese: ['por', 'pt'], 'Portuguese (Brazil)': ['por', 'pt'], Russian: ['rus', 'ru'], Danish: ['dan', 'da'],
  Dutch: ['dut', 'nld', 'nl'], Flemish: ['dut', 'nld', 'nl'], Swedish: ['swe', 'sv'], Norwegian: ['nor', 'nob', 'nno', 'no'],
  Finnish: ['fin', 'fi'], Polish: ['pol', 'pl'], Hindi: ['hin', 'hi'], Turkish: ['tur', 'tr'], Thai: ['tha', 'th'],
  Hebrew: ['heb', 'he'], Arabic: ['ara', 'ar'], Czech: ['cze', 'ces', 'cs'], Hungarian: ['hun', 'hu'],
  Greek: ['gre', 'ell', 'el'], Icelandic: ['ice', 'isl', 'is'], Indonesian: ['ind', 'id'], Ukrainian: ['ukr', 'uk'],
  Vietnamese: ['vie', 'vi'], Romanian: ['rum', 'ron', 'ro'], Bulgarian: ['bul', 'bg'], Croatian: ['hrv', 'hr'],
  Serbian: ['srp', 'sr'], Persian: ['per', 'fas', 'fa'], Tagalog: ['tgl', 'fil'], Malay: ['may', 'msa', 'ms'],
  Catalan: ['cat', 'ca'], Lithuanian: ['lit', 'lt'], Latvian: ['lav', 'lv'], Estonian: ['est', 'et'],
  Slovak: ['slo', 'slk', 'sk'], Slovenian: ['slv', 'sl'], Bengali: ['ben', 'bn'], Tamil: ['tam', 'ta'], Telugu: ['tel', 'te'],
}
const UNTAGGED = new Set(['', 'und', 'mul', 'zxx', 'qaa', 'unknown'])
const tracksOf = (list) => String(list ?? '').toLowerCase().split('/').map((t) => t.trim()).filter(Boolean)

/**
 * Why a file is unwatchable, or null when it's fine / we can't tell:
 *  'audio' - no track in the original language or English (a German dub of an English show)
 *  'subs'  - original-language audio but no English audio and no English subtitles in the
 *            file (a French MULTi anime release: French + Japanese audio, French subs).
 *            External subs are checked separately (Bazarr), see withoutEnglishSubs.
 * English audio is always fine: English dubs of anime are wanted.
 */
function wrongLanguage(mediaInfo, original) {
  const codes = CODES[original]
  if (!codes) return null
  const audio = tracksOf(mediaInfo?.audioLanguages)
  if (!audio.length || audio.some((t) => UNTAGGED.has(t))) return null
  if (audio.some((t) => CODES.English.includes(t))) return null
  if (!audio.some((t) => codes.includes(t))) return 'audio'
  const subs = tracksOf(mediaInfo?.subtitles)
  if (subs.some((t) => UNTAGGED.has(t) || CODES.English.includes(t))) return null
  return 'subs'
}

const bazarrH = (key) => ({ 'X-API-KEY': key, Accept: 'application/json' })
/** File paths Bazarr has a full (not forced-only) English subtitle for. */
async function bazarrEnglishSubs(bazarr, query) {
  const res = await fetch(`${bazarr.url.replace(/\/$/, '')}/api/${query}`, { headers: bazarrH(bazarr.apiKey), signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`bazarr ${query}: HTTP ${res.status}`)
  const paths = new Set()
  for (const x of (await res.json()).data ?? []) {
    if ((x.subtitles ?? []).some((s) => s.path && s.code2 === 'en' && !s.forced)) paths.add(x.path)
  }
  return paths
}

/**
 * Drops 'subs' files that have an external English subtitle. Without Bazarr we
 * can't see those, so 'subs' files are dropped rather than guessed at.
 */
async function withoutEnglishSubs(files, bazarr, query) {
  if (!files.some((f) => f.reason === 'subs')) return files
  let have
  try {
    if (!bazarr?.enabled) throw new Error('not enabled')
    have = await bazarrEnglishSubs(bazarr, query)
  } catch {
    return files.filter((f) => f.reason !== 'subs')
  }
  return files.filter((f) => f.reason !== 'subs' || !have.has(f.path))
}

// Release names that mean a non-English multi-audio/subbed release, which is how
// the 'subs' files got here. Replacing one of those skips releases like it.
const FOREIGN_SUBBED = /\b(multi|french|truefrench|vostfr|subfrench|vff|vf2?|german|ger|ita|spa|esp|latino|castellano|nordic)\b/i

const arr = (svc) => {
  const base = svc.url.replace(/\/$/, '')
  return async (path, { method = 'GET', body, timeout = 30_000 } = {}) => {
    const res = await fetch(`${base}/api/v3${path}`, {
      method,
      headers: { 'X-Api-Key': svc.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }
}

async function mapLimit(items, limit, fn) {
  const out = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

function loadIgnore() {
  try { return JSON.parse(readFileSync(IGNORE_PATH, 'utf8')) } catch { return {} }
}
function saveIgnore(ignore) {
  mkdirSync(dirname(IGNORE_PATH), { recursive: true })
  writeFileSync(IGNORE_PATH, JSON.stringify(ignore, null, 2))
}
function record(entry) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n')
  } catch (err) {
    addLog('warn', `[language] couldn't write ${LOG_PATH}: ${err.message}`, { service: 'system' })
  }
}

// One row per series season or movie: { key, app, ... }.
async function scanSonarr(svc, bazarr) {
  const call = arr(svc)
  const series = await call('/series')
  const groups = await mapLimit(series, 6, async (s) => {
    const files = await call(`/episodefile?seriesId=${s.id}`).catch(() => [])
    const flagged = files
      .map((f) => ({ ...f, reason: wrongLanguage(f.mediaInfo, s.originalLanguage?.name) }))
      .filter((f) => f.reason)
    const bySeason = new Map()
    for (const f of await withoutEnglishSubs(flagged, bazarr, `episodes?seriesid[]=${s.id}`)) {
      // A season with both kinds is listed once per kind, since they replace differently.
      const k = `${f.seasonNumber}:${f.reason}`
      const g = bySeason.get(k) ?? { season: f.seasonNumber, reason: f.reason, files: [], audio: new Set() }
      g.files.push(f)
      g.audio.add(f.mediaInfo.audioLanguages)
      bySeason.set(k, g)
    }
    return [...bySeason.values()].map(({ season, reason, ...g }) => ({
      reason,
      key: `sonarr:${s.id}:${season}${reason === 'subs' ? ':subs' : ''}`,
      ignoreKey: `sonarr:${s.id}`,
      app: 'sonarr',
      seriesId: s.id,
      seasonNumber: season,
      title: s.title,
      originalLanguage: s.originalLanguage.name,
      audio: [...g.audio],
      fileCount: g.files.length,
      fileIds: g.files.map((f) => f.id),
      sample: g.files[0].sceneName || g.files[0].relativePath,
      size: g.files.reduce((n, f) => n + (f.size || 0), 0),
    }))
  })
  return groups.flat()
}

async function scanRadarr(svc, bazarr) {
  const movies = await arr(svc)('/movie', { timeout: 60_000 })
  const flagged = movies
    .filter((m) => m.movieFile)
    .map((m) => ({ ...m, reason: wrongLanguage(m.movieFile.mediaInfo, m.originalLanguage?.name), path: m.movieFile.path }))
    .filter((m) => m.reason)
  const subs = flagged.filter((m) => m.reason === 'subs')
  const kept = new Set(subs.length
    ? (await withoutEnglishSubs(subs, bazarr, `movies?${subs.map((m) => `radarrid[]=${m.id}`).join('&')}`)).map((m) => m.id)
    : [])
  return flagged
    .filter((m) => m.reason === 'audio' || kept.has(m.id))
    .map((m) => ({
      reason: m.reason,
      key: `radarr:${m.id}`,
      ignoreKey: `radarr:${m.id}`,
      app: 'radarr',
      movieId: m.id,
      title: `${m.title}${m.year ? ` (${m.year})` : ''}`,
      originalLanguage: m.originalLanguage.name,
      audio: [m.movieFile.mediaInfo.audioLanguages],
      fileCount: 1,
      fileIds: [m.movieFile.id],
      sample: m.movieFile.sceneName || m.movieFile.relativePath,
      size: m.movieFile.size || 0,
    }))
}

let cache = null  // { at, items, errors }
let scanning = null

async function scan(force = false) {
  if (!force && cache && Date.now() - cache.at < SCAN_TTL_MS) return cache
  if (scanning) return scanning
  scanning = (async () => {
    const { sonarr, radarr, bazarr } = (await getConfig()).services
    const [s, r] = await Promise.allSettled([
      sonarr?.enabled ? scanSonarr(sonarr, bazarr) : [],
      radarr?.enabled ? scanRadarr(radarr, bazarr) : [],
    ])
    const errors = [s, r].filter((x) => x.status === 'rejected').map((x) => x.reason.message)
    const items = [...(s.value ?? []), ...(r.value ?? [])].sort((a, b) => a.title.localeCompare(b.title) || (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0))
    cache = { at: Date.now(), items, errors }
    return cache
  })().finally(() => { scanning = null })
  return scanning
}

/** Releases the profile would accept once the current file is gone. */
async function acceptableReleases(call, item) {
  const query = item.app === 'sonarr' ? `seriesId=${item.seriesId}&seasonNumber=${item.seasonNumber}` : `movieId=${item.movieId}`
  const releases = await call(`/release?${query}`, { timeout: RELEASE_TIMEOUT_MS })
  return releases
    .filter((r) => (r.customFormatScore ?? 0) >= 0)
    .filter((r) => item.reason !== 'subs' || !FOREIGN_SUBBED.test(r.title ?? ''))
    .filter((r) => (r.rejections ?? []).every((x) => UPGRADE_ONLY.test(typeof x === 'string' ? x : x.reason ?? '')))
    .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0))
}

async function replace(item) {
  const svc = (await getConfig()).services[item.app]
  if (!svc?.enabled) throw Object.assign(new Error(`${item.app} not enabled`), { status: 400 })
  const call = arr(svc)
  const options = await acceptableReleases(call, item)
  const label = item.app === 'sonarr' ? `${item.title} S${item.seasonNumber}` : item.title
  if (!options.length) {
    const what = item.reason === 'subs' ? 'other' : item.originalLanguage
    addLog('info', `[language] ${label}: no ${what} release found, kept the files`, { service: item.app })
    return { replaced: false, message: `No ${what} release found, files kept` }
  }
  if (item.app === 'sonarr') {
    const episodes = await call(`/episode?seriesId=${item.seriesId}&seasonNumber=${item.seasonNumber}`)
    const fileIds = new Set(item.fileIds)
    const episodeIds = episodes.filter((e) => fileIds.has(e.episodeFileId)).map((e) => e.id)
    await call('/episodefile/bulk', { method: 'DELETE', body: { episodeFileIds: item.fileIds } })
    await call('/command', { method: 'POST', body: { name: 'EpisodeSearch', episodeIds } })
  } else {
    await call(`/moviefile/${item.fileIds[0]}`, { method: 'DELETE' })
    await call('/command', { method: 'POST', body: { name: 'MoviesSearch', movieIds: [item.movieId] } })
  }
  record({ app: item.app, title: label, files: item.fileCount, audio: item.audio, removed: item.sample, options: options.length, example: options[0].title })
  // The re-downloads are old episodes; keep them off Plex's Recently Added (server/plexAddedAt.js).
  trackReplacement(item.app === 'sonarr'
    ? { app: 'sonarr', seriesId: item.seriesId, seasonNumber: item.seasonNumber, title: label }
    : { app: 'radarr', movieId: item.movieId, title: label })
  addLog('info', `[language] ${label}: deleted ${item.fileCount} file(s) with ${item.audio.join(', ')} audio and searched (${options.length} ${item.originalLanguage} releases available)`, { service: item.app })
  cache.items = cache.items.filter((i) => i.key !== item.key)
  return { replaced: true, message: `Replacing ${item.fileCount} file${item.fileCount === 1 ? '' : 's'}, e.g. ${options[0].title}` }
}

export default async function languageRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async (request) => {
    const { items, errors, at } = await scan(request.query.refresh === '1')
    const ignore = loadIgnore()
    return {
      scannedAt: at,
      errors,
      items: items.filter((i) => !ignore[i.ignoreKey]).map(({ fileIds, ...i }) => i),
      ignored: Object.entries(ignore).map(([key, title]) => ({ key, title })),
    }
  })

  // Body: { key } from the list. The item is looked up server-side, so only
  // files the scan found can be deleted.
  fastify.post('/replace', async (request, reply) => {
    const { items } = await scan()
    const item = items.find((i) => i.key === request.body?.key)
    if (!item) return reply.status(404).send({ error: 'Not in the current scan; refresh the list' })
    try {
      return await replace(item)
    } catch (err) {
      addLog('error', `[language] replace ${item.title}: ${err.message}`, { service: item.app })
      return reply.status(err.status ?? 502).send({ error: err.message })
    }
  })

  fastify.post('/ignore', async (request, reply) => {
    const { key, title } = request.body ?? {}
    if (!/^(sonarr|radarr):\d+$/.test(key ?? '')) return reply.status(400).send({ error: 'Invalid key' })
    saveIgnore({ ...loadIgnore(), [key]: String(title ?? key) })
    return { ok: true }
  })

  fastify.delete('/ignore/:key', async (request) => {
    const ignore = loadIgnore()
    delete ignore[request.params.key]
    saveIgnore(ignore)
    return { ok: true }
  })
}
