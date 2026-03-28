// src/readability.js — Flesch-Kincaid readability scoring

/**
 * Heuristic syllable counter. Returns 0 for empty/non-alpha strings.
 */
export function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!word) return 0
  if (word.length <= 3) return 1
  // Strip silent trailing e patterns
  word = word.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '')
  word = word.replace(/^y/, '')
  const m = word.match(/[aeiouy]{1,2}/g)
  return m ? m.length : 1
}

/**
 * Returns Flesch-Kincaid Reading Ease score (0-100) and grade level label.
 */
export function fleschKincaid(text) {
  const sentences = (text.match(/[.!?]+/g) || []).length || 1
  const wordList = text.trim().split(/\s+/).filter(w => w.replace(/[^a-z]/gi, ''))
  const words = wordList.length || 1
  const syllables = wordList.reduce((n, w) => n + countSyllables(w), 0) || 1

  const raw = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words)
  const score = Math.max(0, Math.min(100, Math.round(raw)))

  const level =
    score >= 90 ? '5th grade' :
    score >= 80 ? '6th grade' :
    score >= 70 ? '7th grade' :
    score >= 60 ? '8th–9th grade' :
    score >= 50 ? 'College' : 'Graduate'

  return { score, level }
}
