import { useQuery } from '@tanstack/react-query'
import api from '../services/api'

interface DiskInfo {
  mount: string
  label: string
  used: number
  total: number
  free: number
  percent: number
}

interface NetInfo {
  iface: string
  rx: number
  tx: number
  rxTotal: number
  txTotal: number
}

interface CpuInfo {
  percent: number
  cores: number
  user: number
  system: number
}

interface MemInfo {
  percent: number
  used: number
  total: number
  free: number
}

interface GpuInfo {
  name: string
  gpu_util: number
  mem_util: number
  mem_used: number
  mem_total: number
  temp: number
  power_draw: number
  power_limit: number
}

interface ProcessInfo {
  pid: number
  name: string
  cpu: number
  memMb: number
  gpuRelated: boolean
}

interface ServerStats {
  label: string
  host: string | null
  cpu: CpuInfo | null
  mem: MemInfo | null
  disks: DiskInfo[]
  network: NetInfo[]
  gpu: GpuInfo | null
  processList: ProcessInfo[]
}

interface ContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: number[]
}

interface SystemData {
  plexgpu: ServerStats
  arr: ServerStats
  containers: ContainerInfo[] | null
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(1)} TB`
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function formatSpeed(bps: number): string {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`
  return `${bps} B/s`
}

function GaugeBar({ percent, color = 'blue' }: { percent: number; color?: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
    purple: 'bg-purple-500',
  }
  const pct = Math.min(100, Math.max(0, percent))
  const barColor = pct >= 90 ? colorMap.red : pct >= 70 ? colorMap.yellow : colorMap[color] ?? colorMap.blue

  return (
    <div className="w-full bg-gray-800 rounded-full h-1.5 mt-1">
      <div className={`h-1.5 rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function GpuProcessBadge({ name }: { name: string }) {
  const lower = name.toLowerCase()
  if (lower.includes('plex transcode') || lower.includes('plex media')) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-300 font-medium shrink-0">Plex</span>
  }
  if (lower.includes('ffmpeg')) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 font-medium shrink-0">ffmpeg</span>
  }
  if (lower.includes('transcode') || lower.includes('nvenc') || lower.includes('cuda')) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-900/50 text-violet-300 font-medium shrink-0">GPU</span>
  }
  return null
}

function ServerCard({ server }: { server: ServerStats }) {
  if (!server.host && !server.cpu && !server.mem) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center text-gray-600 text-sm">
        No data — Glances not reachable on this host
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* CPU */}
      {server.cpu && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">CPU</h3>
            <span className="text-lg font-bold text-white tabular-nums">{server.cpu.percent}%</span>
          </div>
          <GaugeBar percent={server.cpu.percent} />
          <div className="flex gap-4 mt-2 text-xs text-gray-600">
            <span>{server.cpu.cores} cores</span>
            <span>User {server.cpu.user}%</span>
            <span>Sys {server.cpu.system}%</span>
          </div>
        </div>
      )}

      {/* RAM */}
      {server.mem && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Memory</h3>
            <span className="text-lg font-bold text-white tabular-nums">{server.mem.percent}%</span>
          </div>
          <GaugeBar percent={server.mem.percent} color="green" />
          <div className="flex gap-4 mt-2 text-xs text-gray-600">
            <span>{formatBytes(server.mem.used)} used</span>
            <span>{formatBytes(server.mem.total)} total</span>
            <span>{formatBytes(server.mem.free)} free</span>
          </div>
        </div>
      )}

      {/* GPU */}
      {server.gpu && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">GPU</h3>
            <span className="text-xs text-gray-500 truncate ml-2 max-w-[140px]">{server.gpu.name}</span>
          </div>
          <div className="space-y-2">
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-0.5">
                <span>GPU Load</span>
                <span className="text-white">{server.gpu.gpu_util.toFixed(0)}%</span>
              </div>
              <GaugeBar percent={server.gpu.gpu_util} color="purple" />
            </div>
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-0.5">
                <span>VRAM</span>
                <span className="text-white">{server.gpu.mem_used.toFixed(0)} / {server.gpu.mem_total.toFixed(0)} MB</span>
              </div>
              <GaugeBar percent={server.gpu.mem_util} color="purple" />
            </div>
            <div className="flex gap-4 text-xs text-gray-600 mt-1">
              <span>🌡 {server.gpu.temp.toFixed(0)}°C</span>
              <span>⚡ {server.gpu.power_draw.toFixed(0)}W / {server.gpu.power_limit.toFixed(0)}W</span>
            </div>

            {/* GPU process list */}
            {server.processList?.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-800">
                <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-2">
                  Active Processes
                </p>
                <div className="space-y-1">
                  {server.processList.map((p) => (
                    <div key={p.pid} className="flex items-center gap-2 text-xs">
                      <GpuProcessBadge name={p.name} />
                      <span className={`flex-1 truncate font-mono text-[11px] ${p.gpuRelated ? 'text-white' : 'text-gray-400'}`}>
                        {p.name}
                      </span>
                      <span className="tabular-nums text-gray-500 shrink-0">{p.cpu.toFixed(1)}%</span>
                      <span className="tabular-nums text-gray-600 shrink-0 hidden sm:block">{p.memMb} MB</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Disks */}
      {server.disks.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Storage</h3>
          <div className="space-y-3">
            {server.disks.map((disk, i) => (
              <div key={i}>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className="text-gray-400">{disk.label} <span className="text-gray-700">({disk.mount})</span></span>
                  <span className={`font-medium ${disk.percent >= 90 ? 'text-red-400' : disk.percent >= 70 ? 'text-yellow-400' : 'text-gray-400'}`}>
                    {disk.percent}%
                  </span>
                </div>
                <GaugeBar percent={disk.percent} />
                <div className="flex gap-3 text-xs text-gray-700 mt-0.5">
                  <span>{formatBytes(disk.used)} used</span>
                  <span>{formatBytes(disk.free)} free</span>
                  <span>{formatBytes(disk.total)} total</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Network */}
      {server.network.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Network</h3>
          <div className="space-y-2">
            {server.network.map((n, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <span className="text-xs text-gray-500 font-mono">{n.iface}</span>
                <div className="flex gap-4 text-xs tabular-nums">
                  <span className="text-green-400">↓ {formatSpeed(n.rx)}</span>
                  <span className="text-blue-400">↑ {formatSpeed(n.tx)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function System() {
  const { data, isLoading, error, dataUpdatedAt } = useQuery<SystemData>({
    queryKey: ['system'],
    queryFn: async () => (await api.get<SystemData>('/system')).data,
    refetchInterval: 15_000,
  })

  function timeAgo(ts: number) {
    const diff = Math.floor((Date.now() - ts) / 1000)
    if (diff < 5) return 'just now'
    if (diff < 60) return `${diff}s ago`
    return `${Math.floor(diff / 60)}m ago`
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">System Stats</h1>
          <p className="text-sm text-gray-500">CPU, RAM, storage, and network across both servers</p>
        </div>
        {dataUpdatedAt > 0 && (
          <span className="text-xs text-gray-600">Updated {timeAgo(dataUpdatedAt)}</span>
        )}
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[0, 1].map(i => (
            <div key={i} className="space-y-4">
              {[0, 1, 2].map(j => (
                <div key={j} className="bg-gray-900 border border-gray-800 rounded-lg h-24 animate-pulse" />
              ))}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-4 py-3 text-sm text-red-400">
          Failed to load system stats — make sure Glances is running on your servers in web mode (glances -w)
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div>
              <h2 className="section-label">{data.plexgpu.label}</h2>
              {data.plexgpu.host && (
                <p className="text-xs text-gray-600 mb-3 font-mono">{data.plexgpu.host}</p>
              )}
              <ServerCard server={data.plexgpu} />
            </div>
            <div>
              <h2 className="section-label">{data.arr.label}</h2>
              {data.arr.host && (
                <p className="text-xs text-gray-600 mb-3 font-mono">{data.arr.host}</p>
              )}
              <ServerCard server={data.arr} />
            </div>
          </div>

          {/* Docker Containers */}
          {data.containers && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="section-label mb-0">Docker Containers</h2>
                <span className="text-xs text-gray-600">
                  {data.containers.filter(c => c.state === 'running').length} running
                  {data.containers.filter(c => c.state !== 'running').length > 0 &&
                    ` · ${data.containers.filter(c => c.state !== 'running').length} stopped`}
                </span>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800">
                {data.containers.map((c) => {
                  const stateColor =
                    c.state === 'running'    ? 'bg-green-400' :
                    c.state === 'paused'     ? 'bg-yellow-400' :
                    c.state === 'restarting' ? 'bg-blue-400 animate-pulse' :
                                               'bg-red-500'
                  return (
                    <div key={c.id} className="px-4 py-2.5 flex items-center gap-3">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${stateColor}`} />
                      <div className="flex-1 min-w-0 flex items-center gap-3">
                        <span className="text-sm text-white font-medium truncate">{c.name}</span>
                        <span className="text-xs text-gray-600 truncate hidden sm:block">{c.image}</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {c.ports.length > 0 && (
                          <span className="text-xs text-gray-600 font-mono hidden md:block">
                            :{c.ports.join(' :')}
                          </span>
                        )}
                        <span className={`text-xs tabular-nums ${
                          c.state === 'running' ? 'text-gray-500' : 'text-red-400'
                        }`}>
                          {c.status}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
