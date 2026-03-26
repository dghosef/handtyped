import { computeEditProfile } from './editProfile'
import { computePauseTopology } from './pauseTopology'
import { computeFrontierTracking } from './frontierTracking'
import { computeTypingRhythm } from './typingRhythm'
import { computeTabSwitch } from './tabSwitch'
import { computeComplexity } from './complexity'

// Signal weights as specified in the design
const WEIGHTS = {
  strikeScore:    0.15,
  tabSwitch:      0.08,
  pauseTopology:  0.12,
  semanticEdit:   0.30,
  frontier:       0.10,
  typingRhythm:   0.10,
  complexityCalib: 0.05,
  // challengeResponse: 0.10 - added dynamically if triggered
}

// NOTE on false positives/negatives:
// - Some signals are hard to produce false positives on (paste strikes: you actually tried to paste)
// - Some signals are prone to false negatives (typing rhythm: needs 40+ qualifying words)
// - Signals marked computed:false default to 0.5 (neutral) and are DOWN-WEIGHTED
//   so insufficient data never penalizes a genuine writer
// - Only signals with computed:true carry their full weight in the composite

function weightedComposite(signalMap, challengeResult) {
  let weightSum = 0
  let scoreSum = 0

  const weights = { ...WEIGHTS }
  if (challengeResult) {
    // Redistribute challenge weight proportionally from other signals
    const challengeWeight = 0.10
    const scaleFactor = (1 - challengeWeight) / Object.values(weights).reduce((a, b) => a + b, 0)
    for (const k of Object.keys(weights)) weights[k] *= scaleFactor
    weights.challengeResponse = challengeWeight
    signalMap.challengeResponse = challengeResult
  }

  for (const [key, signal] of Object.entries(signalMap)) {
    const w = weights[key] ?? 0
    // If signal not computed, use half weight and neutral score (0.5)
    // This prevents false positives from insufficient data
    const effectiveWeight = signal.computed === false ? w * 0.5 : w
    const effectiveScore = signal.computed === false ? 0.5 : signal.score

    weightSum += effectiveWeight
    scoreSum += effectiveScore * effectiveWeight
  }

  return weightSum > 0 ? scoreSum / weightSum : 0.5
}

export function computeComposite(log, finalText) {
  const strikeCount = log.filter(e =>
    e.type === 'paste_attempt' || e.type === 'copy_attempt' || e.type === 'cut_attempt'
  ).length

  // Strikes: hard signal, very low false-positive rate. 3+ is always a flag.
  const strikeScore = strikeCount === 0 ? 1.0
    : strikeCount === 1 ? 0.85
    : strikeCount === 2 ? 0.55
    : 0.1 // 3+ strikes: strong flag

  const tabSwitch = computeTabSwitch(log)
  const pauseTopology = computePauseTopology(log, finalText)
  const editProfile = computeEditProfile(log, finalText)
  const frontierRaw = computeFrontierTracking(log)
  const typingRhythm = computeTypingRhythm(log)
  const complexity = computeComplexity(finalText)

  // Quality-edit calibration: expected rates scale with text complexity
  const cx = complexity.score
  const expectedMeaningfulEditRate = 0.02 + cx * 0.08
  const expectedFrontierRevisitRate = 0.05 + cx * 0.15

  // Semantic edit score: normalize actual vs expected, capped at 1.0
  // If not enough substitutions, mark as not-computed (avoid false negative penalty)
  let semanticEditScore, semanticComputed
  if (!editProfile.hasEnoughSubs) {
    semanticEditScore = 0.5
    semanticComputed = false
  } else {
    const editRateScore = Math.min(1.0, editProfile.meaningfulEditRate / Math.max(0.001, expectedMeaningfulEditRate))
    const pauseKLScore = editProfile.pauseKLComputed
      ? Math.min(1.0, editProfile.pauseEditKL / 2.0)
      : 0.5
    semanticEditScore = editRateScore * 0.6 + pauseKLScore * 0.4
    semanticComputed = true
  }

  // Frontier score
  let frontierScore, frontierComputed
  if (!frontierRaw.computed) {
    frontierScore = 0.5
    frontierComputed = false
  } else {
    frontierScore = Math.min(1.0, editProfile.frontierRevisitRate / Math.max(0.001, expectedFrontierRevisitRate))
    frontierComputed = true
  }

  // Challenge response (if present in log)
  const challengeEvents = log.filter(e => e.type === 'challenge_response')
  let challengeResult = null
  if (challengeEvents.length > 0) {
    const cr = challengeEvents[challengeEvents.length - 1]
    // Fast response with fluent typing = composition signal
    // latency < 3000ms to first key, response >= 10 words
    const latencyScore = cr.responseLatencyMs < 3000 ? 1.0
      : cr.responseLatencyMs < 8000 ? 0.7
      : 0.4
    const lengthScore = (cr.wordCount || 0) >= 10 ? 1.0
      : (cr.wordCount || 0) >= 5 ? 0.6
      : 0.3
    challengeResult = {
      score: latencyScore * 0.6 + lengthScore * 0.4,
      computed: true,
      latencyMs: cr.responseLatencyMs,
      wordCount: cr.wordCount
    }
  }

  const signalMap = {
    strikeScore: { score: strikeScore, computed: true, count: strikeCount },
    tabSwitch,
    pauseTopology,
    semanticEdit: { score: semanticEditScore, computed: semanticComputed, meaningfulEditRate: editProfile.meaningfulEditRate, typoRatio: editProfile.typoRatio, pauseEditKL: editProfile.pauseEditKL },
    frontier: { score: frontierScore, computed: frontierComputed, revisitRate: editProfile.frontierRevisitRate },
    typingRhythm,
    complexityCalib: complexity
  }

  const composite = weightedComposite(signalMap, challengeResult)

  const breakdown = {
    strikeScore: { score: strikeScore, weight: WEIGHTS.strikeScore, strikeCount, computed: true },
    tabSwitch: { ...tabSwitch, weight: WEIGHTS.tabSwitch },
    pauseTopology: { ...pauseTopology, weight: WEIGHTS.pauseTopology },
    semanticEdit: {
      score: semanticEditScore,
      weight: WEIGHTS.semanticEdit,
      computed: semanticComputed,
      meaningfulEditRate: editProfile.meaningfulEditRate,
      typoRatio: editProfile.typoRatio,
      pauseEditKL: editProfile.pauseEditKL,
      lexicalSubs: editProfile.lexicalSubs,
      structuralRewrites: editProfile.structuralRewrites,
      ideationalRevisions: editProfile.ideationalRevisions
    },
    frontier: { score: frontierScore, weight: WEIGHTS.frontier, computed: frontierComputed, revisitRate: editProfile.frontierRevisitRate },
    typingRhythm: { ...typingRhythm, weight: WEIGHTS.typingRhythm },
    complexityCalib: { ...complexity, weight: WEIGHTS.complexityCalib },
    ...(challengeResult ? { challengeResponse: { ...challengeResult, weight: 0.10 } } : {}),
    composite
  }

  return { score: composite, breakdown }
}

export function getVerdict(score, strikeCount) {
  if (strikeCount >= 3) return 'SUSPICIOUS'
  if (score > 0.75) return 'STRONG HUMAN SIGNAL'
  if (score >= 0.55) return 'LIKELY HUMAN'
  if (score >= 0.35) return 'AMBIGUOUS'
  return 'SUSPICIOUS'
}
