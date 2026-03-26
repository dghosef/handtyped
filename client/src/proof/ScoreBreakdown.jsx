function scoreColor(score, computed) {
  if (!computed) return '#9ca3af'
  if (score > 0.7) return '#10b981'
  if (score > 0.4) return '#f59e0b'
  return '#ef4444'
}

export default function ScoreBreakdown({ breakdown }) {
  if (!breakdown) return null

  const signals = [
    {
      key: 'strikeScore',
      label: 'Paste / Copy / Cut Blocking',
      reliability: 'HIGH',
      description: () => {
        const sc = breakdown.strikeScore?.strikeCount ?? 0
        return `${sc} blocked attempt${sc !== 1 ? 's' : ''} logged. ${
          sc === 0 ? 'No attempts were made.' :
          sc < 3 ? 'Some attempts recorded.' :
          'Three or more attempts is a significant flag.'
        }`
      }
    },
    {
      key: 'tabSwitch',
      label: 'Tab Switch Pattern',
      reliability: 'MEDIUM',
      description: () => {
        const ts = breakdown.tabSwitch
        if (!ts) return 'No data.'
        return `${ts.switchCount} focus loss event${ts.switchCount !== 1 ? 's' : ''}. ${
          ts.suspiciousRatio > 0.5 ? 'Many returns were immediately followed by typing bursts, a transcription pattern.' :
          'Tab switch pattern appears normal.'
        }`
      }
    },
    {
      key: 'pauseTopology',
      label: 'Pause Topology',
      reliability: 'MEDIUM',
      description: () => {
        const pt = breakdown.pauseTopology
        if (!pt?.computed) return `Insufficient pauses to analyze (need at least 3). Signal not computed.`
        return `${pt.pauseCount} pause${pt.pauseCount !== 1 ? 's' : ''} detected; ${pt.boundaryPauses ?? 0} fell at sentence or paragraph boundaries. Composition pauses cluster at semantic boundaries; transcription pauses are roughly periodic.`
      }
    },
    {
      key: 'semanticEdit',
      label: 'Semantic Edit Graph',
      reliability: 'HIGH',
      description: () => {
        const se = breakdown.semanticEdit
        if (!se?.computed) return 'Insufficient substitutions to classify (need at least 3). Signal not computed.'
        const mer = ((se.meaningfulEditRate ?? 0) * 100).toFixed(1)
        const tr = ((se.typoRatio ?? 0) * 100).toFixed(0)
        const kl = se.pauseEditKL != null ? se.pauseEditKL.toFixed(2) : 'N/A'
        return `Meaningful edit rate: ${mer}%. Typo ratio: ${tr}%. Pause divergence (KL): ${kl}. Lexical subs: ${se.lexicalSubs ?? 0}, structural rewrites: ${se.structuralRewrites ?? 0}, ideational revisions: ${se.ideationalRevisions ?? 0}. Genuine composition shows organic revision with longer pauses preceding meaningful changes.`
      }
    },
    {
      key: 'frontier',
      label: 'Document Position Frontier',
      reliability: 'MEDIUM',
      description: () => {
        const f = breakdown.frontier
        if (!f?.computed) return 'Insufficient editing data. Signal not computed.'
        return `Revisit rate: ${((f.revisitRate ?? 0) * 100).toFixed(1)}%. Writers composing original text frequently return to earlier positions to revise; transcribers tend to proceed linearly.`
      }
    },
    {
      key: 'typingRhythm',
      label: 'Typing Rhythm Coherence',
      reliability: 'LOW (needs 40+ words)',
      description: () => {
        const tr = breakdown.typingRhythm
        if (!tr?.computed) return `Insufficient qualifying words (${tr?.sampleSize ?? 0} of 40 needed; requires 4+ char words without backspacing, not after a 1s pause). Signal not computed.`
        return `Spearman r = ${tr.correlation?.toFixed(3)}. Expected human composition: -0.3 to -0.6 (common words typed faster). Sample: ${tr.sampleSize} qualifying words.`
      }
    },
    {
      key: 'complexityCalib',
      label: 'Quality-Edit Calibration',
      reliability: 'MODIFIER',
      description: () => {
        const c = breakdown.complexityCalib
        if (!c?.computed) return 'Text too short to measure complexity reliably.'
        return `Text complexity: ${((c.score ?? 0) * 100).toFixed(0)}% (Flesch-Kincaid grade ${c.fk?.toFixed(1)}, TTR ${((c.ttr ?? 0) * 100).toFixed(0)}%). Used to set expected baselines for semantic edit and frontier signals.`
      }
    },
  ]

  if (breakdown.challengeResponse) {
    signals.push({
      key: 'challengeResponse',
      label: 'Challenge-Response',
      reliability: 'HIGH (when triggered)',
      description: () => {
        const cr = breakdown.challengeResponse
        return `Response latency: ${(cr.latencyMs / 1000).toFixed(1)}s to first keystroke. Word count: ${cr.wordCount}. Fast, fluent response to the in-session question is a strong composition signal.`
      }
    })
  }

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <h2 style={{ marginBottom: '1rem', fontSize: '1.2rem' }}>Signal Breakdown</h2>
      {signals.map(sig => {
        const data = breakdown[sig.key]
        const score = data?.score ?? 0.5
        const computed = data?.computed !== false
        const color = scoreColor(score, computed)

        return (
          <div key={sig.key} style={{ marginBottom: '1.25rem', borderBottom: '1px solid #e5e7eb', paddingBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
              <strong style={{ fontSize: '0.95rem' }}>{sig.label}</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                  {computed ? '' : 'not computed'}
                </span>
                <span style={{ fontWeight: 'bold', color }}>{(score * 100).toFixed(0)}%</span>
              </div>
            </div>
            <div style={{ height: 5, background: '#e5e7eb', borderRadius: 3, marginBottom: '0.5rem' }}>
              <div style={{
                height: '100%',
                width: `${score * 100}%`,
                background: color,
                borderRadius: 3,
                opacity: computed ? 1 : 0.4
              }} />
            </div>
            <p style={{ color: '#6b7280', fontSize: '0.875rem', lineHeight: 1.5, marginBottom: '0.25rem' }}>
              {sig.description()}
            </p>
            <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>Reliability: {sig.reliability}</span>
          </div>
        )
      })}
    </div>
  )
}
