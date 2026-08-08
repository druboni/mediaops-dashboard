export type ServiceName =
  | 'plex'
  | 'sonarr'
  | 'radarr'
  | 'lidarr'
  | 'bazarr'
  | 'overseerr'
  | 'prowlarr'
  | 'jackett'
  | 'qbittorrent'
  | 'nzbget'
  | 'huntarr'
  | 'requestrr'
  | 'tautulli'

export interface ServiceConfig {
  enabled: boolean
  url: string
  apiKey: string
}

export interface QuickLink {
  label: string
  url: string
}

export interface NotificationsConfig {
  discordWebhookUrl: string
  mediaAddedEnabled: boolean
  webhookSecret: string
  ntfyEnabled: boolean
  ntfyUrl: string
  pushoverEnabled: boolean
  pushoverUserKey: string
  pushoverApiToken: string
  telegramEnabled: boolean
  telegramBotToken: string
  telegramChatId: string
}

export type ArrInstanceType = 'sonarr' | 'radarr' | 'lidarr'

export interface ArrInstance {
  id: string
  name: string
  url: string
  apiKey: string
}

export interface Config {
  services: Record<ServiceName, ServiceConfig>
  links?: QuickLink[]
  adminPasswordHash?: string
  autoDeleteAfterImport?: boolean
  notifications?: NotificationsConfig
  additionalInstances?: Record<ArrInstanceType, ArrInstance[]>
}
