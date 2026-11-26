// The whole *arr download queue, every page.
//
// Sonarr makes one queue record per episode, so a busy Sonarr (Huntarr grabbing
// season packs, a library being re-downloaded) easily passes 1,000 records.
// Reading only the first page then loses whatever sorts last, which is usually
// the finished downloads waiting to import, and every check built on the queue
// (the Importing panel, blocked-import alerts, "is this torrent still tracked?")
// silently sees an empty or partial list.

const PAGE = 1000
// A runaway total can't turn one request into hundreds.
const MAX_PAGES = 20

/**
 * @param {string} baseUrl  service URL, e.g. http://host:8989
 * @param {string} apiVer   'v3' for Sonarr/Radarr, 'v1' for Lidarr
 * @param {string} apiKey
 * @param {string} [include] extra query string, e.g. 'includeSeries=true&includeEpisode=true'
 * @returns {Promise<object[]>} all queue records; throws if the first page fails
 */
export async function fetchArrQueue(baseUrl, apiVer, apiKey, include = '', timeout = 15000) {
  const base = `${baseUrl.replace(/\/$/, '')}/api/${apiVer}/queue?pageSize=${PAGE}${include ? `&${include}` : ''}`
  const get = async (page) => {
    const res = await fetch(`${base}&page=${page}`, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) throw new Error(`queue HTTP ${res.status}`)
    return res.json()
  }
  const first = await get(1)
  // Older Lidarr builds return a bare array with no paging.
  if (Array.isArray(first)) return first
  const records = [...(first.records ?? [])]
  const pages = Math.min(Math.ceil((first.totalRecords ?? records.length) / PAGE), MAX_PAGES)
  for (let p = 2; p <= pages; p++) {
    const json = await get(p)
    records.push(...(json.records ?? []))
  }
  return records
}
