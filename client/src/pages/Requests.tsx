import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'

// ── Types ──────────────────────────────────────────────────────────────────

interface OverseerrUser { id: number; displayName: string; avatar?: string }

interface OverseerrMedia {
  id: number
  tmdbId: number
  tvdbId?: number
  mediaType: 'movie' | 'tv'
  status: number
  title?: string
  originalTitle?: string
}

interface OverseerrRequest {
  id: number
  status: 1 | 2 | 3   // 1=pending, 2=approved, 3=declined
  createdAt: string
  updatedAt: string
  type: 'movie' | 'tv'
  is4k: boolean
  seasons: { id: number; seasonNumber: number; status: number }[]
  requestedBy: OverseerrUser
  modifiedBy?: OverseerrUser
  media: OverseerrMedia
}

interface OverseerrIssue {
  id: number
  issueType: number  // 0=other, 1=video, 2=audio, 3=subtitles, 4=not_available
  status: 1 | 2     // 1=open, 2=resolved
  problemSeason?: number
  problemEpisode?: number
  createdAt: string
  updatedAt: string
  reportedBy: OverseerrUser
  media: OverseerrMedia
  comments?: { id: number; message: string; user: OverseerrUser; createdAt: string }[]
}

interface RequestPage { pageInfo: { pages: number; results: number; page: number }; results: OverseerrRequest[] }
interface IssuePage  { pageInfo: { pages: number; results: number; page: number }; results: OverseerrIssue[] }
interface RequestCount { all: number; pending: number; approved: number; declined: number; processing: number; available: number; failed: number }

// ── Helpers ────────────────────────────────────────────────────────────────

const REQ_STATUS: Record<number, { label: string; badgeCls: string }> = {
  1: { label: 'Pending',  badgeCls: 'bg-yellow-900/50 text-yellow-300' },
  2: { label: 'Approved', badgeCls: 'bg-blue-900/50 text-blue-300' },
  3: { label: 'Declined', badgeCls: 'bg-red-900/50 text-red-400' },
}

const MEDIA_STATUS: Record<number, { label: string; color: string }> = {
  1: { label: 'Unknown',     color: 'text-gray-500' },
  2: { label: 'Pending',     color: 'text-yellow-400' },
  3: { label: 'Processing',  color: 'text-blue-400' },
  4: { label: 'Partial',     color: 'text-orange-400' },
  5: { label: 'Available',   color: 'text-green-400' },
}

const ISSUE_TYPE: Record<number, string> = {
  0: 'Other', 1: 'Video', 2: 'Audio', 3: 'Subtitles', 4: 'Not Available',
}

function mediaTitle(media: OverseerrMedia) {
  return media?.originalTitle || media?.title || 'Unknown'
}

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Request Detail Panel ───────────────────────────────────────────────────

function RequestDetailPanel({
  request, onClose, onApprove, onDecline, onDelete, onRetry,
}: {
  request: OverseerrRequest
  onClose: () => void
  onApprove: (id: number) => void
  onDecline: (id: number) => void
  onDelete: (id: number) => void
  onRetry: (id: number) => void
}) {
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const { label: statusLabel, badgeCls } = REQ_STATUS[request.status] ?? REQ_STATUS[1]
  const mediaStatus = MEDIA_STATUS[request.media?.status] ?? MEDIA_STATUS[1]
  const title = mediaTitle(request.media)

  const displaySeasons = request.type === 'tv' && request.seasons?.length > 0
    ? [...request.seasons].sort((a, b) => a.seasonNumber - b.seasonNumber)
    : []

  return (
    <div className="fixed right-0 top-0 h-screen w-[420px] bg-gray-900 border-l border-gray-800 flex flex-col z-40 overflow-hidden shadow-2xl">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
            request.type === 'movie' ? 'bg-blue-900/60 text-blue-300' : 'bg-purple-900/60 text-purple-300'
          }`}>
            {request.type === 'movie' ? 'Movie' : 'TV'}
          </span>
          {request.is4k && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-yellow-900/50 text-yellow-400 shrink-0">4K</span>
          )}
          <span className="text-sm font-semibold text-white truncate">{title}</span>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors shrink-0 ml-2">✕</button>
      </div>

      <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
        {/* Status badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs px-2 py-1 rounded font-medium ${badgeCls}`}>{statusLabel}</span>
          <span className={`text-xs ${mediaStatus.color}`}>Media: {mediaStatus.label}</span>
        </div>

        {/* Request meta */}
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs text-gray-500">Requested by</span>
            <span className="text-xs text-white font-medium">{request.requestedBy?.displayName ?? 'Unknown'}</span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs text-gray-500">Requested</span>
            <span className="text-xs text-gray-400">{timeAgo(request.createdAt)}</span>
          </div>
          {request.modifiedBy && (
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs text-gray-500">Modified by</span>
              <span className="text-xs text-gray-400">{request.modifiedBy.displayName}</span>
            </div>
          )}
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs text-gray-500">TMDB ID</span>
            <span className="text-xs text-gray-600 font-mono">{request.media?.tmdbId}</span>
          </div>
        </div>

        {/* Seasons */}
        {displaySeasons.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Requested Seasons</p>
            <div className="flex flex-wrap gap-1.5">
              {displaySeasons.map((s) => (
                <span key={s.seasonNumber} className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-300">
                  Season {s.seasonNumber}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-5 py-4 border-t border-gray-800 shrink-0">
        {deleteConfirm ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-400">Delete this request?</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteConfirm(false)} className="flex-1 text-xs py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={() => { onDelete(request.id); setDeleteConfirm(false) }} className="flex-1 text-xs py-1.5 rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Delete</button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {request.status === 1 && (
              <>
                <button onClick={() => onApprove(request.id)} className="flex-1 text-xs py-1.5 rounded bg-green-700 hover:bg-green-600 text-white transition-colors">Approve</button>
                <button onClick={() => onDecline(request.id)} className="flex-1 text-xs py-1.5 rounded bg-gray-700 hover:bg-red-700 text-white transition-colors">Decline</button>
              </>
            )}
            {request.status === 2 && (
              <button onClick={() => onDecline(request.id)} className="flex-1 text-xs py-1.5 rounded bg-gray-700 hover:bg-red-700 text-white transition-colors">Decline</button>
            )}
            {request.status === 3 && (
              <button onClick={() => onApprove(request.id)} className="flex-1 text-xs py-1.5 rounded bg-green-700 hover:bg-green-600 text-white transition-colors">Re-approve</button>
            )}
            <button onClick={() => onRetry(request.id)} className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white border border-gray-700 transition-colors">Retry</button>
            <button onClick={() => setDeleteConfirm(true)} className="text-xs px-3 py-1.5 rounded bg-gray-800 text-gray-400 hover:text-red-400 border border-gray-700 hover:border-red-800 transition-colors">Delete</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Issue Detail Panel ─────────────────────────────────────────────────────

function IssueDetailPanel({
  issue, onClose, onCloseIssue, onDelete,
}: {
  issue: OverseerrIssue
  onClose: () => void
  onCloseIssue: (id: number) => void
  onDelete: (id: number) => void
}) {
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  const { data: fullIssue } = useQuery<OverseerrIssue>({
    queryKey: ['overseerr-issue', issue.id],
    queryFn: async () => (await api.get(`/proxy/overseerr/api/v1/issue/${issue.id}`)).data,
    staleTime: 30_000,
  })

  const display = fullIssue ?? issue
  const title = mediaTitle(display.media)

  return (
    <div className="fixed right-0 top-0 h-screen w-[420px] bg-gray-900 border-l border-gray-800 flex flex-col z-40 overflow-hidden shadow-2xl">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
            display.status === 1 ? 'bg-red-900/60 text-red-400' : 'bg-green-900/60 text-green-400'
          }`}>
            {display.status === 1 ? 'Open' : 'Resolved'}
          </span>
          <span className="text-sm font-semibold text-white truncate">{title}</span>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors shrink-0 ml-2">✕</button>
      </div>

      <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500">Issue type</span>
            <span className="text-xs text-white">{ISSUE_TYPE[display.issueType] ?? 'Other'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500">Reported by</span>
            <span className="text-xs text-white">{display.reportedBy?.displayName ?? 'Unknown'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500">Reported</span>
            <span className="text-xs text-gray-400">{timeAgo(display.createdAt)}</span>
          </div>
          {(display.problemSeason ?? 0) > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-500">Problem</span>
              <span className="text-xs text-gray-400">
                S{String(display.problemSeason).padStart(2, '0')}
                {(display.problemEpisode ?? 0) > 0 && `E${String(display.problemEpisode).padStart(2, '0')}`}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500">Media type</span>
            <span className="text-xs text-gray-400 capitalize">{display.media?.mediaType ?? '—'}</span>
          </div>
        </div>

        {/* Comments */}
        {display.comments && display.comments.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Comments</p>
            <div className="space-y-3">
              {display.comments.map((c) => (
                <div key={c.id} className="bg-gray-800/50 rounded-lg px-3 py-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-gray-300">{c.user?.displayName}</span>
                    <span className="text-[10px] text-gray-600">{timeAgo(c.createdAt)}</span>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">{c.message}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {!fullIssue && (
          <p className="text-xs text-gray-600">Loading details…</p>
        )}
      </div>

      <div className="px-5 py-4 border-t border-gray-800 shrink-0">
        {deleteConfirm ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-400">Delete this issue?</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteConfirm(false)} className="flex-1 text-xs py-1.5 rounded bg-gray-800 text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={() => { onDelete(display.id); setDeleteConfirm(false) }} className="flex-1 text-xs py-1.5 rounded bg-red-800 hover:bg-red-700 text-white transition-colors">Delete</button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            {display.status === 1 && (
              <button onClick={() => onCloseIssue(display.id)} className="flex-1 text-xs py-1.5 rounded bg-green-800 hover:bg-green-700 text-white transition-colors">Resolve</button>
            )}
            <button onClick={() => setDeleteConfirm(true)} className="flex-1 text-xs py-1.5 rounded bg-gray-800 text-gray-400 hover:text-red-400 border border-gray-700 hover:border-red-800 transition-colors">Delete</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────

type MainTab = 'pending' | 'all' | 'issues'
type AllFilter = 'all' | 'pending' | 'approved' | 'declined' | 'available' | 'processing'
type IssueFilter = 'open' | 'all'

const TAKE = 25

export default function Requests() {
  const { enabledServices } = useConfig()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<MainTab>('pending')
  const [allFilter, setAllFilter] = useState<AllFilter>('all')
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('open')
  const [allPage, setAllPage] = useState(0)
  const [selectedRequest, setSelectedRequest] = useState<OverseerrRequest | null>(null)
  const [selectedIssue, setSelectedIssue] = useState<OverseerrIssue | null>(null)

  const enabled = enabledServices.includes('overseerr')

  // Request counts
  const { data: counts } = useQuery<RequestCount>({
    queryKey: ['overseerr-request-count'],
    queryFn: async () => (await api.get('/proxy/overseerr/api/v1/request/count')).data,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  // Pending requests
  const { data: pendingData, isLoading: pendingLoading } = useQuery<RequestPage>({
    queryKey: ['overseerr-requests', 'pending'],
    queryFn: async () => (await api.get('/proxy/overseerr/api/v1/request', {
      params: { filter: 'pending', take: 100, skip: 0, sort: 'added' },
    })).data,
    enabled: enabled && tab === 'pending',
    staleTime: 30_000,
  })

  // All requests (paginated)
  const { data: allData, isLoading: allLoading } = useQuery<RequestPage>({
    queryKey: ['overseerr-requests', 'all', allFilter, allPage],
    queryFn: async () => (await api.get('/proxy/overseerr/api/v1/request', {
      params: { filter: allFilter, take: TAKE, skip: allPage * TAKE, sort: 'added' },
    })).data,
    enabled: enabled && tab === 'all',
    staleTime: 30_000,
  })

  // Issues
  const { data: issuesData, isLoading: issuesLoading } = useQuery<IssuePage>({
    queryKey: ['overseerr-issues', issueFilter],
    queryFn: async () => (await api.get('/proxy/overseerr/api/v1/issue', {
      params: { take: 50, skip: 0, filter: issueFilter, sort: 'added' },
    })).data,
    enabled: enabled && tab === 'issues',
    staleTime: 30_000,
  })

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['overseerr-requests'] })
    queryClient.invalidateQueries({ queryKey: ['overseerr-request-count'] })
  }
  const invalidateIssues = () => {
    queryClient.invalidateQueries({ queryKey: ['overseerr-issues'] })
  }

  const approve = useMutation({
    mutationFn: (id: number) => api.post(`/proxy/overseerr/api/v1/request/${id}/approve`),
    onSuccess: () => { invalidateAll(); setSelectedRequest(null) },
  })
  const decline = useMutation({
    mutationFn: (id: number) => api.post(`/proxy/overseerr/api/v1/request/${id}/decline`),
    onSuccess: () => { invalidateAll(); setSelectedRequest(null) },
  })
  const deleteRequest = useMutation({
    mutationFn: (id: number) => api.delete(`/proxy/overseerr/api/v1/request/${id}`),
    onSuccess: () => { invalidateAll(); setSelectedRequest(null) },
  })
  const retryRequest = useMutation({
    mutationFn: (id: number) => api.post(`/proxy/overseerr/api/v1/request/${id}/retry`),
    onSuccess: () => invalidateAll(),
  })
  const closeIssue = useMutation({
    mutationFn: (id: number) => api.post(`/proxy/overseerr/api/v1/issue/${id}/close`),
    onSuccess: () => { invalidateIssues(); setSelectedIssue(null) },
  })
  const deleteIssue = useMutation({
    mutationFn: (id: number) => api.delete(`/proxy/overseerr/api/v1/issue/${id}`),
    onSuccess: () => { invalidateIssues(); setSelectedIssue(null) },
  })

  if (!enabled) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Requests</h1>
        <p className="text-gray-500">Enable Overseerr in Settings to manage requests.</p>
      </div>
    )
  }

  const panelOpen = selectedRequest !== null || selectedIssue !== null

  const closePanel = () => { setSelectedRequest(null); setSelectedIssue(null) }

  const allPages = allData ? Math.ceil(allData.pageInfo.results / TAKE) : 0

  return (
    <div className={`p-6 transition-all duration-200 ${panelOpen ? 'pr-[436px]' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold text-white">Requests</h1>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-gray-800">
        {([
          { key: 'pending', label: 'Pending', count: counts?.pending },
          { key: 'all',     label: 'All Requests', count: counts?.all },
          { key: 'issues',  label: 'Issues' },
        ] as { key: MainTab; label: string; count?: number }[]).map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => { setTab(key); closePanel() }}
            className={`px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2 ${
              tab === key ? 'border-blue-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {label}
            {count !== undefined && count > 0 && (
              <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                key === 'pending' ? 'bg-yellow-700 text-yellow-200' : 'bg-gray-700 text-gray-300'
              }`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Pending Tab ── */}
      {tab === 'pending' && (
        <>
          {pendingLoading ? (
            <LoadingSkeleton />
          ) : !pendingData?.results.length ? (
            <EmptyState message="No pending requests" />
          ) : (
            <RequestTable
              requests={pendingData.results}
              selected={selectedRequest}
              onSelect={(r) => { setSelectedRequest(r); setSelectedIssue(null) }}
              onApprove={(id) => approve.mutate(id)}
              onDecline={(id) => decline.mutate(id)}
              onDelete={(id) => deleteRequest.mutate(id)}
              showActions
            />
          )}
        </>
      )}

      {/* ── All Requests Tab ── */}
      {tab === 'all' && (
        <>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
              {(['all', 'pending', 'approved', 'declined', 'available', 'processing'] as AllFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => { setAllFilter(f); setAllPage(0) }}
                  className={`px-3 py-1.5 transition-colors capitalize ${
                    allFilter === f ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
            {allData && (
              <span className="text-xs text-gray-600">{allData.pageInfo.results} total</span>
            )}
          </div>

          {allLoading ? (
            <LoadingSkeleton />
          ) : !allData?.results.length ? (
            <EmptyState message="No requests found" />
          ) : (
            <>
              <RequestTable
                requests={allData.results}
                selected={selectedRequest}
                onSelect={(r) => { setSelectedRequest(r); setSelectedIssue(null) }}
                onApprove={(id) => approve.mutate(id)}
                onDecline={(id) => decline.mutate(id)}
                onDelete={(id) => deleteRequest.mutate(id)}
                showActions={false}
                showStatus
              />
              {allPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <button
                    onClick={() => setAllPage((p) => Math.max(0, p - 1))}
                    disabled={allPage === 0}
                    className="text-xs px-4 py-2 rounded bg-gray-800 text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    ← Previous
                  </button>
                  <span className="text-xs text-gray-500">
                    Page {allPage + 1} of {allPages}
                  </span>
                  <button
                    onClick={() => setAllPage((p) => Math.min(allPages - 1, p + 1))}
                    disabled={allPage >= allPages - 1}
                    className="text-xs px-4 py-2 rounded bg-gray-800 text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Issues Tab ── */}
      {tab === 'issues' && (
        <>
          <div className="flex items-center gap-3 mb-4">
            <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
              {(['open', 'all'] as IssueFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setIssueFilter(f)}
                  className={`px-3 py-1.5 transition-colors capitalize ${
                    issueFilter === f ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white'
                  }`}
                >
                  {f === 'open' ? 'Open' : 'All Issues'}
                </button>
              ))}
            </div>
            {issuesData && (
              <span className="text-xs text-gray-600">{issuesData.pageInfo.results} total</span>
            )}
          </div>

          {issuesLoading ? (
            <LoadingSkeleton />
          ) : !issuesData?.results.length ? (
            <EmptyState message="No issues found" />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5 font-medium">Title</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Type</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Reporter</th>
                    <th className="text-left px-4 py-2.5 font-medium">Status</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Date</th>
                    <th className="px-4 py-2.5 w-32" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {issuesData.results.map((issue) => {
                    const isActive = selectedIssue?.id === issue.id
                    return (
                      <tr
                        key={issue.id}
                        onClick={() => { setSelectedIssue(isActive ? null : issue); setSelectedRequest(null) }}
                        className={`cursor-pointer transition-colors group ${isActive ? 'bg-blue-900/20' : 'hover:bg-gray-800/40'}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                              issue.media?.mediaType === 'movie' ? 'bg-blue-900/60 text-blue-300' : 'bg-purple-900/60 text-purple-300'
                            }`}>
                              {issue.media?.mediaType === 'movie' ? 'Movie' : 'TV'}
                            </span>
                            <span className="text-white truncate">{mediaTitle(issue.media)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400 hidden md:table-cell">{ISSUE_TYPE[issue.issueType] ?? 'Other'}</td>
                        <td className="px-4 py-3 text-xs text-gray-400 hidden sm:table-cell">{issue.reportedBy?.displayName}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-medium ${issue.status === 1 ? 'text-red-400' : 'text-green-400'}`}>
                            {issue.status === 1 ? 'Open' : 'Resolved'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600 hidden sm:table-cell">{timeAgo(issue.createdAt)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                            {issue.status === 1 && (
                              <button
                                onClick={(e) => { e.stopPropagation(); closeIssue.mutate(issue.id) }}
                                className="text-xs px-2 py-1 rounded bg-green-900/40 hover:bg-green-800 text-green-400 transition-colors"
                              >
                                Resolve
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteIssue.mutate(issue.id) }}
                              className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-red-800 text-gray-400 hover:text-red-300 transition-colors"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Detail Panels */}
      {panelOpen && <div className="fixed inset-0 z-30" onClick={closePanel} />}

      {selectedRequest && (
        <RequestDetailPanel
          request={selectedRequest}
          onClose={closePanel}
          onApprove={(id) => approve.mutate(id)}
          onDecline={(id) => decline.mutate(id)}
          onDelete={(id) => deleteRequest.mutate(id)}
          onRetry={(id) => retryRequest.mutate(id)}
        />
      )}
      {selectedIssue && (
        <IssueDetailPanel
          issue={selectedIssue}
          onClose={closePanel}
          onCloseIssue={(id) => closeIssue.mutate(id)}
          onDelete={(id) => deleteIssue.mutate(id)}
        />
      )}
    </div>
  )
}

// ── Shared sub-components ──────────────────────────────────────────────────

function RequestTable({
  requests, selected, onSelect, onApprove, onDecline, onDelete, showActions, showStatus,
}: {
  requests: OverseerrRequest[]
  selected: OverseerrRequest | null
  onSelect: (r: OverseerrRequest) => void
  onApprove: (id: number) => void
  onDecline: (id: number) => void
  onDelete: (id: number) => void
  showActions?: boolean
  showStatus?: boolean
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
            <th className="text-left px-4 py-2.5 font-medium">Title</th>
            <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Requested by</th>
            <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Date</th>
            {showStatus && <th className="text-left px-4 py-2.5 font-medium">Status</th>}
            <th className="px-4 py-2.5 w-40" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {requests.map((req) => {
            const isActive = selected?.id === req.id
            const title = mediaTitle(req.media)
            const { badgeCls, label } = REQ_STATUS[req.status] ?? REQ_STATUS[1]
            return (
              <tr
                key={req.id}
                onClick={() => onSelect(req)}
                className={`cursor-pointer transition-colors group ${isActive ? 'bg-blue-900/20' : 'hover:bg-gray-800/40'}`}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                      req.type === 'movie' ? 'bg-blue-900/60 text-blue-300' : 'bg-purple-900/60 text-purple-300'
                    }`}>
                      {req.type === 'movie' ? 'Movie' : 'TV'}
                    </span>
                    {req.is4k && <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-900/50 text-yellow-400 shrink-0">4K</span>}
                    <span className="text-white truncate">{title}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-400 hidden sm:table-cell">
                  {req.requestedBy?.displayName}
                </td>
                <td className="px-4 py-3 text-xs text-gray-600 hidden sm:table-cell">
                  {timeAgo(req.createdAt)}
                </td>
                {showStatus && (
                  <td className="px-4 py-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${badgeCls}`}>{label}</span>
                  </td>
                )}
                <td className="px-4 py-3">
                  {showActions ? (
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={(e) => { e.stopPropagation(); onApprove(req.id) }}
                        className="text-xs px-2 py-1 rounded bg-green-900/40 hover:bg-green-800 text-green-400 transition-colors"
                      >
                        Approve
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDecline(req.id) }}
                        className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-red-800 text-gray-400 hover:text-red-300 transition-colors"
                      >
                        Decline
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(req.id) }}
                        className="text-xs px-1.5 py-1 rounded bg-gray-700 hover:bg-red-900 text-gray-500 hover:text-red-400 transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                      {req.status === 1 && (
                        <button onClick={(e) => { e.stopPropagation(); onApprove(req.id) }} className="text-xs px-2 py-1 rounded bg-green-900/40 hover:bg-green-800 text-green-400 transition-colors">Approve</button>
                      )}
                      {req.status !== 3 && (
                        <button onClick={(e) => { e.stopPropagation(); onDecline(req.id) }} className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-red-800 text-gray-400 hover:text-red-300 transition-colors">Decline</button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); onDelete(req.id) }} className="text-xs px-1.5 py-1 rounded bg-gray-700 hover:bg-red-900 text-gray-500 hover:text-red-400 transition-colors">✕</button>
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-1.5">
      {[...Array(8)].map((_, i) => <div key={i} className="h-11 bg-gray-900 rounded-lg animate-pulse" />)}
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return <div className="text-center py-20 text-gray-600 text-sm">{message}</div>
}
