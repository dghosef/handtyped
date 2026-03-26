import { useState, useRef } from 'react'
import { logEvent } from './sessionLog'

export default function Challenge({ onDismiss }) {
  const [response, setResponse] = useState('')
  const firstKeyTime = useRef(null)
  const displayTime = useRef(performance.now())

  function handleKeyDown() {
    if (!firstKeyTime.current) {
      firstKeyTime.current = performance.now()
    }
  }

  function handleSubmit() {
    const latencyMs = firstKeyTime.current
      ? firstKeyTime.current - displayTime.current
      : performance.now() - displayTime.current

    logEvent('challenge_response', {
      responseText: response,
      responseLatencyMs: latencyMs,
      wordCount: response.trim().split(/\s+/).filter(Boolean).length
    })
    onDismiss()
  }

  const canSubmit = response.trim().length > 0

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{
        background: '#fff', borderRadius: 8, padding: '2rem', maxWidth: 500, width: '90%',
        fontFamily: 'sans-serif', boxShadow: '0 20px 60px rgba(0,0,0,0.3)'
      }}>
        <h2 style={{ marginBottom: '0.75rem', fontSize: '1.1rem', fontWeight: 600 }}>Quick Check</h2>
        <p style={{ marginBottom: '1.25rem', color: '#374151', lineHeight: 1.6, fontSize: '0.95rem' }}>
          In one sentence, what argument are you making in the paragraph you just finished?
        </p>
        <textarea
          autoFocus
          value={response}
          onChange={e => setResponse(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          style={{
            width: '100%', padding: '0.75rem', fontSize: '1rem',
            border: '1px solid #d1d5db', borderRadius: 4,
            resize: 'vertical', fontFamily: 'Georgia, serif',
            outline: 'none', lineHeight: 1.6
          }}
          placeholder="Type your answer here..."
        />
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            marginTop: '1rem', background: canSubmit ? '#2563eb' : '#9ca3af',
            color: '#fff', border: 'none', borderRadius: 4,
            padding: '0.5rem 1.5rem', fontSize: '1rem',
            cursor: canSubmit ? 'pointer' : 'not-allowed'
          }}
        >
          Continue Writing
        </button>
      </div>
    </div>
  )
}
