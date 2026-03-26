// Merge raw transaction log entries into higher-level gestures.
// Gesture types: BURST (consecutive insertions), DELETE, SUBSTITUTE (delete+insert at same pos)

const BURST_GAP_MS = 500
const SUBSTITUTE_GAP_MS = 1000

export function mergeGestures(log) {
  const txns = log.filter(e => e.type === 'transaction')
  if (!txns.length) return []

  const gestures = []
  let current = null

  for (const tx of txns) {
    const isInsertion = Boolean(tx.inserted_text) && !tx.deleted_text
    const isDeletion = Boolean(tx.deleted_text) && !tx.inserted_text
    const isBoth = Boolean(tx.inserted_text) && Boolean(tx.deleted_text)

    if (!current) {
      current = startGesture(tx)
      continue
    }

    const gap = tx.timestamp - current.lastTimestamp

    // Atomic substitute (both in one step)
    if (isBoth) {
      gestures.push(finalizeGesture(current))
      current = { type: 'SUBSTITUTE', entries: [tx], lastTimestamp: tx.timestamp, startPosition: tx.position }
      continue
    }

    // Extend DELETE gesture
    if (isDeletion && current.type === 'DELETE' && gap < BURST_GAP_MS) {
      current.entries.push(tx)
      current.lastTimestamp = tx.timestamp
      continue
    }

    // DELETE followed by INSERT at same/nearby position -> SUBSTITUTE
    if (isInsertion && current.type === 'DELETE' && gap < SUBSTITUTE_GAP_MS) {
      current.type = 'SUBSTITUTE'
      current.entries.push(tx)
      current.lastTimestamp = tx.timestamp
      continue
    }

    // Extend BURST gesture (consecutive insertions advancing forward)
    if (isInsertion && current.type === 'BURST' && gap < BURST_GAP_MS) {
      current.entries.push(tx)
      current.lastTimestamp = tx.timestamp
      continue
    }

    // DELETE interrupting a BURST -> close burst, start delete
    if (isDeletion && current.type === 'BURST' && gap < BURST_GAP_MS) {
      gestures.push(finalizeGesture(current))
      current = { type: 'DELETE', entries: [tx], lastTimestamp: tx.timestamp, startPosition: tx.position }
      continue
    }

    // Gap exceeded or incompatible type -> close and start new
    gestures.push(finalizeGesture(current))
    current = startGesture(tx)
  }

  if (current) gestures.push(finalizeGesture(current))
  return gestures
}

function startGesture(tx) {
  const isInsertion = Boolean(tx.inserted_text) && !tx.deleted_text
  const isDeletion = Boolean(tx.deleted_text) && !tx.inserted_text
  const isBoth = Boolean(tx.inserted_text) && Boolean(tx.deleted_text)
  const type = isBoth ? 'SUBSTITUTE' : isDeletion ? 'DELETE' : 'BURST'
  return { type, entries: [tx], lastTimestamp: tx.timestamp, startPosition: tx.position }
}

function finalizeGesture(g) {
  const allInserted = g.entries.map(e => e.inserted_text || '').join('')
  const allDeleted = g.entries.map(e => e.deleted_text || '').join('')
  return {
    type: g.type,
    startTimestamp: g.entries[0].timestamp,
    endTimestamp: g.lastTimestamp,
    position: g.startPosition,
    insertedText: allInserted,
    deletedText: allDeleted,
    entries: g.entries
  }
}
