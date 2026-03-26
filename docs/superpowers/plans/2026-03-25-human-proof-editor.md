# Human-Proof Writing Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web-based writing editor that cryptographically proves a human wrote the text by recording a millisecond-level session log, computing behavioral signals, and generating a signed proof artifact with a public permalink.

**Architecture:** React frontend with ProseMirror for rich text editing and transaction-level event capture; Node/Express backend with Postgres for proof storage and signing; signal pipeline runs entirely on the client at proof-generation time; proof artifacts are immutable records stored server-side and publicly viewable via UUID permalink.

**Tech Stack:** React 18, ProseMirror, Node.js/Express, PostgreSQL, pg (node-postgres), crypto (built-in Node), sha256, SUBTLEX-US frequency data (bundled JSON), Anthropic SDK (optional LLM tie-break), Vite (dev server + build)

---

## File Structure

```
editor/
  client/
    index.html
    vite.config.js
    package.json
    src/
      main.jsx                      # React entry point
      App.jsx                       # Top-level router: editor vs proof page
      editor/
        EditorPage.jsx              # Editor page wrapper
        ProseEditor.jsx             # ProseMirror mount + React bridge
        prosemirror.js              # PM schema, plugins, view setup
        sessionLog.js               # Append-only session log + event types
        blockingPlugin.js           # Paste/copy/cut/contextmenu blocking plugin
        focusTracker.js             # Page Visibility API tracker
        autosave.js                 # 30-second autosave to server
        challenge.js                # Challenge-response overlay logic
      signals/
        gestures.js                 # Merge transactions into gestures
        editProfile.js              # Semantic edit graph (step 2-4)
        pauseTopology.js            # Pause boundary analysis
        frontierTracking.js         # Document position frontier
        typingRhythm.js             # SUBTLEX-US Spearman correlation
        tabSwitch.js                # Tab switch pattern analysis
        complexity.js               # Text complexity (FK, TTR, etc.)
        composite.js                # Weighted composite score
        llmLayer.js                 # Anthropic API tie-break
      proof/
        ProofPage.jsx               # Public proof permalink page
        ScoreBreakdown.jsx          # Per-signal score display
        Timeline.jsx                # Typing rhythm visualization
        proofApi.js                 # Client API calls for proof
      data/
        subtlex_us.json             # SUBTLEX-US word frequency data (trimmed)
      utils/
        levenshtein.js              # Levenshtein distance util
        flesch.js                   # Flesch-Kincaid grade level
        kl.js                       # KL divergence util
        hash.js                     # SHA-256 (Web Crypto API)
  server/
    package.json
    index.js                        # Express app entry
    db.js                           # pg pool + migration runner
    migrations/
      001_init.sql                  # sessions + proofs tables
    routes/
      autosave.js                   # POST /api/sessions/:id/autosave
      proof.js                      # POST /api/proof, GET /api/proof/:uuid
    signing.js                      # HMAC-SHA256 signing with SERVER_SECRET
    llm.js                          # Anthropic API call (optional)
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `client/package.json`
- Create: `client/vite.config.js`
- Create: `client/index.html`
- Create: `server/package.json`
- Create: `server/index.js` (stub)

- [ ] **Step 1: Initialize client**

```bash
cd /Users/dghosef/editor
mkdir -p client/src/editor client/src/signals client/src/proof client/src/data client/src/utils
mkdir -p server/routes server/migrations
```

- [ ] **Step 2: Write client/package.json**

```json
{
  "name": "human-proof-editor-client",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "prosemirror-commands": "^1.5.2",
    "prosemirror-history": "^1.3.2",
    "prosemirror-keymap": "^1.2.2",
    "prosemirror-model": "^1.22.3",
    "prosemirror-schema-basic": "^1.2.3",
    "prosemirror-schema-list": "^1.3.0",
    "prosemirror-state": "^1.4.3",
    "prosemirror-view": "^1.33.8",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.23.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.3.1"
  }
}
```

- [ ] **Step 3: Write client/vite.config.js**

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
})
```

- [ ] **Step 4: Write client/index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Human Proof Editor</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Georgia, serif; background: #fafaf8; color: #1a1a1a; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Write server/package.json**

```json
{
  "name": "human-proof-editor-server",
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.26.0",
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "pg": "^8.12.0",
    "uuid": "^10.0.0"
  }
}
```

- [ ] **Step 6: Write server/index.js stub**

```js
const express = require('express')
const cors = require('cors')
const { initDb } = require('./db')
const autosaveRoute = require('./routes/autosave')
const proofRoute = require('./routes/proof')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.use('/api/sessions', autosaveRoute)
app.use('/api/proof', proofRoute)

const PORT = process.env.PORT || 3001

async function start() {
  await initDb()
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
}

start().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 7: Install dependencies**

```bash
cd /Users/dghosef/editor/client && npm install
cd /Users/dghosef/editor/server && npm install
```

- [ ] **Step 8: Commit**

```bash
cd /Users/dghosef/editor
git init
git add -A
git commit -m "chore: scaffold client and server"
```

---

## Task 2: Database + Server Infrastructure

**Files:**
- Create: `server/migrations/001_init.sql`
- Create: `server/db.js`
- Create: `server/signing.js`

- [ ] **Step 1: Write migration**

```sql
-- server/migrations/001_init.sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  partial_log JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proofs (
  uuid TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  session_log JSONB NOT NULL,
  final_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  session_duration_ms DOUBLE PRECISION NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  score_breakdown JSONB NOT NULL,
  server_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signature TEXT NOT NULL
);
```

- [ ] **Step 2: Write server/db.js**

```js
const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://localhost/humanproof'
})

async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations/001_init.sql'), 'utf8')
  await pool.query(sql)
  console.log('Database initialized')
}

module.exports = { pool, initDb }
```

- [ ] **Step 3: Write server/signing.js**

```js
const crypto = require('crypto')

const SECRET = process.env.SERVER_SECRET || 'dev-secret-change-in-production'

function sign(payload) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(JSON.stringify(payload))
    .digest('hex')
}

function verify(payload, sig) {
  return sign(payload) === sig
}

module.exports = { sign, verify }
```

- [ ] **Step 4: Write server/routes/autosave.js**

```js
const express = require('express')
const { pool } = require('../db')
const router = express.Router()

// POST /api/sessions/:id/autosave
router.post('/:id/autosave', async (req, res) => {
  const { id } = req.params
  const { log } = req.body
  if (!Array.isArray(log)) return res.status(400).json({ error: 'log must be array' })

  await pool.query(
    `INSERT INTO sessions (id, partial_log, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET partial_log = $2::jsonb, updated_at = NOW()`,
    [id, JSON.stringify(log)]
  )
  res.json({ ok: true })
})

module.exports = router
```

- [ ] **Step 5: Write server/routes/proof.js**

```js
const express = require('express')
const { v4: uuidv4 } = require('uuid')
const { pool } = require('../db')
const { sign } = require('../signing')
const router = express.Router()

// POST /api/proof
router.post('/', async (req, res) => {
  const { contentHash, sessionLog, finalText, wordCount, sessionDurationMs, score, scoreBreakdown } = req.body
  if (!contentHash || !sessionLog || !finalText) return res.status(400).json({ error: 'missing fields' })

  const uuid = uuidv4()
  const serverTimestamp = new Date().toISOString()

  const payload = { uuid, contentHash, serverTimestamp, score }
  const signature = sign(payload)

  await pool.query(
    `INSERT INTO proofs (uuid, content_hash, session_log, final_text, word_count, session_duration_ms, score, score_breakdown, server_timestamp, signature)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [uuid, contentHash, JSON.stringify(sessionLog), finalText, wordCount, sessionDurationMs, score, JSON.stringify(scoreBreakdown), serverTimestamp, signature]
  )

  res.json({ uuid, serverTimestamp, signature })
})

// GET /api/proof/:uuid
router.get('/:uuid', async (req, res) => {
  const { uuid } = req.params
  const { rows } = await pool.query('SELECT * FROM proofs WHERE uuid = $1', [uuid])
  if (!rows.length) return res.status(404).json({ error: 'not found' })
  const row = rows[0]
  res.json({
    uuid: row.uuid,
    contentHash: row.content_hash,
    finalText: row.final_text,
    wordCount: row.word_count,
    sessionDurationMs: row.session_duration_ms,
    score: row.score,
    scoreBreakdown: row.score_breakdown,
    serverTimestamp: row.server_timestamp,
    signature: row.signature,
    sessionLog: row.session_log
  })
})

module.exports = router
```

- [ ] **Step 6: Create local Postgres database**

```bash
createdb humanproof
```

- [ ] **Step 7: Start server and verify it starts**

```bash
cd /Users/dghosef/editor/server && node index.js &
# Should print: Database initialized, Server running on port 3001
curl http://localhost:3001/api/proof/nonexistent-uuid
# Should return: {"error":"not found"}
```

- [ ] **Step 8: Commit**

```bash
cd /Users/dghosef/editor
git add -A
git commit -m "feat: add database schema and proof/autosave API routes"
```

---

## Task 3: Session Log Data Model

**Files:**
- Create: `client/src/editor/sessionLog.js`

- [ ] **Step 1: Write sessionLog.js**

The session log is append-only. All entries share `timestamp: performance.now()`.

```js
// client/src/editor/sessionLog.js

let _log = []
let _sessionId = null
let _sessionStart = null

export function initSession() {
  _log = []
  _sessionId = crypto.randomUUID()
  _sessionStart = performance.now()
  return _sessionId
}

export function getSessionId() { return _sessionId }
export function getLog() { return _log }
export function getSessionDurationMs() { return performance.now() - _sessionStart }

export function logTransaction({ position, deletedText, insertedText, surroundingBefore, surroundingAfter }) {
  _log.push({
    type: 'transaction',
    timestamp: performance.now(),
    position,
    deleted_text: deletedText,
    inserted_text: insertedText,
    surrounding_before: surroundingBefore,
    surrounding_after: surroundingAfter
  })
}

export function logEvent(type, extra = {}) {
  _log.push({ type, timestamp: performance.now(), ...extra })
}
```

- [ ] **Step 2: Verify log is append-only by reviewing the code** - there must be no mutation of existing entries, only push calls.

- [ ] **Step 3: Commit**

```bash
git add client/src/editor/sessionLog.js
git commit -m "feat: append-only session log data model"
```

---

## Task 4: ProseMirror Editor Setup

**Files:**
- Create: `client/src/editor/prosemirror.js`
- Create: `client/src/editor/ProseEditor.jsx`

- [ ] **Step 1: Write prosemirror.js**

```js
// client/src/editor/prosemirror.js
import { Schema } from 'prosemirror-model'
import { schema as basicSchema } from 'prosemirror-schema-basic'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { logTransaction } from './sessionLog'
import { createBlockingPlugin } from './blockingPlugin'

function extractContext(doc, pos, windowSize = 50) {
  const fullText = doc.textContent
  const before = fullText.slice(Math.max(0, pos - windowSize), pos)
  const after = fullText.slice(pos, pos + windowSize)
  return { before, after }
}

function makeTransactionPlugin(onTransaction) {
  return {
    key: null,
    props: {},
    filterTransaction: null,
    appendTransaction: null,
  }
}

export function createEditor(domNode, onTransaction, onStrike) {
  const state = EditorState.create({
    schema: basicSchema,
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
      keymap(baseKeymap),
      createBlockingPlugin(onStrike),
    ]
  })

  const view = new EditorView(domNode, {
    state,
    dispatchTransaction(tr) {
      if (tr.docChanged) {
        const oldDoc = view.state.doc
        tr.steps.forEach((step, i) => {
          const stepMap = step.getMap()
          stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
            const deletedText = oldDoc.textBetween(oldStart, oldEnd, '\n', '')
            const insertedText = tr.docs[i] ? tr.docs[i].textBetween(newStart, newEnd, '\n', '') : ''
            const { before, after } = extractContext(oldDoc, oldStart)
            logTransaction({
              position: newStart,
              deletedText,
              insertedText,
              surroundingBefore: before,
              surroundingAfter: after
            })
          })
        })
        if (onTransaction) onTransaction(tr)
      }
      const newState = view.state.apply(tr)
      view.updateState(newState)
    }
  })

  return view
}
```

- [ ] **Step 2: Write ProseEditor.jsx**

```jsx
// client/src/editor/ProseEditor.jsx
import { useEffect, useRef } from 'react'
import { createEditor } from './prosemirror'
import { initSession } from './sessionLog'
import { initFocusTracker } from './focusTracker'
import { startAutosave, stopAutosave } from './autosave'

export default function ProseEditor({ onStrike, onTransaction }) {
  const mountRef = useRef(null)
  const viewRef = useRef(null)

  useEffect(() => {
    initSession()
    const view = createEditor(mountRef.current, onTransaction, onStrike)
    viewRef.current = view
    initFocusTracker()
    startAutosave()

    return () => {
      stopAutosave()
      view.destroy()
    }
  }, [])

  return (
    <div
      ref={mountRef}
      style={{
        minHeight: '60vh',
        border: '1px solid #ccc',
        padding: '2rem',
        fontSize: '1.1rem',
        lineHeight: 1.8,
        outline: 'none',
        background: '#fff',
        borderRadius: '4px'
      }}
    />
  )
}
```

- [ ] **Step 3: Start the dev server and verify ProseMirror mounts**

```bash
cd /Users/dghosef/editor/client
# First write a minimal src/main.jsx and App.jsx (see Task 5) then:
npm run dev
# Open browser to http://localhost:5173 and verify text can be typed
```

- [ ] **Step 4: Commit**

```bash
git add client/src/editor/prosemirror.js client/src/editor/ProseEditor.jsx
git commit -m "feat: ProseMirror editor with transaction logging"
```

---

## Task 5: Blocking Plugin + Focus Tracker

**Files:**
- Create: `client/src/editor/blockingPlugin.js`
- Create: `client/src/editor/focusTracker.js`

- [ ] **Step 1: Write blockingPlugin.js**

```js
// client/src/editor/blockingPlugin.js
import { Plugin } from 'prosemirror-state'
import { logEvent } from './sessionLog'

export function createBlockingPlugin(onStrike) {
  return new Plugin({
    props: {
      handleDOMEvents: {
        paste(view, event) {
          event.preventDefault()
          logEvent('paste_attempt')
          if (onStrike) onStrike('paste')
          return true
        },
        copy(view, event) {
          event.preventDefault()
          logEvent('copy_attempt')
          if (onStrike) onStrike('copy')
          return true
        },
        cut(view, event) {
          event.preventDefault()
          logEvent('cut_attempt')
          if (onStrike) onStrike('cut')
          return true
        },
        contextmenu(view, event) {
          event.preventDefault()
          return true
        }
      }
    }
  })
}
```

- [ ] **Step 2: Write focusTracker.js**

```js
// client/src/editor/focusTracker.js
import { logEvent } from './sessionLog'

let _focusLossStart = null

export function initFocusTracker() {
  document.addEventListener('visibilitychange', handleVisibility)
}

export function teardownFocusTracker() {
  document.removeEventListener('visibilitychange', handleVisibility)
}

function handleVisibility() {
  if (document.hidden) {
    _focusLossStart = performance.now()
    logEvent('focus_loss')
  } else {
    const duration = _focusLossStart != null ? performance.now() - _focusLossStart : 0
    _focusLossStart = null
    logEvent('focus_return', { duration })
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/editor/blockingPlugin.js client/src/editor/focusTracker.js
git commit -m "feat: paste/copy/cut blocking plugin and focus loss tracker"
```

---

## Task 6: Autosave + Main App Shell

**Files:**
- Create: `client/src/editor/autosave.js`
- Create: `client/src/main.jsx`
- Create: `client/src/App.jsx`
- Create: `client/src/editor/EditorPage.jsx`

- [ ] **Step 1: Write autosave.js**

```js
// client/src/editor/autosave.js
import { getLog, getSessionId } from './sessionLog'

let _timer = null

export function startAutosave(intervalMs = 30000) {
  _timer = setInterval(async () => {
    const id = getSessionId()
    const log = getLog()
    if (!id || !log.length) return
    try {
      await fetch(`/api/sessions/${id}/autosave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log })
      })
    } catch (e) {
      console.warn('Autosave failed', e)
    }
  }, intervalMs)
}

export function stopAutosave() {
  if (_timer) clearInterval(_timer)
}
```

- [ ] **Step 2: Write client/src/main.jsx**

```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
)
```

- [ ] **Step 3: Write client/src/App.jsx**

```jsx
import { Routes, Route } from 'react-router-dom'
import EditorPage from './editor/EditorPage'
import ProofPage from './proof/ProofPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<EditorPage />} />
      <Route path="/proof/:uuid" element={<ProofPage />} />
    </Routes>
  )
}
```

- [ ] **Step 4: Write EditorPage.jsx**

```jsx
// client/src/editor/EditorPage.jsx
import { useState, useCallback } from 'react'
import ProseEditor from './ProseEditor'
import { getLog, getSessionDurationMs } from './sessionLog'
import { computeComposite } from '../signals/composite'
import { hashText } from '../utils/hash'
import Challenge from './challenge'

const STRIKE_LIMIT = 3

export default function EditorPage() {
  const [strikes, setStrikes] = useState(0)
  const [proofUuid, setProofUuid] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [challengeVisible, setChallengeVisible] = useState(false)
  const [editorView, setEditorView] = useState(null)

  const handleStrike = useCallback((type) => {
    setStrikes(s => s + 1)
  }, [])

  const handleTransaction = useCallback((tr) => {
    // placeholder for running score monitoring
  }, [])

  async function generateProof() {
    if (!editorView) return
    setGenerating(true)
    try {
      const finalText = editorView.state.doc.textContent
      const wordCount = finalText.trim().split(/\s+/).filter(Boolean).length
      const log = getLog()
      const contentHash = await hashText(finalText)
      const sessionDurationMs = getSessionDurationMs()
      const { score, breakdown } = computeComposite(log, finalText)

      const res = await fetch('/api/proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentHash, sessionLog: log, finalText, wordCount, sessionDurationMs, score, scoreBreakdown: breakdown })
      })
      const { uuid } = await res.json()
      setProofUuid(uuid)
    } finally {
      setGenerating(false)
    }
  }

  function exportPlaintext() {
    if (!editorView) return
    const text = editorView.state.doc.textContent
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'document.txt'
    a.click()
  }

  function exportMarkdown() {
    if (!editorView) return
    // Simple conversion: paragraphs separated by blank lines
    const parts = []
    editorView.state.doc.forEach(node => {
      if (node.isTextblock) parts.push(node.textContent)
    })
    const md = parts.join('\n\n')
    const blob = new Blob([md], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'document.md'
    a.click()
  }

  const verdictLabel = strikes >= STRIKE_LIMIT ? ' (3+ strikes)' : ''

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '2rem' }}>
      <h1 style={{ fontFamily: 'sans-serif', marginBottom: '0.5rem' }}>Human Proof Editor</h1>
      <p style={{ fontFamily: 'sans-serif', color: '#666', marginBottom: '1rem', fontSize: '0.9rem' }}>
        Write your text below. Paste, copy, and cut are blocked. When done, generate a cryptographic proof.
      </p>

      {strikes > 0 && (
        <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 4, padding: '0.5rem 1rem', marginBottom: '1rem', fontFamily: 'sans-serif', fontSize: '0.9rem' }}>
          Strikes: {strikes}{verdictLabel}
        </div>
      )}

      <ProseEditor
        onStrike={handleStrike}
        onTransaction={handleTransaction}
        onViewReady={setEditorView}
      />

      {challengeVisible && (
        <Challenge onDismiss={() => setChallengeVisible(false)} />
      )}

      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
        <button onClick={generateProof} disabled={generating} style={btnStyle('#2563eb')}>
          {generating ? 'Generating...' : 'Generate Proof'}
        </button>
        <button onClick={exportPlaintext} style={btnStyle('#374151')}>Export Plaintext</button>
        <button onClick={exportMarkdown} style={btnStyle('#374151')}>Export Markdown</button>
      </div>

      {proofUuid && (
        <div style={{ marginTop: '1rem', fontFamily: 'sans-serif', background: '#d1fae5', border: '1px solid #10b981', borderRadius: 4, padding: '0.75rem 1rem' }}>
          Proof generated: <a href={`/proof/${proofUuid}`} target="_blank" rel="noopener noreferrer">/proof/{proofUuid}</a>
        </div>
      )}
    </div>
  )
}

function btnStyle(bg) {
  return {
    background: bg,
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '0.5rem 1.25rem',
    fontFamily: 'sans-serif',
    fontSize: '0.95rem',
    cursor: 'pointer'
  }
}
```

- [ ] **Step 5: Update ProseEditor.jsx to call onViewReady**

```jsx
// client/src/editor/ProseEditor.jsx
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
        borderRadius: '4px'
      }}
    />
  )
}
```

- [ ] **Step 6: Start dev server and verify editor renders, typing works, paste is blocked**

```bash
cd /Users/dghosef/editor/client && npm run dev
# Open http://localhost:5173
# Type text - should work
# Try Ctrl+V - should be blocked and show strike counter increment
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: autosave, app shell, and editor page with strike counter"
```

---

## Task 7: Utility Functions

**Files:**
- Create: `client/src/utils/levenshtein.js`
- Create: `client/src/utils/flesch.js`
- Create: `client/src/utils/kl.js`
- Create: `client/src/utils/hash.js`

- [ ] **Step 1: Write levenshtein.js**

```js
// client/src/utils/levenshtein.js
export function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i-1][j-1]
      else dp[i][j] = 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
    }
  }
  return dp[m][n]
}
```

- [ ] **Step 2: Write flesch.js**

```js
// client/src/utils/flesch.js

function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!word.length) return 0
  const vowels = word.match(/[aeiou]+/g)
  let count = vowels ? vowels.length : 1
  if (word.endsWith('e') && count > 1) count--
  return Math.max(1, count)
}

export function fleschKincaidGrade(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0)
  const words = text.match(/\b\w+\b/g) || []
  if (!words.length || !sentences.length) return 0
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0)
  const wordsPerSentence = words.length / sentences.length
  const syllablesPerWord = syllables / words.length
  return 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59
}

export function typeTokenRatio(text) {
  const words = (text.match(/\b[a-z]+\b/gi) || []).map(w => w.toLowerCase())
  if (!words.length) return 0
  return new Set(words).size / words.length
}

export function meanSentenceLength(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0)
  const words = text.match(/\b\w+\b/g) || []
  if (!sentences.length) return 0
  return words.length / sentences.length
}

export function subordinateClauseDensity(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0)
  if (!sentences.length) return 0
  const subordinators = /\b(although|because|since|while|when|if|unless|until|after|before|though|whereas|whether|which|that|who|whom)\b/gi
  const commas = (text.match(/,/g) || []).length
  const subMatches = (text.match(subordinators) || []).length
  return (commas + subMatches) / sentences.length
}
```

- [ ] **Step 3: Write kl.js**

```js
// client/src/utils/kl.js
// KL divergence D_KL(P || Q) between two arrays of numbers (treated as samples)
// Uses binned histogram approach with 10 bins

export function klDivergence(p, q) {
  if (!p.length || !q.length) return 0
  const allVals = [...p, ...q]
  const min = Math.min(...allVals)
  const max = Math.max(...allVals)
  if (min === max) return 0

  const BINS = 10
  const binSize = (max - min) / BINS

  function histogram(arr) {
    const counts = new Array(BINS).fill(0)
    arr.forEach(v => {
      const bin = Math.min(BINS - 1, Math.floor((v - min) / binSize))
      counts[bin]++
    })
    return counts.map(c => (c + 1e-10) / arr.length) // smoothed
  }

  const ph = histogram(p)
  const qh = histogram(q)

  return ph.reduce((sum, pi, i) => sum + pi * Math.log(pi / qh[i]), 0)
}
```

- [ ] **Step 4: Write hash.js**

```js
// client/src/utils/hash.js
export async function hashText(text) {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/utils/
git commit -m "feat: utility functions (levenshtein, flesch, KL divergence, SHA-256)"
```

---

## Task 8: SUBTLEX-US Data

**Files:**
- Create: `client/src/data/subtlex_us.json` (trimmed - top 20k words by frequency)

- [ ] **Step 1: Download and trim SUBTLEX-US**

SUBTLEX-US is available from multiple academic sources. We need a JSON mapping `word -> log10_frequency`. The file should contain the top ~20,000 most frequent English words.

```bash
# Download from the Ghent University mirror (publicly available)
# The raw file is a tab-separated text file. We convert it to JSON.
cd /Users/dghosef/editor/client/src/data

# Option A: Download raw SUBTLEX-US and convert
# The file format is: Word\tFREQcount\tCDcount\tFREQlow\tCDlow\tSUBTLEXus\tLog10SUBTLEX\tPOS\tAll_PoS_SUBTLEX\tAll_freqs_SUBTLEX\tDom_PoS_SUBTLEX\tFrequency_at_SUBTLEX_max\tConcrete\tSentenceCount
# We want: word -> Log10SUBTLEX

# Create a Python script to generate the JSON:
cat > /tmp/gen_subtlex.py << 'PYEOF'
import json, urllib.request, io

url = "https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus/subtlexus2.zip"
# If that URL is unavailable, the data needs to be sourced manually.
# For now create a minimal seed file with top English words and approximate frequencies
# This ensures the app works even without the full dataset.

words = {
  "the": 7.0, "be": 6.8, "to": 6.7, "of": 6.7, "and": 6.6, "a": 6.9, "in": 6.5,
  "that": 6.3, "have": 6.2, "it": 6.4, "for": 6.2, "not": 6.1, "on": 6.1, "with": 6.1,
  "he": 6.1, "as": 6.0, "you": 6.3, "do": 6.0, "at": 6.0, "this": 6.1, "but": 5.9,
  "his": 5.9, "by": 5.8, "from": 5.8, "they": 5.9, "we": 5.9, "say": 5.7, "her": 5.7,
  "she": 5.8, "or": 5.8, "an": 5.9, "will": 5.7, "my": 5.7, "one": 5.7, "all": 5.7,
  "would": 5.7, "there": 5.7, "their": 5.7, "what": 5.7, "so": 5.7, "up": 5.6, "out": 5.6,
  "if": 5.7, "about": 5.5, "who": 5.5, "get": 5.5, "which": 5.5, "go": 5.6, "me": 5.5,
  "when": 5.5, "make": 5.4, "can": 5.5, "like": 5.4, "time": 5.4, "no": 5.5, "just": 5.4,
  "him": 5.4, "know": 5.4, "take": 5.3, "people": 5.3, "into": 5.3, "year": 5.3, "your": 5.4,
  "good": 5.3, "some": 5.4, "could": 5.3, "them": 5.3, "see": 5.3, "other": 5.2, "than": 5.3,
  "then": 5.3, "now": 5.2, "look": 5.2, "only": 5.2, "come": 5.2, "its": 5.2, "over": 5.2,
  "think": 5.2, "also": 5.1, "back": 5.2, "after": 5.1, "use": 5.1, "two": 5.1, "how": 5.1,
  "our": 5.1, "work": 5.1, "first": 5.1, "well": 5.1, "way": 5.1, "even": 5.0, "new": 5.1,
  "want": 5.0, "because": 5.0, "any": 5.0, "these": 5.0, "give": 4.9, "day": 5.0, "most": 5.0
}

with open('subtlex_us.json', 'w') as f:
  json.dump(words, f)
print(f"Wrote {len(words)} words")
PYEOF
python3 /tmp/gen_subtlex.py
```

Note: The full SUBTLEX-US dataset provides more accurate frequency data. The seed above covers the top ~100 most frequent words. The typing rhythm signal requires 40+ qualifying words (4+ chars, no internal backspaces, no prior pause > 1s). For texts with uncommon vocabulary the signal will gracefully degrade due to insufficient qualifying words. If the full dataset is available at build time it should replace this seed.

- [ ] **Step 2: Verify file exists and is valid JSON**

```bash
cd /Users/dghosef/editor/client/src/data
node -e "const d = require('./subtlex_us.json'); console.log('Words:', Object.keys(d).length)"
```

- [ ] **Step 3: Commit**

```bash
git add client/src/data/subtlex_us.json
git commit -m "feat: SUBTLEX-US word frequency seed data"
```

---

## Task 9: Gesture Merging (Signal Foundation)

**Files:**
- Create: `client/src/signals/gestures.js`

- [ ] **Step 1: Write gestures.js**

```js
// client/src/signals/gestures.js
// Merges raw transaction log entries into gestures.

const BURST_GAP_MS = 500
const SUBSTITUTE_GAP_MS = 1000

export function mergeGestures(log) {
  const txns = log.filter(e => e.type === 'transaction')
  if (!txns.length) return []

  const gestures = []
  let current = null

  for (const tx of txns) {
    const isInsertion = tx.inserted_text && !tx.deleted_text
    const isDeletion = tx.deleted_text && !tx.inserted_text
    const isBoth = tx.inserted_text && tx.deleted_text

    if (!current) {
      current = startGesture(tx)
      continue
    }

    const gap = tx.timestamp - current.lastTimestamp

    if (isBoth) {
      // Always a new SUBSTITUTE gesture
      if (current) gestures.push(finalizeGesture(current))
      current = { type: 'SUBSTITUTE', entries: [tx], lastTimestamp: tx.timestamp, startPosition: tx.position }
      continue
    }

    if (isDeletion && current.type === 'DELETE' && gap < BURST_GAP_MS) {
      current.entries.push(tx)
      current.lastTimestamp = tx.timestamp
      continue
    }

    if (isDeletion && current.type === 'BURST' && gap < BURST_GAP_MS) {
      // DELETE after BURST - could become substitute if INSERT follows
      gestures.push(finalizeGesture(current))
      current = { type: 'DELETE', entries: [tx], lastTimestamp: tx.timestamp, startPosition: tx.position }
      continue
    }

    if (isInsertion && current.type === 'DELETE' && gap < SUBSTITUTE_GAP_MS) {
      // DELETE -> INSERT at same/near position = SUBSTITUTE
      current.type = 'SUBSTITUTE'
      current.entries.push(tx)
      current.lastTimestamp = tx.timestamp
      continue
    }

    if (isInsertion && current.type === 'BURST' && gap < BURST_GAP_MS && tx.position >= current.startPosition) {
      current.entries.push(tx)
      current.lastTimestamp = tx.timestamp
      continue
    }

    // Gap exceeded or type mismatch - start new gesture
    gestures.push(finalizeGesture(current))
    current = startGesture(tx)
  }

  if (current) gestures.push(finalizeGesture(current))
  return gestures
}

function startGesture(tx) {
  const isInsertion = tx.inserted_text && !tx.deleted_text
  const isDeletion = tx.deleted_text && !tx.inserted_text
  const isBoth = tx.inserted_text && tx.deleted_text
  const type = isBoth ? 'SUBSTITUTE' : isDeletion ? 'DELETE' : 'BURST'
  return { type, entries: [tx], lastTimestamp: tx.timestamp, startPosition: tx.position }
}

function finalizeGesture(g) {
  const allInserted = g.entries.map(e => e.inserted_text || '').join('')
  const allDeleted = g.entries.map(e => e.deleted_text || '').join('')
  return {
    type: g.type,
    startTimestamp: g.entries[0].timestamp,
    endTimestamp: g.lastTimestamp,
    position: g.startPosition,
    insertedText: allInserted,
    deletedText: allDeleted,
    entries: g.entries
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/signals/gestures.js
git commit -m "feat: transaction-to-gesture merging"
```

---

## Task 10: Semantic Edit Graph + Pause Topology

**Files:**
- Create: `client/src/signals/editProfile.js`
- Create: `client/src/signals/pauseTopology.js`

- [ ] **Step 1: Write editProfile.js**

```js
// client/src/signals/editProfile.js
import { mergeGestures } from './gestures'
import { levenshtein } from '../utils/levenshtein'
import { klDivergence } from '../utils/kl'

const COMMON_TYPOS = /^(teh|hte|adn|nad|recieve|definately|occured|seperate|accomodate|untill)$/i

function classifySubstitute(deleted, inserted) {
  const dWords = deleted.trim().split(/\s+/).filter(Boolean)
  const iWords = inserted.trim().split(/\s+/).filter(Boolean)
  const dist = levenshtein(deleted.toLowerCase(), inserted.toLowerCase())

  if (dist <= 2 || COMMON_TYPOS.test(deleted)) return 'TYPO_CORRECTION'
  if (dWords.length === 1 && iWords.length === 1) return 'LEXICAL_SUB'
  // Multi-word: check if meaning preserved (rough heuristic: length similarity)
  const lengthRatio = deleted.length / Math.max(1, inserted.length)
  if (lengthRatio > 0.5 && lengthRatio < 2.0) return 'STRUCTURAL_REWRITE'
  return 'IDEATIONAL_REVISION'
}

export function computeEditProfile(log, finalText) {
  const gestures = mergeGestures(log)
  const wordCount = Math.max(1, (finalText.match(/\b\w+\b/g) || []).length)

  let typoCorrections = 0, lexicalSubs = 0, structuralRewrites = 0, ideationalRevisions = 0
  let insertMids = 0, frontier = 0
  const frontierOverTime = []

  // Pause durations preceding each gesture type
  const typoPrePauses = []
  const meaningfulPrePauses = []

  let prevTimestamp = log.length ? log[0].timestamp : 0

  for (const g of gestures) {
    const prePause = g.startTimestamp - prevTimestamp
    prevTimestamp = g.endTimestamp

    if (g.type === 'BURST') {
      const endPos = g.position + (g.insertedText || '').length
      if (endPos > frontier) frontier = endPos
      frontierOverTime.push({ timestamp: g.endTimestamp, frontier, position: g.position })
    }

    if (g.type === 'SUBSTITUTE') {
      const cls = classifySubstitute(g.deletedText, g.insertedText)
      if (cls === 'TYPO_CORRECTION') { typoCorrections++; typoPrePauses.push(prePause) }
      else if (cls === 'LEXICAL_SUB') { lexicalSubs++; meaningfulPrePauses.push(prePause) }
      else if (cls === 'STRUCTURAL_REWRITE') { structuralRewrites++; meaningfulPrePauses.push(prePause) }
      else { ideationalRevisions++; meaningfulPrePauses.push(prePause) }
    }

    if (g.type === 'BURST' && g.position < frontier - 100) insertMids++
  }

  const totalSubs = typoCorrections + lexicalSubs + structuralRewrites + ideationalRevisions
  const typoRatio = totalSubs > 0 ? typoCorrections / totalSubs : 0
  const meaningfulEditRate = (lexicalSubs + structuralRewrites + ideationalRevisions) / wordCount

  const pauseEditKL = klDivergence(typoPrePauses, meaningfulPrePauses)

  // Frontier revisit rate
  const frontierRevisitRate = (gestures.length > 0)
    ? insertMids / gestures.length
    : 0

  const meanFrontierDistance = insertMids > 0
    ? gestures.filter(g => g.type === 'BURST' && g.position < frontier - 100)
        .reduce((sum, g) => sum + (frontier - g.position), 0) / insertMids
    : 0

  return {
    typoCorrections,
    lexicalSubs,
    structuralRewrites,
    ideationalRevisions,
    insertMids,
    meanFrontierDistance,
    typoRatio,
    meaningfulEditRate,
    pauseEditKL,
    frontierRevisitRate,
    gestures
  }
}
```

- [ ] **Step 2: Write pauseTopology.js**

```js
// client/src/signals/pauseTopology.js

const PAUSE_THRESHOLD_MS = 300

export function computePauseTopology(log, finalText) {
  const txns = log.filter(e => e.type === 'transaction')
  if (txns.length < 2) return { score: 0.5, pauseCount: 0 }

  // Find sentence and paragraph boundary positions in final text
  const boundaryPositions = new Set()
  let pos = 0
  for (let i = 0; i < finalText.length; i++) {
    const ch = finalText[i]
    if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
      boundaryPositions.add(i)
      boundaryPositions.add(i + 1)
    }
  }

  // Identify pauses > 300ms and their document positions
  const pauses = []
  for (let i = 1; i < txns.length; i++) {
    const gap = txns[i].timestamp - txns[i - 1].timestamp
    if (gap > PAUSE_THRESHOLD_MS) {
      pauses.push({ duration: gap, position: txns[i].position })
    }
  }

  if (!pauses.length) return { score: 0.5, pauseCount: 0 }

  // Score: fraction of pauses that fall at or near (within 10 chars) a semantic boundary
  const BOUNDARY_WINDOW = 10
  const atBoundary = pauses.filter(p => {
    for (let d = -BOUNDARY_WINDOW; d <= BOUNDARY_WINDOW; d++) {
      if (boundaryPositions.has(p.position + d)) return true
    }
    return false
  })

  const score = atBoundary.length / pauses.length

  return { score, pauseCount: pauses.length, pauses }
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/signals/editProfile.js client/src/signals/pauseTopology.js
git commit -m "feat: semantic edit graph and pause topology signals"
```

---

## Task 11: Frontier Tracking, Typing Rhythm, Tab Switch, Complexity

**Files:**
- Create: `client/src/signals/frontierTracking.js`
- Create: `client/src/signals/typingRhythm.js`
- Create: `client/src/signals/tabSwitch.js`
- Create: `client/src/signals/complexity.js`

- [ ] **Step 1: Write frontierTracking.js**

```js
// client/src/signals/frontierTracking.js

export function computeFrontierTracking(log) {
  const txns = log.filter(e => e.type === 'transaction')
  if (!txns.length) return { score: 0.5 }

  let frontier = 0
  let totalEdits = 0
  let behindFrontierEdits = 0

  for (const tx of txns) {
    totalEdits++
    if (tx.position < frontier - 100) behindFrontierEdits++
    const endPos = tx.position + (tx.inserted_text || '').length
    if (endPos > frontier) frontier = endPos
  }

  const score = totalEdits > 0 ? behindFrontierEdits / totalEdits : 0
  return { score, totalEdits, behindFrontierEdits }
}
```

- [ ] **Step 2: Write typingRhythm.js**

```js
// client/src/signals/typingRhythm.js
import subtlex from '../data/subtlex_us.json'

export function computeTypingRhythm(log) {
  const txns = log.filter(e => e.type === 'transaction')
  if (txns.length < 2) return { score: 0.5, sampleSize: 0, correlation: null }

  // Identify qualifying word-typing events:
  // - min 4 chars, no backspaces inside (no deleted_text mid-word), not after pause > 1s
  const wordEvents = []
  let wordBuf = { chars: [], timestamps: [], startIdx: 0 }
  let prevTimestamp = txns[0].timestamp

  for (let i = 0; i < txns.length; i++) {
    const tx = txns[i]
    const gap = tx.timestamp - prevTimestamp
    prevTimestamp = tx.timestamp

    if (gap > 1000) {
      wordBuf = { chars: [], timestamps: [], startIdx: i }
      continue
    }

    if (tx.inserted_text && !tx.deleted_text) {
      if (tx.inserted_text === ' ' || tx.inserted_text === '\n') {
        // Word boundary - finalize
        if (wordBuf.chars.length >= 4) {
          const word = wordBuf.chars.join('')
          const ikis = []
          for (let j = 1; j < wordBuf.timestamps.length; j++) {
            ikis.push(wordBuf.timestamps[j] - wordBuf.timestamps[j - 1])
          }
          const meanIki = ikis.length > 0 ? ikis.reduce((a, b) => a + b, 0) / ikis.length : 0
          const freq = subtlex[word.toLowerCase()]
          if (freq != null) wordEvents.push({ word, meanIki, logFreq: freq })
        }
        wordBuf = { chars: [], timestamps: [], startIdx: i }
      } else {
        wordBuf.chars.push(tx.inserted_text)
        wordBuf.timestamps.push(tx.timestamp)
      }
    } else if (tx.deleted_text) {
      // Backspace mid-word - reset
      wordBuf = { chars: [], timestamps: [], startIdx: i }
    }
  }

  if (wordEvents.length < 40) return { score: 0.5, sampleSize: wordEvents.length, correlation: null }

  const correlation = spearmanCorrelation(wordEvents.map(e => e.logFreq), wordEvents.map(e => e.meanIki))
  // Expected composition: r between -0.3 and -0.6. Score: map [-0.6, -0.3] -> [0.8, 1.0], scale otherwise
  let score
  if (correlation >= -0.6 && correlation <= -0.3) {
    score = 1.0
  } else if (correlation < -0.6) {
    score = 0.7 // too strong correlation
  } else if (correlation < 0) {
    score = 0.5 + (Math.abs(correlation) / 0.3) * 0.3
  } else {
    score = Math.max(0, 0.5 - correlation * 0.5) // positive correlation = suspicious
  }

  return { score, sampleSize: wordEvents.length, correlation }
}

function spearmanCorrelation(x, y) {
  const n = x.length
  const rx = rankArray(x), ry = rankArray(y)
  let d2 = 0
  for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2
  return 1 - (6 * d2) / (n * (n * n - 1))
}

function rankArray(arr) {
  const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array(arr.length)
  sorted.forEach(({ i }, rank) => { ranks[i] = rank + 1 })
  return ranks
}
```

- [ ] **Step 3: Write tabSwitch.js**

```js
// client/src/signals/tabSwitch.js

export function computeTabSwitch(log) {
  const focusEvents = log.filter(e => e.type === 'focus_loss' || e.type === 'focus_return')
  const txns = log.filter(e => e.type === 'transaction')

  if (!focusEvents.length) return { score: 1.0, switchCount: 0 }

  const losses = focusEvents.filter(e => e.type === 'focus_loss')
  const returns = focusEvents.filter(e => e.type === 'focus_return')

  const meanDuration = returns.length > 0
    ? returns.reduce((sum, e) => sum + (e.duration || 0), 0) / returns.length
    : 0

  // Check if focus returns are followed by typing bursts within 10 seconds (transcription signal)
  let suspiciousReturns = 0
  for (const ret of returns) {
    const burstAfter = txns.filter(tx => tx.timestamp > ret.timestamp && tx.timestamp < ret.timestamp + 10000)
    if (burstAfter.length > 5) suspiciousReturns++
  }

  const frequency = losses.length
  const suspiciousRatio = returns.length > 0 ? suspiciousReturns / returns.length : 0

  // Score: penalize suspicious patterns
  const score = Math.max(0, 1.0 - suspiciousRatio * 0.5 - Math.min(1, frequency / 20) * 0.3)

  return { score, switchCount: losses.length, meanDuration, suspiciousRatio }
}
```

- [ ] **Step 4: Write complexity.js**

```js
// client/src/signals/complexity.js
import { fleschKincaidGrade, typeTokenRatio, meanSentenceLength, subordinateClauseDensity } from '../utils/flesch'

export function computeComplexity(text) {
  const fk = fleschKincaidGrade(text)
  const ttr = typeTokenRatio(text)
  const msl = meanSentenceLength(text)
  const scd = subordinateClauseDensity(text)

  // Normalize each to 0-1
  const fkNorm = Math.min(1, Math.max(0, fk / 18))       // grade 18 = college
  const ttrNorm = Math.min(1, ttr)
  const mslNorm = Math.min(1, Math.max(0, msl / 40))
  const scdNorm = Math.min(1, Math.max(0, scd / 5))

  const score = (fkNorm * 0.4 + ttrNorm * 0.3 + mslNorm * 0.15 + scdNorm * 0.15)
  return { score, fk, ttr, msl, scd }
}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/signals/
git commit -m "feat: frontier tracking, typing rhythm, tab switch, complexity signals"
```

---

## Task 12: Composite Scoring

**Files:**
- Create: `client/src/signals/composite.js`
- Create: `client/src/signals/llmLayer.js`

- [ ] **Step 1: Write composite.js**

```js
// client/src/signals/composite.js
import { computeEditProfile } from './editProfile'
import { computePauseTopology } from './pauseTopology'
import { computeFrontierTracking } from './frontierTracking'
import { computeTypingRhythm } from './typingRhythm'
import { computeTabSwitch } from './tabSwitch'
import { computeComplexity } from './complexity'

export function computeComposite(log, finalText) {
  const strikeCount = log.filter(e =>
    e.type === 'paste_attempt' || e.type === 'copy_attempt' || e.type === 'cut_attempt'
  ).length

  const strikeScore = strikeCount === 0 ? 1.0
    : strikeCount === 1 ? 0.8
    : strikeCount === 2 ? 0.5
    : 0.1 // 3+

  const tabSwitch = computeTabSwitch(log)
  const pauseTopology = computePauseTopology(log, finalText)
  const editProfile = computeEditProfile(log, finalText)
  const frontierRaw = computeFrontierTracking(log)
  const typingRhythm = computeTypingRhythm(log)
  const complexity = computeComplexity(finalText)

  // Quality-edit calibration: normalize expected baselines
  const cx = complexity.score
  const expectedMeaningfulEditRate = 0.02 + cx * 0.08
  const expectedFrontierRevisitRate = 0.05 + cx * 0.15

  const semanticEditScore = Math.min(1.0, editProfile.meaningfulEditRate / Math.max(0.001, expectedMeaningfulEditRate))
  const frontierScore = Math.min(1.0, editProfile.frontierRevisitRate / Math.max(0.001, expectedFrontierRevisitRate))

  // Pause-edit KL: higher = more composition-like (up to some max)
  const pauseEditScore = Math.min(1.0, editProfile.pauseEditKL / 2.0)

  // Build overall semantic edit graph score: combine edit rate + pause-edit correlation
  const semanticScore = semanticEditScore * 0.6 + pauseEditScore * 0.4

  const weights = {
    strikeScore: 0.15,
    tabSwitch: 0.08,
    pauseTopology: 0.12,
    semanticEdit: 0.30,
    frontier: 0.10,
    typingRhythm: 0.10,
    complexityCalib: 0.05,
    // challengeResponse: 0.10 - only when triggered (redistributed if not)
  }

  // Redistribute challenge weight proportionally if not triggered
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0)
  const scale = 1 / totalWeight

  const composite =
    strikeScore * weights.strikeScore * scale +
    tabSwitch.score * weights.tabSwitch * scale +
    pauseTopology.score * weights.pauseTopology * scale +
    semanticScore * weights.semanticEdit * scale +
    frontierScore * weights.frontier * scale +
    typingRhythm.score * weights.typingRhythm * scale +
    cx * weights.complexityCalib * scale

  const breakdown = {
    strikeScore: { score: strikeScore, weight: weights.strikeScore, strikeCount },
    tabSwitch: { score: tabSwitch.score, weight: weights.tabSwitch, switchCount: tabSwitch.switchCount },
    pauseTopology: { score: pauseTopology.score, weight: weights.pauseTopology, pauseCount: pauseTopology.pauseCount },
    semanticEdit: {
      score: semanticScore,
      weight: weights.semanticEdit,
      meaningfulEditRate: editProfile.meaningfulEditRate,
      typoRatio: editProfile.typoRatio,
      pauseEditKL: editProfile.pauseEditKL
    },
    frontier: { score: frontierScore, weight: weights.frontier, revisitRate: editProfile.frontierRevisitRate },
    typingRhythm: { score: typingRhythm.score, weight: weights.typingRhythm, correlation: typingRhythm.correlation, sampleSize: typingRhythm.sampleSize },
    complexityCalib: { score: cx, weight: weights.complexityCalib },
    composite
  }

  return { score: composite, breakdown }
}

export function getVerdict(score, strikeCount) {
  if (strikeCount >= 3) return 'SUSPICIOUS'
  if (score > 0.75) return 'STRONG HUMAN SIGNAL'
  if (score >= 0.55) return 'LIKELY HUMAN'
  if (score >= 0.35) return 'AMBIGUOUS'
  return 'SUSPICIOUS'
}
```

- [ ] **Step 2: Write llmLayer.js (client-side call via server proxy)**

```js
// client/src/signals/llmLayer.js

export async function llmTieBreak(editProfile, finalText) {
  const edits = buildEditSummary(editProfile)
  try {
    const res = await fetch('/api/llm-tiebreak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits, finalText: finalText.slice(0, 2000) })
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function buildEditSummary(editProfile) {
  return {
    typoCorrections: editProfile.typoCorrections,
    lexicalSubs: editProfile.lexicalSubs,
    structuralRewrites: editProfile.structuralRewrites,
    ideationalRevisions: editProfile.ideationalRevisions,
    meaningfulEditRate: editProfile.meaningfulEditRate,
    pauseEditKL: editProfile.pauseEditKL
  }
}
```

- [ ] **Step 3: Add LLM proxy route to server**

```js
// Add to server/index.js after existing routes:
const llmRoute = require('./llm')
app.use('/api/llm-tiebreak', llmRoute)
```

```js
// server/llm.js
const express = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const router = express.Router()

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null

router.post('/', async (req, res) => {
  if (!client) return res.json({ verdict: 'AMBIGUOUS', reasoning: 'LLM not configured' })

  const { edits, finalText } = req.body
  try {
    const msg = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are analyzing whether a piece of writing was composed by a human or transcribed/generated by AI.

Edit profile: ${JSON.stringify(edits)}
Final text excerpt: ${finalText}

Based on the edit pattern, does this look like genuine compositional thinking (human writing with organic revisions) or mechanical transcription/AI generation?

Respond with exactly: COMPOSITION, TRANSCRIPTION, or AMBIGUOUS
Then on the next line, one sentence of reasoning.`
      }]
    })
    const lines = msg.content[0].text.trim().split('\n')
    const verdict = ['COMPOSITION', 'TRANSCRIPTION', 'AMBIGUOUS'].includes(lines[0]) ? lines[0] : 'AMBIGUOUS'
    res.json({ verdict, reasoning: lines[1] || '' })
  } catch (e) {
    res.json({ verdict: 'AMBIGUOUS', reasoning: 'LLM error' })
  }
})

module.exports = router
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: composite scoring and LLM tie-break"
```

---

## Task 13: Challenge-Response Overlay

**Files:**
- Create: `client/src/editor/challenge.js`

- [ ] **Step 1: Write challenge.jsx**

```jsx
// client/src/editor/challenge.jsx
import { useState, useRef } from 'react'
import { logEvent } from './sessionLog'

export default function Challenge({ onDismiss }) {
  const [response, setResponse] = useState('')
  const [started, setStarted] = useState(false)
  const firstKeyTime = useRef(null)

  function handleKeyDown(e) {
    if (!started) {
      setStarted(true)
      firstKeyTime.current = performance.now()
    }
  }

  function handleSubmit() {
    const latency = firstKeyTime.current ? firstKeyTime.current : performance.now()
    logEvent('challenge_response', {
      responseText: response,
      responseLatencyMs: latency,
      wordCount: response.trim().split(/\s+/).filter(Boolean).length
    })
    onDismiss()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{
        background: '#fff', borderRadius: 8, padding: '2rem', maxWidth: 480, width: '90%',
        fontFamily: 'sans-serif'
      }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>Quick Check</h2>
        <p style={{ marginBottom: '1rem', color: '#374151', lineHeight: 1.6 }}>
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
            border: '1px solid #d1d5db', borderRadius: 4, resize: 'vertical', fontFamily: 'Georgia, serif'
          }}
          placeholder="Type your answer here..."
        />
        <button
          onClick={handleSubmit}
          disabled={!response.trim()}
          style={{
            marginTop: '1rem', background: '#2563eb', color: '#fff',
            border: 'none', borderRadius: 4, padding: '0.5rem 1.5rem',
            fontSize: '1rem', cursor: response.trim() ? 'pointer' : 'not-allowed',
            opacity: response.trim() ? 1 : 0.5
          }}
        >
          Continue Writing
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Update EditorPage to trigger challenge when score drops below 0.35**

In `EditorPage.jsx`, update `handleTransaction` to compute a running score and show challenge:

```jsx
const handleTransaction = useCallback((tr) => {
  const log = getLog()
  if (log.length < 20) return // Need minimum data
  const view = editorView // captured via ref
  if (!view) return
  const text = view.state.doc.textContent
  if (text.length < 100) return

  // Only check periodically (every 20 transactions)
  if (log.filter(e => e.type === 'transaction').length % 20 !== 0) return

  import('../signals/composite').then(({ computeComposite }) => {
    const { score } = computeComposite(log, text)
    if (score < 0.35 && !challengeVisible) {
      setChallengeVisible(true)
    }
  })
}, [challengeVisible, editorView])
```

- [ ] **Step 3: Commit**

```bash
git add client/src/editor/challenge.jsx client/src/editor/EditorPage.jsx
git commit -m "feat: challenge-response overlay at low composite score"
```

---

## Task 14: Proof Permalink Page + Visualizations

**Files:**
- Create: `client/src/proof/proofApi.js`
- Create: `client/src/proof/ScoreBreakdown.jsx`
- Create: `client/src/proof/Timeline.jsx`
- Create: `client/src/proof/ProofPage.jsx`

- [ ] **Step 1: Write proofApi.js**

```js
// client/src/proof/proofApi.js
export async function fetchProof(uuid) {
  const res = await fetch(`/api/proof/${uuid}`)
  if (!res.ok) throw new Error('Proof not found')
  return res.json()
}
```

- [ ] **Step 2: Write ScoreBreakdown.jsx**

```jsx
// client/src/proof/ScoreBreakdown.jsx
export default function ScoreBreakdown({ breakdown }) {
  const signals = [
    {
      key: 'strikeScore',
      label: 'Paste / Copy / Cut Blocking',
      description: `${breakdown.strikeScore.strikeCount} attempt(s) logged. ${breakdown.strikeScore.strikeCount >= 3 ? 'Three or more attempts is a significant flag.' : 'No major flags.'}`
    },
    {
      key: 'tabSwitch',
      label: 'Tab Switch Pattern',
      description: `${breakdown.tabSwitch.switchCount} focus loss events. A pattern of returning to the tab immediately before typing bursts suggests transcription.`
    },
    {
      key: 'pauseTopology',
      label: 'Pause Topology',
      description: `${breakdown.pauseTopology.pauseCount} pauses detected. Score reflects how many pauses fell at sentence and paragraph boundaries (composition-like) vs. random positions (transcription-like).`
    },
    {
      key: 'semanticEdit',
      label: 'Semantic Edit Graph',
      description: `Meaningful edit rate: ${(breakdown.semanticEdit.meaningfulEditRate * 100).toFixed(1)}%. Typo ratio: ${(breakdown.semanticEdit.typoRatio * 100).toFixed(0)}%. Pause-before-edit divergence: ${breakdown.semanticEdit.pauseEditKL?.toFixed(2)}. Genuine composition shows organic revisions with longer pauses before meaningful changes.`
    },
    {
      key: 'frontier',
      label: 'Document Position Frontier',
      description: `Revisit rate: ${(breakdown.frontier.revisitRate * 100).toFixed(1)}%. Writers composing original text frequently return to earlier positions to revise; transcribers proceed linearly.`
    },
    {
      key: 'typingRhythm',
      label: 'Typing Rhythm Coherence',
      description: breakdown.typingRhythm.sampleSize < 40
        ? `Insufficient qualifying words (${breakdown.typingRhythm.sampleSize} / 40 needed). Signal not computed.`
        : `Spearman r = ${breakdown.typingRhythm.correlation?.toFixed(3)}. Expected human composition: -0.3 to -0.6 (faster typing on common words).`
    },
    {
      key: 'complexityCalib',
      label: 'Quality-Edit Calibration',
      description: `Text complexity score: ${(breakdown.complexityCalib.score * 100).toFixed(0)}%. Used to adjust expected baselines for semantic edits and frontier revisits.`
    },
  ]

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <h2 style={{ marginBottom: '1rem' }}>Signal Breakdown</h2>
      {signals.map(sig => {
        const scoreData = breakdown[sig.key]
        const score = scoreData?.score ?? 0
        return (
          <div key={sig.key} style={{ marginBottom: '1.25rem', borderBottom: '1px solid #e5e7eb', paddingBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
              <strong>{sig.label}</strong>
              <span style={{ fontWeight: 'bold', color: scoreColor(score) }}>{(score * 100).toFixed(0)}%</span>
            </div>
            <div style={{ height: 6, background: '#e5e7eb', borderRadius: 3, marginBottom: '0.5rem' }}>
              <div style={{ height: '100%', width: `${score * 100}%`, background: scoreColor(score), borderRadius: 3, transition: 'width 0.5s' }} />
            </div>
            <p style={{ color: '#6b7280', fontSize: '0.9rem', lineHeight: 1.5 }}>{sig.description}</p>
          </div>
        )
      })}
    </div>
  )
}

function scoreColor(score) {
  if (score > 0.7) return '#10b981'
  if (score > 0.4) return '#f59e0b'
  return '#ef4444'
}
```

- [ ] **Step 3: Write Timeline.jsx**

```jsx
// client/src/proof/Timeline.jsx
export default function Timeline({ sessionLog }) {
  if (!sessionLog || !sessionLog.length) return null

  const txns = sessionLog.filter(e => e.type === 'transaction')
  const strikes = sessionLog.filter(e => ['paste_attempt', 'copy_attempt', 'cut_attempt'].includes(e.type))
  const focusLosses = sessionLog.filter(e => e.type === 'focus_loss')

  if (!txns.length) return null

  const start = txns[0].timestamp
  const end = txns[txns.length - 1].timestamp
  const duration = end - start || 1

  const W = 800, H = 60, PAUSE_THRESHOLD = 300

  // Build burst segments
  const segments = []
  let segStart = txns[0]
  for (let i = 1; i < txns.length; i++) {
    const gap = txns[i].timestamp - txns[i - 1].timestamp
    if (gap > PAUSE_THRESHOLD) {
      segments.push({ start: segStart.timestamp, end: txns[i - 1].timestamp, type: 'burst' })
      segments.push({ start: txns[i - 1].timestamp, end: txns[i].timestamp, type: 'pause' })
      segStart = txns[i]
    }
  }
  segments.push({ start: segStart.timestamp, end: txns[txns.length - 1].timestamp, type: 'burst' })

  function toX(ts) { return ((ts - start) / duration) * W }

  return (
    <div>
      <h3 style={{ fontFamily: 'sans-serif', marginBottom: '0.5rem' }}>Session Timeline</h3>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ borderRadius: 4, background: '#f9fafb' }}>
        {segments.map((seg, i) => (
          <rect key={i}
            x={toX(seg.start)} y={10}
            width={Math.max(2, toX(seg.end) - toX(seg.start))}
            height={40}
            fill={seg.type === 'burst' ? '#6ee7b7' : '#f3f4f6'}
          />
        ))}
        {strikes.map((e, i) => (
          <line key={`s${i}`}
            x1={toX(e.timestamp)} x2={toX(e.timestamp)}
            y1={0} y2={H}
            stroke="#ef4444" strokeWidth={2}
          />
        ))}
        {focusLosses.map((e, i) => (
          <line key={`f${i}`}
            x1={toX(e.timestamp)} x2={toX(e.timestamp)}
            y1={0} y2={H}
            stroke="#f59e0b" strokeWidth={1} strokeDasharray="4"
          />
        ))}
      </svg>
      <div style={{ fontFamily: 'sans-serif', fontSize: '0.8rem', color: '#6b7280', marginTop: '0.5rem', display: 'flex', gap: '1.5rem' }}>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#6ee7b7', marginRight: 4, verticalAlign: 'middle' }}></span>Burst</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#f3f4f6', border: '1px solid #e5e7eb', marginRight: 4, verticalAlign: 'middle' }}></span>Pause</span>
        <span><span style={{ display: 'inline-block', width: 2, height: 12, background: '#ef4444', marginRight: 4, verticalAlign: 'middle' }}></span>Strike</span>
        <span><span style={{ display: 'inline-block', width: 2, height: 12, background: '#f59e0b', marginRight: 4, verticalAlign: 'middle' }}></span>Focus loss</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Write ProofPage.jsx**

```jsx
// client/src/proof/ProofPage.jsx
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchProof } from './proofApi'
import ScoreBreakdown from './ScoreBreakdown'
import Timeline from './Timeline'
import { getVerdict } from '../signals/composite'

export default function ProofPage() {
  const { uuid } = useParams()
  const [proof, setProof] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchProof(uuid).then(setProof).catch(e => setError(e.message))
  }, [uuid])

  if (error) return <div style={{ padding: '2rem', fontFamily: 'sans-serif', color: '#ef4444' }}>Error: {error}</div>
  if (!proof) return <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>Loading...</div>

  const verdict = getVerdict(proof.score, proof.scoreBreakdown?.strikeScore?.strikeCount || 0)
  const verdictColor = { 'STRONG HUMAN SIGNAL': '#10b981', 'LIKELY HUMAN': '#3b82f6', 'AMBIGUOUS': '#f59e0b', 'SUSPICIOUS': '#ef4444' }[verdict]

  const durationMin = (proof.sessionDurationMs / 60000).toFixed(1)

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Writing Proof</h1>
      <p style={{ color: '#6b7280', marginBottom: '2rem', fontFamily: 'monospace', fontSize: '0.85rem' }}>
        {uuid}
      </p>

      <div style={{
        background: verdictColor + '20', border: `2px solid ${verdictColor}`,
        borderRadius: 8, padding: '1.5rem', marginBottom: '2rem', textAlign: 'center'
      }}>
        <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: verdictColor, letterSpacing: '0.05em' }}>
          {verdict}
        </div>
        <div style={{ fontSize: '1.2rem', color: '#374151', marginTop: '0.5rem' }}>
          Score: {(proof.score * 100).toFixed(1)}%
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '2rem' }}>
        {[
          { label: 'Word Count', value: proof.wordCount },
          { label: 'Session Duration', value: `${durationMin} min` },
          { label: 'Timestamp', value: new Date(proof.serverTimestamp).toLocaleString() }
        ].map(({ label, value }) => (
          <div key={label} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '1rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{value}</div>
            <div style={{ color: '#6b7280', fontSize: '0.85rem' }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ marginBottom: '0.5rem' }}>Content Hash (SHA-256)</h2>
        <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 4, padding: '0.75rem', wordBreak: 'break-all' }}>
          {proof.contentHash}
        </div>
      </div>

      <div style={{ marginBottom: '2rem' }}>
        <Timeline sessionLog={proof.sessionLog} />
      </div>

      <div style={{ marginBottom: '2rem' }}>
        <ScoreBreakdown breakdown={proof.scoreBreakdown} />
      </div>

      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ marginBottom: '0.5rem' }}>Full Text</h2>
        <div style={{ fontFamily: 'Georgia, serif', lineHeight: 1.8, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 4, padding: '1.5rem', whiteSpace: 'pre-wrap' }}>
          {proof.finalText}
        </div>
      </div>

      <div style={{ color: '#9ca3af', fontSize: '0.8rem', borderTop: '1px solid #e5e7eb', paddingTop: '1rem' }}>
        Server signature: <span style={{ fontFamily: 'monospace' }}>{proof.signature}</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/proof/
git commit -m "feat: proof permalink page with timeline visualization and score breakdown"
```

---

## Task 15: End-to-End Integration + Smoke Test

- [ ] **Step 1: Start both servers**

```bash
# Terminal 1
cd /Users/dghosef/editor/server && node index.js

# Terminal 2
cd /Users/dghosef/editor/client && npm run dev
```

- [ ] **Step 2: Smoke test editor**

Open http://localhost:5173 and:
1. Type at least 200 words
2. Verify typing is logged (open console, check window.sessionLog is not accessible - log is module-scoped)
3. Try Ctrl+V - verify strike counter increments and paste is blocked
4. Try right-click - verify context menu does not appear

- [ ] **Step 3: Smoke test proof generation**

1. Click "Generate Proof"
2. Verify redirect to `/proof/<uuid>`
3. Verify the proof page loads with score, timeline, and breakdown

- [ ] **Step 4: Verify proof permalink is permanent**

```bash
# Note the UUID from step 3
UUID="<the uuid>"
curl http://localhost:3001/api/proof/$UUID | jq '.score'
# Should return a number between 0 and 1
```

- [ ] **Step 5: Verify autosave**

```bash
# After 30 seconds with the editor open
psql humanproof -c "SELECT id, updated_at FROM sessions;"
# Should show one row
```

- [ ] **Step 6: Fix any issues found during smoke test**

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete human-proof writing editor"
```

---

## Environment Setup Notes

**Required environment variables:**
```bash
# server/.env (not committed)
DATABASE_URL=postgres://localhost/humanproof
SERVER_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
ANTHROPIC_API_KEY=<optional - enables LLM tie-break>
PORT=3001
```

**To run in development:**
```bash
# Setup
createdb humanproof

# Server
cd server && npm install && node index.js

# Client (separate terminal)
cd client && npm install && npm run dev
```
