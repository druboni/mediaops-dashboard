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
  plexAddedEnabled: boolean
  webhookSecret: string
}

export interface Config {
  services: Record<ServiceName, ServiceConfig>
  links?: QuickLink[]
  adminPasswordHash?: string
  autoDeleteAfterImport?: boolean
  notifications?: NotificationsConfig
}
