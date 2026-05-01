import { useState, useEffect } from 'react'
import { useConfig } from '../store/config'
import api from '../services/api'
import type { Config, ServiceName, ServiceConfig } from '../types'

interface ServiceMeta {
  label: string
  category: string
  placeholder: string
  keyLabel: string
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
  qbittorrent: { label: 'qBittorrent',  category: 'Download Clients', placeholder: 'http://192.168.1.x:8080',  keyLabel: 'Password' },
  nzbget:      { label: 'NZBGet',       category: 'Download Clients', placeholder: 'http://192.168.1.x:6789',  keyLabel: 'user:password' },
  huntarr:     { label: 'Huntarr',      category: 'Utilities',        placeholder: 'http://192.168.1.x:9705',  keyLabel: 'API Key' },
  requestrr:   { label: 'Requestrr',    category: 'Utilities',        placeholder: 'http://192.168.1.x:4545',  keyLabel: 'API Key' },
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
  const [services, setServices] = useState<Config['services']>(EMPTY_SERVICES)
  const [testStatus, setTestStatus] = useState<Partial<Record<ServiceName, TestStatus>>>({})
  const [testError, setTestError] = useState<Partial<Record<ServiceName, string>>>({})
  const [showKey, setShowKey] = useState<Partial<Record<ServiceName, boolean>>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (config?.services) setServices(config.services)
  }, [config])

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
      await updateConfig({ ...config!, services })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
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
