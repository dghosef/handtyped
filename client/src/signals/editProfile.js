import { mergeGestures } from './gestures'
import { levenshtein } from '../utils/levenshtein'
import { klDivergence } from '../utils/kl'

const COMMON_TYPOS = /^(teh|hte|adn|nad|recieve|definately|occured|seperate|accomodate|untill|thier|wierd|enviroment|occurance|independant)$/i

function classifySubstitute(deleted, inserted) {
  if (!deleted || !inserted) return 'TYPO_CORRECTION'

  const dLower = deleted.toLowerCase().trim()
  const iLower = inserted.toLowerCase().trim()
  const dist = levenshtein(dLower, iLower)

  // Typo: small edit distance or matches known typo pattern
  if (dist <= 2 || COMMON_TYPOS.test(dLower)) return 'TYPO_CORRECTION'

  const dWords = dLower.split(/\s+/).filter(Boolean)
  const iWords = iLower.split(/\s+/).filter(Boolean)

  // Single word -> single word: lexical substitution
  if (dWords.length === 1 && iWords.length === 1) return 'LEXICAL_SUB'

  // Multi-word: check length ratio as proxy for meaning preservation
  const lengthRatio = deleted.length / Math.max(1, inserted.length)
  if (lengthRatio > 0.4 && lengthRatio < 2.5) return 'STRUCTURAL_REWRITE'

  return 'IDEATIONAL_REVISION'
}

// Identify INSERT_MID gestures: insertions behind the current writing frontier
function isBehindFrontier(gesture, frontier) {
  return gesture.type === 'BURST' && gesture.position < frontier - 100
}

export function computeEditProfile(log, finalText) {
  const gestures = mergeGestures(log)
  const wordCount = Math.max(1, (finalText.match(/\b\w+\b/g) || []).length)

  let typoCorrections = 0
  let lexicalSubs = 0
  let structuralRewrites = 0
  let ideationalRevisions = 0
  let insertMids = 0
  let frontier = 0

  const typoPrePauses = []
  const meaningfulPrePauses = []

  let prevTimestamp = log.length ? log[0].timestamp : 0

  for (const g of gestures) {
    const prePause = g.startTimestamp - prevTimestamp
    prevTimestamp = g.endTimestamp

    if (g.type === 'BURST') {
      if (isBehindFrontier(g, frontier)) insertMids++
      const endPos = g.position + (g.insertedText || '').length
      if (endPos > frontier) frontier = endPos
    }

    if (g.type === 'SUBSTITUTE') {
      const cls = classifySubstitute(g.deletedText, g.insertedText)
      if (cls === 'TYPO_CORRECTION') {
        typoCorrections++
        typoPrePauses.push(prePause)
      } else if (cls === 'LEXICAL_SUB') {
        lexicalSubs++
        meaningfulPrePauses.push(prePause)
      } else if (cls === 'STRUCTURAL_REWRITE') {
        structuralRewrites++
        meaningfulPrePauses.push(prePause)
      } else {
        ideationalRevisions++
        meaningfulPrePauses.push(prePause)
      }
    }
  }

  const totalSubs = typoCorrections + lexicalSubs + structuralRewrites + ideationalRevisions
  const typoRatio = totalSubs > 0 ? typoCorrections / totalSubs : 0
  const meaningfulEditRate = (lexicalSubs + structuralRewrites + ideationalRevisions) / wordCount

  // KL divergence between pause distributions: higher = more distinction = more composition-like
  const pauseEditKL = klDivergence(typoPrePauses, meaningfulPrePauses)

  const frontierRevisitRate = gestures.length > 0 ? insertMids / gestures.length : 0

  const behindFrontierGestures = gestures.filter(g =>
    g.type === 'BURST' && g.position < frontier - 100
  )
  const meanFrontierDistance = behindFrontierGestures.length > 0
    ? behindFrontierGestures.reduce((sum, g) => sum + (frontier - g.position), 0) / behindFrontierGestures.length
    : 0

  // Signal reliability: mark as computed only if we have enough data
  const hasEnoughSubs = totalSubs >= 3
  const hasEnoughMeaningful = (lexicalSubs + structuralRewrites + ideationalRevisions) >= 2

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
    gestures,
    wordCount,
    // Reliability flags (see user note: some signals produce false negatives, not false positives)
    hasEnoughSubs,
    hasEnoughMeaningful,
    pauseKLComputed: typoPrePauses.length >= 3 && meaningfulPrePauses.length >= 3
  }
}
