import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const landingPageHtml = fs.readFileSync(
  path.join(process.cwd(), 'public', 'index.html'),
  'utf8',
)

describe('landing page', () => {
  it('keeps the front-page copy intact', () => {
    expect(landingPageHtml).toContain('Proof of work for writing')
    expect(landingPageHtml).toContain(
      'With Handtyped, you can show the world that your work was human-written. For bloggers, Redditors, students, journalists, and everyone in between.',
    )
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
      'For example, <a href="https://replay.handtyped.app/1seeSaZBfpjwiF8P">here</a> is the replay for the text of this website.',
    )
    expect(landingPageHtml).toContain(
      'You could in theory build a robot to type on the keyboard, modify the client to produce fake logs, or copy from another screen and manually mimic believable typing patterns.',
    )
    expect(landingPageHtml).toContain(
      'At that point, however, faking it is as much work as writing it.',
    )
  })

  it('uses the replay font, image logo, and local mini replay player', () => {
    expect(landingPageHtml).toContain(
      'fonts.googleapis.com/css?family=Open%20Sans%3A400%2C600%2C700&display=swap',
    )
    expect(landingPageHtml).toContain("font-family: 'Open Sans', Arial, Helvetica, sans-serif;")
    expect(landingPageHtml).toContain('img src="./handtyped-icon.png" alt=""')
    expect(landingPageHtml).not.toContain('alt="Handtyped"')
    expect(landingPageHtml).toContain('class="mini-replay"')
    expect(landingPageHtml).toContain('id="mini-play"')
    expect(landingPageHtml).toContain('id="mini-track"')
    expect(landingPageHtml).toContain('id="mini-time"')
    expect(landingPageHtml).toContain('id="mini-speed"')
    expect(landingPageHtml).toContain('touch-action: none;')
    expect(landingPageHtml).toContain('overflow: auto;')
    expect(landingPageHtml).toContain('<option value="10" selected>10x</option>')
    expect(landingPageHtml).toContain('id="mini-document"')
    expect(landingPageHtml).toContain('data-session-id="1seeSaZBfpjwiF8P"')
    expect(landingPageHtml).toContain('data-session-url="./landing-replay.json"')
    expect(landingPageHtml).toContain("import {\n      compressIdleGaps")
    expect(landingPageHtml).toContain("from './replay-view.js'")
    expect(landingPageHtml).toContain('fetch(replayEl.dataset.sessionUrl)')
    expect(landingPageHtml).toContain('pointerdown')
    expect(landingPageHtml).toContain('pointermove')
    expect(landingPageHtml).toContain('pointerup')
    expect(landingPageHtml).not.toContain('<iframe')
  })

  it('keeps one download button and one GitHub button', () => {
    expect(landingPageHtml.match(/Download for macOS/g)).toHaveLength(1)
    expect(landingPageHtml).toContain('id="download-button"')
    expect(landingPageHtml).toContain('href="/downloads/Handtyped-macos.dmg"')
    expect(landingPageHtml).toContain('download="Handtyped-macos.dmg"')
    expect(landingPageHtml).toContain('id="github-button"')
    expect(landingPageHtml).toContain('href="https://github.com/dghosef/handtyped"')
    expect(landingPageHtml).toContain('<h2>How it works</h2>')
    expect(landingPageHtml).toContain('https://replay.handtyped.app/1seeSaZBfpjwiF8P')
  })
})
