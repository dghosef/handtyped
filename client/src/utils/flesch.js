function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!word.length) return 0
  const vowels = word.match(/[aeiou]+/g)
  let count = vowels ? vowels.length : 1
  if (word.endsWith('e') && count > 1) count--
  return Math.max(1, count)
}

export function fleschKincaidGrade(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0)
  const words = text.match(/\b\w+\b/g) || []
  if (!words.length || !sentences.length) return 0
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0)
  const wordsPerSentence = words.length / sentences.length
  const syllablesPerWord = syllables / words.length
  return 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59
}

export function typeTokenRatio(text) {
  const words = (text.match(/\b[a-z]+\b/gi) || []).map(w => w.toLowerCase())
  if (!words.length) return 0
  return new Set(words).size / words.length
}

export function meanSentenceLength(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0)
  const words = text.match(/\b\w+\b/g) || []
  if (!sentences.length) return 0
  return words.length / sentences.length
}

export function subordinateClauseDensity(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0)
  if (!sentences.length) return 0
  const subordinators = /\b(although|because|since|while|when|if|unless|until|after|before|though|whereas|whether|which|that|who|whom)\b/gi
  const commas = (text.match(/,/g) || []).length
  const subMatches = (text.match(subordinators) || []).length
  return (commas + subMatches) / sentences.length
}
