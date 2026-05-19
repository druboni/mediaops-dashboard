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

function formatBytes(b) { return b }

async function getGlances(host, port = 61208) {
  const base = `http://${host}:${port}/api/3`
  const [cpu, mem, fs, net] = await Promise.allSettled([
    safeFetch(`${base}/cpu`),
    safeFetch(`${base}/mem`),
    safeFetch(`${base}/fs`),
    safeFetch(`${base}/network`),
  ])

  const cpuVal  = cpu.status  === 'fulfilled' && cpu.value.ok  ? cpu.value.data   : null
  const memVal  = mem.status  === 'fulfilled' && mem.value.ok  ? mem.value.data   : null
  const fsVal   = fs.status   === 'fulfilled' && fs.value.ok   ? fs.value.data    : []
  const netVal  = net.status  === 'fulfilled' && net.value.ok  ? net.value.data   : []

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

  const SKIP_NET = ['lo', 'docker0', 'virbr0', 'br-']
  const network = Array.isArray(netVal)
    ? netVal
        .filter(n => !SKIP_NET.some(s => n.interface_name.startsWith(s)) && (n.rx > 0 || n.tx > 0 || n.interface_name.startsWith('en') || n.interface_name.startsWith('wl')))
        .slice(0, 3)
        .map(n => ({ iface: n.interface_name, rx: n.rx, tx: n.tx, rxTotal: n.cumulative_rx, txTotal: n.cumulative_tx }))
    : []

  return {
    cpu:     cpuVal ? { percent: Math.round(cpuVal.total), cores: cpuVal.cpucore, user: Math.round(cpuVal.user), system: Math.round(cpuVal.system) } : null,
    mem:     memVal ? { percent: Math.round(memVal.percent), used: memVal.used, total: memVal.total, free: memVal.free } : null,
    disks,
    network,
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

    const [plexGlances, arrGlances, gpu] = await Promise.allSettled([
      plexHost ? getGlances(plexHost) : null,
      arrHost  ? getGlances(arrHost)  : null,
      plexHost ? getGpu(plexHost)     : null,
    ])

    return {
      plexgpu: {
        label: 'Media Server (plexgpu)',
        host: plexHost,
        ...(plexGlances.status === 'fulfilled' ? plexGlances.value : { cpu: null, mem: null, disks: [], network: [] }),
        gpu: gpu.status === 'fulfilled' ? gpu.value : null,
      },
      arr: {
        label: 'Arr Server',
        host: arrHost,
        ...(arrGlances.status === 'fulfilled' ? arrGlances.value : { cpu: null, mem: null, disks: [], network: [] }),
        gpu: null,
      },
    }
  })
}
