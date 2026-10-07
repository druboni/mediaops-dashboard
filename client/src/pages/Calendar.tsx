import { useMemo, Component } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConfig } from '../store/config'
import api from '../services/api'
import { CalendarBody, useCalendarState } from '../components/calendar/CalendarView'
import type { CalEpisode, CalMovie } from '../components/calendar/CalendarView'

class CalendarErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null }
  static getDerivedStateFromError(err: Error) { return { error: err.message } }
  render() {
    if (this.state.error) {
      return (
        <div className="p-6">
          <h1 className="text-2xl font-bold text-white mb-4">Calendar</h1>
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 text-sm font-mono">
            {this.state.error}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface SonarrSeries {
  id: number
  title: string
  network?: string
}

interface SonarrEpisode extends CalEpisode {
  id: number
  seriesId: number
  series?: SonarrSeries
}

// ── Page ───────────────────────────────────────────────────────────────────

// Rendering lives in components/calendar/CalendarView so the public share page
// draws exactly the same thing; this page only owns the authenticated fetch.
export default function Calendar() {
  return <CalendarErrorBoundary><CalendarInner /></CalendarErrorBoundary>
}

function CalendarInner() {
  const { enabledServices } = useConfig()
  const hasSonarr = enabledServices.includes('sonarr')
  const hasRadarr = enabledServices.includes('radarr')
  const cal = useCalendarState()
  const { startStr, endStr } = cal

  const { data: seriesList = [], isLoading: seriesLoading } = useQuery<SonarrSeries[]>({
    queryKey: ['sonarr-series'],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/series')).data,
    enabled: hasSonarr,
    staleTime: 3_600_000,
  })

  const seriesMap = useMemo(() => {
    const m = new Map<number, SonarrSeries>()
    for (const s of seriesList) m.set(s.id, s)
    return m
  }, [seriesList])

  const { data: episodes = [], isLoading: epLoading } = useQuery<SonarrEpisode[]>({
    queryKey: ['sonarr-calendar', startStr, endStr],
    queryFn: async () => (await api.get('/proxy/sonarr/api/v3/calendar', {
      params: { start: startStr, end: endStr, unmonitored: false },
    })).data,
    enabled: hasSonarr,
    staleTime: 300_000,
  })

  const { data: movies = [], isLoading: movLoading } = useQuery<CalMovie[]>({
    queryKey: ['radarr-calendar', startStr, endStr],
    queryFn: async () => (await api.get('/proxy/radarr/api/v3/calendar', {
      params: { start: startStr, end: endStr, unmonitored: false },
    })).data,
    enabled: hasRadarr,
    staleTime: 300_000,
  })

  const enrichedEpisodes = useMemo(
    () => episodes.map((ep) => ({ ...ep, series: seriesMap.get(ep.seriesId) ?? ep.series })),
    [episodes, seriesMap]
  )

  const isLoading = (hasSonarr && (epLoading || seriesLoading)) || (hasRadarr && movLoading)

  if (!hasSonarr && !hasRadarr) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-4">Calendar</h1>
        <p className="text-gray-500">Enable Sonarr or Radarr in Settings to see the calendar.</p>
      </div>
    )
  }

  return <CalendarBody cal={cal} episodes={enrichedEpisodes} movies={movies} isLoading={isLoading} />
}
