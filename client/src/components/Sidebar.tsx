import { Link, useLocation } from 'react-router-dom'
import { useConfig } from '../store/config'
import { useAuth } from '../store/auth'
import type { ServiceName } from '../types'

interface NavItem {
  label: string
  path: string
  service?: ServiceName
  anyOf?: ServiceName[]
}

interface NavSection {
  label: string
  items: NavItem[]
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Media',
    items: [
      { label: 'Movies',    path: '/movies',    service: 'radarr' },
      { label: 'TV Shows',  path: '/tv',         service: 'sonarr' },
      { label: 'Music',     path: '/music',      service: 'lidarr' },
      { label: 'Subtitles', path: '/subtitles',  service: 'bazarr' },
    ],
  },
  {
    label: 'Requests',
    items: [
      { label: 'Requests', path: '/requests', service: 'overseerr' },
    ],
  },
  {
    label: 'Downloads',
    items: [
      { label: 'Downloads', path: '/downloads', anyOf: ['qbittorrent', 'nzbget'] },
    ],
  },
  {
    label: 'Indexers',
    items: [
      { label: 'Indexers', path: '/indexers', anyOf: ['prowlarr', 'jackett'] },
    ],
  },
  {
    label: 'Utilities',
    items: [
      { label: 'Hunt',     path: '/hunt',     service: 'huntarr' },
      { label: 'Activity', path: '/activity', anyOf: ['sonarr', 'radarr', 'lidarr', 'bazarr'] },
    ],
  },
]

export default function Sidebar() {
  const { enabledServices } = useConfig()
  const { logout } = useAuth()
  const location = useLocation()

  const isVisible = (item: NavItem) => {
    if (item.service) return enabledServices.includes(item.service)
    if (item.anyOf) return item.anyOf.some((s) => enabledServices.includes(s))
    return true
  }

  const isActive = (path: string) => location.pathname === path

  return (
    <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col h-screen fixed left-0 top-0">
      <div className="px-4 py-5 border-b border-gray-800">
        <span className="text-white font-bold text-lg tracking-tight">MediaOps</span>
        <p className="text-gray-600 text-xs mt-0.5">developed by Brian</p>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        <NavLink path="/" label="Dashboard" active={isActive('/')} />

        {NAV_SECTIONS.map((section) => {
          const visible = section.items.filter(isVisible)
          if (!visible.length) return null
          return (
            <div key={section.label} className="mt-4">
              <p className="px-4 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                {section.label}
              </p>
              {visible.map((item) => (
                <NavLink key={item.path} path={item.path} label={item.label} active={isActive(item.path)} />
              ))}
            </div>
          )
        })}
      </nav>

      <div className="border-t border-gray-800 py-2">
        <NavLink path="/settings" label="Settings" active={isActive('/settings')} />
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

function NavLink({ path, label, active }: { path: string; label: string; active: boolean }) {
  return (
    <Link
      to={path}
      className={`flex items-center px-4 py-2 text-sm transition-colors ${
        active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
      }`}
    >
      {label}
    </Link>
  )
}
