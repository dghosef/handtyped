const express = require('express')
const { getDb } = require('../db')
const router = express.Router()

// POST /api/sessions/:id/autosave
router.post('/:id/autosave', (req, res) => {
  const { id } = req.params
  const { log } = req.body
  if (!Array.isArray(log)) return res.status(400).json({ error: 'log must be array' })

  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, partial_log, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET partial_log = excluded.partial_log, updated_at = excluded.updated_at`
  ).run(id, JSON.stringify(log))

  res.json({ ok: true })
})

module.exports = router
