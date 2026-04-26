const React = require('react')
const prettyBytes = require('prettier-bytes')

const Checkbox = require('material-ui/Checkbox').default
const Heading = require('../components/heading')
const { dispatch, dispatcher } = require('../lib/dispatcher')

let draggedTorrentId = null
let dropTargetTorrentId = null
let dropPosition = null
let didDrop = false

module.exports = class DownloadingPage extends React.Component {
  render () {
    return (
      <div className='downloading-page'>
        <Heading level={1}>Downloading</Heading>
        {this.renderTorrents()}
      </div>
    )
  }

  renderTorrents () {
    const torrents = this.props.state.saved.torrents.filter((torrentSummary) => {
      return ['queued', 'downloading', 'seeding', 'paused', 'new'].includes(torrentSummary.status)
    })

    if (torrents.length === 0) {
      return (
        <div className='downloading-empty'>
          No active torrent.
        </div>
      )
    }

    return (
      <div className='downloading-list'>
        {torrents.map((torrentSummary) => this.renderTorrent(torrentSummary))}
      </div>
    )
  }

  renderTorrent (torrentSummary) {
    const prog = torrentSummary.progress
    const name = getTorrentName(torrentSummary)
    const status = getTorrentStatus(torrentSummary)
    const torrentId = getTorrentId(torrentSummary)

    return (
      <div
        className='downloading-active'
        data-torrent-id={torrentId}
        key={torrentId}
        onDragEnter={this.handleDragEnter}
        onDragOver={this.handleDragOver}
        onDragLeave={this.handleDragLeave}
        onDrop={(e) => this.handleDrop(e, torrentId)}
      >
        <div className='name ellipsis'>{name}</div>
        <div className='downloading-status-row'>
          {this.renderDownloadCheckbox(torrentSummary)}
          <span className='status'>{status}</span>
          <i
            className='icon downloading-delete-button'
            title='Remove torrent'
            onClick={dispatcher('confirmDeleteTorrent', torrentId, false)}
            role='button'
            aria-label='Remove torrent'
          >
            close
          </i>
        </div>
        {prog ? this.renderProgress(prog) : null}
        <i
          className='icon downloading-item-button'
          draggable
          title='Torrent actions'
          onDragStart={(e) => this.handleDragStart(e, torrentId)}
          onDragEnd={this.handleDragEnd}
          role='button'
          aria-label='Torrent actions'
        >
          drag_handle
        </i>
      </div>
    )
  }

  renderDownloadCheckbox (torrentSummary) {
    const toggleId = torrentSummary.infoHash || torrentSummary.torrentKey
    const isActive = torrentSummary.status === 'downloading'
    return (
      <Checkbox
        className={'control download ' + torrentSummary.status}
        style={{
          display: 'inline-block',
          width: 32
        }}
        iconStyle={{
          width: 20,
          height: 20
        }}
        checked={isActive}
        disabled={!toggleId}
        onClick={stopPropagation}
        onCheck={toggleId ? dispatcher('toggleTorrent', toggleId) : () => {}}
      />
    )
  }

  handleDragStart (e, torrentId) {
    e.stopPropagation()
    draggedTorrentId = torrentId
    dropTargetTorrentId = null
    dropPosition = null
    didDrop = false

    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-webtorrent-torrent-id', torrentId)
    e.dataTransfer.setData('text/plain', torrentId)

    const item = e.currentTarget.closest('.downloading-active')
    if (item) {
      const rect = item.getBoundingClientRect()
      e.dataTransfer.setDragImage(item, rect.width - 12, rect.height / 2)
    }
  }

  handleDragEnd (e) {
    if (!didDrop) {
      const dropTarget = getDropTargetFromPoint(e.clientX, e.clientY)
      if (dropTarget) setDropTargetFromElement(dropTarget, e.clientY)
      reorderDraggedTorrent()
    }
    draggedTorrentId = null
    dropTargetTorrentId = null
    dropPosition = null
    didDrop = false
    clearDropTargets()
  }

  handleDragEnter (e) {
    e.preventDefault()
    setDropTarget(e)
  }

  handleDragOver (e) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(e)
  }

  handleDragLeave (e) {
    if (e.currentTarget.contains(e.relatedTarget)) return
    e.currentTarget.classList.remove('is-drag-over')
  }

  handleDrop (e, targetTorrentId) {
    e.preventDefault()
    setDropTarget(e)
    reorderDraggedTorrent(targetTorrentId)
    didDrop = true
    clearDropTargets()
  }

  renderProgress (prog) {
    const progress = Math.floor(100 * prog.progress)
    const downloaded = prettyBytes(prog.downloaded)
    const total = prettyBytes(prog.length || 0)
    const speeds = []
    if (prog.downloadSpeed > 0) speeds.push('↓ ' + prettyBytes(prog.downloadSpeed) + '/s')
    if (prog.uploadSpeed > 0) speeds.push('↑ ' + prettyBytes(prog.uploadSpeed) + '/s')

    return (
      <div className='progress'>
        <div className='bar'>
          <div className='fill' style={{ width: progress + '%' }} />
        </div>
        <div className='details'>
          {progress}% · {downloaded} / {total}
          {speeds.length ? ' · ' + speeds.join(' ') : ''}
        </div>
      </div>
    )
  }
}

function getTorrentId (torrentSummary) {
  if (torrentSummary.torrentKey != null) return String(torrentSummary.torrentKey)
  return torrentSummary.infoHash
}

function setDropTarget (e) {
  const targetTorrentId = e.currentTarget.dataset.torrentId
  clearDropTargets()
  if (draggedTorrentId && draggedTorrentId !== targetTorrentId) {
    e.currentTarget.classList.add('is-drag-over')
    setDropTargetFromElement(e.currentTarget, e.clientY)
  }
}

function setDropTargetFromElement (item, clientY) {
  const targetTorrentId = item.dataset.torrentId
  if (!draggedTorrentId || !targetTorrentId || draggedTorrentId === targetTorrentId) return

  item.classList.add('is-drag-over')
  dropTargetTorrentId = targetTorrentId
  dropPosition = getDropPosition(item, clientY)
}

function getDropTargetFromPoint (clientX, clientY) {
  if (clientX == null || clientY == null) return null
  const el = document.elementFromPoint(clientX, clientY)
  if (!el) return null
  return el.closest('.downloading-active')
}

function getDropPosition (item, clientY) {
  const rect = item.getBoundingClientRect()
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

function reorderDraggedTorrent (targetTorrentId = dropTargetTorrentId) {
  if (!draggedTorrentId || !targetTorrentId || draggedTorrentId === targetTorrentId) return
  dispatch('reorderTorrent', draggedTorrentId, targetTorrentId, dropPosition || 'after')
}

function clearDropTargets () {
  document.querySelectorAll('.downloading-active.is-drag-over').forEach((item) => {
    item.classList.remove('is-drag-over')
  })
}

function stopPropagation (e) {
  e.stopPropagation()
}

function getTorrentName (torrentSummary) {
  if (torrentSummary.name) return torrentSummary.name
  if (torrentSummary.displayName) return torrentSummary.displayName
  if (torrentSummary.pendingCreateOptions) return torrentSummary.pendingCreateOptions.name
  return 'Loading torrent...'
}

function getTorrentStatus (torrentSummary) {
  if (torrentSummary.status === 'queued') return 'Queued'
  if (torrentSummary.status === 'paused') return 'Paused'
  if (torrentSummary.status === 'downloading') {
    if (!torrentSummary.progress) return 'Downloading'
    if (!torrentSummary.progress.ready) return 'Verifying'
    return 'Downloading'
  }
  if (torrentSummary.status === 'seeding') return 'Seeding'
  return 'Loading torrent info...'
}
