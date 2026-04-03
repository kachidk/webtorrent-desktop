const fs = require('fs')
const path = require('path')
const parseTorrent = require('parse-torrent')

/**
 * Parse torrent metadata from a magnet URI, 40-char infohash, or .torrent file path.
 * Does not use WebTorrent — safe while another download is active.
 *
 * @param {string} torrentId
 * @param {(err: Error|null, peek: object|null) => void} cb
 */
function peekTorrentId (torrentId, cb) {
  if (typeof torrentId !== 'string' || !torrentId.trim()) {
    return process.nextTick(() => cb(new Error('Invalid torrent id'), null))
  }

  const s = torrentId.trim()

  if (/^magnet:/i.test(s) || /^[a-fA-F0-9]{40}$/.test(s)) {
    try {
      const parsed = parseTorrent(s)
      return process.nextTick(() => cb(null, normalizePeek(parsed)))
    } catch (err) {
      return process.nextTick(() => cb(err, null))
    }
  }

  const filePath = path.resolve(s)
  fs.readFile(filePath, (err, buf) => {
    if (err) return cb(err, null)
    try {
      const parsed = parseTorrent(buf)
      cb(null, normalizePeek(parsed))
    } catch (e) {
      cb(e, null)
    }
  })
}

function normalizePeek (parsed) {
  if (!parsed || !parsed.infoHash) return null
  const infoHash = typeof parsed.infoHash === 'string'
    ? parsed.infoHash
    : Buffer.from(parsed.infoHash).toString('hex')

  const out = {
    infoHash,
    name: parsed.name || null,
    magnetURI: null,
    files: parsed.files || null
  }
  try {
    out.magnetURI = parseTorrent.toMagnetURI(parsed)
  } catch (_) {
    out.magnetURI = null
  }
  return out
}

/**
 * Merge peek result into a torrent summary (queued or about to start).
 */
function applyPeekToSummary (summary, originalTorrentId, peek) {
  if (!peek || !peek.infoHash) return

  summary.infoHash = peek.infoHash
  if (peek.name) {
    summary.name = peek.name
    summary.displayName = peek.name
  }
  if (/^magnet:/i.test(originalTorrentId)) {
    summary.magnetURI = originalTorrentId
  } else if (peek.magnetURI) {
    summary.magnetURI = peek.magnetURI
  }
  if (peek.files && peek.files.length) {
    summary.files = peek.files
    if (!summary.selections) {
      summary.selections = peek.files.map(() => true)
    }
  }
}

module.exports = {
  peekTorrentId,
  applyPeekToSummary
}
