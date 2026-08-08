import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

type ArrService = 'sonarr' | 'radarr' | 'lidarr'

// Sonarr/Radarr are on the v3 REST API; Lidarr is still on v1.
function apiV(service: ArrService) {
  return service === 'lidarr' ? 'v1' : 'v3'
}

// ── Types ──────────────────────────────────────────────────────────────────

interface ArrField {
  name: string
  label: string
  value?: unknown
  type: string
  advanced?: boolean
  selectOptions?: { value: number; name: string }[]
  helpText?: string
  [key: string]: unknown
}

interface ArrTag { id: number; label: string }

interface ArrMessage { message: string; type: string }

interface ArrIndexer {
  id?: number
  name: string
  enableRss: boolean
  enableAutomaticSearch: boolean
  enableInteractiveSearch: boolean
  protocol: 'usenet' | 'torrent'
  priority: number
  tags: number[]
  fields: ArrField[]
  implementation: string
  implementationName: string
  configContract: string
  infoLink?: string
  message?: ArrMessage
  [key: string]: unknown
}

interface ArrDownloadClient {
  id?: number
  name: string
  enable: boolean
  protocol: 'usenet' | 'torrent'
  priority: number
  tags: number[]
  fields: ArrField[]
  implementation: string
  implementationName: string
  configContract: string
  message?: ArrMessage
  [key: string]: unknown
}

interface ArrRootFolder {
  id?: number
  path: string
  accessible?: boolean
  freeSpace?: number
  unmappedFolders?: { name: string; path: string }[]
  [key: string]: unknown
}

interface ArrQualityItem {
  id?: number
  name?: string
  quality?: { id: number; name: string }
  items?: ArrQualityItem[]
  allowed: boolean
  [key: string]: unknown
}

interface ArrQualityProfile {
  id?: number
  name: string
  upgradeAllowed: boolean
  cutoff: number
  items: ArrQualityItem[]
  [key: string]: unknown
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail'

// ── Helpers ────────────────────────────────────────────────────────────────

function extractError(err: unknown): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const data = (err as { response?: { data?: unknown } }).response?.data
    if (Array.isArray(data) && data.length) {
      return data.map((d) => (d as { errorMessage?: string; message?: string }).errorMessage
        || (d as { errorMessage?: string; message?: string }).message).filter(Boolean).join('; ') || 'Request failed'
    }
    if (data && typeof data === 'object') {
      const d = data as { message?: string; error?: string }
      if (d.message) return d.message
      if (d.error) return d.error
    }
  }
  return err instanceof Error ? err.message : 'Request failed'
}

function formatBytes(b: number) {
  if (b >= 1_099_511_627_776) return `${(b / 1_099_511_627_776).toFixed(1)} TB`
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${b} B`
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

function FieldInput({ field, onChange }: { field: ArrField; onChange: (value: unknown) => void }) {
  const label = (
    <label className="block text-xs text-gray-400 mb-1">
      {field.label}
      {field.helpText && <span className="text-gray-600 ml-1" title={field.helpText}>ⓘ</span>}
    </label>
  )

  if (field.type === 'checkbox') {
    return (
      <div className="flex items-center justify-between py-1">
        <span className="text-xs text-gray-400">{field.label}</span>
        <Toggle enabled={!!field.value} onChange={onChange} />
      </div>
    )
  }

  if (field.type === 'select' && Array.isArray(field.selectOptions)) {
    return (
      <div>
        {label}
        <select
          className="input w-full"
          value={String(field.value ?? '')}
          onChange={(e) => {
            const raw = e.target.value
            onChange(Number.isNaN(Number(raw)) || raw === '' ? raw : Number(raw))
          }}
        >
          {field.selectOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.name}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.type === 'tagSelect' && Array.isArray(field.selectOptions)) {
    const selected = Array.isArray(field.value) ? (field.value as unknown[]).map(String) : []
    return (
      <div>
        {label}
        <select
          multiple
          className="input w-full h-24"
          value={selected}
          onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => Number(o.value)))}
        >
          {field.selectOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.name}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.type === 'number') {
    return (
      <div>
        {label}
        <input
          type="number"
          className="input w-full"
          value={(field.value as number) ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      </div>
    )
  }

  if (['textbox', 'url', 'path', 'filePath', 'password', 'text'].includes(field.type)) {
    return (
      <div>
        {label}
        <input
          type={field.type === 'password' ? 'password' : 'text'}
          className="input w-full"
          value={(field.value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  }

  // Unsupported field type (e.g. seedCriteria, oAuth) — left as-is so it round-trips unchanged on save
  return (
    <div>
      {label}
      <p className="text-xs text-gray-600 italic">Not editable here — configure this field in the arr app directly</p>
    </div>
  )
}

function TagMultiSelect({ tags, selected, onChange }: { tags: ArrTag[]; selected: number[]; onChange: (ids: number[]) => void }) {
  if (!tags.length) return null
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">Tags</label>
      <select
        multiple
        className="input w-full h-20"
        value={selected.map(String)}
        onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => Number(o.value)))}
      >
        {tags.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>
    </div>
  )
}

// ── Schema picker (choose implementation when adding new) ───────────────────

function SchemaPicker({
  title, schemas, onPick, onClose,
}: {
  title: string
  schemas: { implementationName: string }[]
  onPick: (index: number) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const filtered = schemas
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.implementationName.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h3 className="text-white font-semibold">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>
        <div className="px-5 py-3 border-b border-gray-800 shrink-0">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search type…"
            className="input w-full"
          />
        </div>
        <div className="overflow-y-auto py-1">
          {filtered.length === 0 && <p className="text-gray-600 text-sm text-center py-6">No matches</p>}
          {filtered.map(({ s, i }) => (
            <button
              key={i}
              onClick={() => onPick(i)}
              className="w-full text-left px-5 py-2.5 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
            >
              {s.implementationName}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Indexer modal (add / edit) ───────────────────────────────────────────────

function IndexerModal({
  service, tags, initial, onClose, onSaved,
}: {
  service: ArrService
  tags: ArrTag[]
  initial: ArrIndexer
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<ArrIndexer>(initial)
  const base = `/proxy/${service}/api/${apiV(service)}/indexer`

  const save = useMutation({
    mutationFn: (item: ArrIndexer) => (item.id ? api.put(`${base}/${item.id}`, item) : api.post(base, item)),
    onSuccess: onSaved,
  })

  const updateField = (name: string, value: unknown) => {
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.name === name ? { ...f, value } : f)) }))
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h3 className="text-white font-semibold">{draft.id ? 'Edit Indexer' : `Add Indexer — ${draft.implementationName}`}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              className="input w-full"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-xs text-gray-400 mb-1">Priority</label>
              <input
                type="number"
                className="input w-full"
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: Number(e.target.value) }))}
              />
            </div>
          </div>
          <div className="flex items-center gap-5 py-1">
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <Toggle enabled={draft.enableRss} onChange={(v) => setDraft((d) => ({ ...d, enableRss: v }))} /> RSS
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <Toggle enabled={draft.enableAutomaticSearch} onChange={(v) => setDraft((d) => ({ ...d, enableAutomaticSearch: v }))} /> Automatic Search
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <Toggle enabled={draft.enableInteractiveSearch} onChange={(v) => setDraft((d) => ({ ...d, enableInteractiveSearch: v }))} /> Interactive Search
            </label>
          </div>
          <TagMultiSelect tags={tags} selected={draft.tags ?? []} onChange={(ids) => setDraft((d) => ({ ...d, tags: ids }))} />
          <div className="border-t border-gray-800 pt-3 space-y-3">
            {draft.fields.map((f) => (
              <FieldInput key={f.name} field={f} onChange={(v) => updateField(f.name, v)} />
            ))}
          </div>
          {save.isError && <p className="text-red-400 text-xs">{extractError(save.error)}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800 shrink-0">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors">Cancel</button>
          <button
            onClick={() => save.mutate(draft)}
            disabled={save.isPending}
            className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Download client modal (add / edit) ───────────────────────────────────────

function DownloadClientModal({
  service, tags, initial, onClose, onSaved,
}: {
  service: ArrService
  tags: ArrTag[]
  initial: ArrDownloadClient
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<ArrDownloadClient>(initial)
  const base = `/proxy/${service}/api/${apiV(service)}/downloadclient`

  const save = useMutation({
    mutationFn: (item: ArrDownloadClient) => (item.id ? api.put(`${base}/${item.id}`, item) : api.post(base, item)),
    onSuccess: onSaved,
  })

  const updateField = (name: string, value: unknown) => {
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.name === name ? { ...f, value } : f)) }))
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h3 className="text-white font-semibold">{draft.id ? 'Edit Download Client' : `Add Download Client — ${draft.implementationName}`}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              className="input w-full"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-xs text-gray-400 mb-1">Priority</label>
              <input
                type="number"
                className="input w-full"
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: Number(e.target.value) }))}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-400 pt-4">
              <Toggle enabled={draft.enable} onChange={(v) => setDraft((d) => ({ ...d, enable: v }))} /> Enabled
            </label>
          </div>
          <TagMultiSelect tags={tags} selected={draft.tags ?? []} onChange={(ids) => setDraft((d) => ({ ...d, tags: ids }))} />
          <div className="border-t border-gray-800 pt-3 space-y-3">
            {draft.fields.map((f) => (
              <FieldInput key={f.name} field={f} onChange={(v) => updateField(f.name, v)} />
            ))}
          </div>
          {save.isError && <p className="text-red-400 text-xs">{extractError(save.error)}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800 shrink-0">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors">Cancel</button>
          <button
            onClick={() => save.mutate(draft)}
            disabled={save.isPending}
            className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Indexer section ──────────────────────────────────────────────────────────

function ArrIndexerSection({ service }: { service: ArrService }) {
  const queryClient = useQueryClient()
  const base = `/proxy/${service}/api/${apiV(service)}/indexer`
  const [editing, setEditing] = useState<ArrIndexer | null>(null)
  const [pickingSchema, setPickingSchema] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)
  const [testStates, setTestStates] = useState<Record<number, TestState>>({})
  const [testAllState, setTestAllState] = useState<'idle' | 'testing' | 'done'>('idle')

  const { data: indexers, isLoading } = useQuery<ArrIndexer[]>({
    queryKey: [service, 'indexers'],
    queryFn: async () => (await api.get(base)).data,
    staleTime: 30_000,
  })

  const { data: tags } = useQuery<ArrTag[]>({
    queryKey: [service, 'tags'],
    queryFn: async () => (await api.get(`/proxy/${service}/api/${apiV(service)}/tag`)).data,
    staleTime: 60_000,
  })

  const { data: schemas } = useQuery<ArrIndexer[]>({
    queryKey: [service, 'indexer-schema'],
    queryFn: async () => (await api.get(`${base}/schema`)).data,
    staleTime: 300_000,
    enabled: pickingSchema,
  })

  const toggleFlag = useMutation({
    mutationFn: (indexer: ArrIndexer) => api.put(`${base}/${indexer.id}`, indexer),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [service, 'indexers'] }),
  })

  const deleteIndexer = useMutation({
    mutationFn: (id: number) => api.delete(`${base}/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [service, 'indexers'] })
      setDeleteTarget(null)
    },
  })

  const testOne = async (idx: ArrIndexer) => {
    setTestStates((s) => ({ ...s, [idx.id!]: 'testing' }))
    try {
      await api.post(`${base}/test`, idx)
      setTestStates((s) => ({ ...s, [idx.id!]: 'ok' }))
    } catch {
      setTestStates((s) => ({ ...s, [idx.id!]: 'fail' }))
    }
  }

  const testAll = async () => {
    setTestAllState('testing')
    try {
      await api.post(`${base}/testall`)
      setTestAllState('done')
      setTimeout(() => setTestAllState('idle'), 3000)
    } catch {
      setTestAllState('idle')
    }
  }

  const closeAndRefresh = () => {
    setEditing(null)
    queryClient.invalidateQueries({ queryKey: [service, 'indexers'] })
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setPickingSchema(true)}
          className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          + Add Indexer
        </button>
        <button
          onClick={testAll}
          disabled={testAllState === 'testing'}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
        >
          {testAllState === 'testing' ? 'Testing…' : testAllState === 'done' ? '✓ Done' : 'Test All'}
        </button>
        {indexers && <span className="text-xs text-gray-600 ml-1">{indexers.length} indexers</span>}
      </div>

      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(4)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : !indexers?.length ? (
        <p className="text-gray-600 text-sm py-8 text-center">No indexers configured</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Flags</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Priority</th>
                <th className="px-4 py-2.5 w-48" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {indexers.map((idx) => {
                const testState = testStates[idx.id!] ?? 'idle'
                return (
                  <tr key={idx.id} className="hover:bg-gray-800/20 transition-colors group">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                          idx.protocol === 'torrent' ? 'bg-blue-900/60 text-blue-300' : 'bg-green-900/60 text-green-300'
                        }`}>
                          {idx.protocol === 'torrent' ? 'TRK' : 'NZB'}
                        </span>
                        <span className="text-sm text-white truncate">{idx.name}</span>
                        {idx.message && (
                          <span className="text-orange-400 text-xs" title={idx.message.message}>⚠</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleFlag.mutate({ ...idx, enableRss: !idx.enableRss })}
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${idx.enableRss ? 'bg-green-900/60 text-green-300' : 'bg-gray-800 text-gray-600'}`}
                          title="Toggle RSS"
                        >RSS</button>
                        <button
                          onClick={() => toggleFlag.mutate({ ...idx, enableAutomaticSearch: !idx.enableAutomaticSearch })}
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${idx.enableAutomaticSearch ? 'bg-green-900/60 text-green-300' : 'bg-gray-800 text-gray-600'}`}
                          title="Toggle Automatic Search"
                        >Auto</button>
                        <button
                          onClick={() => toggleFlag.mutate({ ...idx, enableInteractiveSearch: !idx.enableInteractiveSearch })}
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${idx.enableInteractiveSearch ? 'bg-green-900/60 text-green-300' : 'bg-gray-800 text-gray-600'}`}
                          title="Toggle Interactive Search"
                        >Int</button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 hidden sm:table-cell">{idx.priority}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        {testState === 'ok' && <span className="text-green-400 text-xs">✓</span>}
                        {testState === 'fail' && <span className="text-red-400 text-xs">✗</span>}
                        <button
                          onClick={() => testOne(idx)}
                          disabled={testState === 'testing'}
                          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                        >
                          {testState === 'testing' ? '…' : 'Test'}
                        </button>
                        <button
                          onClick={() => setEditing(idx)}
                          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
                        >
                          Edit
                        </button>
                        {deleteTarget === idx.id ? (
                          <>
                            <button onClick={() => deleteIndexer.mutate(idx.id!)} className="text-xs px-2 py-1 rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Confirm</button>
                            <button onClick={() => setDeleteTarget(null)} className="text-xs px-1.5 py-1 rounded bg-gray-700 text-gray-400 hover:text-white transition-colors">✕</button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeleteTarget(idx.id!)}
                            className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-red-800 text-gray-500 hover:text-red-300 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {pickingSchema && !schemas && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl px-6 py-4 text-sm text-gray-400">Loading types…</div>
        </div>
      )}
      {pickingSchema && schemas && (
        <SchemaPicker
          title="Choose Indexer Type"
          schemas={schemas}
          onClose={() => setPickingSchema(false)}
          onPick={(i) => {
            const schema = schemas[i]
            setEditing({ ...schema, tags: [], priority: 25 })
            setPickingSchema(false)
          }}
        />
      )}
      {editing && (
        <IndexerModal
          service={service}
          tags={tags ?? []}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={closeAndRefresh}
        />
      )}
    </div>
  )
}

// ── Download client section ─────────────────────────────────────────────────

function ArrDownloadClientSection({ service }: { service: ArrService }) {
  const queryClient = useQueryClient()
  const base = `/proxy/${service}/api/${apiV(service)}/downloadclient`
  const [editing, setEditing] = useState<ArrDownloadClient | null>(null)
  const [pickingSchema, setPickingSchema] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)
  const [testStates, setTestStates] = useState<Record<number, TestState>>({})
  const [testAllState, setTestAllState] = useState<'idle' | 'testing' | 'done'>('idle')

  const { data: clients, isLoading } = useQuery<ArrDownloadClient[]>({
    queryKey: [service, 'downloadclients'],
    queryFn: async () => (await api.get(base)).data,
    staleTime: 30_000,
  })

  const { data: tags } = useQuery<ArrTag[]>({
    queryKey: [service, 'tags'],
    queryFn: async () => (await api.get(`/proxy/${service}/api/${apiV(service)}/tag`)).data,
    staleTime: 60_000,
  })

  const { data: schemas } = useQuery<ArrDownloadClient[]>({
    queryKey: [service, 'downloadclient-schema'],
    queryFn: async () => (await api.get(`${base}/schema`)).data,
    staleTime: 300_000,
    enabled: pickingSchema,
  })

  const toggleEnable = useMutation({
    mutationFn: (client: ArrDownloadClient) => api.put(`${base}/${client.id}`, { ...client, enable: !client.enable }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [service, 'downloadclients'] }),
  })

  const deleteClient = useMutation({
    mutationFn: (id: number) => api.delete(`${base}/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [service, 'downloadclients'] })
      setDeleteTarget(null)
    },
  })

  const testOne = async (client: ArrDownloadClient) => {
    setTestStates((s) => ({ ...s, [client.id!]: 'testing' }))
    try {
      await api.post(`${base}/test`, client)
      setTestStates((s) => ({ ...s, [client.id!]: 'ok' }))
    } catch {
      setTestStates((s) => ({ ...s, [client.id!]: 'fail' }))
    }
  }

  const testAll = async () => {
    setTestAllState('testing')
    try {
      await api.post(`${base}/testall`)
      setTestAllState('done')
      setTimeout(() => setTestAllState('idle'), 3000)
    } catch {
      setTestAllState('idle')
    }
  }

  const closeAndRefresh = () => {
    setEditing(null)
    queryClient.invalidateQueries({ queryKey: [service, 'downloadclients'] })
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setPickingSchema(true)}
          className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          + Add Download Client
        </button>
        <button
          onClick={testAll}
          disabled={testAllState === 'testing'}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
        >
          {testAllState === 'testing' ? 'Testing…' : testAllState === 'done' ? '✓ Done' : 'Test All'}
        </button>
        {clients && <span className="text-xs text-gray-600 ml-1">{clients.length} clients</span>}
      </div>

      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(3)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : !clients?.length ? (
        <p className="text-gray-600 text-sm py-8 text-center">No download clients configured</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Priority</th>
                <th className="px-4 py-2.5 w-48" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {clients.map((c) => {
                const testState = testStates[c.id!] ?? 'idle'
                return (
                  <tr key={c.id} className="hover:bg-gray-800/20 transition-colors group">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${c.enable ? 'bg-green-400' : 'bg-gray-600'}`} />
                        <span className={`text-sm truncate ${c.enable ? 'text-white' : 'text-gray-500'}`}>{c.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                          c.protocol === 'torrent' ? 'bg-blue-900/60 text-blue-300' : 'bg-green-900/60 text-green-300'
                        }`}>
                          {c.protocol === 'torrent' ? 'TRK' : 'NZB'}
                        </span>
                        {c.message && (
                          <span className="text-orange-400 text-xs" title={c.message.message}>⚠</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 hidden sm:table-cell">{c.priority}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 justify-end">
                        {testState === 'ok' && <span className="text-green-400 text-xs">✓</span>}
                        {testState === 'fail' && <span className="text-red-400 text-xs">✗</span>}
                        <button
                          onClick={() => testOne(c)}
                          disabled={testState === 'testing'}
                          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                        >
                          {testState === 'testing' ? '…' : 'Test'}
                        </button>
                        <button
                          onClick={() => setEditing(c)}
                          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => toggleEnable.mutate(c)}
                          disabled={toggleEnable.isPending}
                          className={`text-xs px-2.5 py-1 rounded border transition-colors disabled:opacity-50 ${
                            c.enable
                              ? 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-red-900/40 hover:border-red-800 hover:text-red-300'
                              : 'bg-green-900/40 border-green-800 text-green-400 hover:bg-green-800 hover:text-white'
                          }`}
                        >
                          {c.enable ? 'Disable' : 'Enable'}
                        </button>
                        {deleteTarget === c.id ? (
                          <>
                            <button onClick={() => deleteClient.mutate(c.id!)} className="text-xs px-2 py-1 rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Confirm</button>
                            <button onClick={() => setDeleteTarget(null)} className="text-xs px-1.5 py-1 rounded bg-gray-700 text-gray-400 hover:text-white transition-colors">✕</button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeleteTarget(c.id!)}
                            className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-red-800 text-gray-500 hover:text-red-300 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {pickingSchema && !schemas && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl px-6 py-4 text-sm text-gray-400">Loading types…</div>
        </div>
      )}
      {pickingSchema && schemas && (
        <SchemaPicker
          title="Choose Download Client Type"
          schemas={schemas}
          onClose={() => setPickingSchema(false)}
          onPick={(i) => {
            const schema = schemas[i]
            setEditing({ ...schema, tags: [], priority: 1, enable: true })
            setPickingSchema(false)
          }}
        />
      )}
      {editing && (
        <DownloadClientModal
          service={service}
          tags={tags ?? []}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={closeAndRefresh}
        />
      )}
    </div>
  )
}

// ── Root folders section ─────────────────────────────────────────────────

function ArrRootFoldersSection({ service }: { service: ArrService }) {
  const queryClient = useQueryClient()
  const base = `/proxy/${service}/api/${apiV(service)}/rootfolder`
  const [newPath, setNewPath] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)

  const { data: folders, isLoading } = useQuery<ArrRootFolder[]>({
    queryKey: [service, 'rootfolder'],
    queryFn: async () => (await api.get(base)).data,
    staleTime: 30_000,
  })

  const add = useMutation({
    mutationFn: (path: string) => api.post(base, { path }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [service, 'rootfolder'] })
      setNewPath('')
    },
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`${base}/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [service, 'rootfolder'] })
      setDeleteTarget(null)
    },
  })

  return (
    <div className="max-w-2xl">
      <form
        onSubmit={(e) => { e.preventDefault(); if (newPath.trim()) add.mutate(newPath.trim()) }}
        className="flex items-center gap-2 mb-4"
      >
        <input
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          placeholder="/path/inside/the/arr/container"
          className="input flex-1"
        />
        <button
          type="submit"
          disabled={!newPath.trim() || add.isPending}
          className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 shrink-0"
        >
          {add.isPending ? 'Adding…' : '+ Add'}
        </button>
      </form>
      {add.isError && <p className="text-red-400 text-xs mb-3">{extractError(add.error)}</p>}

      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(2)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : !folders?.length ? (
        <p className="text-gray-600 text-sm py-8 text-center">No root folders configured</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800/50">
          {folders.map((f) => (
            <div key={f.id} className="px-4 py-2.5 flex items-center gap-3 group">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${f.accessible ? 'bg-green-400' : 'bg-red-500'}`} />
              <span className="flex-1 min-w-0 text-sm text-white truncate font-mono">{f.path}</span>
              {f.freeSpace !== undefined && (
                <span className="text-xs text-gray-500 shrink-0 tabular-nums">{formatBytes(f.freeSpace)} free</span>
              )}
              {deleteTarget === f.id ? (
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => remove.mutate(f.id!)} className="text-xs px-2 py-1 rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Confirm</button>
                  <button onClick={() => setDeleteTarget(null)} className="text-xs px-1.5 py-1 rounded bg-gray-700 text-gray-400 hover:text-white transition-colors">✕</button>
                </div>
              ) : (
                <button
                  onClick={() => setDeleteTarget(f.id!)}
                  className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-red-800 text-gray-500 hover:text-red-300 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Quality profiles section ────────────────────────────────────────────────

function qualityCutoffOptions(items: ArrQualityItem[]) {
  return items
    .filter((it) => it.allowed)
    .map((it) => ({ value: it.quality ? it.quality.id : it.id!, label: it.quality?.name ?? it.name ?? 'Unknown' }))
}

function QualityProfileModal({
  service, profile, onClose, onSaved,
}: {
  service: ArrService
  profile: ArrQualityProfile
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<ArrQualityProfile>(profile)
  const base = `/proxy/${service}/api/${apiV(service)}/qualityprofile`

  const save = useMutation({
    mutationFn: (p: ArrQualityProfile) => (p.id ? api.put(`${base}/${p.id}`, p) : api.post(base, p)),
    onSuccess: onSaved,
  })

  const toggleItem = (idx: number) => {
    setDraft((d) => ({
      ...d,
      items: d.items.map((it, i) => (i === idx ? { ...it, allowed: !it.allowed } : it)),
    }))
  }

  const cutoffOptions = qualityCutoffOptions(draft.items)

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h3 className="text-white font-semibold">{draft.id ? 'Edit Quality Profile' : 'New Quality Profile'}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              className="input w-full"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
          <label className="flex items-center justify-between py-1">
            <span className="text-xs text-gray-400">Upgrade until cutoff</span>
            <Toggle enabled={draft.upgradeAllowed} onChange={(v) => setDraft((d) => ({ ...d, upgradeAllowed: v }))} />
          </label>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Cutoff quality</label>
            <select
              className="input w-full"
              value={draft.cutoff}
              onChange={(e) => setDraft((d) => ({ ...d, cutoff: Number(e.target.value) }))}
            >
              {cutoffOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="border-t border-gray-800 pt-3">
            <p className="text-xs text-gray-400 mb-2">Allowed qualities (top = highest priority)</p>
            <div className="space-y-1">
              {draft.items.map((it, i) => (
                <label key={it.quality?.id ?? it.id ?? i} className="flex items-center justify-between py-1">
                  <span className={`text-sm ${it.allowed ? 'text-white' : 'text-gray-600'}`}>
                    {it.quality?.name ?? it.name}
                    {it.items?.length ? <span className="text-[10px] text-gray-600 ml-1.5">(group)</span> : null}
                  </span>
                  <Toggle enabled={it.allowed} onChange={() => toggleItem(i)} />
                </label>
              ))}
            </div>
          </div>
          {save.isError && <p className="text-red-400 text-xs">{extractError(save.error)}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800 shrink-0">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors">Cancel</button>
          <button
            onClick={() => save.mutate(draft)}
            disabled={save.isPending}
            className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ArrQualityProfilesSection({ service }: { service: ArrService }) {
  const queryClient = useQueryClient()
  const base = `/proxy/${service}/api/${apiV(service)}/qualityprofile`
  const [editing, setEditing] = useState<ArrQualityProfile | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)

  const { data: profiles, isLoading } = useQuery<ArrQualityProfile[]>({
    queryKey: [service, 'qualityprofile'],
    queryFn: async () => (await api.get(base)).data,
    staleTime: 30_000,
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`${base}/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [service, 'qualityprofile'] })
      setDeleteTarget(null)
    },
  })

  const closeAndRefresh = () => {
    setEditing(null)
    queryClient.invalidateQueries({ queryKey: [service, 'qualityprofile'] })
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        {profiles && profiles.length > 0 && (
          <button
            onClick={() => setEditing({ ...structuredClone(profiles[0]), id: undefined, name: `${profiles[0].name} copy` })}
            className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            + Duplicate "{profiles[0].name}"
          </button>
        )}
        {profiles && <span className="text-xs text-gray-600 ml-1">{profiles.length} profiles</span>}
      </div>
      <p className="text-xs text-gray-600 mb-4">
        New profiles are created by duplicating an existing one — pick the result to edit its name and qualities.
      </p>

      {isLoading ? (
        <div className="space-y-1.5">
          {[...Array(3)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
        </div>
      ) : !profiles?.length ? (
        <p className="text-gray-600 text-sm py-8 text-center">No quality profiles found</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800/50">
          {profiles.map((p) => {
            const cutoffLabel = qualityCutoffOptions(p.items).find((o) => o.value === p.cutoff)?.label ?? '—'
            return (
              <div key={p.id} className="px-4 py-2.5 flex items-center gap-3 group">
                <span className="flex-1 min-w-0 text-sm text-white truncate">{p.name}</span>
                <span className="text-xs text-gray-500 shrink-0">Cutoff: {cutoffLabel}</span>
                {p.upgradeAllowed && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 font-medium shrink-0">Upgrades</span>
                )}
                <button
                  onClick={() => setEditing(p)}
                  className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-400 hover:text-white transition-colors shrink-0"
                >
                  Edit
                </button>
                {deleteTarget === p.id ? (
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => remove.mutate(p.id!)} className="text-xs px-2 py-1 rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Confirm</button>
                    <button onClick={() => setDeleteTarget(null)} className="text-xs px-1.5 py-1 rounded bg-gray-700 text-gray-400 hover:text-white transition-colors">✕</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteTarget(p.id!)}
                    className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-red-800 text-gray-500 hover:text-red-300 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                  >
                    Delete
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <QualityProfileModal service={service} profile={editing} onClose={() => setEditing(null)} onSaved={closeAndRefresh} />
      )}
    </div>
  )
}

// ── Generic flat config section (host / naming / media management) ─────────
// These three arr endpoints are all a single flat resource with an id, so one
// component (parameterized by endpoint) covers all of them via typeof-based
// field rendering — no need to hardcode each endpoint's field list.

function ArrFlatConfigSection({ service, endpoint }: { service: ArrService; endpoint: string }) {
  const queryClient = useQueryClient()
  const base = `/proxy/${service}/api/${apiV(service)}/${endpoint}`
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  const { data, isLoading } = useQuery<Record<string, unknown>>({
    queryKey: [service, endpoint],
    queryFn: async () => (await api.get(base)).data,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (data && !draft) setDraft(data)
  }, [data, draft])

  if (isLoading || !draft) {
    return (
      <div className="space-y-2 max-w-2xl">
        {[...Array(8)].map((_, i) => <div key={i} className="h-9 bg-gray-900 rounded animate-pulse" />)}
      </div>
    )
  }

  const setValue = (k: string, v: unknown) => setDraft((d) => (d ? { ...d, [k]: v } : d))
  const keys = Object.keys(draft).filter((k) => k !== 'id')

  const save = async () => {
    setSaveState('saving')
    setSaveError(null)
    try {
      await api.put(`${base}/${draft.id}`, draft)
      setSaveState('saved')
      queryClient.invalidateQueries({ queryKey: [service, endpoint] })
      setTimeout(() => setSaveState('idle'), 2500)
    } catch (err) {
      setSaveState('error')
      setSaveError(extractError(err))
    }
  }

  const labelFor = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim()

  return (
    <div className="max-w-2xl">
      <div className="bg-gray-900 border border-gray-800 rounded-lg divide-y divide-gray-800/50">
        {keys.map((k) => {
          const v = draft[k]
          if (typeof v === 'boolean') {
            return (
              <div key={k} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm text-gray-400">{labelFor(k)}</span>
                <Toggle enabled={v} onChange={(val) => setValue(k, val)} />
              </div>
            )
          }
          if (typeof v === 'number') {
            return (
              <div key={k} className="flex items-center justify-between px-4 py-2.5 gap-4">
                <span className="text-sm text-gray-400 shrink-0">{labelFor(k)}</span>
                <input
                  type="number"
                  className="input w-32 text-right"
                  value={v}
                  onChange={(e) => setValue(k, Number(e.target.value))}
                />
              </div>
            )
          }
          if (typeof v === 'string') {
            const isSecret = /password|apikey|secret/i.test(k)
            return (
              <div key={k} className="flex items-center justify-between px-4 py-2.5 gap-4">
                <span className="text-sm text-gray-400 shrink-0">{labelFor(k)}</span>
                <input
                  type={isSecret ? 'password' : 'text'}
                  className="input w-56"
                  value={v}
                  onChange={(e) => setValue(k, e.target.value)}
                />
              </div>
            )
          }
          return null
        })}
      </div>
      {saveError && <p className="text-red-400 text-xs mt-2">{saveError}</p>}
      <button
        onClick={save}
        disabled={saveState === 'saving'}
        className="mt-4 text-sm px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
      >
        {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : 'Save Changes'}
      </button>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────

type SubTab = 'indexers' | 'downloadclients' | 'rootfolders' | 'qualityprofiles' | 'naming' | 'mediamanagement' | 'host'

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'indexers', label: 'Indexers' },
  { key: 'downloadclients', label: 'Download Clients' },
  { key: 'rootfolders', label: 'Root Folders' },
  { key: 'qualityprofiles', label: 'Quality Profiles' },
  { key: 'naming', label: 'Naming' },
  { key: 'mediamanagement', label: 'Media Management' },
  { key: 'host', label: 'Host / General' },
]

export default function ArrManage() {
  const { enabledServices } = useConfig()
  const hasSonarr = enabledServices.includes('sonarr')
  const hasRadarr = enabledServices.includes('radarr')
  const hasLidarr = enabledServices.includes('lidarr')

  const services: ArrService[] = [
    ...(hasSonarr ? (['sonarr'] as const) : []),
    ...(hasRadarr ? (['radarr'] as const) : []),
    ...(hasLidarr ? (['lidarr'] as const) : []),
  ]

  const [activeService, setActiveService] = useState<ArrService | null>(services[0] ?? null)
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('indexers')

  if (services.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Sonarr / Radarr / Lidarr</h1>
        <p className="text-gray-500">Enable Sonarr, Radarr, or Lidarr in Settings to manage them here.</p>
      </div>
    )
  }

  const service = activeService ?? services[0]

  return (
    <div className="p-6 max-w-6xl">
      <h1 className="text-2xl font-bold text-white mb-5">Sonarr / Radarr / Lidarr</h1>

      {services.length > 1 && (
        <div className="flex items-center gap-1 mb-4">
          {services.map((s) => (
            <button
              key={s}
              onClick={() => setActiveService(s)}
              className={`text-sm px-3 py-1.5 rounded-lg font-medium capitalize transition-colors ${
                service === s ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1 mb-6 border-b border-gray-800">
        {SUB_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveSubTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
              activeSubTab === key ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* key={service} forces a clean remount when switching Sonarr/Radarr so section state doesn't leak across */}
      {activeSubTab === 'indexers' && <ArrIndexerSection key={`${service}-indexers`} service={service} />}
      {activeSubTab === 'downloadclients' && <ArrDownloadClientSection key={`${service}-dlc`} service={service} />}
      {activeSubTab === 'rootfolders' && <ArrRootFoldersSection key={`${service}-rootfolders`} service={service} />}
      {activeSubTab === 'qualityprofiles' && <ArrQualityProfilesSection key={`${service}-qualityprofiles`} service={service} />}
      {activeSubTab === 'naming' && <ArrFlatConfigSection key={`${service}-naming`} service={service} endpoint="config/naming" />}
      {activeSubTab === 'mediamanagement' && <ArrFlatConfigSection key={`${service}-mediamanagement`} service={service} endpoint="config/mediamanagement" />}
      {activeSubTab === 'host' && <ArrFlatConfigSection key={`${service}-host`} service={service} endpoint="config/host" />}
    </div>
  )
}
