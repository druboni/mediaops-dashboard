import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CalendarBody, useCalendarState } from '../components/calendar/CalendarView'
import type { CalEpisode, CalMovie } from '../components/calendar/CalendarView'

// The read-only calendar anyone with the share link can open.
//
// It sits outside PrivateRoute and Layout, so there's no sidebar and nothing
// linking into the rest of MediaOps, and it never touches a dashboard session.
// That's also why it uses fetch rather than the shared api client: that client
// attaches a token if one exists and, on a 401, redirects to /login — neither
// of which belongs on a page meant for someone who isn't a dashboard user.

interface ShareResponse {
  sonarr: boolean
  radarr: boolean
  episodes: CalEpisode[]
  movies: CalMovie[]
}

class ShareUnavailable extends Error {}

export default function PublicCalendar() {
  const { secret = '' } = useParams<{ secret: string }>()
  const cal = useCalendarState()
  const { startStr, endStr } = cal

  const { data, isLoading, error } = useQuery<ShareResponse>({
    queryKey: ['public-calendar', secret, startStr, endStr],
    queryFn: async () => {
      const qs = new URLSearchParams({ start: startStr, end: endStr })
      const res = await fetch(`/api/public/calendar/${encodeURIComponent(secret)}?${qs}`)
      // 404 covers both a wrong link and sharing having been switched off —
      // deliberately indistinguishable, so say the same thing for both.
      if (res.status === 404) throw new ShareUnavailable()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    // A dead link stays dead; retrying it three times just delays saying so.
    retry: (count, err) => !(err instanceof ShareUnavailable) && count < 2,
    staleTime: 300_000,
  })

  return (
    <div className="min-h-screen bg-gray-950">
      {error instanceof ShareUnavailable ? (
        <div className="flex items-center justify-center min-h-screen p-6">
          <div className="text-center max-w-sm">
            <p className="text-white font-semibold mb-1">This calendar isn't available</p>
            <p className="text-sm text-gray-500">
              The link may have been turned off or replaced. Ask whoever shared it for a new one.
            </p>
          </div>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center min-h-screen p-6">
          <p className="text-sm text-gray-500">Couldn't load the calendar right now. Try again in a moment.</p>
        </div>
      ) : data && !data.sonarr && !data.radarr ? (
        <div className="flex items-center justify-center min-h-screen p-6">
          <p className="text-sm text-gray-500">Nothing is scheduled to show here yet.</p>
        </div>
      ) : (
        <CalendarBody
          cal={cal}
          episodes={data?.episodes ?? []}
          movies={data?.movies ?? []}
          isLoading={isLoading}
          title="Upcoming Releases"
          headerExtra={
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-800 text-gray-400 uppercase tracking-wider">
              Read-only
            </span>
          }
        />
      )}
    </div>
  )
}
