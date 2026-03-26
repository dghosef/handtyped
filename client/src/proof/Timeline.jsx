export default function Timeline({ sessionLog }) {
  if (!sessionLog?.length) return null

  const txns = sessionLog.filter(e => e.type === 'transaction')
  if (txns.length < 2) return null

  const strikes = sessionLog.filter(e =>
    e.type === 'paste_attempt' || e.type === 'copy_attempt' || e.type === 'cut_attempt'
  )
  const focusLosses = sessionLog.filter(e => e.type === 'focus_loss')

  const start = txns[0].timestamp
  const end = txns[txns.length - 1].timestamp
  const duration = Math.max(1, end - start)

  const W = 760
  const H = 60
  const PAUSE_THRESHOLD = 300

  // Build burst and pause segments
  const segments = []
  let segStart = txns[0]
  for (let i = 1; i < txns.length; i++) {
    const gap = txns[i].timestamp - txns[i - 1].timestamp
    if (gap > PAUSE_THRESHOLD) {
      if (txns[i - 1].timestamp > segStart.timestamp) {
        segments.push({ start: segStart.timestamp, end: txns[i - 1].timestamp, type: 'burst' })
      }
      segments.push({ start: txns[i - 1].timestamp, end: txns[i].timestamp, type: 'pause' })
      segStart = txns[i]
    }
  }
  if (txns[txns.length - 1].timestamp > segStart.timestamp) {
    segments.push({ start: segStart.timestamp, end: txns[txns.length - 1].timestamp, type: 'burst' })
  }

  function toX(ts) { return ((ts - start) / duration) * W }

  const totalMs = end - start
  const minutes = Math.floor(totalMs / 60000)
  const seconds = Math.floor((totalMs % 60000) / 1000)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h3 style={{ fontFamily: 'sans-serif', fontSize: '1rem', fontWeight: 600 }}>Session Timeline</h3>
        <span style={{ fontFamily: 'sans-serif', fontSize: '0.8rem', color: '#9ca3af' }}>
          {minutes}m {seconds}s
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 4, background: '#f9fafb', display: 'block' }}>
          {/* Background */}
          <rect x={0} y={0} width={W} height={H} fill="#f9fafb" />

          {/* Segments */}
          {segments.map((seg, i) => {
            const x1 = toX(seg.start)
            const x2 = toX(seg.end)
            const w = Math.max(1, x2 - x1)
            return (
              <rect key={i}
                x={x1} y={10}
                width={w} height={40}
                fill={seg.type === 'burst' ? '#6ee7b7' : '#e5e7eb'}
              />
            )
          })}

          {/* Strike markers (red vertical lines) */}
          {strikes.map((e, i) => (
            <line key={`s${i}`}
              x1={toX(e.timestamp)} x2={toX(e.timestamp)}
              y1={0} y2={H}
              stroke="#ef4444" strokeWidth={2.5}
            />
          ))}

          {/* Focus loss markers (amber dashed lines) */}
          {focusLosses.map((e, i) => (
            <line key={`f${i}`}
              x1={toX(e.timestamp)} x2={toX(e.timestamp)}
              y1={0} y2={H}
              stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4 3"
            />
          ))}

          {/* Time axis labels */}
          {[0.25, 0.5, 0.75].map(frac => (
            <text key={frac}
              x={W * frac} y={H - 2}
              fill="#9ca3af" fontSize={9} textAnchor="middle"
            >
              {Math.floor(frac * totalMs / 60000)}m{Math.floor((frac * totalMs % 60000) / 1000)}s
            </text>
          ))}
        </svg>
      </div>

      <div style={{
        fontFamily: 'sans-serif', fontSize: '0.8rem', color: '#6b7280',
        marginTop: '0.5rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap'
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span style={{ display: 'inline-block', width: 14, height: 10, background: '#6ee7b7', borderRadius: 2 }} />
          Typing burst
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span style={{ display: 'inline-block', width: 14, height: 10, background: '#e5e7eb', border: '1px solid #d1d5db', borderRadius: 2 }} />
          Pause
        </span>
        {strikes.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ display: 'inline-block', width: 2, height: 12, background: '#ef4444' }} />
            Strike ({strikes.length})
          </span>
        )}
        {focusLosses.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ display: 'inline-block', width: 2, height: 12, background: '#f59e0b' }} />
            Focus loss ({focusLosses.length})
          </span>
        )}
      </div>
    </div>
  )
}
