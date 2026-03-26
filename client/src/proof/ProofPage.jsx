import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchProof } from './proofApi'
import ScoreBreakdown from './ScoreBreakdown'
import Timeline from './Timeline'
import { getVerdict } from '../signals/composite'

const VERDICT_COLORS = {
  'STRONG HUMAN SIGNAL': '#10b981',
  'LIKELY HUMAN': '#3b82f6',
  'AMBIGUOUS': '#f59e0b',
  'SUSPICIOUS': '#ef4444'
}

export default function ProofPage() {
  const { uuid } = useParams()
  const [proof, setProof] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchProof(uuid).then(setProof).catch(e => setError(e.message))
  }, [uuid])

  if (error) return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', color: '#ef4444' }}>
      Error: {error}
    </div>
  )
  if (!proof) return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', color: '#6b7280' }}>
      Loading...
    </div>
  )

  const strikeCount = proof.scoreBreakdown?.strikeScore?.strikeCount ?? 0
  const verdict = getVerdict(proof.score, strikeCount)
  const verdictColor = VERDICT_COLORS[verdict] ?? '#6b7280'

  const durationMin = (proof.sessionDurationMs / 60000).toFixed(1)
  const ts = new Date(proof.serverTimestamp)
  const tsFormatted = ts.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) +
    ' at ' + ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '2rem 1.5rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontFamily: 'sans-serif', fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.25rem' }}>
          Writing Proof
        </h1>
        <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: '#9ca3af', wordBreak: 'break-all' }}>
          {uuid}
        </div>
      </div>

      {/* Verdict */}
      <div style={{
        background: verdictColor + '18',
        border: `2px solid ${verdictColor}`,
        borderRadius: 8,
        padding: '1.5rem',
        marginBottom: '2rem',
        textAlign: 'center'
      }}>
        <div style={{
          fontSize: '1.6rem', fontWeight: 800, color: verdictColor,
          letterSpacing: '0.06em', fontFamily: 'sans-serif', marginBottom: '0.4rem'
        }}>
          {verdict}
        </div>
        <div style={{ fontSize: '1.1rem', color: '#374151', fontFamily: 'sans-serif' }}>
          Composite score: <strong>{(proof.score * 100).toFixed(1)}%</strong>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
        {[
          { label: 'Words', value: proof.wordCount?.toLocaleString() ?? '-' },
          { label: 'Session length', value: `${durationMin} min` },
          { label: 'Timestamp', value: tsFormatted },
          { label: 'Strikes', value: strikeCount, warn: strikeCount >= 3 }
        ].map(({ label, value, warn }) => (
          <div key={label} style={{
            background: warn ? '#fef3c7' : '#f9fafb',
            border: `1px solid ${warn ? '#f59e0b' : '#e5e7eb'}`,
            borderRadius: 6, padding: '1rem', textAlign: 'center'
          }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: 'sans-serif', color: warn ? '#92400e' : '#111827' }}>
              {value}
            </div>
            <div style={{ color: '#6b7280', fontSize: '0.8rem', fontFamily: 'sans-serif' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Content hash */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontFamily: 'sans-serif', fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
          Content Hash (SHA-256)
        </h2>
        <div style={{
          fontFamily: 'monospace', fontSize: '0.8rem', background: '#f9fafb',
          border: '1px solid #e5e7eb', borderRadius: 4, padding: '0.75rem',
          wordBreak: 'break-all', color: '#374151'
        }}>
          {proof.contentHash}
        </div>
      </div>

      {/* Timeline */}
      <div style={{ marginBottom: '2rem' }}>
        <Timeline sessionLog={proof.sessionLog} />
      </div>

      {/* Score breakdown */}
      <div style={{ marginBottom: '2rem' }}>
        <ScoreBreakdown breakdown={proof.scoreBreakdown} />
      </div>

      {/* Full text */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontFamily: 'sans-serif', fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
          Full Text
        </h2>
        <div style={{
          fontFamily: 'Georgia, serif', lineHeight: 1.8, background: '#fff',
          border: '1px solid #e5e7eb', borderRadius: 4, padding: '1.5rem',
          whiteSpace: 'pre-wrap', fontSize: '1rem', color: '#1a1a1a'
        }}>
          {proof.finalText}
        </div>
      </div>

      {/* Signature */}
      <div style={{
        color: '#9ca3af', fontSize: '0.75rem', fontFamily: 'sans-serif',
        borderTop: '1px solid #e5e7eb', paddingTop: '1rem'
      }}>
        Server signature:{' '}
        <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{proof.signature}</span>
      </div>
    </div>
  )
}
