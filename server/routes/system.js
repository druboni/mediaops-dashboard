import http from 'http'
import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'
import { addLog } from '../logBuffer.js'

// See server/routes/health.js for the full explanation — same optional mount path.
const PLEX_MOUNT_PATH = process.env.PLEX_MOUNT_PATH || '/mnt/plex'

async function safeFetch(url, timeout = 5000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}


// GPU-relevant process name fragments — these get a highlighted badge in the UI
const GPU_PROCESS_NAMES = ['plex transcode', 'ffmpeg', 'transcode', 'nvenc', 'cuda', 'plex media server']

// Glances rewrote its REST API from /api/3 to /api/4 (different base path,
// renamed network fields) in recent versions, and older installs may still
// only serve /api/3 — detect which one a given host actually speaks rather
// than assuming, so both old and current Glances installs work.
async function detectGlancesApiVersion(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/api/4/cpu`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) return '4'
  } catch { /* fall through to v3 */ }
  return '3'
}

// Maps Glances' own native GPU plugin (available on any OS Glances runs on,
// via nvidia-ml/gpustat — no extra setup) into the same shape the custom
// getGpu() sidecar endpoint returns. Used as a fallback when a monitored
// server doesn't have its own GPU stats port configured.
function mapGlancesGpu(data) {
  const g = Array.isArray(data) ? data[0] : null
  if (!g) return null
  return {
    name: g.name ?? 'GPU',
    gpu_util: g.proc ?? 0,
    mem_util: g.mem ?? 0,
    mem_used: 0,
    mem_total: 0,
    temp: g.temperature ?? 0,
    power_draw: 0,
    power_limit: 0,
  }
}

async function getGlances(host, port = 61208, includeProcesses = false) {
  const apiVersion = await detectGlancesApiVersion(host, port)
  const base = `http://${host}:${port}/api/${apiVersion}`
  const fetches = [
    safeFetch(`${base}/cpu`),
    safeFetch(`${base}/mem`),
    safeFetch(`${base}/fs`),
    safeFetch(`${base}/network`),
    safeFetch(`${base}/gpu`),
  ]
  if (includeProcesses) fetches.push(safeFetch(`${base}/processlist`, 10_000))

  const [cpu, mem, fs, net, glancesGpu, procs] = await Promise.allSettled(fetches)

  const cpuVal   = cpu.status   === 'fulfilled' && cpu.value.ok   ? cpu.value.data   : null
  const memVal   = mem.status   === 'fulfilled' && mem.value.ok   ? mem.value.data   : null
  const fsVal    = fs.status    === 'fulfilled' && fs.value.ok    ? fs.value.data    : []
  const netVal   = net.status   === 'fulfilled' && net.value.ok   ? net.value.data   : []
  const glancesGpuVal = glancesGpu.status === 'fulfilled' && glancesGpu.value.ok ? mapGlancesGpu(glancesGpu.value.data) : null
  const procsVal = includeProcesses && procs && procs.status === 'fulfilled' && procs.value.ok
    ? procs.value.data : []

  const SKIP_FS = ['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'nsfs']
  const disks = Array.isArray(fsVal)
    ? fsVal
        .filter(f => !SKIP_FS.includes(f.device_name) && f.size > 1e8)
        .map(f => ({
          mount:   f.mnt_point,
          label:   f.mnt_point === '/' ? 'OS' : (f.mnt_point.split(/[/\\]/).filter(Boolean).pop() || f.mnt_point),
          used:    f.used,
          total:   f.size,
          free:    f.free,
          percent: Math.round(f.percent),
        }))
    : []

  // Glances doesn't surface the mergerfs /mnt/plex union mount, so synthesise it
  // by summing the underlying drives (mounted at /etc/plexmediaN).
  const plexDrives = disks.filter(d => d.mount.startsWith('/etc/plexmedia'))
  if (plexDrives.length > 0) {
    const total   = plexDrives.reduce((s, d) => s + d.total, 0)
    const used    = plexDrives.reduce((s, d) => s + d.used,  0)
    const free    = plexDrives.reduce((s, d) => s + d.free,  0)
    disks.unshift({
      mount:   PLEX_MOUNT_PATH,
      label:   'Plex Pool',
      used, total, free,
      percent: Math.round((used / total) * 100),
      pool:    true,
    })
  }

  const SKIP_NET = ['lo', 'docker0', 'virbr0', 'br-']
  // Glances v4 renamed these fields (rx/tx/cumulative_* → bytes_*_rate_per_sec/
  // bytes_*_gauge) — support both so older and current Glances installs work.
  const network = Array.isArray(netVal)
    ? netVal
        .map(n => ({
          iface:   n.interface_name,
          rx:      n.rx ?? n.bytes_recv_rate_per_sec ?? n.bytes_recv ?? 0,
          tx:      n.tx ?? n.bytes_sent_rate_per_sec ?? n.bytes_sent ?? 0,
          rxTotal: n.cumulative_rx ?? n.bytes_recv_gauge ?? 0,
          txTotal: n.cumulative_tx ?? n.bytes_sent_gauge ?? 0,
        }))
        .filter(n => !SKIP_NET.some(s => n.iface.startsWith(s))
          && (n.rx > 0 || n.tx > 0 || /^(en|wl|eth|Ethernet|Wi-Fi)/.test(n.iface)))
        .slice(0, 3)
    : []

  // Build process list — sort by CPU desc, take top 8, tag GPU-likely ones
  const processList = Array.isArray(procsVal)
    ? procsVal
        .filter((p) => (p.cpu_percent ?? 0) > 0.1 || GPU_PROCESS_NAMES.some((n) => (p.name ?? '').toLowerCase().includes(n)))
        .sort((a, b) => (b.cpu_percent ?? 0) - (a.cpu_percent ?? 0))
        .slice(0, 8)
        .map((p) => ({
          pid:        p.pid,
          name:       p.name ?? 'unknown',
          cpu:        Math.round((p.cpu_percent ?? 0) * 10) / 10,
          memMb:      Math.round((p.memory_info?.[0] ?? 0) / 1_048_576),
          gpuRelated: GPU_PROCESS_NAMES.some((n) => (p.name ?? '').toLowerCase().includes(n)),
        }))
    : []

  return {
    cpu:     cpuVal ? { percent: Math.round(cpuVal.total), cores: cpuVal.cpucore, user: Math.round(cpuVal.user), system: Math.round(cpuVal.system) } : null,
    mem:     memVal ? { percent: Math.round(memVal.percent), used: memVal.used, total: memVal.total, free: memVal.free } : null,
    disks,
    network,
    processList,
    glancesGpu: glancesGpuVal,
  }
}

function dockerApiGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath: '/var/run/docker.sock', path, headers: { Host: 'localhost' } },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(raw)) }
          catch { reject(new Error('Docker API: invalid JSON')) }
        })
      }
    )
    req.setTimeout(5000, () => { req.destroy(new Error('Docker API timeout')) })
    req.on('error', reject)
  })
}

function dockerApiPost(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path, method: 'POST', headers: { Host: 'localhost', 'Content-Length': 0 } },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve()
          let msg = `Docker API HTTP ${res.statusCode}`
          try {
            const parsed = JSON.parse(raw)
            if (parsed.message) msg = parsed.message
          } catch { /* non-JSON error body */ }
          reject(new Error(msg))
        })
      }
    )
    req.setTimeout(20000, () => { req.destroy(new Error('Docker API timeout')) })
    req.on('error', reject)
    req.end()
  })
}

function dockerApiGetRaw(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath: '/var/run/docker.sock', path, headers: { Host: 'localhost' } },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(Buffer.concat(chunks))
          reject(new Error(`Docker API HTTP ${res.statusCode}`))
        })
      }
    )
    req.setTimeout(10000, () => { req.destroy(new Error('Docker API timeout')) })
    req.on('error', reject)
  })
}

// Docker multiplexes stdout/stderr into 8-byte-header frames unless the
// container was started with a TTY, in which case the body is already plain
// text. Returns null (rather than throwing) if the buffer doesn't parse as
// framed data, so the caller can fall back to raw text.
function demuxDockerLogs(buf) {
  const lines = []
  let offset = 0
  while (offset + 8 <= buf.length) {
    const streamType = buf.readUInt8(offset)
    const size = buf.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (streamType > 2 || end > buf.length) return null
    lines.push(buf.subarray(start, end).toString('utf8'))
    offset = end
  }
  return offset === buf.length ? lines.join('') : null
}

const ANSI_RE = /\x1b\[[0-9;]*m/g

async function getDockerContainers() {
  try {
    const raw = await dockerApiGet('/containers/json?all=1')
    if (!Array.isArray(raw)) return null
    return raw
      .map((c) => ({
        id:     c.Id?.slice(0, 12) ?? '',
        name:   (c.Names?.[0] ?? '').replace(/^\//, ''),
        image:  (c.Image ?? '').replace(/^sha256:/, '').split(':')[0].split('/').pop(),
        state:  c.State  ?? 'unknown',   // 'running' | 'exited' | 'paused' | 'restarting' | ...
        status: c.Status ?? '',           // human string, e.g. "Up 3 hours"
        ports:  (c.Ports ?? [])
          .filter((p) => p.PublicPort)
          .map((p) => p.PublicPort)
          .filter((v, i, a) => a.indexOf(v) === i)  // deduplicate
          .sort((a, b) => a - b)
          .slice(0, 4),
      }))
      .sort((a, b) => {
        // running first, then alphabetical
        if (a.state === b.state) return a.name.localeCompare(b.name)
        return a.state === 'running' ? -1 : b.state === 'running' ? 1 : 0
      })
  } catch {
    return null  // socket not mounted / not available
  }
}

async function getGpu(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const d = await res.json()
    return d.error ? null : d
  } catch { return null }
}

// Same sidecar pattern as the GPU stats port — a small HTTP endpoint you run
// on the monitored server itself (see scripts/speedtest-sidecar.py) that
// actually runs the test against that server's own internet connection.
// Real speedtests take a while, hence the long timeout.
async function runSpeedtest(host, port) {
  const res = await fetch(`http://${host}:${port}/speedtest`, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`Speedtest sidecar returned HTTP ${res.status}`)
  const d = await res.json()
  if (typeof d.download !== 'number' || typeof d.upload !== 'number') {
    throw new Error('Speedtest sidecar returned an unexpected response shape')
  }
  return d
}

// Splits an image reference like "lscr.io/linuxserver/radarr:latest" or
// "portainer/portainer-ce:latest" or "alpine" into a registry API host, repo
// path, and tag — following the same "does the first segment look like a
// hostname" heuristic Docker itself uses to decide whether a ref is on Docker
// Hub (implicit, no host segment) or some other registry.
function parseImageRef(ref) {
  let rest = ref.split('@')[0] // drop any @sha256:... digest suffix
  const lastSlash = rest.lastIndexOf('/')
  const lastColon = rest.lastIndexOf(':')
  let tag = 'latest'
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1)
    rest = rest.slice(0, lastColon)
  }
  const firstSeg = rest.split('/')[0]
  const isRegistryHost = firstSeg.includes('.') || firstSeg.includes(':') || firstSeg === 'localhost'
  if (isRegistryHost) {
    return { host: firstSeg, repo: rest.slice(firstSeg.length + 1), tag }
  }
  return { host: 'registry-1.docker.io', repo: rest.includes('/') ? rest : `library/${rest}`, tag }
}

const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ')

// Discovers the registry's token endpoint from the standard 401 challenge on
// /v2/ (works for Docker Hub, ghcr.io, and mirrors like lscr.io that delegate
// to ghcr.io under the hood), then fetches the manifest digest for the tag.
async function getRemoteDigest(host, repo, tag) {
  const pingRes = await fetch(`https://${host}/v2/`, { signal: AbortSignal.timeout(8000) })
  const challenge = pingRes.headers.get('www-authenticate') || ''
  const realmMatch = challenge.match(/realm="([^"]+)"/)
  if (!realmMatch) throw new Error(`${host} does not support registry token auth discovery`)
  const serviceMatch = challenge.match(/service="([^"]+)"/)
  const tokenUrl = `${realmMatch[1]}?service=${encodeURIComponent(serviceMatch?.[1] ?? '')}&scope=${encodeURIComponent(`repository:${repo}:pull`)}`

  const tokenRes = await fetch(tokenUrl, { signal: AbortSignal.timeout(8000) })
  if (!tokenRes.ok) throw new Error(`Registry token request failed: HTTP ${tokenRes.status}`)
  const { token } = await tokenRes.json()

  const manifestRes = await fetch(`https://${host}/v2/${repo}/manifests/${tag}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    signal: AbortSignal.timeout(8000),
  })
  if (!manifestRes.ok) throw new Error(`Manifest request failed: HTTP ${manifestRes.status}`)
  const digest = manifestRes.headers.get('docker-content-digest')
  if (!digest) throw new Error('Registry did not return a content digest')
  return digest
}

export default async function systemRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async () => {
    const config = await getConfig()
    const monitored = config.monitoredServers ?? []

    const [serverResults, containers] = await Promise.allSettled([
      Promise.allSettled(
        monitored.map(async (s) => {
          const [glances, gpu] = await Promise.allSettled([
            getGlances(s.host, s.glancesPort || 61208, true),
            s.gpuPort ? getGpu(s.host, s.gpuPort) : null,
          ])
          const stats = glances.status === 'fulfilled' && glances.value
            ? glances.value
            : { cpu: null, mem: null, disks: [], network: [], processList: [], glancesGpu: null }
          // Prefer the custom GPU sidecar (richer stats: VRAM in MB, power
          // draw) when configured; otherwise fall back to whatever Glances'
          // own native GPU plugin reported, if anything.
          const customGpu = gpu.status === 'fulfilled' ? gpu.value : null
          const { glancesGpu: nativeGpu, ...restStats } = stats
          return {
            id: s.id,
            name: s.name,
            host: s.host,
            ...restStats,
            gpu: customGpu ?? nativeGpu,
            hasSpeedtest: !!s.speedtestPort,
          }
        })
      ),
      getDockerContainers(),
    ])

    return {
      servers: serverResults.status === 'fulfilled'
        ? serverResults.value.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean)
        : [],
      containers: containers.status === 'fulfilled' ? containers.value : null,
    }
  })

  fastify.post('/containers/:id/restart', async (request, reply) => {
    const { id } = request.params
    if (!/^[a-zA-Z0-9_.-]+$/.test(id)) return reply.status(400).send({ error: 'Invalid container id' })
    try {
      await dockerApiPost(`/containers/${id}/restart?t=10`)
      addLog('info', `[system] Restarted container ${id}`, { container: id })
      return { ok: true }
    } catch (err) {
      addLog('error', `[system] Failed to restart container ${id}: ${err.message}`, { container: id, error: err.message })
      return reply.status(502).send({ error: err.message })
    }
  })

  fastify.get('/containers/:id/logs', async (request, reply) => {
    const { id } = request.params
    if (!/^[a-zA-Z0-9_.-]+$/.test(id)) return reply.status(400).send({ error: 'Invalid container id' })
    const tail = Math.min(parseInt(request.query.tail) || 300, 2000)
    try {
      const buf = await dockerApiGetRaw(`/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=1`)
      const text = demuxDockerLogs(buf) ?? buf.toString('utf8')
      return { logs: text.replace(ANSI_RE, '') }
    } catch (err) {
      return reply.status(502).send({ error: err.message })
    }
  })

  fastify.get('/containers/:id/update-check', async (request, reply) => {
    const { id } = request.params
    if (!/^[a-zA-Z0-9_.-]+$/.test(id)) return reply.status(400).send({ error: 'Invalid container id' })
    try {
      const info = await dockerApiGet(`/containers/${id}/json`)
      const imageRef = info?.Config?.Image
      if (!imageRef) return reply.status(404).send({ error: 'Container not found' })

      const imgInfo = await dockerApiGet(`/images/${encodeURIComponent(info.Image)}/json`)
      const repoDigests = imgInfo?.RepoDigests ?? []
      if (repoDigests.length === 0) {
        return { updateAvailable: null, reason: 'Locally built image — nothing upstream to compare against' }
      }
      const localDigest = repoDigests[0].split('@')[1]

      const { host, repo, tag } = parseImageRef(imageRef)
      const remoteDigest = await getRemoteDigest(host, repo, tag)

      return { updateAvailable: remoteDigest !== localDigest, localDigest, remoteDigest }
    } catch (err) {
      return reply.status(502).send({ error: err.message })
    }
  })

  fastify.get('/servers/:id/speedtest', async (request, reply) => {
    const { id } = request.params
    const config = await getConfig()
    const server = (config.monitoredServers ?? []).find((s) => s.id === id)
    if (!server) return reply.status(404).send({ error: 'Unknown monitored server' })
    if (!server.speedtestPort) return reply.status(400).send({ error: 'No speedtest port configured for this server' })

    try {
      const result = await runSpeedtest(server.host, server.speedtestPort)
      addLog('info', `[system] Speedtest for ${server.name}: ${result.download.toFixed(0)}↓ / ${result.upload.toFixed(0)}↑ Mbps`, {
        server: server.name, download: result.download, upload: result.upload, ping: result.ping,
      })
      return result
    } catch (err) {
      addLog('error', `[system] Speedtest failed for ${server.name}: ${err.message}`, { server: server.name, error: err.message })
      return reply.status(502).send({ error: err.message })
    }
  })
}
