import { getConfig } from './routes/config.js'
import { addLog } from './logBuffer.js'
import { getQbitCookie, refreshQbitCookie } from './qbitSession.js'

// Dead-torrent replacement: a torrent nobody is sharing never finishes on its
// own. A magnet with no peers sits in "metaDL" forever, named only by its hash,
// and a torrent whose last seeder left sits at 92% the same way. Removing it
// through the *arr's queue with blocklist makes the *arr search again and pick
// a different release, which is what a person would do by hand.
//
// Runs on the server, not in the Downloads page, so it works without a browser
// open. Only the main qBittorrent is touched (never qbittorrentMam: MAM torrents
// must keep seeding), and only torrents an *arr is tracking: anything else
// isn't the *arrs' to replace.

const HOUR = 3_600_000
const CHECK_EVERY_MS = 30 * 60_000
// A run that finds more than this many dead torrents removes this many and
// leaves the rest for the next run, so a misreading can never empty the queue.
const MAX_PER_RUN = 25

const ARRS = [
  ['sonarr', 'v3'],
  ['radarr', 'v3'],
  ['lidarr', 'v1'],
]

/**
 * Why a torrent counts as dead, or null if it doesn't.
 *   no-metadata: a magnet that hasn't found a single peer in 6 hours
 *   no-seeders:  stalled, and no data received for 24 hours
 */
export function deadReason(t, now = Date.now()) {
  const added = (t.added_on || 0) * 1000
  const lastData = t.last_activity > 0 ? t.last_activity * 1000 : added
  if ((t.state === 'metaDL' || t.state === 'forcedMetaDL') && now - added > 6 * HOUR) return 'no-metadata'
  if (t.state === 'stalledDL' && now - added > 24 * HOUR && now - lastData > 24 * HOUR) return 'no-seeders'
  return null
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

async function qbitTorrents(qbit) {
  const url = qbit.url.replace(/\/$/, '')
  let cookie = await getQbitCookie(url, qbit.apiKey)
  let res = await fetch(`${url}/api/v2/torrents/info`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) })
  if (res.status === 403) {
    cookie = await refreshQbitCookie(url, qbit.apiKey)
    res = await fetch(`${url}/api/v2/torrents/info`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) })
  }
  if (!res.ok) throw new Error(`qBittorrent HTTP ${res.status}`)
  return res.json()
}

export async function replaceDeadTorrents() {
  const config = await getConfig()
  if (config.replaceDeadTorrents === false) return { skipped: 'disabled' }
  const qbit = config.services.qbittorrent
  if (!qbit?.enabled) return { skipped: 'qbittorrent not enabled' }

  // Every queue must be readable: a hash missing from a queue we couldn't read
  // would look untracked, and that's not a reason to act either way.
  const owners = new Map() // hash → { name, svc, v, record }
  for (const [name, v] of ARRS) {
    const svc = config.services[name]
    if (!svc?.enabled) continue
    for (const r of await arrQueue(svc, v)) {
      const hash = String(r.downloadId || '').toLowerCase()
      if (hash && !owners.has(hash)) owners.set(hash, { name, svc, v, record: r })
    }
  }

  const now = Date.now()
  const dead = (await qbitTorrents(qbit))
    .map((t) => ({ t, reason: deadReason(t, now), owner: owners.get(t.hash.toLowerCase()) }))
    .filter((d) => d.reason && d.owner)
    .slice(0, MAX_PER_RUN)

  let replaced = 0
  for (const { t, reason, owner } of dead) {
    const { name, svc, v, record } = owner
    const res = await fetch(
      `${svc.url.replace(/\/$/, '')}/api/${v}/queue/${record.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
      { method: 'DELETE', headers: { 'X-Api-Key': svc.apiKey }, signal: AbortSignal.timeout(30000) }
    ).catch((err) => ({ ok: false, status: err.message }))
    const label = record.title || t.name
    if (res.ok) {
      replaced += 1
      addLog('info', `[deadTorrents] replaced "${label}" (${reason === 'no-metadata' ? 'no peers, never got metadata' : 'no seeders for 24h'}); ${name} will search for another release`, { service: name })
    } else {
      addLog('warn', `[deadTorrents] couldn't remove "${label}" from ${name}: ${res.status}`, { service: name })
    }
  }
  return { replaced }
}

export function startDeadTorrentSweep() {
  const run = () => replaceDeadTorrents().catch((err) => addLog('warn', `[deadTorrents] failed: ${err.message}`, { service: 'system' }))
  // First run a few minutes after start, so a restart loop can't hammer anything.
  setTimeout(run, 5 * 60_000)
  setInterval(run, CHECK_EVERY_MS)
}
