import { useState, useEffect } from 'react'
import { useConfig } from '../store/config'
import { useTheme, THEMES } from '../store/theme'
import api from '../services/api'
import type { Config, ServiceName, ServiceConfig, QuickLink, NotificationsConfig } from '../types'

interface ServiceMeta {
  label: string
  category: string
  placeholder: string
  keyLabel: string
  splitCreds?: boolean
}

const SERVICE_META: Record<ServiceName, ServiceMeta> = {
  plex:        { label: 'Plex',         category: 'Media Server',     placeholder: 'http://192.168.1.x:32400', keyLabel: 'Token' },
  sonarr:      { label: 'Sonarr',       category: 'Media Management', placeholder: 'http://192.168.1.x:8989',  keyLabel: 'API Key' },
  radarr:      { label: 'Radarr',       category: 'Media Management', placeholder: 'http://192.168.1.x:7878',  keyLabel: 'API Key' },
  lidarr:      { label: 'Lidarr',       category: 'Media Management', placeholder: 'http://192.168.1.x:8686',  keyLabel: 'API Key' },
  bazarr:      { label: 'Bazarr',       category: 'Media Management', placeholder: 'http://192.168.1.x:6767',  keyLabel: 'API Key' },
  overseerr:   { label: 'Overseerr',    category: 'Requests',         placeholder: 'http://192.168.1.x:5055',  keyLabel: 'API Key' },
  prowlarr:    { label: 'Prowlarr',     category: 'Indexers',         placeholder: 'http://192.168.1.x:9696',  keyLabel: 'API Key' },
  jackett:     { label: 'Jackett',      category: 'Indexers',         placeholder: 'http://192.168.1.x:9117',  keyLabel: 'API Key' },
  qbittorrent: { label: 'qBittorrent',  category: 'Download Clients', placeholder: 'http://192.168.1.x:8080',  keyLabel: 'Username', splitCreds: true },
  nzbget:      { label: 'NZBGet',       category: 'Download Clients', placeholder: 'http://192.168.1.x:6789',  keyLabel: 'Username', splitCreds: true },
  huntarr:     { label: 'Huntarr',      category: 'Utilities',        placeholder: 'http://192.168.1.x:9705',  keyLabel: 'API Key' },
  requestrr:   { label: 'Requestrr',    category: 'Utilities',        placeholder: 'http://192.168.1.x:4545',  keyLabel: 'API Key' },
  tautulli:    { label: 'Tautulli',     category: 'Media Server',     placeholder: 'http://192.168.1.x:8181',  keyLabel: 'API Key' },
}

const CATEGORY_ORDER = [
  'Media Server',
  'Media Management',
  'Requests',
  'Download Clients',
  'Indexers',
  'Utilities',
]

const SERVICE_NAMES = Object.keys(SERVICE_META) as ServiceName[]

const EMPTY_SERVICES: Config['services'] = Object.fromEntries(
  SERVICE_NAMES.map((s) => [s, { enabled: false, url: '', apiKey: '' }])
) as Config['services']

type TestStatus = 'idle' | 'testing' | 'ok' | 'error'

export default function Settings() {
  const { config, updateConfig } = useConfig()
  const { theme, setTheme } = useTheme()
  const [services, setServices] = useState<Config['services']>(EMPTY_SERVICES)
  const [testStatus, setTestStatus] = useState<Partial<Record<ServiceName, TestStatus>>>({})
  const [testError, setTestError] = useState<Partial<Record<ServiceName, string>>>({})
  const [showKey, setShowKey] = useState<Partial<Record<ServiceName, boolean>>>({})
  const [links, setLinks] = useState<QuickLink[]>([])
  const [newLink, setNewLink] = useState<{ label: string; url: string }>({ label: '', url: '' })
  const [autoDeleteAfterImport, setAutoDeleteAfterImport] = useState(false)
  const [notifications, setNotifications] = useState<NotificationsConfig>({
    discordWebhookUrl: '', plexAddedEnabled: false, webhookSecret: '',
  })
  const [discordTestStatus, setDiscordTestStatus] = useState<TestStatus>('idle')
  const [discordTestError, setDiscordTestError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [restoreMsg, setRestoreMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [autoBackups, setAutoBackups] = useState<{ name: string; size: number; createdAt: string }[]>([])

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (config?.services) setServices(config.services)
    if (config?.links) setLinks(config.links)
    if (typeof config?.autoDeleteAfterImport === 'boolean')
      setAutoDeleteAfterImport(config.autoDeleteAfterImport)
    if (config?.notifications) setNotifications(config.notifications)
  }, [config])

  useEffect(() => {
    api.get('/config/backups').then((res) => setAutoBackups(res.data)).catch(() => {})
  }, [])

  const updateService = (name: ServiceName, field: keyof ServiceConfig, value: string | boolean) => {
    setServices((prev) => ({ ...prev, [name]: { ...prev[name], [field]: value } }))
    setTestStatus((prev) => ({ ...prev, [name]: 'idle' }))
  }

  const testConnection = async (name: ServiceName) => {
    setTestStatus((prev) => ({ ...prev, [name]: 'testing' }))
    setTestError((prev) => ({ ...prev, [name]: '' }))
    try {
      const svc = services[name]
      await api.post(`/services/${name}/test`, { url: svc.url, apiKey: svc.apiKey })
      setTestStatus((prev) => ({ ...prev, [name]: 'ok' }))
    } catch (err: unknown) {
      setTestStatus((prev) => ({ ...prev, [name]: 'error' }))
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : undefined
      setTestError((prev) => ({ ...prev, [name]: msg || 'Connection failed' }))
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      await updateConfig({ ...config!, services, links, autoDeleteAfterImport, notifications })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  const testDiscordWebhook = async () => {
    setDiscordTestStatus('testing')
    setDiscordTestError('')
    try {
      await api.post('/config/notifications/test-discord', { discordWebhookUrl: notifications.discordWebhookUrl })
      setDiscordTestStatus('ok')
    } catch (err: unknown) {
      setDiscordTestStatus('error')
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : undefined
      setDiscordTestError(msg || 'Failed to send test notification')
    }
  }

  const handleBackup = async () => {
    const res = await api.get('/config/backup', { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mediaops-config-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleRestore = async (file: File) => {
    setRestoreMsg(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      await api.post('/config/restore', parsed)
      setRestoreMsg({ type: 'ok', text: 'Config restored — reloading…' })
      setTimeout(() => window.location.reload(), 1200)
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : undefined
      setRestoreMsg({ type: 'error', text: msg || 'Invalid backup file' })
    }
  }

  const handlePasswordChange = async () => {
    setPasswordMsg(null)
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'error', text: 'Passwords do not match' })
      return
    }
    if (newPassword.length < 8) {
      setPasswordMsg({ type: 'error', text: 'Password must be at least 8 characters' })
      return
    }
    try {
      await api.put('/config/password', { currentPassword, newPassword })
      setPasswordMsg({ type: 'ok', text: 'Password changed successfully' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
          : undefined
      setPasswordMsg({ type: 'error', text: msg || 'Failed to change password' })
    }
  }

  const noServicesEnabled = !config || Object.values(services).every((s) => !s.enabled)

  const grouped = CATEGORY_ORDER.reduce<Record<string, ServiceName[]>>((acc, cat) => {
    acc[cat] = SERVICE_NAMES.filter((n) => SERVICE_META[n].category === cat)
    return acc
  }, {})

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
        </button>
      </div>

      {noServicesEnabled && (
        <div className="bg-blue-950 border border-blue-800 rounded-lg p-4 mb-6 text-blue-300 text-sm">
          Welcome — enable and configure at least one service to get started.
        </div>
      )}

      <section className="mb-8">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Appearance
        </h2>
        <div className="flex gap-3">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-all text-sm font-medium ${
                theme === t.id
                  ? 'border-blue-600 bg-blue-900/30 text-white'
                  : 'border-gray-700 bg-gray-900 text-gray-400 hover:text-white hover:border-gray-600'
              }`}
            >
              <span
                className="w-4 h-4 rounded-full shrink-0"
                style={{
                  backgroundColor: t.accent,
                  boxShadow: theme === t.id ? `0 0 8px ${t.accent}` : 'none',
                }}
              />
              {t.label}
              {theme === t.id && <span className="text-xs text-blue-400 ml-1">active</span>}
            </button>
          ))}
        </div>
      </section>

      <div className="space-y-8">
        {CATEGORY_ORDER.map((category) => (
          <section key={category}>
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              {category}
            </h2>
            <div className="space-y-3">
              {grouped[category].map((name) => (
                <ServiceCard
                  key={name}
                  name={name}
                  meta={SERVICE_META[name]}
                  config={services[name]}
                  status={testStatus[name] || 'idle'}
                  error={testError[name] || ''}
                  keyVisible={showKey[name] || false}
                  onToggle={(v) => updateService(name, 'enabled', v)}
                  onUrl={(v) => updateService(name, 'url', v)}
                  onApiKey={(v) => updateService(name, 'apiKey', v)}
                  onTest={() => testConnection(name)}
                  onToggleKey={() => setShowKey((prev) => ({ ...prev, [name]: !prev[name] }))}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Downloads */}
      <section className="mt-10 pt-8 border-t border-gray-800">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Downloads</h2>
        <p className="text-xs text-gray-600 mb-4">Behaviour after a download is imported into the library</p>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white font-medium mb-0.5">Auto-remove from qBittorrent after import</p>
            <p className="text-xs text-gray-500 leading-relaxed">
              When Sonarr or Radarr finishes importing a torrent, automatically delete it from qBittorrent
              along with its source files. Safe with all import modes — hard-links preserve the library
              copy, and copies/moves leave the file in place.
            </p>
          </div>
          <div className="shrink-0 mt-0.5">
            <Toggle enabled={autoDeleteAfterImport} onChange={setAutoDeleteAfterImport} />
          </div>
        </div>
      </section>

      {/* Notifications */}
      <section className="mt-10 pt-8 border-t border-gray-800">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Notifications</h2>
        <p className="text-xs text-gray-600 mb-4">Post to a Discord channel whenever Plex adds new media</p>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white font-medium mb-0.5">Notify on Plex library additions</p>
              <p className="text-xs text-gray-500">Requires Plex Pass — Plex calls the receiver URL below directly</p>
            </div>
            <Toggle
              enabled={notifications.plexAddedEnabled}
              onChange={(v) => setNotifications((p) => ({ ...p, plexAddedEnabled: v }))}
            />
          </div>

          {notifications.plexAddedEnabled && (
            <>
              <div className="flex gap-2">
                <input
                  type="url"
                  placeholder="https://discord.com/api/webhooks/..."
                  value={notifications.discordWebhookUrl}
                  onChange={(e) => setNotifications((p) => ({ ...p, discordWebhookUrl: e.target.value }))}
                  className="input flex-1"
                />
                <button
                  onClick={testDiscordWebhook}
                  disabled={discordTestStatus === 'testing' || !notifications.discordWebhookUrl}
                  className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
                >
                  {discordTestStatus === 'testing' ? 'Testing…' : 'Test'}
                </button>
              </div>
              {discordTestStatus === 'ok' && (
                <p className="text-green-400 text-xs">Test message sent — check your Discord channel</p>
              )}
              {discordTestStatus === 'error' && (
                <p className="text-red-400 text-xs">{discordTestError}</p>
              )}

              {notifications.webhookSecret && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">
                    Paste this into Plex → Settings → Webhooks → Add Webhook:
                  </p>
                  <code className="block text-xs bg-black/40 border border-gray-800 rounded px-2 py-1.5 text-gray-300 break-all">
                    {window.location.origin}/api/webhooks/plex/{notifications.webhookSecret}
                  </code>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Quick Links */}
      <section className="mt-10 pt-8 border-t border-gray-800">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Quick Links</h2>
        <p className="text-xs text-gray-600 mb-4">Bookmarks that appear in the sidebar under "Links"</p>
        <div className="space-y-2 mb-3">
          {links.map((link, i) => (
            <div key={i} className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
              <span className="text-sm text-white flex-1 truncate">{link.label}</span>
              <span className="text-xs text-gray-600 truncate max-w-[200px]">{link.url}</span>
              <button
                onClick={() => setLinks((prev) => prev.filter((_, j) => j !== i))}
                className="text-gray-600 hover:text-red-400 transition-colors shrink-0"
              >
                ✕
              </button>
            </div>
          ))}
          {links.length === 0 && (
            <p className="text-xs text-gray-600 py-2">No links yet</p>
          )}
        </div>
        <div className="flex gap-2 items-end">
          <div className="flex-1 space-y-2">
            <input
              type="text"
              placeholder="Label (e.g. Plex)"
              value={newLink.label}
              onChange={(e) => setNewLink((p) => ({ ...p, label: e.target.value }))}
              className="input w-full"
            />
            <input
              type="url"
              placeholder="URL (e.g. http://192.168.1.x:32400)"
              value={newLink.url}
              onChange={(e) => setNewLink((p) => ({ ...p, url: e.target.value }))}
              className="input w-full"
            />
          </div>
          <button
            onClick={() => {
              if (!newLink.label || !newLink.url) return
              setLinks((prev) => [...prev, { label: newLink.label, url: newLink.url }])
              setNewLink({ label: '', url: '' })
            }}
            disabled={!newLink.label || !newLink.url}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap h-fit"
          >
            Add
          </button>
        </div>
      </section>

      {/* Backup & Restore */}
      <section className="mt-10 pt-8 border-t border-gray-800">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Backup &amp; Restore</h2>
        <p className="text-xs text-gray-600 mb-4">Export or import the full config (service URLs, API keys, links, settings)</p>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center gap-3 flex-wrap">
          <button
            onClick={handleBackup}
            className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Download Backup
          </button>
          <label className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer">
            Restore from File…
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleRestore(f)
                e.target.value = ''
              }}
            />
          </label>
          {restoreMsg && (
            <p className={`text-xs ${restoreMsg.type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
              {restoreMsg.text}
            </p>
          )}
          <p className="text-xs text-gray-600 w-full">
            ⚠ The backup contains API keys in plain text — store it somewhere safe. Restoring overwrites the current config.
          </p>
        </div>

        {autoBackups.length > 0 && (
          <div className="mt-3 bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-2">
              Automatic weekly backups (kept on disk, last {autoBackups.length})
            </p>
            <div className="space-y-1">
              {autoBackups.map((b) => (
                <div key={b.name} className="flex items-center justify-between text-xs text-gray-500">
                  <span className="font-mono truncate">{b.name}</span>
                  <span className="shrink-0 ml-3">
                    {(b.size / 1024).toFixed(0)} KB · {new Date(b.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="mt-10 pt-8 border-t border-gray-800">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">
          Change Password
        </h2>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 max-w-sm space-y-3">
          <input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="input w-full"
          />
          <input
            type="password"
            placeholder="New password (min 8 chars)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="input w-full"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="input w-full"
          />
          {passwordMsg && (
            <p className={`text-xs ${passwordMsg.type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
              {passwordMsg.text}
            </p>
          )}
          <button
            onClick={handlePasswordChange}
            className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Change Password
          </button>
        </div>
      </section>
    </div>
  )
}

interface ServiceCardProps {
  name: ServiceName
  meta: ServiceMeta
  config: ServiceConfig
  status: TestStatus
  error: string
  keyVisible: boolean
  onToggle: (v: boolean) => void
  onUrl: (v: string) => void
  onApiKey: (v: string) => void
  onTest: () => void
  onToggleKey: () => void
}

function ServiceCard({
  meta, config, status, error, keyVisible,
  onToggle, onUrl, onApiKey, onTest, onToggleKey,
}: ServiceCardProps) {
  // For split-creds services (qBit, NZBGet), parse stored "user:password" into two fields
  const parsedUsername = meta.splitCreds ? (config.apiKey || '').split(':')[0] : ''
  const parsedPassword = meta.splitCreds ? (config.apiKey || '').split(':').slice(1).join(':') : ''

  const handleUsername = (u: string) => {
    onApiKey(u + ':' + parsedPassword)
  }
  const handlePassword = (p: string) => {
    onApiKey(parsedUsername + ':' + p)
  }

  return (
    <div
      className={`bg-gray-900 border rounded-lg p-4 transition-all ${
        config.enabled ? 'border-gray-700' : 'border-gray-800 opacity-60'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-white font-medium">{meta.label}</span>
        <Toggle enabled={config.enabled} onChange={onToggle} />
      </div>

      {config.enabled && (
        <div className="space-y-2">
          <input
            type="url"
            placeholder={meta.placeholder}
            value={config.url}
            onChange={(e) => onUrl(e.target.value)}
            className="input w-full"
          />

          {meta.splitCreds ? (
            <>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Username"
                  value={parsedUsername}
                  onChange={(e) => handleUsername(e.target.value)}
                  className="input flex-1"
                  autoComplete="off"
                />
                <div className="relative flex-1">
                  <input
                    type={keyVisible ? 'text' : 'password'}
                    placeholder="Password"
                    value={parsedPassword}
                    onChange={(e) => handlePassword(e.target.value)}
                    className="input w-full pr-12"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={onToggleKey}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
                  >
                    {keyVisible ? 'hide' : 'show'}
                  </button>
                </div>
                <button
                  onClick={onTest}
                  disabled={status === 'testing' || !config.url}
                  className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
                >
                  {status === 'testing' ? 'Testing…' : 'Test'}
                </button>
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={keyVisible ? 'text' : 'password'}
                  placeholder={meta.keyLabel}
                  value={config.apiKey}
                  onChange={(e) => onApiKey(e.target.value)}
                  className="input w-full pr-12"
                />
                <button
                  type="button"
                  onClick={onToggleKey}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
                >
                  {keyVisible ? 'hide' : 'show'}
                </button>
              </div>
              <button
                onClick={onTest}
                disabled={status === 'testing' || !config.url}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
              >
                {status === 'testing' ? 'Testing…' : 'Test'}
              </button>
            </div>
          )}

          {status === 'ok' && (
            <p className="text-green-400 text-xs">Connected successfully</p>
          )}
          {status === 'error' && (
            <p className="text-red-400 text-xs">{error}</p>
          )}
        </div>
      )}
    </div>
  )
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        enabled ? 'bg-blue-600' : 'bg-gray-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-1'
        }`}
      />
    </button>
  )
}
