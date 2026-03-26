export function computeFrontierTracking(log) {
  const txns = log.filter(e => e.type === 'transaction')
  if (!txns.length) return { score: 0.5, totalEdits: 0, behindFrontierEdits: 0, computed: false }

  let frontier = 0
  let totalEdits = 0
  let behindFrontierEdits = 0

  for (const tx of txns) {
    totalEdits++
    if (tx.position < frontier - 100) behindFrontierEdits++
    const endPos = tx.position + (tx.inserted_text || '').length
    if (endPos > frontier) frontier = endPos
  }

  if (totalEdits < 10) return { score: 0.5, totalEdits, behindFrontierEdits, computed: false }

  const revisitRate = behindFrontierEdits / totalEdits
  return { score: revisitRate, totalEdits, behindFrontierEdits, revisitRate, computed: true }
}
