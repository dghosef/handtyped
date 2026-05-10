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

  it('does not advertise or prefill a shared default teacher account', () => {
    expect(loginHtml).not.toContain('Default local development account')
    expect(loginHtml).not.toContain('value="teacher@edu.handtyped.app"')
    expect(loginHtml).not.toContain('value="handtyped-edu"')
  })

  it('renders Google sign-in after the async identity script becomes available', () => {
    expect(loginHtml).toContain('https://accounts.google.com/gsi/client')
    expect(loginHtml).toContain('id="google-signin-button"')
    expect(loginHtml).toContain('googleButtonRendered')
    expect(loginHtml).toContain('renderGoogleButtonWhenReady(retriesRemaining = 40)')
    expect(loginHtml).toContain('window.setTimeout(() => renderGoogleButtonWhenReady(retriesRemaining - 1), 150)')
    expect(loginHtml).toContain("provider: 'google'")
  })
})
