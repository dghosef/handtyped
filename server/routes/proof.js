const express = require('express')
const { v4: uuidv4 } = require('uuid')
const { getDb } = require('../db')
const { sign } = require('../signing')
const router = express.Router()

// POST /api/proof
router.post('/', (req, res) => {
  const { contentHash, sessionLog, finalText, wordCount, sessionDurationMs, score, scoreBreakdown } = req.body
  if (!contentHash || !sessionLog || !finalText) return res.status(400).json({ error: 'missing fields' })

  const uuid = uuidv4()
  const serverTimestamp = new Date().toISOString()
  const payload = { uuid, contentHash, serverTimestamp, score }
  const signature = sign(payload)

  const db = getDb()
  db.prepare(
    `INSERT INTO proofs (uuid, content_hash, session_log, final_text, word_count, session_duration_ms, score, score_breakdown, server_timestamp, signature)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(uuid, contentHash, JSON.stringify(sessionLog), finalText, wordCount, sessionDurationMs, score, JSON.stringify(scoreBreakdown), serverTimestamp, signature)

  res.json({ uuid, serverTimestamp, signature })
})

// GET /api/proof/:uuid
router.get('/:uuid', (req, res) => {
  const { uuid } = req.params
  const db = getDb()
  const row = db.prepare('SELECT * FROM proofs WHERE uuid = ?').get(uuid)
  if (!row) return res.status(404).json({ error: 'not found' })

  res.json({
    uuid: row.uuid,
    contentHash: row.content_hash,
    finalText: row.final_text,
    wordCount: row.word_count,
    sessionDurationMs: row.session_duration_ms,
    score: row.score,
    scoreBreakdown: JSON.parse(row.score_breakdown),
    serverTimestamp: row.server_timestamp,
    signature: row.signature,
    sessionLog: JSON.parse(row.session_log)
  })
})

module.exports = router
