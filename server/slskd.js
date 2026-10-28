// slskd (Soulseek client) — Soularr feeds it Lidarr's wanted albums. slskd
// tracks each file separately, grouped by the peer it comes from and that
// peer's folder; one folder is one album, so that's what we show as a download.

const ACTIVE = new Set(['InProgress', 'Initializing'])
const WAITING = new Set(['Requested', 'Queued'])
// Folder names that say nothing about the album, skipped when picking a label.
const GENERIC = /^(music|my music|albums?|eps?|singles?|discography|flac|mp3|lossless|downloads?|complete|share[sd]?|soulseek|(cd|dis[ck])\s*\d+)$/i

const headers = (key) => ({ 'X-API-Key': key })

async function getJson(url, key, path, timeout = 8000) {
  const res = await fetch(`${url}${path}`, { headers: headers(key), signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`slskd HTTP ${res.status}`)
  return res.json()
}

// "Music\Artist\Album\2011 - Title" → "Artist – 2011 - Title"
function folderLabel(directory) {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  const last = parts.pop() ?? directory
  const parent = [...parts].reverse().find((p) => !GENERIC.test(p))
  if (!parent || last.toLowerCase().includes(parent.toLowerCase())) return last
  return `${parent} – ${last}`
}

// slskd states look like "Completed, Succeeded" or "Queued, Remotely".
const stateOf = (file) => file.state.split(',')[0].trim()
const resultOf = (file) => file.state.split(',')[1]?.trim() ?? ''

function groupStatus(files) {
  if (files.some((f) => ACTIVE.has(stateOf(f)))) return 'downloading'
  if (files.some((f) => WAITING.has(stateOf(f)))) return 'queued'
  if (files.every((f) => resultOf(f) === 'Succeeded')) return 'completed'
  return 'failed'
}

/** Every slskd download, one item per peer folder, in the Downloads page's shape. */
export async function getSlskdDownloads(url, key) {
  const users = await getJson(url, key, '/api/v0/transfers/downloads')
  const items = []
  for (const user of users ?? []) {
    for (const dir of user.directories ?? []) {
      const files = dir.files ?? []
      if (!files.length) continue
      const size = files.reduce((n, f) => n + (f.size || 0), 0)
      const done = files.reduce((n, f) => n + (f.bytesTransferred || 0), 0)
      const speed = files.filter((f) => stateOf(f) === 'InProgress').reduce((n, f) => n + (f.averageSpeed || 0), 0)
      const status = groupStatus(files)
      const failedFiles = files.filter((f) => stateOf(f) === 'Completed' && resultOf(f) !== 'Succeeded').length
      const ended = files.map((f) => f.endedAt).filter(Boolean).sort().at(-1) ?? null
      items.push({
        id: `${user.username}|${dir.directory}`,
        client: 'slskd',
        name: folderLabel(dir.directory),
        category: 'soulseek',
        size,
        downloaded: done,
        progress: size > 0 ? done / size : 0,
        dlSpeed: speed,
        upSpeed: 0,
        eta: speed > 0 ? Math.round((size - done) / speed) : -1,
        status,
        rawState: `${files.length} files${failedFiles ? `, ${failedFiles} failed` : ''} from ${user.username}`,
        canDeleteFiles: false,
        endedAt: status === 'completed' || status === 'failed' ? ended : null,
        fileIds: files.map((f) => f.id),
        username: user.username,
      })
    }
  }
  return items
}

/** Health, speed and recent albums for the dashboard. */
export async function getSlskdDashboard(url, key) {
  try {
    const [app, items] = await Promise.all([
      getJson(url, key, '/api/v0/application', 5000),
      getSlskdDownloads(url, key),
    ])
    const loggedIn = !!app?.server?.isLoggedIn
    return {
      health: {
        ok: loggedIn,
        ...(app?.version?.current ? { version: app.version.current } : {}),
        ...(loggedIn ? {} : { error: `Soulseek: ${app?.server?.state || 'not connected'}` }),
      },
      dlSpeed: items.reduce((n, i) => n + i.dlSpeed, 0),
      activeCount: items.filter((i) => i.status === 'downloading' || i.status === 'queued').length,
      recentlyDownloaded: items
        .filter((i) => i.status === 'completed' && i.endedAt)
        .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
        .slice(0, 10)
        .map((i) => ({ name: i.name, date: i.endedAt, size: i.size, client: 'slskd' })),
    }
  } catch (err) {
    return { health: { ok: false, error: err.message } }
  }
}

/** Cancels every file of one folder download and removes it from slskd's list. */
export async function removeSlskdDownload(url, key, id) {
  const sep = id.indexOf('|')
  if (sep < 1) throw new Error('Invalid slskd download id')
  const username = id.slice(0, sep)
  const items = await getSlskdDownloads(url, key)
  const item = items.find((i) => i.id === id)
  if (!item) throw new Error('That download is no longer in slskd')
  for (const fileId of item.fileIds) {
    const path = `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(fileId)}`
    // A finished transfer can only be removed; an active one is cancelled first.
    for (const query of item.status === 'downloading' || item.status === 'queued' ? ['', '?remove=true'] : ['?remove=true']) {
      const res = await fetch(`${url}${path}${query}`, { method: 'DELETE', headers: headers(key), signal: AbortSignal.timeout(8000) })
      if (!res.ok && res.status !== 404) throw new Error(`slskd HTTP ${res.status}`)
    }
  }
  return item
}
