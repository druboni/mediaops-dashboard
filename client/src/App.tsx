import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './store/auth'
import { ConfigProvider } from './store/config'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Downloads from './pages/Downloads'
import Settings from './pages/Settings'
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
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ConfigProvider>
            <AppRoutes />
          </ConfigProvider>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  )
}
