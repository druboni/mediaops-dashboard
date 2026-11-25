import { getConfig } from './routes/config.js'
import { addLog } from './logBuffer.js'

// Sends one alert to every notification channel set up in Settings →
// Notifications. Each channel's failure is logged, never thrown, so one bad
// channel can't block the others. (Library additions use webhooks.js, which
// batches episodes and builds richer Discord embeds.)
export async function sendAlert(title, text, { color = 0xef4444 } = {}) {
  const n = (await getConfig()).notifications ?? {}
  const send = (channel, url, opts) =>
    fetch(url, { ...opts, signal: AbortSignal.timeout(8000) })
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`) })
      .catch((err) => addLog('warn', `[notify] ${channel} failed: ${err.message}`, { service: 'system' }))

  const jobs = []
  if (n.discordWebhookUrl) {
    jobs.push(send('Discord', n.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title, description: text, color }] }),
    }))
  }
  if (n.ntfyEnabled && n.ntfyUrl) {
    jobs.push(send('ntfy', n.ntfyUrl, { method: 'POST', headers: { Title: title, Priority: 'high' }, body: text }))
  }
  if (n.pushoverEnabled && n.pushoverUserKey && n.pushoverApiToken) {
    jobs.push(send('Pushover', 'https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: n.pushoverApiToken, user: n.pushoverUserKey, title, message: text, priority: '1' }),
    }))
  }
  if (n.telegramEnabled && n.telegramBotToken && n.telegramChatId) {
    jobs.push(send('Telegram', `https://api.telegram.org/bot${n.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: n.telegramChatId, text: `${title}\n${text}` }),
    }))
  }
  await Promise.all(jobs)
  return jobs.length
}
