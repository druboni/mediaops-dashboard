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

export interface ServiceConfig {
  enabled: boolean
  url: string
  apiKey: string
}

export interface Config {
  services: Record<ServiceName, ServiceConfig>
  adminPasswordHash?: string
}
