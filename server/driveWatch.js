import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { getConfig } from './routes/config.js'
import { addLog } from './logBuffer.js'
import { sendAlert } from './notify.js'

// Drive watch: when a drive dies it doesn't announce itself. The kernel drops
// it, its mount disappears, and the mergerfs pool just gets smaller, so the
// first sign is Sonarr and Radarr marking thousands of files "missing from
// disk" and re-downloading them.
//
// Every few minutes this reads each monitored server's mounted drives from
// Glances and remembers every data drive it has seen. A known drive that's
// gone while the server itself still answers is a missing drive: it raises a
// Dashboard alert and a notification, and another notification when the drive
// comes back. A drive taken out on purpose is cleared with Forget on the
// System page. Known drives live in drives.json next to config.json.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.CONFIG_PATH ? dirname(process.env.CONFIG_PATH) : join(__dirname, '../config')
const STATE_PATH = process.env.DRIVES_STATE_PATH || join(CONFIG_DIR, 'drives.json')

const CHECK_EVERY_MS = 5 * 60_000
// Missing on two checks in a row (the second comes 5 minutes after the first)
// before it counts, so one odd Glances reply can't page anyone.
const CONFIRM_MS = 4 * 60_000
// Data drives only: skips EFI and boot partitions and small system mounts.
const MIN_SIZE = 20e9
const SKIP_FS = ['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'nsfs', 'fuse.mergerfs']
const SKIP_MOUNT = /^\/(boot|snap|run|proc|sys|dev|var\/lib\/docker)(\/|$)/

function load() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { return { servers: {} } }
}

function save(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

const label = (mount) => (mount === '/' ? 'OS' : mount.split(/[/\\]/).filter(Boolean).pop() || mount)
// Binary units, like the Storage card's sizes.
export const driveSize = (bytes) => (bytes >= 2 ** 40 ? `${(bytes / 2 ** 40).toFixed(1)} TB` : `${Math.round(bytes / 2 ** 30)} GB`)
// Relative, because the container's clock is UTC and the reader's isn't.
const ago = (ms) => {
  const min = Math.round(ms / 60_000)
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'} ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`
}

// The server's data drives right now, or null when Glances didn't answer (a
// server that's down says nothing about its drives).
async function currentDrives(host, port) {
  for (const v of ['4', '3']) {
    try {
      const res = await fetch(`http://${host}:${port}/api/${v}/fs`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const fs = await res.json()
      if (!Array.isArray(fs) || fs.length === 0) return null
      return fs
        .filter((f) => f.size >= MIN_SIZE && !SKIP_FS.includes(f.fs_type) && !SKIP_FS.includes(f.device_name) && !SKIP_MOUNT.test(f.mnt_point))
        .map((f) => ({ mount: f.mnt_point, device: f.device_name, total: f.size }))
    } catch { /* try the other API version */ }
  }
  return null
}

/** One pass over every monitored server. Exported for tests and the first run. */
export async function checkDrives(now = Date.now()) {
  const config = await getConfig()
  const state = load()
  const events = []

  for (const s of config.monitoredServers ?? []) {
    if (!s.host) continue
    const drives = await currentDrives(s.host, s.glancesPort || 61208)
    if (!drives) continue
    const known = (state.servers[s.id] ??= {})
    const seen = new Set()

    for (const d of drives) {
      seen.add(d.mount)
      const k = known[d.mount]
      if (k?.notified) events.push({ type: 'back', server: s, mount: d.mount, drive: { ...k, ...d } })
      known[d.mount] = { label: label(d.mount), device: d.device, total: d.total, firstSeen: k?.firstSeen ?? now, lastSeen: now }
    }

    for (const [mount, k] of Object.entries(known)) {
      if (seen.has(mount)) continue
      k.missingSince ??= now
      if (!k.notified && now - k.missingSince >= CONFIRM_MS) {
        k.notified = true
        events.push({ type: 'missing', server: s, mount, drive: k })
      }
    }
  }
  save(state)

  for (const e of events) {
    const name = `${e.drive.label} (${e.mount}, ${driveSize(e.drive.total)})`
    if (e.type === 'missing') {
      const since = ago(now - e.drive.lastSeen)
      addLog('error', `[driveWatch] ${e.server.name}: drive ${name} is missing, last seen ${new Date(e.drive.lastSeen).toISOString()}`, { service: 'system' })
      await sendAlert(
        `Drive missing on ${e.server.name}`,
        `${name} has disappeared (last seen ${since}). If it's part of the Plex pool, files on it will look deleted: ` +
          `stop Sonarr and Radarr before they re-download everything, and check the drive.`
      )
    } else {
      addLog('info', `[driveWatch] ${e.server.name}: drive ${name} is back`, { service: 'system' })
      await sendAlert(`Drive back on ${e.server.name}`, `${name} is mounted again.`, { color: 0x22c55e })
    }
  }
  return events.map((e) => ({ type: e.type, server: e.server.id, mount: e.mount }))
}

/** Missing drives per server id, confirmed ones only, for the System page and alerts. */
export function missingDrives() {
  const out = {}
  for (const [serverId, drives] of Object.entries(load().servers ?? {})) {
    const missing = Object.entries(drives)
      .filter(([, d]) => d.notified)
      .map(([mount, d]) => ({ mount, label: d.label, total: d.total, lastSeen: d.lastSeen, missingSince: d.missingSince }))
    if (missing.length) out[serverId] = missing
  }
  return out
}

/** Stops tracking a drive that was removed on purpose. */
export function forgetDrive(serverId, mount) {
  const state = load()
  if (!state.servers?.[serverId]?.[mount]) return false
  delete state.servers[serverId][mount]
  save(state)
  addLog('info', `[driveWatch] forgot drive ${mount} on ${serverId}`, { service: 'system' })
  return true
}

export function startDriveWatch() {
  const run = () => checkDrives().catch((err) => addLog('warn', `[driveWatch] failed: ${err.message}`, { service: 'system' }))
  setTimeout(run, 60_000)
  setInterval(run, CHECK_EVERY_MS)
}
