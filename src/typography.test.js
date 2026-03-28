import { describe, expect, it } from 'vitest'

import { TYPOGRAPHY_RULES } from './typography.js'

describe('typography rules', () => {
  it('has a rule for em-dash', () => {
    const rule = TYPOGRAPHY_RULES.find(r => r.id === 'em-dash')
    expect(rule).toBeDefined()
    expect(rule.replacement).toBe('—')
    expect(rule.pattern.test('foo--')).toBe(true)
  })

  it('has a rule for ellipsis', () => {
    const rule = TYPOGRAPHY_RULES.find(r => r.id === 'ellipsis')
    expect(rule).toBeDefined()
    expect(rule.replacement).toBe('…')
    expect(rule.pattern.test('foo...')).toBe(true)
  })

  it('has rules for copyright, registered, trademark', () => {
    const ids = TYPOGRAPHY_RULES.map(r => r.id)
    expect(ids).toContain('copyright')
    expect(ids).toContain('registered')
    expect(ids).toContain('trademark')
  })

  it('has rules for smart quotes', () => {
    const ids = TYPOGRAPHY_RULES.map(r => r.id)
    expect(ids).toContain('double-quote')
    expect(ids).toContain('single-quote')
  })
})
