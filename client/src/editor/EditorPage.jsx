import { useState, useCallback, useRef } from 'react'
import ProseEditor from './ProseEditor'
import { getLog, getSessionDurationMs } from './sessionLog'
import { hashText } from '../utils/hash'
import Challenge from './challenge'

const STRIKE_LIMIT = 3

function btnStyle(bg, disabled) {
  return {
    background: disabled ? '#9ca3af' : bg,
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '0.5rem 1.25rem',
    fontFamily: 'sans-serif',
    fontSize: '0.95rem',
    cursor: disabled ? 'not-allowed' : 'pointer'
  }
}

export default function EditorPage() {
  const [strikes, setStrikes] = useState(0)
  const [proofUuid, setProofUuid] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [challengeVisible, setChallengeVisible] = useState(false)
  const challengeShown = useRef(false)
  const editorViewRef = useRef(null)
  const txnCount = useRef(0)

  const handleStrike = useCallback(() => {
    setStrikes(s => s + 1)
  }, [])

  const handleTransaction = useCallback(() => {
    txnCount.current += 1
    // Check score periodically every 20 transactions, after minimum data
    if (txnCount.current % 20 !== 0 || txnCount.current < 20) return
    if (challengeShown.current) return

    const view = editorViewRef.current
    if (!view) return
    const text = view.state.doc.textContent
    if (text.length < 150) return

    import('../signals/composite').then(({ computeComposite }) => {
      const log = getLog()
      const { score } = computeComposite(log, text)
      if (score < 0.35) {
        challengeShown.current = true
        setChallengeVisible(true)
      }
    })
  }, [])

  const handleViewReady = useCallback((view) => {
    editorViewRef.current = view
  }, [])

  async function generateProof() {
    const view = editorViewRef.current
    if (!view) return
    setGenerating(true)
    try {
      const finalText = view.state.doc.textContent
      const wordCount = finalText.trim().split(/\s+/).filter(Boolean).length
      const log = getLog()
      const contentHash = await hashText(finalText)
      const sessionDurationMs = getSessionDurationMs()

      const { computeComposite } = await import('../signals/composite')
      const { score, breakdown } = computeComposite(log, finalText)

      const res = await fetch('/api/proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentHash, sessionLog: log, finalText, wordCount, sessionDurationMs, score, scoreBreakdown: breakdown })
      })
      const data = await res.json()
      if (data.uuid) setProofUuid(data.uuid)
      else alert('Proof generation failed: ' + JSON.stringify(data))
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setGenerating(false)
    }
  }

  function exportPlaintext() {
    const view = editorViewRef.current
    if (!view) return
    const text = view.state.doc.textContent
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'document.txt'
    a.click()
  }

  function exportMarkdown() {
    const view = editorViewRef.current
    if (!view) return
    const parts = []
    view.state.doc.forEach(node => {
      if (node.isTextblock) parts.push(node.textContent)
    })
    const md = parts.join('\n\n')
    const blob = new Blob([md], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'document.md'
    a.click()
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '2rem' }}>
      <h1 style={{ fontFamily: 'sans-serif', marginBottom: '0.25rem', fontSize: '1.4rem' }}>Human Proof Editor</h1>
      <p style={{ fontFamily: 'sans-serif', color: '#6b7280', marginBottom: '1.25rem', fontSize: '0.875rem', lineHeight: 1.5 }}>
        Write your text. Paste, copy, and cut are blocked. Generate a proof when done.
      </p>

      {strikes > 0 && (
        <div style={{
          background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 4,
          padding: '0.5rem 1rem', marginBottom: '1rem',
          fontFamily: 'sans-serif', fontSize: '0.875rem', color: '#92400e'
        }}>
          {strikes} strike{strikes !== 1 ? 's' : ''} recorded
          {strikes >= STRIKE_LIMIT ? ' — significant flag in proof' : ''}
        </div>
      )}

      <ProseEditor
        onStrike={handleStrike}
        onTransaction={handleTransaction}
        onViewReady={handleViewReady}
      />

      {challengeVisible && (
        <Challenge onDismiss={() => setChallengeVisible(false)} />
      )}

      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={generateProof} disabled={generating} style={btnStyle('#2563eb', generating)}>
          {generating ? 'Generating...' : 'Generate Proof'}
        </button>
        <button onClick={exportPlaintext} style={btnStyle('#374151', false)}>Export Plaintext</button>
        <button onClick={exportMarkdown} style={btnStyle('#374151', false)}>Export Markdown</button>
      </div>

      {proofUuid && (
        <div style={{
          marginTop: '1rem', fontFamily: 'sans-serif',
          background: '#d1fae5', border: '1px solid #10b981',
          borderRadius: 4, padding: '0.75rem 1rem', fontSize: '0.9rem'
        }}>
          Proof generated:{' '}
          <a href={`/proof/${proofUuid}`} target="_blank" rel="noopener noreferrer" style={{ color: '#065f46' }}>
            /proof/{proofUuid}
          </a>
        </div>
      )}
    </div>
  )
}
