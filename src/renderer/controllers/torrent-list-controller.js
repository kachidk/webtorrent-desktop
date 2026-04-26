const fs = require('fs')
const path = require('path')
const { ipcRenderer, clipboard } = require('electron')
const remote = require('@electron/remote')

const { dispatch } = require('../lib/dispatcher')
const { TorrentKeyNotFoundError } = require('../lib/errors')
const { peekTorrentId, applyPeekToSummary } = require('../lib/peek-torrent')
const sound = require('../lib/sound')
const TorrentSummary = require('../lib/torrent-summary')

const instantIoRegex = /^(https:\/\/)?instant\.io\/#/

// Controls the torrent list: creating, adding, deleting, & manipulating torrents
module.exports = class TorrentListController {
  constructor (state) {
    this.state = state
  }

  // Adds a torrent to the list. FIFO queue: stays queued until earlier torrents finish.
  // TorrentID can be a magnet URI, infohash, or torrent file: https://git.io/vik9M
  addTorrent (torrentId) {
    if (torrentId.path) {
      // Use path string instead of W3C File object
      torrentId = torrentId.path
    }

    // Trim extra spaces off pasted magnet links
    if (typeof torrentId === 'string') {
      torrentId = torrentId.trim()
    }

    // Allow a instant.io link to be pasted
    if (typeof torrentId === 'string' && instantIoRegex.test(torrentId)) {
      torrentId = torrentId.slice(torrentId.indexOf('#') + 1)
    }

    if (typeof torrentId === 'string' && !torrentId) return

    const torrentKey = this.state.nextTorrentKey++
    const downloadPath = this.state.saved.prefs.downloadPath

    const summary = {
      torrentKey,
      status: 'queued',
      pendingTorrentId: torrentId
    }
    this.state.saved.torrents.push(summary)
    sound.play('ADD')
    dispatch('stateSave')

    peekTorrentId(torrentId, (err, peek) => {
      const s = TorrentSummary.getByKey(this.state, torrentKey)
      if (!s) return

      if (peek && !err) {
        applyPeekToSummary(s, torrentId, peek)
        const duplicate = this.state.saved.torrents.find((t) =>
          t !== s && s.infoHash && TorrentSummary.infoHashesEqual(t.infoHash, s.infoHash))
        if (duplicate) {
          const idx = this.state.saved.torrents.indexOf(s)
          if (idx !== -1) this.state.saved.torrents.splice(idx, 1)
          dispatch('error', 'Cannot add duplicate torrent')
          dispatch('update')
          return
        }
      }

      if (!this.hasEarlierNotFinished(s)) {
        s.status = 'new'
        delete s.pendingTorrentId
        if (this.hasAnyOtherDownloading(torrentKey)) {
          this.pauseOtherActiveTorrents(torrentKey)
        }
        ipcRenderer.send('wt-start-torrenting', torrentKey, torrentId, downloadPath)
      }

      dispatch('update')
      dispatch('stateSave')
    })

    dispatch('backToList')
  }

  // Shows the Create Torrent page with options to seed a given file or folder
  showCreateTorrent (files) {
    // You can only create torrents from the home screen.
    if (this.state.location.url() !== 'home') {
      return dispatch('error', 'Please go back to the torrent list before creating a new torrent.')
    }

    // Files will either be an array of file objects, which we can send directly
    // to the create-torrent screen
    if (files.length === 0 || typeof files[0] !== 'string') {
      this.state.location.go({
        url: 'create-torrent',
        files,
        setup: (cb) => {
          this.state.window.title = 'Create New Torrent'
          cb(null)
        }
      })
      return
    }

    // ... or it will be an array of mixed file and folder paths. We have to walk
    // through all the folders and find the files
    findFilesRecursive(files, (allFiles) => this.showCreateTorrent(allFiles))
  }

  // Creates a new torrent (seed). Queued like downloads when earlier torrents are not finished.
  createTorrent (options) {
    const state = this.state
    const torrentKey = state.nextTorrentKey++
    const summary = {
      torrentKey,
      status: 'queued',
      pendingCreateOptions: options
    }
    state.saved.torrents.push(summary)
    sound.play('ADD')
    dispatch('stateSave')

    if (!this.hasEarlierNotFinished(summary)) {
      summary.status = 'new'
      delete summary.pendingCreateOptions
      if (this.hasAnyOtherDownloading(torrentKey)) {
        this.pauseOtherActiveTorrents(torrentKey)
      }
      ipcRenderer.send('wt-create-torrent', torrentKey, options)
    }

    state.location.cancel()
  }

  // Starts downloading a given torrentSummary (playback may bypass the FIFO queue).
  startTorrentingSummary (torrentKey, opts = {}) {
    const s = TorrentSummary.getByKey(this.state, torrentKey)
    if (!s) throw new TorrentKeyNotFoundError(torrentKey)

    if (s.status === 'queued') {
      return
    }

    const bypassQueue = opts.bypassQueue === true
    if (!bypassQueue && this.hasEarlierNotFinished(s)) {
      return
    }

    const start = () => {
      if (this.hasAnyOtherDownloading(s.torrentKey)) {
        this.pauseOtherActiveTorrents(s.torrentKey)
      }
      ipcRenderer.send('wt-start-torrenting',
        s.torrentKey,
        TorrentSummary.getTorrentId(s),
        s.path,
        s.fileModtimes,
        s.selections)
    }

    // New torrent: give it a path
    if (!s.path) {
      s.path = this.state.saved.prefs.downloadPath
      return start()
    }

    const fileOrFolder = TorrentSummary.getFileOrFolder(s)

    // New torrent: metadata not yet received
    if (!fileOrFolder) return start()

    // Existing torrent: check that the path is still there
    fs.stat(fileOrFolder, err => {
      if (err) {
        s.error = 'path-missing'
        dispatch('backToList')
        return
      }
      start()
    })
  }

  // True if any earlier list entry still needs the queue (still downloading or waiting ahead of this one).
  hasEarlierNotFinished (torrentSummary) {
    const torrents = this.state.saved.torrents
    const i = torrents.indexOf(torrentSummary)
    // indexOf === -1 must block: (-1 <= 0) is true in JS and wrongly treated "no earlier work" before.
    if (i < 0) return true
    if (i === 0) return false
    for (let j = 0; j < i; j++) {
      if (!this.torrentQueueSlotClear(torrents[j])) return true
    }
    return false
  }

  // Earlier slots are "clear" when they are not actively using the download slot:
  // finished, or paused (user paused — next queued torrent may start).
  torrentQueueSlotClear (t) {
    if (!t) return true
    if (t.status === 'finished') return true
    if (t.status === 'paused') return true
    if (t.status === 'downloading' || t.status === 'new' || t.status === 'queued') return false
    if (t.status === 'seeding') return false
    return false
  }

  hasAnyOtherDownloading (keepTorrentKey) {
    const k = String(keepTorrentKey)
    return this.state.saved.torrents.some(
      (t) => String(t.torrentKey) !== k && t.status === 'downloading'
    )
  }

  torrentNeedsDownload (torrentSummary) {
    const p = torrentSummary.progress
    return !p || p.progress < 1
  }

  processDownloadQueue () {
    for (const t of this.state.saved.torrents) {
      if (t.status !== 'queued') continue
      if (this.hasEarlierNotFinished(t)) continue
      if (this.activateQueuedTorrent(t)) return
    }
  }

  reorderTorrent (torrentId, targetTorrentId, position) {
    const torrents = this.state.saved.torrents
    const fromIndex = torrents.findIndex((t) => matchesTorrentId(t, torrentId))
    if (fromIndex === -1) return

    const [torrentSummary] = torrents.splice(fromIndex, 1)
    const targetIndex = torrents.findIndex((t) => matchesTorrentId(t, targetTorrentId))
    if (targetIndex === -1) {
      torrents.splice(fromIndex, 0, torrentSummary)
      return
    }

    const insertIndex = position === 'after' ? targetIndex + 1 : targetIndex
    torrents.splice(insertIndex, 0, torrentSummary)
    this.queueReorderedTorrent(torrentSummary)
    this.activateFirstDownload()
    dispatch('stateSave')
    dispatch('update')
  }

  queueReorderedTorrent (torrentSummary) {
    if (torrentSummary.status === 'finished') return
    if (!this.torrentNeedsDownload(torrentSummary)) return
    if (['downloading', 'paused', 'new'].includes(torrentSummary.status)) {
      torrentSummary.status = 'queued'
      if (torrentSummary.infoHash) {
        ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)
      }
    }
  }

  activateFirstDownload () {
    const torrentSummary = this.state.saved.torrents.find((t) => {
      return ['queued', 'downloading', 'paused', 'new'].includes(t.status) &&
        this.torrentNeedsDownload(t)
    })
    if (!torrentSummary) return

    if (torrentSummary.status === 'downloading') {
      this.pauseOtherActiveTorrents(torrentSummary.torrentKey)
      return
    }

    if (torrentSummary.status === 'queued') {
      this.activateQueuedTorrent(torrentSummary, { queueOthers: true })
      return
    }

    this.queueOtherActiveTorrents(torrentSummary.torrentKey)
    torrentSummary.status = 'new'
    this.startTorrentingSummary(torrentSummary.torrentKey)
  }

  /**
   * Move a queued torrent into WebTorrent (pause any other downloader first).
   * @returns {boolean} true if this summary was started
   */
  activateQueuedTorrent (t, options = {}) {
    const downloadPath = this.state.saved.prefs.downloadPath
    const key = t.torrentKey

    if (t.pendingTorrentId) {
      const id = t.pendingTorrentId
      delete t.pendingTorrentId
      t.status = 'new'
      if (options.queueOthers) {
        this.queueOtherActiveTorrents(key)
      } else if (this.hasAnyOtherDownloading(key)) {
        this.pauseOtherActiveTorrents(key)
      }
      ipcRenderer.send('wt-start-torrenting', key, id, downloadPath)
      if (options.playSound) sound.play('ENABLE')
      return true
    }

    if (t.pendingCreateOptions) {
      const opts = t.pendingCreateOptions
      delete t.pendingCreateOptions
      t.status = 'new'
      if (options.queueOthers) {
        this.queueOtherActiveTorrents(key)
      } else if (this.hasAnyOtherDownloading(key)) {
        this.pauseOtherActiveTorrents(key)
      }
      ipcRenderer.send('wt-create-torrent', key, opts)
      if (options.playSound) sound.play('ENABLE')
      return true
    }

    t.status = 'new'
    if (options.queueOthers) {
      this.queueOtherActiveTorrents(key)
    }
    this.startTorrentingSummary(key)
    if (options.playSound) sound.play('ENABLE')
    return true
  }

  setGlobalTrackers (globalTrackers) {
    ipcRenderer.send('wt-set-global-trackers', globalTrackers)
  }

  // TODO: use torrentKey, not infoHash
  toggleTorrent (infoHash) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (torrentSummary.status === 'finished') {
      return dispatch('error', 'This download is already complete.')
    }
    if (torrentSummary.status === 'queued') {
      if (!this.activateQueuedTorrent(torrentSummary, { playSound: true })) {
        return dispatch('error', 'Torrent is still loading. Try again in a moment.')
      }
      dispatch('update')
      return
    }
    if (torrentSummary.status === 'paused') {
      if (this.hasEarlierNotFinished(torrentSummary)) {
        return dispatch('error', 'Wait for earlier torrents to finish downloading.')
      }
      torrentSummary.status = 'new'
      this.startTorrentingSummary(torrentSummary.torrentKey)
      sound.play('ENABLE')
      return
    }

    this.pauseTorrent(torrentSummary, true)
  }

  pauseAllTorrents () {
    this.state.saved.torrents.forEach((torrentSummary) => {
      if (torrentSummary.status === 'downloading') {
        torrentSummary.status = 'paused'
        ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)
      }
    })
    sound.play('DISABLE')
  }

  resumeAllTorrents () {
    for (const t of this.state.saved.torrents) {
      if (t.status !== 'paused' || !this.torrentNeedsDownload(t)) continue
      if (this.hasEarlierNotFinished(t)) continue
      t.status = 'downloading'
      this.startTorrentingSummary(t.torrentKey)
      sound.play('ENABLE')
      return
    }
  }

  pauseTorrent (torrentSummary, playSound, options = {}) {
    const wasDownloading = torrentSummary.status === 'downloading'
    torrentSummary.status = 'paused'
    ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)

    if (playSound) sound.play('DISABLE')

    if (wasDownloading && !options.skipQueueAdvance) {
      dispatch('processDownloadQueue')
    }
  }

  // Only one torrent may download at a time; pause the rest (no playback queue).
  pauseOtherActiveTorrents (keepTorrentKey) {
    const keep = String(keepTorrentKey)
    this.state.saved.torrents.forEach((torrentSummary) => {
      if (String(torrentSummary.torrentKey) === keep) return
      if (torrentSummary.status === 'downloading') {
        this.pauseTorrent(torrentSummary, false, { skipQueueAdvance: true })
      }
    })
  }

  queueOtherActiveTorrents (keepTorrentKey) {
    const keep = String(keepTorrentKey)
    this.state.saved.torrents.forEach((torrentSummary) => {
      if (String(torrentSummary.torrentKey) === keep) return
      if (torrentSummary.status === 'downloading') {
        torrentSummary.status = 'queued'
        ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)
      }
    })
  }

  prioritizeTorrent (infoHash) {
    this.state.saved.torrents
      .filter(torrent => torrent.status === 'downloading') // Active torrents only.
      .forEach((torrent) => { // Pause all active torrents except the one that started playing.
        if (infoHash === torrent.infoHash) return

        // Pause torrent without playing sounds.
        this.pauseTorrent(torrent, false, { skipQueueAdvance: true })

        this.state.saved.torrentsToResume.push(torrent.infoHash)
      })

    console.log('Playback Priority: paused torrents: ', this.state.saved.torrentsToResume)
  }

  resumePausedTorrents () {
    console.log('Playback Priority: resuming paused torrents')
    if (!this.state.saved.torrentsToResume || !this.state.saved.torrentsToResume.length) return
    const [first] = this.state.saved.torrentsToResume
    this.state.saved.torrentsToResume = []
    // One torrent at a time: resume only the first queued torrent; others stay paused.
    this.toggleTorrent(first)
  }

  toggleTorrentFile (infoHash, index) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (!torrentSummary.selections) return
    torrentSummary.selections[index] = !torrentSummary.selections[index]

    // Let the WebTorrent process know to start or stop fetching that file
    if (torrentSummary.status !== 'paused' && torrentSummary.status !== 'queued' && torrentSummary.status !== 'finished') {
      ipcRenderer.send('wt-select-files', infoHash, torrentSummary.selections)
    }
  }

  confirmDeleteTorrent (infoHash, deleteData) {
    this.state.modal = {
      id: 'remove-torrent-modal',
      infoHash,
      deleteData
    }
  }

  confirmDeleteAllTorrents (deleteData) {
    this.state.modal = {
      id: 'delete-all-torrents-modal',
      deleteData
    }
  }

  deleteTorrent (torrentId, deleteData) {
    const index = this.state.saved.torrents.findIndex((x) => matchesTorrentId(x, torrentId))

    if (index > -1) {
      const summary = this.state.saved.torrents[index]
      deleteTorrentFile(summary, deleteData)

      // remove torrent from saved list
      this.state.saved.torrents.splice(index, 1)
      dispatch('stateSave')
      dispatch('processDownloadQueue')

      // prevent user from going forward to a deleted torrent
      this.state.location.clearForward('player')
      sound.play('DELETE')
    } else {
      throw new TorrentKeyNotFoundError(torrentId)
    }
  }

  deleteAllTorrents (deleteData) {
    // Go back to list before the current playing torrent is deleted
    if (this.state.location.url() === 'player') {
      dispatch('backToList')
    }

    this.state.saved.torrents.forEach((summary) => deleteTorrentFile(summary, deleteData))

    this.state.saved.torrents = []
    dispatch('stateSave')

    // prevent user from going forward to a deleted torrent
    this.state.location.clearForward('player')
    sound.play('DELETE')
  }

  toggleSelectTorrent (infoHash) {
    if (this.state.selectedInfoHash === infoHash) {
      this.state.selectedInfoHash = null
    } else {
      this.state.selectedInfoHash = infoHash
    }
  }

  openTorrentContextMenu (infoHash) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    const menu = new remote.Menu()

    menu.append(new remote.MenuItem({
      label: 'Remove From List',
      click: () => dispatch('confirmDeleteTorrent', torrentSummary.infoHash, false)
    }))

    menu.append(new remote.MenuItem({
      label: 'Remove Data File',
      click: () => dispatch('confirmDeleteTorrent', torrentSummary.infoHash, true)
    }))

    menu.append(new remote.MenuItem({
      type: 'separator'
    }))

    if (torrentSummary.files) {
      menu.append(new remote.MenuItem({
        label: process.platform === 'darwin' ? 'Show in Finder' : 'Show in Folder',
        click: () => showItemInFolder(torrentSummary)
      }))
      menu.append(new remote.MenuItem({
        type: 'separator'
      }))
    }

    menu.append(new remote.MenuItem({
      label: 'Copy Magnet Link to Clipboard',
      click: () => clipboard.writeText(torrentSummary.magnetURI)
    }))

    menu.append(new remote.MenuItem({
      label: 'Copy Instant.io Link to Clipboard',
      click: () => clipboard.writeText(`https://instant.io/#${torrentSummary.infoHash}`)
    }))

    menu.append(new remote.MenuItem({
      label: 'Save Torrent File As...',
      click: () => dispatch('saveTorrentFileAs', torrentSummary.torrentKey),
      enabled: torrentSummary.torrentFileName != null
    }))

    menu.append(new remote.MenuItem({
      type: 'separator'
    }))

    const sortedByName = this.state.saved.prefs.sortByName
    menu.append(new remote.MenuItem({
      label: `${sortedByName ? '✓ ' : ''}Sort by Name`,
      click: () => dispatch('updatePreferences', 'sortByName', !sortedByName)
    }))

    menu.popup({ window: remote.getCurrentWindow() })
  }

  // Takes a torrentSummary or torrentKey
  // Shows a Save File dialog, then saves the .torrent file wherever the user requests
  saveTorrentFileAs (torrentKey) {
    const torrentSummary = TorrentSummary.getByKey(this.state, torrentKey)
    if (!torrentSummary) throw new TorrentKeyNotFoundError(torrentKey)
    const downloadPath = this.state.saved.prefs.downloadPath
    const newFileName = path.parse(torrentSummary.name).name + '.torrent'
    const win = remote.getCurrentWindow()
    const opts = {
      title: 'Save Torrent File',
      defaultPath: path.join(downloadPath, newFileName),
      filters: [
        { name: 'Torrent Files', extensions: ['torrent'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      buttonLabel: 'Save'
    }

    const savePath = remote.dialog.showSaveDialogSync(win, opts)

    if (!savePath) return // They clicked Cancel
    console.log('Saving torrent ' + torrentKey + ' to ' + savePath)
    const torrentPath = TorrentSummary.getTorrentPath(torrentSummary)
    fs.readFile(torrentPath, (err, torrentFile) => {
      if (err) return dispatch('error', err)
      fs.writeFile(savePath, torrentFile, err => {
        if (err) return dispatch('error', err)
      })
    })
  }
}

function matchesTorrentId (torrentSummary, torrentId) {
  const id = String(torrentId)
  return (torrentSummary.torrentKey != null && String(torrentSummary.torrentKey) === id) ||
    torrentSummary.infoHash === id
}

// Recursively finds {name, path, size} for all files in a folder
// Calls `cb` on success, calls `onError` on failure
function findFilesRecursive (paths, cb_) {
  if (paths.length > 1) {
    let numComplete = 0
    const ret = []
    paths.forEach(path => {
      findFilesRecursive([path], fileObjs => {
        ret.push(...fileObjs)
        if (++numComplete === paths.length) {
          ret.sort((a, b) => a.path < b.path ? -1 : Number(a.path > b.path))
          cb_(ret)
        }
      })
    })
    return
  }

  const fileOrFolder = paths[0]
  fs.stat(fileOrFolder, (err, stat) => {
    if (err) return dispatch('error', err)

    // Files: return name, path, and size
    if (!stat.isDirectory()) {
      const filePath = fileOrFolder
      return cb_([{
        name: path.basename(filePath),
        path: filePath,
        size: stat.size
      }])
    }

    // Folders: recurse, make a list of all the files
    const folderPath = fileOrFolder
    fs.readdir(folderPath, (err, fileNames) => {
      if (err) return dispatch('error', err)
      const paths = fileNames.map((fileName) => path.join(folderPath, fileName))
      findFilesRecursive(paths, cb_)
    })
  })
}

function deleteFile (path) {
  if (!path) return
  fs.unlink(path, err => {
    if (err) dispatch('error', err)
  })
}

// Delete all files in a torrent
function moveItemToTrash (torrentSummary) {
  const filePath = TorrentSummary.getFileOrFolder(torrentSummary)
  if (filePath) ipcRenderer.send('moveItemToTrash', filePath)
}

function showItemInFolder (torrentSummary) {
  ipcRenderer.send('showItemInFolder', TorrentSummary.getFileOrFolder(torrentSummary))
}

function deleteTorrentFile (torrentSummary, deleteData) {
  if (torrentSummary.infoHash) {
    ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)
  }

  // remove torrent and poster file
  deleteFile(TorrentSummary.getTorrentPath(torrentSummary))
  deleteFile(TorrentSummary.getPosterPath(torrentSummary))

  // optionally delete the torrent data
  if (deleteData) moveItemToTrash(torrentSummary)
}
