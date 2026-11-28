import { readFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { getConfig } from './routes/config.js'
import { addLog } from './logBuffer.js'

// Drive-failure recovery tracker. config/recovery-baseline.json is a snapshot of
// what Plex held before a drive died, taken from a Plex database backup:
//   { label, takenAt, movies: [[guid, title, year]], episodes: [[guid, show, season, episode]] }
// This compares it with live Plex and reports how much of it is back. A movie
// counts as back if Plex has its guid or the same title + year; an episode if
// Plex has its guid or the same show title + season + episode number (re-added
// shows sometimes get a new guid). Items added since the failure don't count.
//
// No baseline file means no card. Delete the file once recovery is done.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CONFIG_PATH ? dirname(process.env.CONFIG_PATH) : join(__dirname, '../config')
const BASELINE_PATH = join(CONFIG_DIR, 'recovery-baseline.json')

const REFRESH_MS = 15 * 60_000
const PAGE = 10_000

let baseline = null      // parsed file
let baselineMtime = 0
let snapshot = null      // last result
let running = null       // in-flight promise

async function loadBaseline() {
  let st
  try { st = await stat(BASELINE_PATH) } catch { baseline = null; baselineMtime = 0; return null }
  if (baseline && st.mtimeMs === baselineMtime) return baseline
  const raw = JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  baseline = raw
  baselineMtime = st.mtimeMs
  snapshot = null // new baseline, old numbers no longer apply
  return baseline
}

async function plexJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`Plex HTTP ${res.status}`)
  return res.json()
}

// All items of one type in one section, paged so a 20k-episode library isn't one giant response.
async function plexAll(base, headers, key, type) {
  const out = []
  for (let start = 0; ; start += PAGE) {
    const j = await plexJson(`${base}/library/sections/${key}/all?type=${type}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}`, headers)
    const items = j?.MediaContainer?.Metadata ?? []
    out.push(...items)
    const total = j?.MediaContainer?.totalSize ?? out.length
    if (items.length < PAGE || out.length >= total) break
  }
  return out
}

const norm = (s) => String(s ?? '').toLowerCase()

async function compute() {
  const b = await loadBaseline()
  if (!b) { snapshot = null; return null }
  const svc = (await getConfig()).services?.plex
  if (!svc?.enabled || !svc.url) return snapshot
  const base = svc.url.replace(/\/$/, '')
  const headers = { 'X-Plex-Token': svc.apiKey, Accept: 'application/json' }

  const sections = (await plexJson(`${base}/library/sections`, headers))?.MediaContainer?.Directory ?? []
  const movieGuids = new Set(), movieKeys = new Set(), epGuids = new Set(), epKeys = new Set()
  for (const s of sections) {
    if (s.type === 'movie') {
      for (const m of await plexAll(base, headers, s.key, 1)) {
        if (m.guid) movieGuids.add(m.guid)
        movieKeys.add(`${norm(m.title)}|${m.year ?? 0}`)
      }
    } else if (s.type === 'show') {
      for (const e of await plexAll(base, headers, s.key, 4)) {
        if (e.guid) epGuids.add(e.guid)
        epKeys.add(`${norm(e.grandparentTitle)}|${e.parentIndex}|${e.index}`)
      }
    }
  }

  const movies = b.movies ?? [], episodes = b.episodes ?? []
  const moviesBack = movies.filter(([g, t, y]) => movieGuids.has(g) || movieKeys.has(`${norm(t)}|${y ?? 0}`)).length
  const episodesBack = episodes.filter(([g, show, s, e]) => epGuids.has(g) || epKeys.has(`${norm(show)}|${s}|${e}`)).length
  const total = movies.length + episodes.length
  snapshot = {
    label: b.label ?? null,
    takenAt: b.takenAt ?? null,
    checkedAt: new Date().toISOString(),
    movies: { back: moviesBack, total: movies.length },
    episodes: { back: episodesBack, total: episodes.length },
    percent: total ? Math.round(((moviesBack + episodesBack) / total) * 1000) / 10 : 100,
  }
  addLog('info', `[recovery] ${snapshot.percent}% back — episodes ${episodesBack}/${episodes.length}, movies ${moviesBack}/${movies.length}`, { service: 'plex' })
  return snapshot
}

function refresh() {
  if (!running) {
    running = compute()
      .catch((err) => { addLog('warn', `[recovery] check failed: ${err.message}`, { service: 'plex' }); return snapshot })
      .finally(() => { running = null })
  }
  return running
}

// For the dashboard poll: returns the last result straight away and refreshes in
// the background when it's stale, so a slow Plex never holds up the dashboard.
// The first call after start waits for the first check (bounded) so the card
// appears on first load rather than one poll later.
export async function getRecovery() {
  try {
    const b = await loadBaseline()
    if (!b) return null
  } catch (err) {
    addLog('warn', `[recovery] can't read baseline: ${err.message}`, { service: 'plex' })
    return null
  }
  const stale = !snapshot || Date.now() - new Date(snapshot.checkedAt).getTime() > REFRESH_MS
  if (stale) {
    const p = refresh()
    if (!snapshot) await Promise.race([p, new Promise((r) => setTimeout(r, 4000))])
  }
  return snapshot
}
