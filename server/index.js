const express = require('express')
const cors = require('cors')
const { initDb } = require('./db')
const autosaveRoute = require('./routes/autosave')
const proofRoute = require('./routes/proof')
const llmRoute = require('./llm')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.use('/api/sessions', autosaveRoute)
app.use('/api/proof', proofRoute)
app.use('/api/llm-tiebreak', llmRoute)

const PORT = process.env.PORT || 3001

initDb()
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
