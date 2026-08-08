import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './store/auth'
import { ConfigProvider } from './store/config'
import { ThemeProvider } from './store/theme'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Layout from './components/Layout'

// Everything past the first paint is code-split — the dashboard is the only
// page most sessions ever load, so the rest shouldn't be in the initial bundle.
const Downloads   = lazy(() => import('./pages/Downloads'))
const Movies      = lazy(() => import('./pages/Movies'))
const TVShows     = lazy(() => import('./pages/TVShows'))
const Requests    = lazy(() => import('./pages/Requests'))
const Indexers    = lazy(() => import('./pages/Indexers'))
const ArrManage   = lazy(() => import('./pages/ArrManage'))
const Music       = lazy(() => import('./pages/Music'))
const Subtitles   = lazy(() => import('./pages/Subtitles'))
const Calendar    = lazy(() => import('./pages/Calendar'))
const Activity    = lazy(() => import('./pages/Activity'))
const Hunt        = lazy(() => import('./pages/Hunt'))
const Settings    = lazy(() => import('./pages/Settings'))
const Logs        = lazy(() => import('./pages/Logs'))
const Search      = lazy(() => import('./pages/Search'))
const System      = lazy(() => import('./pages/System'))
const Wanted      = lazy(() => import('./pages/Wanted'))
const History     = lazy(() => import('./pages/History'))
const Stats       = lazy(() => import('./pages/Stats'))
const PlexLibrary = lazy(() => import('./pages/PlexLibrary'))

const queryClient = new QueryClient()

function RouteFallback() {
  return (
    <div className="flex items-center justify-center h-64 text-gray-600 text-sm">
      Loading…
    </div>
  )
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />
}

function AppRoutes() {
  const { isAuthenticated } = useAuth()
  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <Layout />
          </PrivateRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="downloads" element={<Suspense fallback={<RouteFallback />}><Downloads /></Suspense>} />
        <Route path="movies" element={<Suspense fallback={<RouteFallback />}><Movies /></Suspense>} />
        <Route path="tv" element={<Suspense fallback={<RouteFallback />}><TVShows /></Suspense>} />
        <Route path="requests" element={<Suspense fallback={<RouteFallback />}><Requests /></Suspense>} />
        <Route path="indexers" element={<Suspense fallback={<RouteFallback />}><Indexers /></Suspense>} />
        <Route path="arr-manage" element={<Suspense fallback={<RouteFallback />}><ArrManage /></Suspense>} />
        <Route path="music" element={<Suspense fallback={<RouteFallback />}><Music /></Suspense>} />
        <Route path="subtitles" element={<Suspense fallback={<RouteFallback />}><Subtitles /></Suspense>} />
        <Route path="calendar" element={<Suspense fallback={<RouteFallback />}><Calendar /></Suspense>} />
        <Route path="activity" element={<Suspense fallback={<RouteFallback />}><Activity /></Suspense>} />
        <Route path="hunt" element={<Suspense fallback={<RouteFallback />}><Hunt /></Suspense>} />
        <Route path="search" element={<Suspense fallback={<RouteFallback />}><Search /></Suspense>} />
        <Route path="system" element={<Suspense fallback={<RouteFallback />}><System /></Suspense>} />
        <Route path="wanted" element={<Suspense fallback={<RouteFallback />}><Wanted /></Suspense>} />
        <Route path="history" element={<Suspense fallback={<RouteFallback />}><History /></Suspense>} />
        <Route path="stats" element={<Suspense fallback={<RouteFallback />}><Stats /></Suspense>} />
        <Route path="plex" element={<Suspense fallback={<RouteFallback />}><PlexLibrary /></Suspense>} />
        <Route path="settings" element={<Suspense fallback={<RouteFallback />}><Settings /></Suspense>} />
        <Route path="logs" element={<Suspense fallback={<RouteFallback />}><Logs /></Suspense>} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider>
            <ConfigProvider>
              <AppRoutes />
            </ConfigProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  )
}
