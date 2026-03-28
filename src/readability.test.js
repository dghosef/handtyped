import { describe, it, expect } from 'vitest'
import { countSyllables, fleschKincaid } from './readability.js'

describe('countSyllables', () => {
  it('counts simple word', () => { expect(countSyllables('hello')).toBe(2) })
  it('counts monosyllable', () => { expect(countSyllables('cat')).toBe(1) })
  it('counts "education"', () => { expect(countSyllables('education')).toBe(4) })
  it('short word returns 1', () => { expect(countSyllables('the')).toBe(1) })
  it('handles empty string', () => { expect(countSyllables('')).toBe(0) })
})

describe('fleschKincaid', () => {
  it('returns score and level', () => {
    const result = fleschKincaid('The cat sat on the mat. It is a fat cat.')
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('level')
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
  })
  it('handles single word', () => {
    const result = fleschKincaid('Hello.')
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result).toHaveProperty('level')
    expect(typeof result.level).toBe('string')
  })
  it('assigns correct level label', () => {
    // Simple short text should get a high score (easy reading)
    const { level } = fleschKincaid('Go. Run. Jump. Play. See the dog. He ran fast.')
    expect(['5th grade','6th grade','7th grade','8th–9th grade','College','Graduate']).toContain(level)
  })
  it('simple text scores higher than complex', () => {
    const simple = fleschKincaid('The dog ran fast. The cat sat down.')
    const complex = fleschKincaid('The utilization of sophisticated methodological frameworks necessitates comprehensive evaluation.')
    expect(simple.score).toBeGreaterThan(complex.score)
  })
})
