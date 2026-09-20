import { getConfig } from './config.js'
import { addLog } from '../logBuffer.js'

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


// ── Overseerr issue reports ────────────────────────────────────────────────

// Overseerr's own webhook agent posts these. Its default JSON template carries
// notification_type plus an `issue` block; the subject/message fields are
// already human-readable, so they're used directly rather than rebuilt.
const ISSUE_TYPE_LABEL = {
  VIDEO: 'Video', AUDIO: 'Audio', SUBTITLES: 'Subtitles', OTHER: 'Other', NONE: 'Other',
}

const ISSUE_EVENT_TITLE = {
  ISSUE_CREATED: 'New issue reported',
  ISSUE_COMMENT: 'New comment on an issue',
  ISSUE_RESOLVED: 'Issue resolved',
  ISSUE_REOPENED: 'Issue reopened',
}

const ISSUE_COLOR = {
  ISSUE_CREATED: 0xd9534f,
  ISSUE_COMMENT: 0x5bc0de,
  ISSUE_RESOLVED: 0x5cb85c,
  ISSUE_REOPENED: 0xf0ad4e,
}

function issueLines(body) {
  const issue = body.issue || {}
  const type = ISSUE_TYPE_LABEL[issue.issue_type] ?? issue.issue_type ?? 'Other'
  const who =
    issue.reportedBy_username || issue.reported_by_username || issue.reportedBy_email || 'Unknown'
  const lines = [`**${body.subject || 'Unknown title'}**`, `${type} issue reported by ${who}`]
  // Overseerr sends the report text as `message` on creation and the comment
  // body on ISSUE_COMMENT; either way it's the part worth reading.
  if (body.message) lines.push(`> ${String(body.message).slice(0, 500)}`)
  if (body.comment?.comment_message) lines.push(`> ${String(body.comment.comment_message).slice(0, 500)}`)
  return lines
}

function discordPayloadForIssue(body) {
  const event = body.notification_type
  return {
    embeds: [{
      title: ISSUE_EVENT_TITLE[event] ?? 'Issue update',
      description: issueLines(body).join('\n'),
      color: ISSUE_COLOR[event] ?? COLOR,
      timestamp: new Date().toISOString(),
    }],
  }
}

// Strip the Discord-only markdown for the plain-text channels.
const plainTextForIssue = (body) =>
  `${ISSUE_EVENT_TITLE[body.notification_type] ?? 'Issue update'}\n` +
  issueLines(body).join('\n').replace(/\*\*/g, '').replace(/^> /gm, '')

export default async function webhookRoutes(fastify) {

  // Overseerr's webhook agent posts issue events here. Same secret-in-path
  // scheme as the media hook below — Overseerr can't authenticate to us either.
  // Inert until the webhook is actually configured in Overseerr's settings.
  fastify.post('/issue/:secret', async (request, reply) => {
    const config = await getConfig()
    const notif = config.notifications

    if (request.params.secret !== notif.webhookSecret) return reply.status(404).send()

    const anyChannelEnabled =
      notif.discordWebhookUrl || notif.ntfyEnabled || notif.pushoverEnabled || notif.telegramEnabled
    if (!notif.issueReportedEnabled || !anyChannelEnabled) return reply.status(200).send()

    const body = request.body || {}
    const event = body.notification_type

    // TEST_NOTIFICATION arrives when you press "Test" in Overseerr; letting it
    // through is what makes that button meaningful.
    if (event === 'TEST_NOTIFICATION') {
      notifyAll(fastify, notif,
        { embeds: [{ title: 'MediaOps issue webhook', description: 'Test received.', color: COLOR, timestamp: new Date().toISOString() }] },
        'MediaOps issue webhook\nTest received.')
      return reply.status(200).send()
    }

    if (!ISSUE_EVENT_TITLE[event]) return reply.status(200).send()

    addLog('info', `[webhook:overseerr] ${event} — ${body.subject || 'unknown title'}`, {
      event, issueId: body.issue?.issue_id ?? null,
    })
    notifyAll(fastify, notif, discordPayloadForIssue(body), plainTextForIssue(body))
    return reply.status(200).send()
  })

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
