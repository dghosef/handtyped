export function computeTabSwitch(log) {
  const focusLosses = log.filter(e => e.type === 'focus_loss')
  const focusReturns = log.filter(e => e.type === 'focus_return')
  const txns = log.filter(e => e.type === 'transaction')

  if (!focusLosses.length) return { score: 1.0, switchCount: 0, computed: true }

  const meanDuration = focusReturns.length > 0
    ? focusReturns.reduce((sum, e) => sum + (e.duration || 0), 0) / focusReturns.length
    : 0

  // Flag: focus return immediately followed by a burst of typing (transcription pattern)
  // A burst of > 5 transactions within 10 seconds after returning
  let suspiciousReturns = 0
  for (const ret of focusReturns) {
    const burstAfter = txns.filter(tx =>
      tx.timestamp > ret.timestamp && tx.timestamp < ret.timestamp + 10000
    )
    if (burstAfter.length > 5) suspiciousReturns++
  }

  const switchCount = focusLosses.length
  const suspiciousRatio = focusReturns.length > 0 ? suspiciousReturns / focusReturns.length : 0

  // This signal has moderate false positive risk for users who look things up while writing.
  // Penalize gently - suspiciousness ratio matters more than raw count.
  const frequencyPenalty = Math.min(0.3, (switchCount / 20) * 0.3)
  const suspiciousPenalty = suspiciousRatio * 0.4
  const score = Math.max(0.1, 1.0 - frequencyPenalty - suspiciousPenalty)

  return {
    score,
    switchCount,
    meanDuration,
    suspiciousRatio,
    suspiciousReturns,
    computed: switchCount > 0
  }
}
