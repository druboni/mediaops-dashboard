import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../index.css'
import ShareCalendar from '../components/calendar/ShareCalendar'

// Entry point for the standalone calendar container (calendar-share/). Built
// separately by vite.share.config.ts, so the bundle contains the calendar and
// nothing else of the dashboard — no router, no other pages, no api client.
//
// It reads /api/calendar on its own origin; the container's server holds the
// MediaOps token and makes the real request, so the browser never sees it.

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ShareCalendar
        cacheKey="container"
        dataUrl={(start, end) => `/api/calendar?${new URLSearchParams({ start, end })}`}
      />
    </QueryClientProvider>
  </StrictMode>,
)
