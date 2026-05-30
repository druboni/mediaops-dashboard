import http from 'http'
import { requireAuth } from '../middleware/auth.js'
import { getConfig } from './config.js'

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

async function getGlances(host, port = 61208, includeProcesses = false) {
  const base = `http://${host}:${port}/api/3`
  const fetches = [
    safeFetch(`${base}/cpu`),
    safeFetch(`${base}/mem`),
    safeFetch(`${base}/fs`),
    safeFetch(`${base}/network`),
  ]
  if (includeProcesses) fetches.push(safeFetch(`${base}/processlist`))

  const [cpu, mem, fs, net, procs] = await Promise.allSettled(fetches)

  const cpuVal   = cpu.status   === 'fulfilled' && cpu.value.ok   ? cpu.value.data   : null
  const memVal   = mem.status   === 'fulfilled' && mem.value.ok   ? mem.value.data   : null
  const fsVal    = fs.status    === 'fulfilled' && fs.value.ok    ? fs.value.data    : []
  const netVal   = net.status   === 'fulfilled' && net.value.ok   ? net.value.data   : []
  const procsVal = includeProcesses && procs && procs.status === 'fulfilled' && procs.value.ok
    ? procs.value.data : []

  const SKIP_FS = ['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'nsfs']
  const disks = Array.isArray(fsVal)
    ? fsVal
        .filter(f => !SKIP_FS.includes(f.device_name) && f.size > 1e8)
        .map(f => ({
          mount:   f.mnt_point,
          label:   f.mnt_point === '/' ? 'OS' : f.mnt_point.split('/').pop(),
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
      mount:   '/mnt/plex',
      label:   'Plex Pool',
      used, total, free,
      percent: Math.round((used / total) * 100),
      pool:    true,
    })
  }

  const SKIP_NET = ['lo', 'docker0', 'virbr0', 'br-']
  const network = Array.isArray(netVal)
    ? netVal
        .filter(n => !SKIP_NET.some(s => n.interface_name.startsWith(s)) && (n.rx > 0 || n.tx > 0 || n.interface_name.startsWith('en') || n.interface_name.startsWith('wl')))
        .slice(0, 3)
        .map(n => ({ iface: n.interface_name, rx: n.rx, tx: n.tx, rxTotal: n.cumulative_rx, txTotal: n.cumulative_tx }))
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

async function getGpu(host) {
  try {
    const res = await fetch(`http://${host}:61209`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const d = await res.json()
    return d.error ? null : d
  } catch { return null }
}

export default async function systemRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async () => {
    const config = await getConfig()
    const svcs = config.services

    const plexUrl  = svcs.plex?.enabled ? svcs.plex.url.replace(/\/$/, '') : null
    const arrUrl   = (svcs.sonarr?.enabled ? svcs.sonarr.url : svcs.radarr?.enabled ? svcs.radarr.url : null)?.replace(/\/$/, '')

    const plexHost = plexUrl ? new URL(plexUrl).hostname : null
    const arrHost  = arrUrl  ? new URL(arrUrl).hostname  : null

    const [plexGlances, arrGlances, gpu, containers] = await Promise.allSettled([
      plexHost ? getGlances(plexHost, 61208, true) : null,  // include processes for GPU host
      arrHost  ? getGlances(arrHost)  : null,
      plexHost ? getGpu(plexHost)     : null,
      getDockerContainers(),
    ])

    const plexStats = plexGlances.status === 'fulfilled' && plexGlances.value
      ? plexGlances.value
      : { cpu: null, mem: null, disks: [], network: [], processList: [] }

    return {
      plexgpu: {
        label: 'Media Server (plexgpu)',
        host: plexHost,
        ...plexStats,
        gpu: gpu.status === 'fulfilled' ? gpu.value : null,
      },
      arr: {
        label: 'Arr Server',
        host: arrHost,
        ...(arrGlances.status === 'fulfilled' && arrGlances.value
          ? arrGlances.value
          : { cpu: null, mem: null, disks: [], network: [], processList: [] }),
        gpu: null,
      },
      containers: containers.status === 'fulfilled' ? containers.value : null,
    }
  })
}
