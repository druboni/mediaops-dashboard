import { Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '../services/api'
import { useConfig } from '../store/config'
import { useAuth } from '../store/auth'
import type { ServiceName, QuickLink } from '../types'

declare const __APP_VERSION__: string

type BadgeKey = 'activeDownloads' | 'pendingRequests' | 'openIssues' | 'failingIndexers'

interface NavItem {
  label: string
  path: string
  service?: ServiceName
  anyOf?: ServiceName[]
  /** Count badges this nav entry can carry — lets you tell from any page
   * whether something's actively happening without opening it. Each is only
   * shown once its count is above zero. */
  badges?: BadgeKey[]
}

interface NavSection {
  label: string
  items: NavItem[]
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Media',
    items: [
      { label: 'Calendar',     path: '/calendar',   anyOf: ['sonarr', 'radarr'] },
      { label: 'Movies',       path: '/movies',     service: 'radarr' },
      { label: 'TV Shows',     path: '/tv',         service: 'sonarr' },
      { label: 'Music',        path: '/music',      service: 'lidarr' },
      { label: 'Plex Library', path: '/plex',       service: 'plex' },
      { label: 'Subtitles',    path: '/subtitles',  service: 'bazarr' },
    ],
  },
  {
    label: 'Requests',
    items: [
      { label: 'Requests', path: '/requests', service: 'overseerr', badges: ['pendingRequests', 'openIssues'] },
    ],
  },
  {
    label: 'Downloads',
    items: [
      { label: 'Downloads', path: '/downloads', anyOf: ['qbittorrent', 'nzbget'], badges: ['activeDownloads'] },
    ],
  },
  {
    label: 'Indexers',
    items: [
      { label: 'Indexers', path: '/indexers', anyOf: ['prowlarr', 'jackett'], badges: ['failingIndexers'] },
    ],
  },
  {
    label: 'Utilities',
    items: [
      { label: 'Sonarr / Radarr / Lidarr', path: '/arr-manage', anyOf: ['sonarr', 'radarr', 'lidarr'] },
      { label: 'Wanted',    path: '/wanted',   anyOf: ['radarr', 'sonarr'] },
      { label: 'Reclaim',   path: '/reclaim',  anyOf: ['radarr', 'sonarr'] },
      { label: 'History',   path: '/history',  anyOf: ['radarr', 'sonarr', 'lidarr'] },
      { label: 'Stats',     path: '/stats',    service: 'tautulli' },
      { label: 'Hunt',      path: '/hunt',     service: 'huntarr' },
      { label: 'Activity',  path: '/activity', anyOf: ['sonarr', 'radarr', 'lidarr', 'bazarr'] },
    ],
  },
]

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const { enabledServices, config } = useConfig()
  const { logout } = useAuth()
  const location = useLocation()

  const isVisible = (item: NavItem) => {
    if (item.service) return enabledServices.includes(item.service)
    if (item.anyOf) return item.anyOf.some((s) => enabledServices.includes(s))
    return true
  }

  const isActive = (path: string) => location.pathname === path

  // Reuses the same 'dashboard' query key the Dashboard page itself polls —
  // when that page is open, this just reads its cache; when it isn't, this
  // query key still exists on every page (the sidebar is mounted everywhere),
  // so navigating around the app keeps the counts current without the sidebar
  // running its own continuous poll on top of the page's.
  const { data: dashboard } = useQuery<{
    stats?: { pendingRequests: number | null; openIssues: number | null }
    downloads?: {
      qbittorrent: { active: number } | null
      nzbget: { active: number } | null
    }
  }>({
    queryKey: ['dashboard'],
    queryFn: async () => (await api.get('/dashboard')).data,
    enabled: enabledServices.includes('overseerr') || enabledServices.includes('qbittorrent') || enabledServices.includes('nzbget'),
    staleTime: 30_000,
  })

  // Indexer failures aren't on the dashboard payload — they live on /api/health,
  // which Dashboard.tsx also queries under the same key, so this is the same
  // reuse-the-cache trick as above rather than a second independent poll.
  const { data: health } = useQuery<{ indexerStatus: unknown[] }>({
    queryKey: ['health'],
    queryFn: async () => (await api.get('/health')).data,
    enabled: enabledServices.includes('prowlarr'),
    staleTime: 60_000,
  })

  const badgeCounts: Record<BadgeKey, number> = {
    activeDownloads: (dashboard?.downloads?.qbittorrent?.active ?? 0) + (dashboard?.downloads?.nzbget?.active ?? 0),
    pendingRequests: dashboard?.stats?.pendingRequests ?? 0,
    openIssues: dashboard?.stats?.openIssues ?? 0,
    failingIndexers: health?.indexerStatus?.length ?? 0,
  }

  const BADGE_TONE: Record<BadgeKey, 'red' | 'amber' | 'blue'> = {
    activeDownloads: 'blue',   // informational — things are moving, not a problem
    pendingRequests: 'amber',  // needs a decision from you
    openIssues: 'red',         // someone reported something broken
    failingIndexers: 'red',    // an indexer stopped working
  }

  const BADGE_LABEL: Record<BadgeKey, string> = {
    activeDownloads: 'active download',
    pendingRequests: 'pending request',
    openIssues: 'open issue',
    failingIndexers: 'failing indexer',
  }

  const badgesFor = (item: NavItem): Badge[] =>
    (item.badges ?? [])
      .map((key) => ({ key, value: badgeCounts[key] }))
      .filter((b) => b.value > 0)
      .map((b) => ({
        value: b.value,
        tone: BADGE_TONE[b.key],
        title: `${b.value} ${BADGE_LABEL[b.key]}${b.value === 1 ? '' : 's'}`,
      }))

  const links: QuickLink[] = config?.links ?? []

  return (
    <aside
      className={`
        w-56 bg-gray-900 border-r border-gray-800 flex flex-col h-screen fixed left-0 top-0 z-50
        transition-transform duration-200 ease-in-out
        ${open ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0
      `}
    >
      <div className="px-4 py-5 border-b border-gray-800">
        <div className="flex items-baseline gap-2">
          <span className="text-white font-bold text-lg tracking-tight">MediaOps</span>
          <span className="text-gray-700 text-xs tabular-nums">v{__APP_VERSION__}</span>
        </div>
        <p className="text-gray-600 text-xs mt-0.5">developed by Brian</p>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        <NavLink path="/" label="Dashboard" active={isActive('/')} onNavigate={onClose} />

        {NAV_SECTIONS.map((section) => {
          const visible = section.items.filter(isVisible)
          if (!visible.length) return null
          return (
            <div key={section.label} className="mt-4">
              <p className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                {section.label}
              </p>
              {visible.map((item) => (
                <NavLink
                  key={item.path}
                  path={item.path}
                  label={item.label}
                  active={isActive(item.path)}
                  badges={badgesFor(item)}
                  onNavigate={onClose}
                />
              ))}
            </div>
          )
        })}

        {/* Custom quick links */}
        {links.length > 0 && (
          <div className="mt-4">
            <p className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">Links</p>
            {links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onClose}
                className="flex items-center px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors gap-2"
              >
                <span className="truncate">{link.label}</span>
                <span className="text-gray-700 text-xs shrink-0">↗</span>
              </a>
            ))}
          </div>
        )}
      </nav>

      <div className="border-t border-gray-800 py-2">
        <NavLink path="/search"   label="Search"   active={isActive('/search')}   onNavigate={onClose} />
        <NavLink path="/system"   label="System"   active={isActive('/system')}   onNavigate={onClose} />
        <NavLink path="/settings" label="Settings" active={isActive('/settings')} onNavigate={onClose} />
        <NavLink path="/logs"     label="Logs"     active={isActive('/logs')}     onNavigate={onClose} />

        <button
          onClick={logout}
          className="flex w-full items-center px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}

interface Badge {
  value: number
  tone: 'red' | 'amber' | 'blue'
  title: string
}

const BADGE_TONE_CLASS: Record<Badge['tone'], string> = {
  red: 'bg-red-900/70 text-red-300',
  amber: 'bg-amber-900/60 text-amber-300',
  blue: 'bg-blue-900/60 text-blue-300',
}

function NavLink({
  path, label, active, badges, onNavigate,
}: {
  path: string
  label: string
  active: boolean
  badges?: Badge[]
  onNavigate: () => void
}) {
  return (
    <Link
      to={path}
      onClick={onNavigate}
      className={`flex items-center justify-between gap-2 px-4 py-2 text-sm transition-colors ${
        active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
      }`}
    >
      <span className="truncate">{label}</span>
      {badges && badges.length > 0 && (
        <span className="flex items-center gap-1 shrink-0">
          {badges.map((b, i) => (
            <span
              key={i}
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums ${BADGE_TONE_CLASS[b.tone]}`}
              title={b.title}
            >
              {b.value}
            </span>
          ))}
        </span>
      )}
    </Link>
  )
}
