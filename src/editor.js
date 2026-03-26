import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, toggleMark, setBlockType } from 'prosemirror-commands'
import { schema } from 'prosemirror-schema-basic'
import { invoke } from '@tauri-apps/api/core'
import { initUI, updateWordCount, updateKeystrokeCount, setSaveStatus } from './ui.js'

// ---------------------------------------------------------------------------
// Focus loss tracking
// ---------------------------------------------------------------------------

let _focusLostAt = null

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _focusLostAt = Date.now()
  } else if (_focusLostAt !== null) {
    const duration_ms = Date.now() - _focusLostAt
    _focusLostAt = null
    invoke('log_focus_loss_event', { duration_ms }).catch(console.error)
  }
})

window.addEventListener('blur', () => {
  if (_focusLostAt === null) _focusLostAt = Date.now()
})

window.addEventListener('focus', () => {
  if (_focusLostAt !== null) {
    const duration_ms = Date.now() - _focusLostAt
    _focusLostAt = null
    invoke('log_focus_loss_event', { duration_ms }).catch(console.error)
  }
})

// ---------------------------------------------------------------------------
// ProseMirror setup
// ---------------------------------------------------------------------------

function buildEditor() {
  const state = EditorState.create({
    schema,
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
      keymap(baseKeymap),
    ],
  })

  const view = new EditorView(document.getElementById('editor'), {
    state,
    dispatchTransaction(tr) {
      const newState = view.state.apply(tr)
      view.updateState(newState)
      if (tr.docChanged) {
        updateWordCount(newState.doc.textContent)
      }
    },
    handleDOMEvents: {
      paste(view, event) {
        const text = event.clipboardData?.getData('text/plain') ?? ''
        invoke('log_paste_event', { char_count: text.length }).catch(console.error)
        // Allow paste to proceed (not blocked)
        return false
      },
    },
  })

  return view
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function wireToolbar(view) {
  const { bold, italic } = schema.marks
  const { heading, paragraph } = schema.nodes

  document.getElementById('btn-bold').addEventListener('click', () => {
    toggleMark(bold)(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-italic').addEventListener('click', () => {
    toggleMark(italic)(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-h1').addEventListener('click', () => {
    setBlockType(heading, { level: 1 })(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-h2').addEventListener('click', () => {
    setBlockType(heading, { level: 2 })(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-undo').addEventListener('click', () => {
    undo(view.state, view.dispatch)
    view.focus()
  })
  document.getElementById('btn-redo').addEventListener('click', () => {
    redo(view.state, view.dispatch)
    view.focus()
  })
}

// ---------------------------------------------------------------------------
// Auto-save (every 30s)
// ---------------------------------------------------------------------------

function startAutosave() {
  return setInterval(async () => {
    try {
      await invoke('save_session')
      setSaveStatus(`Saved ${new Date().toLocaleTimeString()}`)
    } catch (e) {
      setSaveStatus('Save failed')
    }
  }, 30_000)
}

// ---------------------------------------------------------------------------
// Keystroke count polling (every 2s)
// ---------------------------------------------------------------------------

function startKeystrokePoller() {
  return setInterval(async () => {
    try {
      const count = await invoke('get_keystroke_count')
      updateKeystrokeCount(count)
    } catch (_) {}
  }, 2_000)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function handleExport(view) {
  const docText = view.state.doc.textContent

  // Serialize doc to HTML for RTF generation in Rust
  const { DOMSerializer } = await import('prosemirror-model')
  const tmp = document.createElement('div')
  const serializer = DOMSerializer.fromSchema(schema)
  tmp.appendChild(serializer.serializeFragment(view.state.doc.content))
  const docHtml = tmp.innerHTML

  try {
    const zipBase64 = await invoke('export_bundle', { doc_text: docText, doc_html: docHtml })
    if (!zipBase64) { alert('Export produced empty bundle'); return }

    const binary = atob(zipBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const blob = new Blob([bytes], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'humanproof-session.zip'
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    alert(`Export failed: ${e}`)
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

initUI()
const view = buildEditor()
wireToolbar(view)
startAutosave()
startKeystrokePoller()

document.getElementById('btn-export').addEventListener('click', () => handleExport(view))
