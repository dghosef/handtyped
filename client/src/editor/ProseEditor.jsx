import { useEffect, useRef } from 'react'
import { createEditor } from './prosemirror'
import { initSession } from './sessionLog'
import { initFocusTracker, teardownFocusTracker } from './focusTracker'
import { startAutosave, stopAutosave } from './autosave'

export default function ProseEditor({ onStrike, onTransaction, onViewReady }) {
  const mountRef = useRef(null)

  useEffect(() => {
    initSession()
    const view = createEditor(mountRef.current, onTransaction, onStrike)
    if (onViewReady) onViewReady(view)
    initFocusTracker()
    startAutosave()

    return () => {
      stopAutosave()
      teardownFocusTracker()
      view.destroy()
    }
  }, [])

  return (
    <div
      ref={mountRef}
      style={{
        minHeight: '60vh',
        border: '1px solid #d1d5db',
        padding: '2rem',
        fontSize: '1.1rem',
        lineHeight: 1.8,
        outline: 'none',
        background: '#fff',
        borderRadius: '4px',
        cursor: 'text'
      }}
    />
  )
}
