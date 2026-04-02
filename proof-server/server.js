import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createApp } from './server-lib.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSIONS_DIR = join(__dirname, 'sessions')
const PORT = 4000

const app = createApp(SESSIONS_DIR)
app.listen(PORT, () => console.log(`Proof server running at http://localhost:${PORT}`))
