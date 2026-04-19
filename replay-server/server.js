import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'
import { createApp } from './server-lib.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSIONS_DIR = join(__dirname, 'sessions')
const PORT = 4000

const fallbackKeyPath = process.env.HANDTYPED_TRUSTED_SIGNER_FILE || join(
  os.homedir(),
  '.config',
  'handtyped',
  'pubkey.hex',
)

if (!process.env.REPLAY_TRUSTED_SIGNER_KEYS && !process.env.HANDTYPED_TRUSTED_SIGNER_FILE) {
  console.warn(
    `Replay uploads require a trusted signer source; set REPLAY_TRUSTED_SIGNER_KEYS or ensure ${fallbackKeyPath} exists before uploading. Health is available at /api/health.`,
  )
}

const app = createApp(SESSIONS_DIR)
app.listen(PORT, () => console.log(`Replay server running at http://localhost:${PORT}`))
