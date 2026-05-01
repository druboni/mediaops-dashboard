import { createContext, useContext, ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../services/api'
import type { Config, ServiceName } from '../types'
import { useAuth } from './auth'

interface ConfigContextType {
  config: Config | undefined
  isLoading: boolean
  enabledServices: ServiceName[]
  updateConfig: (config: Config) => Promise<Config>
}

const ConfigContext = createContext<ConfigContextType | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  const queryClient = useQueryClient()

  const { data: config, isLoading } = useQuery<Config>({
    queryKey: ['config'],
    queryFn: async () => {
      const res = await api.get<Config>('/config')
      return res.data
    },
    enabled: isAuthenticated,
  })

  const mutation = useMutation({
    mutationFn: async (updated: Config) => {
      const res = await api.put<Config>('/config', updated)
      return res.data
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['config'], data)
    },
  })

  const enabledServices = config
    ? (Object.entries(config.services)
        .filter(([, svc]) => svc.enabled)
        .map(([name]) => name) as ServiceName[])
    : []

  return (
    <ConfigContext.Provider
      value={{ config, isLoading, enabledServices, updateConfig: mutation.mutateAsync }}
    >
      {children}
    </ConfigContext.Provider>
  )
}

export function useConfig() {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfig must be used within ConfigProvider')
  return ctx
}
