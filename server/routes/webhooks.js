import { getConfig } from './config.js'

const COLOR = 0xe5a00d

// Sonarr fires one webhook call per imported episode file, even within a single
// season-pack download. Batch episodes per series over a short debounce window
// (reset on each new episode, capped so a steady trickle still flushes eventually)
// so a season import posts one combined Discord message instead of one per episode.
const DEBOUNCE_MS = 30_000
const MAX_WAIT_MS = 3 * 60_000
const pendingSeries = new Map() // seriesId -> { title, episodes, firstSeen, timer }

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

function episodeLine(ep) {
  const season = String(ep.seasonNumber ?? 0).padStart(2, '0')
  const episode = String(ep.episodeNumber ?? 0).padStart(2, '0')
  return `S${season}E${episode}${ep.title ? ` · ${ep.title}` : ''}`
}

function discordPayloadForSonarrBatch(seriesTitle, episodes) {
  return {
    embeds: [{
      title: 'New addition to the library',
      description: `**${seriesTitle}**\n${episodes.map(episodeLine).join('\n')}`,
      color: COLOR,
      timestamp: new Date().toISOString(),
    }],
  }
}

async function sendToDiscord(fastify, discordWebhookUrl, payload) {
  try {
    await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    fastify.log.error({ err }, 'Failed to forward media webhook to Discord')
  }
}

function queueSonarrEpisodes(fastify, discordWebhookUrl, series, newEpisodes) {
  const seriesId = series.id
  let entry = pendingSeries.get(seriesId)
  if (!entry) {
    entry = { title: series.title || 'Unknown Show', episodes: [], firstSeen: Date.now(), timer: null }
    pendingSeries.set(seriesId, entry)
  }
  entry.episodes.push(...newEpisodes)
  clearTimeout(entry.timer)

  const elapsed = Date.now() - entry.firstSeen
  const delay = elapsed >= MAX_WAIT_MS ? 0 : Math.min(DEBOUNCE_MS, MAX_WAIT_MS - elapsed)

  entry.timer = setTimeout(() => {
    pendingSeries.delete(seriesId)
    sendToDiscord(fastify, discordWebhookUrl, discordPayloadForSonarrBatch(entry.title, entry.episodes))
  }, delay)
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

    if (body.movie) {
      sendToDiscord(fastify, notif.discordWebhookUrl, discordPayloadForRadarr(body))
    } else if (body.series) {
      queueSonarrEpisodes(fastify, notif.discordWebhookUrl, body.series, body.episodes || [])
    }

    return reply.status(200).send()
  })
}
