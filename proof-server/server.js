import express from 'express'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSIONS_DIR = join(__dirname, 'sessions')
const PORT = 4000

if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true })

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use(express.static(join(__dirname, 'public')))

// POST /api/sessions — store a session, return a proof URL
app.post('/api/sessions', (req, res) => {
  const id = randomUUID()
  const session = {
    id,
    created_at: new Date().toISOString(),
    session_id: req.body.session_id || id,
    doc_text: req.body.doc_text || '',
    doc_html: req.body.doc_html || '',
    doc_history: req.body.doc_history || [],
    keystroke_log: req.body.keystroke_log || '',
    keystroke_count: req.body.keystroke_count || 0,
    start_wall_ns: req.body.start_wall_ns || 0,
  }
  writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(session, null, 2))
  const url = `http://localhost:${PORT}/replay/${id}`
  console.log(`Session stored: ${id} → ${url}`)
  res.json({ id, url })
})

// GET /api/sessions/:id — return session data
app.get('/api/sessions/:id', (req, res) => {
  const path = join(SESSIONS_DIR, `${req.params.id}.json`)
  if (!existsSync(path)) return res.status(404).json({ error: 'Not found' })
  res.json(JSON.parse(readFileSync(path, 'utf8')))
})

// GET /replay/:id — serve the replay page
app.get('/replay/:id', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'replay.html'))
})

app.listen(PORT, () => console.log(`Proof server running at http://localhost:${PORT}`))
