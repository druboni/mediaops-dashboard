import { useParams } from 'react-router-dom'
import ShareCalendar from '../components/calendar/ShareCalendar'

// The in-network share link: /share/calendar/<secret>. Sits outside
// PrivateRoute and Layout, so there's no sidebar, nothing linking into the
// rest of MediaOps, and no dashboard session involved.
export default function PublicCalendar() {
  const { secret = '' } = useParams<{ secret: string }>()
  return (
    <ShareCalendar
      cacheKey={`link:${secret}`}
      dataUrl={(start, end) =>
        `/api/public/calendar/${encodeURIComponent(secret)}?${new URLSearchParams({ start, end })}`
      }
    />
  )
}
