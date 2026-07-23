import { getConfig } from './config.js'

const COLOR = 0xe5a00d

function discordPayloadForRadarr(body) {
  const movie = body.movie || {}
  const upgrade = body.isUpgrade ? ' (upgraded)' : ''
  return {
    embeds: [{
      title: 'New addition to the library',
      description: `**${movie.title || 'Unknown Movie'}**${movie.year ? ` (${movie.year})` : ''}${upgrade}`,
      color: COLOR,
      timestamp: new Date().toISOString(),
    }],
  }
}

function discordPayloadForSonarr(body) {
  const series = body.series || {}
  const upgrade = body.isUpgrade ? ' (upgraded)' : ''
  const lines = (body.episodes || []).map((ep) => {
    const season = String(ep.seasonNumber ?? 0).padStart(2, '0')
    const episode = String(ep.episodeNumber ?? 0).padStart(2, '0')
    return `S${season}E${episode}${ep.title ? ` · ${ep.title}` : ''}`
  })
  return {
    embeds: [{
      title: 'New addition to the library',
      description: `**${series.title || 'Unknown Show'}**${upgrade}\n${lines.join('\n')}`,
      color: COLOR,
      timestamp: new Date().toISOString(),
    }],
  }
}

export default async function webhookRoutes(fastify) {
  // Sonarr/Radarr POST a plain JSON body here on their "On Import" connect trigger.
  // No JWT — neither app can authenticate with ours; the random secret in the path
  // is what keeps this endpoint from being guessable.
  fastify.post('/media/:secret', async (request, reply) => {
    const config = await getConfig()
    const notif = config.notifications

    if (request.params.secret !== notif.webhookSecret) return reply.status(404).send()
    if (!notif.mediaAddedEnabled || !notif.discordWebhookUrl) return reply.status(200).send()

    const body = request.body || {}
    if (body.eventType !== 'Download') return reply.status(200).send()

    const payload = body.movie
      ? discordPayloadForRadarr(body)
      : body.series
        ? discordPayloadForSonarr(body)
        : null
    if (!payload) return reply.status(200).send()

    try {
      await fetch(notif.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      })
    } catch (err) {
      fastify.log.error({ err }, 'Failed to forward media webhook to Discord')
    }

    return reply.status(200).send()
  })
}
