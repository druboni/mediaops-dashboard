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

// Plain-text equivalent of the Discord embeds above, shared by every other
// channel (ntfy/Pushover/Telegram don't have Discord's embed format).
function plainTextForRadarr(body) {
  const movie = body.movie || {}
  const upgrade = body.isUpgrade ? ' (upgraded)' : ''
  return `New addition to the library\n${movie.title || 'Unknown Movie'}${movie.year ? ` (${movie.year})` : ''}${upgrade}`
}

function plainTextForSonarrBatch(seriesTitle, episodes) {
  return `New addition to the library\n${seriesTitle}\n${episodes.map(episodeLine).join('\n')}`
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

async function sendToNtfy(fastify, ntfyUrl, text) {
  try {
    await fetch(ntfyUrl, {
      method: 'POST',
      headers: { Title: 'New addition to the library' },
      body: text,
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    fastify.log.error({ err }, 'Failed to forward media webhook to ntfy')
  }
}

async function sendToPushover(fastify, userKey, apiToken, text) {
  try {
    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: apiToken, user: userKey, title: 'New addition to the library', message: text }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    fastify.log.error({ err }, 'Failed to forward media webhook to Pushover')
  }
}

async function sendToTelegram(fastify, botToken, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    fastify.log.error({ err }, 'Failed to forward media webhook to Telegram')
  }
}

// Fans a message out to every enabled channel in parallel — each sender
// swallows its own errors (logged, not thrown) so one bad channel can't
// block the others.
function notifyAll(fastify, notif, discordPayload, text) {
  if (notif.discordWebhookUrl) sendToDiscord(fastify, notif.discordWebhookUrl, discordPayload)
  if (notif.ntfyEnabled && notif.ntfyUrl) sendToNtfy(fastify, notif.ntfyUrl, text)
  if (notif.pushoverEnabled && notif.pushoverUserKey && notif.pushoverApiToken) {
    sendToPushover(fastify, notif.pushoverUserKey, notif.pushoverApiToken, text)
  }
  if (notif.telegramEnabled && notif.telegramBotToken && notif.telegramChatId) {
    sendToTelegram(fastify, notif.telegramBotToken, notif.telegramChatId, text)
  }
}

function queueSonarrEpisodes(fastify, notif, series, newEpisodes) {
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
    notifyAll(
      fastify, notif,
      discordPayloadForSonarrBatch(entry.title, entry.episodes),
      plainTextForSonarrBatch(entry.title, entry.episodes),
    )
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
    const anyChannelEnabled = notif.discordWebhookUrl || notif.ntfyEnabled || notif.pushoverEnabled || notif.telegramEnabled
    if (!notif.mediaAddedEnabled || !anyChannelEnabled) return reply.status(200).send()

    const body = request.body || {}
    if (body.eventType !== 'Download') return reply.status(200).send()

    if (body.movie) {
      notifyAll(fastify, notif, discordPayloadForRadarr(body), plainTextForRadarr(body))
    } else if (body.series) {
      queueSonarrEpisodes(fastify, notif, body.series, body.episodes || [])
    }

    return reply.status(200).send()
  })
}
