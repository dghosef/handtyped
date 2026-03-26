const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'humanproof.db')

let db

function getDb() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

function initDb() {
  const d = getDb()
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      partial_log TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proofs (
      uuid TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      session_log TEXT NOT NULL,
      final_text TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      session_duration_ms REAL NOT NULL,
      score REAL NOT NULL,
      score_breakdown TEXT NOT NULL,
      server_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      signature TEXT NOT NULL
    );
  `)
  console.log('Database initialized at', DB_PATH)
}

module.exports = { getDb, initDb }
