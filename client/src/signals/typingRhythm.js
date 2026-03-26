import subtlex from '../data/subtlex_us.json'

const MIN_WORD_LENGTH = 4
const MIN_QUALIFYING_WORDS = 40
const LONG_PAUSE_THRESHOLD = 1000 // ms - resets word buffer

export function computeTypingRhythm(log) {
  const txns = log.filter(e => e.type === 'transaction')
  if (txns.length < 5) return { score: 0.5, sampleSize: 0, correlation: null, computed: false }

  const wordEvents = []
  let wordBuf = { chars: [], timestamps: [] }
  let prevTimestamp = txns[0].timestamp

  for (const tx of txns) {
    const gap = tx.timestamp - prevTimestamp
    prevTimestamp = tx.timestamp

    // Long pause resets word buffer (no qualifying word can span a long pause)
    if (gap > LONG_PAUSE_THRESHOLD) {
      wordBuf = { chars: [], timestamps: [] }
      continue
    }

    if (tx.deleted_text && !tx.inserted_text) {
      // Backspace mid-word - invalidate current word
      wordBuf = { chars: [], timestamps: [] }
      continue
    }

    if (tx.inserted_text && !tx.deleted_text) {
      const ch = tx.inserted_text

      if (ch === ' ' || ch === '\n' || ch === '\t') {
        // Word boundary
        if (wordBuf.chars.length >= MIN_WORD_LENGTH) {
          const word = wordBuf.chars.join('')
          const freq = subtlex[word.toLowerCase()]
          if (freq != null && wordBuf.timestamps.length >= 2) {
            const ikis = []
            for (let j = 1; j < wordBuf.timestamps.length; j++) {
              ikis.push(wordBuf.timestamps[j] - wordBuf.timestamps[j - 1])
            }
            const meanIki = ikis.reduce((a, b) => a + b, 0) / ikis.length
            wordEvents.push({ word, meanIki, logFreq: freq })
          }
        }
        wordBuf = { chars: [], timestamps: [] }
      } else if (/[a-zA-Z']/.test(ch)) {
        wordBuf.chars.push(ch)
        wordBuf.timestamps.push(tx.timestamp)
      } else {
        // Punctuation/number ends the word without qualifying it
        wordBuf = { chars: [], timestamps: [] }
      }
    }
  }

  if (wordEvents.length < MIN_QUALIFYING_WORDS) {
    return { score: 0.5, sampleSize: wordEvents.length, correlation: null, computed: false }
  }

  const correlation = spearmanCorrelation(
    wordEvents.map(e => e.logFreq),
    wordEvents.map(e => e.meanIki)
  )

  // Expected in natural composition: r between -0.3 and -0.6
  // (common words typed faster -> negative correlation with IKI)
  // Transcription: r near 0 (no frequency effect - speed is pacing-based)
  let score
  if (correlation >= -0.6 && correlation <= -0.3) {
    score = 1.0 // ideal composition range
  } else if (correlation < -0.6) {
    score = 0.75 // stronger than expected - still plausible
  } else if (correlation < -0.1) {
    score = 0.5 + Math.abs(correlation + 0.1) / 0.2 * 0.25 // partial signal
  } else if (correlation < 0.1) {
    score = 0.3 // near zero - transcription-like
  } else {
    score = Math.max(0.1, 0.3 - correlation * 0.3) // positive = suspicious
  }

  return { score, sampleSize: wordEvents.length, correlation, computed: true }
}

function spearmanCorrelation(x, y) {
  const n = x.length
  if (n < 3) return 0
  const rx = rankArray(x)
  const ry = rankArray(y)
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
