const PAUSE_THRESHOLD_MS = 300
const BOUNDARY_WINDOW = 15 // chars either side of a pause position

export function computePauseTopology(log, finalText) {
  const txns = log.filter(e => e.type === 'transaction')
  if (txns.length < 5) return { score: 0.5, pauseCount: 0, computed: false }

  // Build set of semantic boundary positions in final text
  // A boundary is the position just after a sentence-ending char or paragraph break
  const boundaryPositions = new Set()
  for (let i = 0; i < finalText.length; i++) {
    const ch = finalText[i]
    if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
      boundaryPositions.add(i)
      boundaryPositions.add(i + 1)
    }
    // Also treat comma-space as a minor clause boundary
    if (ch === ',' && finalText[i + 1] === ' ') {
      boundaryPositions.add(i + 1)
    }
  }

  // Identify pauses > threshold
  const pauses = []
  for (let i = 1; i < txns.length; i++) {
    const gap = txns[i].timestamp - txns[i - 1].timestamp
    if (gap > PAUSE_THRESHOLD_MS) {
      pauses.push({ duration: gap, position: txns[i].position })
    }
  }

  if (pauses.length < 3) return { score: 0.5, pauseCount: pauses.length, computed: false }

  const atBoundary = pauses.filter(p => {
    for (let d = -BOUNDARY_WINDOW; d <= BOUNDARY_WINDOW; d++) {
      if (boundaryPositions.has(p.position + d)) return true
    }
    return false
  })

  const score = atBoundary.length / pauses.length

  return {
    score,
    pauseCount: pauses.length,
    boundaryPauses: atBoundary.length,
    pauses,
    computed: true
  }
}
