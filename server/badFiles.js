import { appendFileSync, readFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { getConfig } from './routes/config.js'
import { addLog } from './logBuffer.js'
import { getQbitCookie, refreshQbitCookie } from './qbitSession.js'

// Bad-file removal: a TV, movie or music release with a program or an archive
// inside isn't media. Fake torrents ship "Show.S01E01.1080p.mkv.exe", a
// shortcut, or a password-protected .7z that tells you to run something, and
// the *arrs can't import any of it (nothing here unpacks archives). Removing it
// through the *arr's queue with blocklist deletes its files and makes the *arr
// pick a different release.
//
// Same scope as dead-torrent replacement: the main qBittorrent only (never
// qbittorrentMam: MAM torrents must keep seeding), and only torrents an *arr is
// tracking, so nothing added by hand is touched. It looks at a torrent's file
// list, which exists as soon as it has metadata, so a bad release goes before
// it finishes downloading. Every removal is written to bad-files.jsonl next to
// config.json, which unlike app.log is never rotated away.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CONFIG_PATH ? dirname(process.env.CONFIG_PATH) : join(__dirname, '../config')
const LOG_PATH = process.env.BAD_FILES_LOG_PATH || join(CONFIG_DIR, 'bad-files.jsonl')

const CHECK_EVERY_MS = 5 * 60_000
// A run that finds more than this removes this many and leaves the rest for the
// next run, so a misreading can never empty the queue.
const MAX_PER_RUN = 10

const ARRS = [
  ['sonarr', 'v3'],
  ['radarr', 'v3'],
  ['lidarr', 'v1'],
]

export const BAD_EXTENSIONS = {
  // Programs, installers, scripts and shortcuts: never part of a media release.
  program: ['exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'lnk', 'vbs', 'vbe', 'js', 'jse',
    'wsf', 'wsh', 'ps1', 'psm1', 'hta', 'jar', 'apk', 'dll', 'reg', 'sh', 'appimage', 'dmg', 'pkg', 'deb', 'rpm'],
  // Archives: the *arrs can't import them, and in a video or music release they
  // are usually a password-locked lure.
  archive: ['7z', 'zip', 'rar', 'gz', 'tgz', 'bz2', 'xz', 'tar', 'cab', 'arj', 'ace', 'lzh'],
}
const KIND = new Map(Object.entries(BAD_EXTENSIONS).flatMap(([kind, exts]) => exts.map((e) => [e, kind])))

/** The files in a torrent's file list that make it a bad release: [{ name, kind }]. */
export function badFilesIn(files) {
  const bad = []
  for (const f of files) {
    const name = String(f.name ?? f)
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    // Split-archive parts: .r00, .r01…, .7z.001, .zip.002.
    const kind = KIND.get(ext) || (/^r\d{2}$/.test(ext) || /\.(7z|zip|rar)\.\d{3}$/i.test(name) ? 'archive' : null)
    if (kind) bad.push({ name, kind })
  }
  return bad
}

function record(entry) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
  } catch (err) {
    addLog('warn', `[badFiles] couldn't write ${LOG_PATH}: ${err.message}`, { service: 'system' })
  }
}

/** Removal log, newest first. */
export function badFileLog(limit = 200) {
  try {
    return readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean).reverse().slice(0, limit)
  } catch {
    return []
  }
}

async function arrQueue(svc, v) {
  const res = await fetch(`${svc.url.replace(/\/$/, '')}/api/${v}/queue?pageSize=1000`, {
    headers: { 'X-Api-Key': svc.apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`queue HTTP ${res.status}`)
  const json = await res.json()
  return json.records ?? json ?? []
}

async function qbitGet(qbit, path) {
  const url = qbit.url.replace(/\/$/, '')
  let cookie = await getQbitCookie(url, qbit.apiKey)
  let res = await fetch(`${url}${path}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) })
  if (res.status === 403) {
    cookie = await refreshQbitCookie(url, qbit.apiKey)
    res = await fetch(`${url}${path}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) })
  }
  if (!res.ok) throw new Error(`qBittorrent ${path} HTTP ${res.status}`)
  return res.json()
}

// Torrents already found clean. A torrent's file list never changes once it has
// metadata, so each is looked at once (until a restart).
const clean = new Set()
// Torrents whose removal failed → when; tried again after an hour, not every run.
const failed = new Map()
const RETRY_FAILED_MS = 60 * 60_000

export async function removeBadReleases() {
  const config = await getConfig()
  if (config.removeBadFiles === false) return { skipped: 'disabled' }
  const qbit = config.services.qbittorrent
  if (!qbit?.enabled) return { skipped: 'qbittorrent not enabled' }

  const owners = new Map() // hash → { name, svc, v, record }
  for (const [name, v] of ARRS) {
    const svc = config.services[name]
    if (!svc?.enabled) continue
    for (const r of await arrQueue(svc, v)) {
      const hash = String(r.downloadId || '').toLowerCase()
      if (hash && !owners.has(hash)) owners.set(hash, { name, svc, v, record: r })
    }
  }

  const torrents = await qbitGet(qbit, '/api/v2/torrents/info')
  const present = new Set(torrents.map((t) => t.hash.toLowerCase()))
  for (const h of clean) if (!present.has(h)) clean.delete(h)
  for (const h of failed.keys()) if (!present.has(h)) failed.delete(h)

  const found = []
  for (const t of torrents) {
    const hash = t.hash.toLowerCase()
    if (clean.has(hash) || !owners.has(hash)) continue
    if (failed.has(hash) && Date.now() - failed.get(hash) < RETRY_FAILED_MS) continue
    const files = await qbitGet(qbit, `/api/v2/torrents/files?hash=${hash}`).catch(() => null)
    if (!files?.length) continue // no metadata yet; look again next run
    const bad = badFilesIn(files)
    if (bad.length) found.push({ t, bad, owner: owners.get(hash) })
    else clean.add(hash)
    if (found.length >= MAX_PER_RUN) break
  }

  let removed = 0
  for (const { t, bad, owner } of found) {
    const { name, svc, v, record: item } = owner
    const res = await fetch(
      `${svc.url.replace(/\/$/, '')}/api/${v}/queue/${item.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
      { method: 'DELETE', headers: { 'X-Api-Key': svc.apiKey }, signal: AbortSignal.timeout(30000) }
    ).catch((err) => ({ ok: false, status: err.message }))
    const release = item.title || t.name
    const kinds = [...new Set(bad.map((b) => b.kind))]
    const what = kinds.map((k) => (k === 'program' ? 'a program' : 'an archive')).join(' and ')
    record({
      time: Date.now(), release, torrent: t.name, hash: t.hash.toLowerCase(), service: name,
      kinds, files: bad.slice(0, 20).map((b) => b.name), fileCount: bad.length,
      result: res.ok ? 'removed' : 'failed', error: res.ok ? undefined : String(res.status),
    })
    if (res.ok) {
      removed += 1
      failed.delete(t.hash.toLowerCase())
      addLog('warn', `[badFiles] removed "${release}": it contains ${what} (${bad[0].name}${bad.length > 1 ? ` and ${bad.length - 1} more` : ''}); ${name} blocklisted it and will search for another release`, { service: name })
    } else {
      failed.set(t.hash.toLowerCase(), Date.now())
      addLog('warn', `[badFiles] found ${what} in "${release}" but couldn't remove it through ${name}: ${res.status}`, { service: name })
    }
  }
  return { removed, found: found.length }
}

export function startBadFileSweep() {
  const run = () => removeBadReleases().catch((err) => addLog('warn', `[badFiles] failed: ${err.message}`, { service: 'system' }))
  // First run a couple of minutes after start, so a restart loop can't hammer anything.
  setTimeout(run, 2 * 60_000)
  setInterval(run, CHECK_EVERY_MS)
}
