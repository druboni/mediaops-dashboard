import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './store/auth'
import { ConfigProvider } from './store/config'
import { ThemeProvider } from './store/theme'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Downloads from './pages/Downloads'
import Movies from './pages/Movies'
import TVShows from './pages/TVShows'
import Requests from './pages/Requests'
import Indexers from './pages/Indexers'
import Music from './pages/Music'
import Subtitles from './pages/Subtitles'
import Activity from './pages/Activity'
import Hunt from './pages/Hunt'
import Settings from './pages/Settings'
import Logs from './pages/Logs'
import Layout from './components/Layout'

const queryClient = new QueryClient()

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
        <Route path="downloads" element={<Downloads />} />
        <Route path="movies" element={<Movies />} />
        <Route path="tv" element={<TVShows />} />
        <Route path="requests" element={<Requests />} />
        <Route path="indexers" element={<Indexers />} />
        <Route path="music" element={<Music />} />
        <Route path="subtitles" element={<Subtitles />} />
        <Route path="activity" element={<Activity />} />
        <Route path="hunt" element={<Hunt />} />
        <Route path="settings" element={<Settings />} />
        <Route path="logs" element={<Logs />} />
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
