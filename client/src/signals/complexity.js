import { fleschKincaidGrade, typeTokenRatio, meanSentenceLength, subordinateClauseDensity } from '../utils/flesch'

export function computeComplexity(text) {
  if (!text || text.length < 50) {
    return { score: 0.3, fk: 0, ttr: 0, msl: 0, scd: 0, computed: false }
  }

  const fk = fleschKincaidGrade(text)
  const ttr = typeTokenRatio(text)
  const msl = meanSentenceLength(text)
  const scd = subordinateClauseDensity(text)

  // Normalize each to 0-1
  const fkNorm = Math.min(1, Math.max(0, fk / 18))   // grade 18 ~ upper academic
  const ttrNorm = Math.min(1, ttr)
  const mslNorm = Math.min(1, Math.max(0, msl / 40))
  const scdNorm = Math.min(1, Math.max(0, scd / 5))

  const score = fkNorm * 0.4 + ttrNorm * 0.3 + mslNorm * 0.15 + scdNorm * 0.15

  return { score, fk, ttr, msl, scd, computed: true }
}
