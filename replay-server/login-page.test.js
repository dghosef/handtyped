import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

const loginHtml = fs.readFileSync(new URL('./public/edu/login.html', import.meta.url), 'utf8')

describe('edu login page', () => {
  it('shows the signup form directly without a redundant create-teacher toggle', () => {
    expect(loginHtml).not.toContain('id="show-signup-button"')
    expect(loginHtml).not.toContain('Create teacher account')
    expect(loginHtml).toContain('id="teacher-signup-form"')
    expect(loginHtml).not.toMatch(/id="teacher-signup-form"[^>]*\shidden\b/)
    expect(loginHtml).toContain('Create account')
  })
})
