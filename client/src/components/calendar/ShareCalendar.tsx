import { useQuery } from '@tanstack/react-query'
import { CalendarBody, useCalendarState } from './CalendarView'
import type { CalEpisode, CalMovie } from './CalendarView'

// The read-only calendar shown to people who aren't dashboard users. Used in
// two places that differ only in where the data comes from:
//
// - the in-network share link (pages/PublicCalendar.tsx), which reads
//   /api/public/calendar/<secret> on MediaOps itself
// - the standalone calendar container (calendar-share/), which reads its own
//   /api/calendar and holds the MediaOps token server-side
//
// It uses fetch rather than the dashboard's api client, which attaches a
// session token and redirects to /login on a 401 — neither belongs here.

interface ShareResponse {
  sonarr: boolean
  radarr: boolean
  episodes: CalEpisode[]
  movies: CalMovie[]
}

class ShareUnavailable extends Error {}

export default function ShareCalendar({ dataUrl, cacheKey }: {
  /** Builds the URL to read the given date window from. */
  dataUrl: (start: string, end: string) => string
  /** Distinguishes queries when more than one share source could be mounted. */
  cacheKey: string
}) {
  const cal = useCalendarState()
  const { startStr, endStr } = cal

  const { data, isLoading, error } = useQuery<ShareResponse>({
    queryKey: ['share-calendar', cacheKey, startStr, endStr],
    queryFn: async () => {
      const res = await fetch(dataUrl(startStr, endStr))
      // 404 covers both a wrong link and sharing having been switched off —
      // deliberately indistinguishable, so say the same thing for both.
      if (res.status === 404) throw new ShareUnavailable()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    // A dead link stays dead; retrying it just delays saying so.
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
              It may have been turned off or replaced. Ask whoever shared it for a new link.
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
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-800 text-gray-400 uppercase tracking-wider whitespace-nowrap">
              Read-only
            </span>
          }
        />
      )}
    </div>
  )
}
