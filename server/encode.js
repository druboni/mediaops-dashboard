import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { getConfig } from './routes/config.js'
import { addLog } from './logBuffer.js'
import { reclaimTargets } from './routes/media.js'

// GPU re-encode, driven from Reclaim. The work happens on the server that holds
// the library and the GPU, in scripts/encode-sidecar.py: it copies a file to
// fast disk, re-encodes it with hevc_nvenc, checks the result and swaps it in.
// This side picks the files (from Radarr/Sonarr), maps their paths to the
// sidecar's view of the library, queues them, and once a job has replaced a
// file tells the *arr and Plex to rescan so sizes and codecs update.
//
// The sidecar is configured per monitored server (encodePort + encodeToken),
// like the Docker sidecar. The first server with both set is the encoder.

const trim = (u) => String(u || '').replace(/\/$/, '')
const arrH = (key) => ({ 'X-Api-Key': key, 'Content-Type': 'application/json' })

// Preset CQ values: what the library's earlier batch re-encodes used.
export const CQ_PRESETS = { movie: 22, tv: 30 }
export const DEFAULT_PATH_FROM = '/data/media'
export const DEFAULT_PATH_TO = '/mnt/plex'

export function encoderServer(config) {
  return (config.monitoredServers ?? []).find((s) => s.encodePort && s.encodeToken) ?? null
}

export async function sidecar(server, path, { method = 'GET', body, timeout = 10000 } = {}) {
  const res = await fetch(`http://${server.host}:${server.encodePort}${path}`, {
    method,
    headers: { Authorization: `Bearer ${server.encodeToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!res.ok) throw new Error(data?.error || `Encoder HTTP ${res.status}`)
  return data
}

/** A path as Radarr/Sonarr see it → the same file as the encode server sees it. */
export function mapPath(arrPath, server) {
  const from = trim(server.encodePathFrom || DEFAULT_PATH_FROM)
  const to = trim(server.encodePathTo || DEFAULT_PATH_TO)
  if (arrPath === from || arrPath.startsWith(`${from}/`)) return to + arrPath.slice(from.length)
  throw new Error(`${arrPath} isn't under ${from} (set the path mapping in Settings → Monitored Servers → Encode)`)
}

const HEVC_LIKE = /^(x265|h\.?265|hevc|av1)$/i

/** Reasons a file may not shrink much, from the *arr's own media info. */
export function fileWarnings(mediaInfo, quality) {
  const w = []
  const codec = mediaInfo?.videoCodec || ''
  if (HEVC_LIKE.test(codec)) w.push(`already ${codec.toUpperCase() === 'X265' ? 'HEVC' : codec}`)
  const height = Number(String(mediaInfo?.resolution || '').split('x')[1]) || 0
  if (height > 1600 || /2160/.test(quality || '')) w.push('4K')
  if (mediaInfo?.videoDynamicRange || mediaInfo?.videoDynamicRangeType) w.push(`HDR (${mediaInfo.videoDynamicRangeType || 'HDR'}: metadata may not survive)`)
  return w
}

/**
 * Every file a Reclaim item covers: a movie's file, a whole series, or one season.
 * → [{ arrPath, path, size, label, codec, warnings, kind, episodeFileId? }]
 */
export async function filesFor(item, target, server) {
  const base = trim(target.svc.url)
  const headers = arrH(target.svc.apiKey)
  const get = async (p) => {
    const res = await fetch(`${base}${p}`, { headers, signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`${target.name} HTTP ${res.status} for ${p}`)
    return res.json()
  }

  if (target.kind === 'movie') {
    const m = await get(`/api/v3/movie/${item.arrId}`)
    const f = m.movieFile
    if (!f?.path) return []
    return [{
      arrPath: f.path, path: mapPath(f.path, server), size: f.size ?? 0,
      label: `${m.title}${m.year ? ` (${m.year})` : ''}`,
      codec: f.mediaInfo?.videoCodec ?? null,
      warnings: fileWarnings(f.mediaInfo, f.quality?.quality?.name),
      kind: 'movie',
    }]
  }

  const [series, files] = await Promise.all([
    get(`/api/v3/series/${item.arrId}`),
    get(`/api/v3/episodefile?seriesId=${item.arrId}`),
  ])
  return files
    .filter((f) => item.seasonNumber == null || f.seasonNumber === Number(item.seasonNumber))
    .sort((a, b) => a.seasonNumber - b.seasonNumber || String(a.relativePath).localeCompare(String(b.relativePath)))
    .map((f) => ({
      arrPath: f.path, path: mapPath(f.path, server), size: f.size ?? 0,
      label: `${series.title} · ${String(f.relativePath || f.path).split('/').pop()}`,
      codec: f.mediaInfo?.videoCodec ?? null,
      warnings: fileWarnings(f.mediaInfo, f.quality?.quality?.name),
      kind: 'tv',
      episodeFileId: f.id,
    }))
}

// ── After a job: rescan ─────────────────────────────────────────────────────

async function arrRescan(config, meta) {
  const target = reclaimTargets(config).find((t) => t.proxyBase === meta.proxyBase)
  if (!target) return
  const body = target.kind === 'movie'
    ? { name: 'RescanMovie', movieId: Number(meta.arrId) }
    : { name: 'RescanSeries', seriesId: Number(meta.arrId) }
  const res = await fetch(`${trim(target.svc.url)}/api/v3/command`, {
    method: 'POST', headers: arrH(target.svc.apiKey), body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`${target.name} rescan HTTP ${res.status}`)
}

// Plex runs on the encode server and sees the same paths the sidecar does, so
// the folder of the replaced file is exactly what a partial scan wants.
async function plexScan(config, filePath) {
  const plex = config.services.plex
  if (!plex?.enabled) return
  const base = trim(plex.url)
  const q = (p) => `${base}${p}${p.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(plex.apiKey)}`
  const res = await fetch(q('/library/sections'), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`Plex sections HTTP ${res.status}`)
  const sections = (await res.json())?.MediaContainer?.Directory ?? []
  const folder = filePath.slice(0, filePath.lastIndexOf('/'))
  const section = sections.find((s) => (s.Location ?? []).some((l) => folder === l.path || folder.startsWith(`${trim(l.path)}/`)))
  if (!section) return
  await fetch(q(`/library/sections/${section.key}/refresh?path=${encodeURIComponent(folder)}`), { signal: AbortSignal.timeout(10000) })
}

// ── Batches ──────────────────────────────────────────────────────────────────
// Each press of Queue is a batch: the job ids it queued, tallied as the sweep
// acks them (exactly once per job), so the panel can say what the whole run
// saved when its last job finishes.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CONFIG_PATH ? dirname(process.env.CONFIG_PATH) : join(__dirname, '../config')
const BATCHES_PATH = join(CONFIG_DIR, 'encode-batches.json')
const KEEP_BATCHES = 20

function loadBatches() {
  try { return JSON.parse(readFileSync(BATCHES_PATH, 'utf8')) } catch { return [] }
}
function saveBatches(batches) {
  mkdirSync(dirname(BATCHES_PATH), { recursive: true })
  writeFileSync(BATCHES_PATH, JSON.stringify(batches.slice(-KEEP_BATCHES), null, 2))
}

/** "Ghost Adventures", "Ghost Adventures + 2 more" — from job labels like "Show · file.mkv". */
function batchLabel(labels) {
  const titles = [...new Set(labels.map((l) => String(l).split(' · ')[0]))]
  return titles.length <= 1 ? (titles[0] ?? 'Re-encode') : `${titles[0]} + ${titles.length - 1} more`
}

export function startBatch(jobIds, labels) {
  if (!jobIds.length) return null
  const batch = {
    id: `b${Date.now().toString(36)}`,
    label: batchLabel(labels),
    queuedAt: Date.now(),
    total: jobIds.length,
    pending: jobIds,
    done: 0, skipped: 0, failed: 0, cancelled: 0,
    savedBytes: 0, originalBytes: 0,
    finishedAt: null,
    dismissed: false,
  }
  saveBatches([...loadBatches(), batch])
  return batch
}

export function publicBatches() {
  return loadBatches().slice(-5).reverse().map(({ pending, ...b }) => ({ ...b, remaining: pending.length }))
}

export function dismissBatch(id) {
  saveBatches(loadBatches().map((b) => (b.id === id ? { ...b, dismissed: true } : b)))
}

function finishBatch(b) {
  b.finishedAt = Date.now()
  const parts = [`${b.done} replaced`, b.skipped && `${b.skipped} skipped`, b.failed && `${b.failed} failed`, b.cancelled && `${b.cancelled} cancelled`].filter(Boolean)
  addLog('info', `[encode] Batch "${b.label}" finished: ${(b.savedBytes / 1e9).toFixed(1)} GB saved (${parts.join(', ')})`, { service: 'system' })
}

/** Count finished jobs into their batches; jobs gone from the sidecar entirely count as cancelled. */
function tallyBatches(finishedJobs, liveIds) {
  const batches = loadBatches()
  let changed = false
  for (const b of batches.filter((x) => !x.finishedAt)) {
    for (const j of finishedJobs.filter((x) => b.pending.includes(x.id))) {
      b[j.status] = (b[j.status] ?? 0) + 1
      if (j.status === 'done' && j.origSize && j.newSize) {
        b.savedBytes += j.origSize - j.newSize
        b.originalBytes += j.origSize
      }
      b.pending = b.pending.filter((id) => id !== j.id)
      changed = true
    }
    const gone = b.pending.filter((id) => !liveIds.has(id))
    if (gone.length) { b.cancelled += gone.length; b.pending = b.pending.filter((id) => liveIds.has(id)); changed = true }
    if (!b.pending.length) { finishBatch(b); changed = true }
  }
  if (changed) saveBatches(batches)
}

let running = false

export async function encodeSweep() {
  if (running) return
  running = true
  try {
    const config = await getConfig()
    const server = encoderServer(config)
    if (!server) return
    const { jobs } = await sidecar(server, '/jobs')
    const finished = jobs.filter((j) => !j.acked && ['done', 'skipped', 'failed', 'cancelled'].includes(j.status))
    // Before acking: a job leaves its batch's pending list when counted, so this can't double-count.
    tallyBatches(finished, new Set(jobs.map((j) => j.id)))
    const rescanned = new Set()
    for (const j of finished) {
      if (j.status === 'done') {
        const saved = (j.origSize ?? 0) - (j.newSize ?? 0)
        addLog('info', `[encode] ${j.label}: ${(j.origSize / 1e9).toFixed(1)} → ${(j.newSize / 1e9).toFixed(1)} GB (saved ${(saved / 1e9).toFixed(1)} GB)`, { service: 'system' })
        const key = `${j.meta?.proxyBase}:${j.meta?.arrId}`
        try {
          if (j.meta?.proxyBase && !rescanned.has(key)) { await arrRescan(config, j.meta); rescanned.add(key) }
          await plexScan(config, j.outPath || j.path)
        } catch (err) {
          addLog('warn', `[encode] rescan after ${j.label} failed: ${err.message}`, { service: 'system' })
        }
      } else if (j.status === 'failed') {
        addLog('warn', `[encode] ${j.label} failed: ${j.error}`, { service: 'system' })
      } else if (j.status === 'skipped') {
        addLog('info', `[encode] ${j.label} skipped: ${j.error}`, { service: 'system' })
      }
      await sidecar(server, `/jobs/${j.id}/ack`, { method: 'POST' }).catch(() => {})
    }
  } catch {
    // Encoder unreachable: try again next sweep.
  } finally {
    running = false
  }
}

export function startEncodeSweep() {
  setInterval(encodeSweep, 30_000)
  setTimeout(encodeSweep, 10_000)
}
