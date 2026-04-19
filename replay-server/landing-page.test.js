import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const landingPageHtml = fs.readFileSync(
  path.join(process.cwd(), 'public', 'index.html'),
  'utf8',
)

describe('landing page copy', () => {
  it('contains the proof-of-work headline and intro copy', () => {
    expect(landingPageHtml).toContain('Proof of work for writing')
    expect(landingPageHtml).toContain(
      'With Handtyped, you can prove to the world that your work was human-written. For bloggers, Redditors, students, journalists, and everyone in between.',
    )
  })

  it('uses the same font for headings and the download button', () => {
    expect(landingPageHtml).toContain(
      "fonts.googleapis.com/css?family=Open%20Sans%3A400%2C600%2C700&display=swap",
    )
    expect(landingPageHtml).toContain("font-family: 'Open Sans', Arial, Helvetica, sans-serif;")
    expect(landingPageHtml).not.toContain('Oswald')
    expect(landingPageHtml).toContain('p + p {')
    expect(landingPageHtml).toContain('margin-top: 14px;')
  })

  it('contains the exact proof and replay copy', () => {
    expect(landingPageHtml).toContain(
      'Handtyped is a markdown editor that only allows input from your physical keyboard. No copy and paste, no AI agents, and no',
    )
    expect(landingPageHtml).toContain(
      'Anything written in Handtyped must truly be typed by hand.',
    )
    expect(landingPageHtml).toContain(
      'Once you finish writing, Handtyped generates and publishes a millisecond-accurate replay of your writing process, keystroke by keystroke. Readers will be able to see every deletion, pause, and rewrite.',
    )
    expect(landingPageHtml).toContain(
      'For example, <a href="https://replay.handtyped.app/B5HKW61AIFZ1Hb2y">here</a> is the replay for the text of this website.',
    )
  })

  it('contains the limitations text and a download button', () => {
    expect(landingPageHtml).toContain(
      'You could in theory build a robot to type on the keyboard, modify the client to produce fake logs, or copy from another screen and manually mimic believable typing patterns.',
    )
    expect(landingPageHtml).toContain(
      'At that point, however, faking it is as much work as writing it.',
    )
    expect(landingPageHtml.match(/Download for macOS/g)).toHaveLength(1)
    expect(landingPageHtml).toContain('id="download-button"')
    expect(landingPageHtml).toContain('href="/downloads/Handtyped-macos.dmg"')
    expect(landingPageHtml).toContain('download="Handtyped-macos.dmg"')
    expect(landingPageHtml).toContain('id="github-button"')
    expect(landingPageHtml).toContain('href="https://github.com/dghosef/handtyped"')
    expect(landingPageHtml).toContain('How it works:')
  })
})
