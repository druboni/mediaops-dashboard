import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../store/auth'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    api.post<{ token: string }>('/auth/login', {})
      .then(res => { login(res.data.token); navigate('/') })
      .catch(() => {})
  }, [])

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <p className="text-gray-500 text-sm">Loading…</p>
    </div>
  )
}
