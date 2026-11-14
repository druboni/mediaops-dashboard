import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { getConfig } from './routes/config.js'
import { addLog } from './logBuffer.js'

// Keeps replaced files out of Plex's Recently Added. When Wanted → Wrong
// Language replaces a season or movie, the new download is an old episode, but
// Plex dates it the day it arrived and puts it on everyone's home screen. This
// sweep waits for the new files to show up in Plex and sets their "date added"
// back to the air/release date (locked, so a metadata refresh keeps it). The
// season's own date follows its newest episode, which is what the Recently
// Added row sorts seasons by.
//
// Only episodes that aired before the replacement are touched, so a genuinely
// new episode of a running show still appears. An entry is dropped after
// KEEP_DAYS, by which time the downloads have long finished or failed.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CONFIG_PATH ? dirname(process.env.CONFIG_PATH) : join(__dirname, '../config')
const PENDING_PATH = join(CONFIG_DIR, 'plex-added-at-pending.json')

const CHECK_EVERY_MS = 10 * 60_000
const KEEP_DAYS = 14
const DAY = 86_400_000

function load() {
  try { return JSON.parse(readFileSync(PENDING_PATH, 'utf8')) } catch { return [] }
}
function save(list) {
  mkdirSync(dirname(PENDING_PATH), { recursive: true })
  writeFileSync(PENDING_PATH, JSON.stringify(list, null, 2))
}

/**
 * Remember a replacement. entry: { app: 'sonarr', seriesId, seasonNumber, title }
 * or { app: 'radarr', movieId, title }.
 */
export function trackReplacement(entry) {
  save([...load(), { ...entry, replacedAt: new Date().toISOString() }])
}

function plexClient(svc) {
  const base = svc.url.replace(/\/$/, '')
  const url = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${svc.apiKey}`
  return {
    async get(path) {
      const res = await fetch(url(path), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`Plex ${path}: HTTP ${res.status}`)
      return (await res.json()).MediaContainer
    },
    async setAddedAt(sectionId, type, ratingKey, epochSeconds) {
      const res = await fetch(url(`/library/sections/${sectionId}/all?type=${type}&id=${ratingKey}&addedAt.value=${epochSeconds}&addedAt.locked=1`), {
        method: 'PUT', signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`Plex edit ${ratingKey}: HTTP ${res.status}`)
    },
  }
}

const arrGet = async (svc, path) => {
  const res = await fetch(`${svc.url.replace(/\/$/, '')}/api/v3${path}`, { headers: { 'X-Api-Key': svc.apiKey }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

/** The Plex item in a section of `type` ('show'/'movie') whose guids include `guid`. */
async function findByGuid(plex, type, title, guid) {
  const sections = (await plex.get('/library/sections')).Directory.filter((d) => d.type === type)
  for (const s of sections) {
    const found = await plex.get(`/library/sections/${s.key}/search?type=${type === 'show' ? 2 : 1}&query=${encodeURIComponent(title)}&includeGuids=1`)
    const hit = (found.Metadata ?? []).find((m) => (m.Guid ?? []).some((g) => g.id === guid))
    if (hit) return { ...hit, sectionId: s.key }
  }
  return null
}

// Noon UTC on the air date, so it shows as that day in any timezone.
const airEpoch = (date) => (date ? Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000) : null)

async function fixSeason(plex, sonarr, entry, cutoff) {
  const series = await arrGet(sonarr, `/series/${entry.seriesId}`)
  const show = await findByGuid(plex, 'show', series.title, `tvdb://${series.tvdbId}`)
  if (!show) return 0
  const leaves = (await plex.get(`/library/metadata/${show.ratingKey}/allLeaves`)).Metadata ?? []
  const season = leaves.filter((e) => e.parentIndex === entry.seasonNumber)
  let fixed = 0
  for (const e of season) {
    const aired = airEpoch(e.originallyAvailableAt)
    if (e.addedAt * 1000 <= cutoff || !aired || aired * 1000 >= cutoff - DAY) continue
    await plex.setAddedAt(show.sectionId, 4, e.ratingKey, aired)
    e.addedAt = aired
    fixed++
  }
  if (fixed && season[0]?.parentRatingKey) {
    const newest = Math.max(...season.map((e) => e.addedAt))
    await plex.setAddedAt(show.sectionId, 3, season[0].parentRatingKey, newest)
  }
  return fixed
}

async function fixMovie(plex, radarr, entry, cutoff) {
  const movie = await arrGet(radarr, `/movie/${entry.movieId}`)
  const item = await findByGuid(plex, 'movie', movie.title, `tmdb://${movie.tmdbId}`)
  if (!item || item.addedAt * 1000 <= cutoff) return 0
  const released = airEpoch(item.originallyAvailableAt) ?? airEpoch(`${movie.year}-01-01`)
  if (!released) return 0
  await plex.setAddedAt(item.sectionId, 1, item.ratingKey, released)
  return 1
}

export async function fixReplacedAddedDates() {
  const pending = load()
  if (!pending.length) return
  const { plex, sonarr, radarr } = (await getConfig()).services
  if (!plex?.enabled) return
  const client = plexClient(plex)
  const keep = []
  for (const entry of pending) {
    const cutoff = Date.parse(entry.replacedAt)
    try {
      const fixed = entry.app === 'sonarr'
        ? (sonarr?.enabled ? await fixSeason(client, sonarr, entry, cutoff) : 0)
        : (radarr?.enabled ? await fixMovie(client, radarr, entry, cutoff) : 0)
      if (fixed) addLog('info', `[plex] ${entry.title}: moved ${fixed} replaced item(s) out of Recently Added`, { service: 'plex' })
    } catch (err) {
      addLog('warn', `[plex] ${entry.title}: couldn't reset the added date: ${err.message}`, { service: 'plex' })
    }
    if (Date.now() - cutoff < KEEP_DAYS * DAY) keep.push(entry)
  }
  // trackReplacement only appends, so anything past the old length was added during this run.
  save([...keep, ...load().slice(pending.length)])
}

export function startPlexAddedAtSweep() {
  const run = () => fixReplacedAddedDates().catch((err) => addLog('warn', `[plex] added-date sweep failed: ${err.message}`, { service: 'plex' }))
  setTimeout(run, 2 * 60_000)
  setInterval(run, CHECK_EVERY_MS)
}
