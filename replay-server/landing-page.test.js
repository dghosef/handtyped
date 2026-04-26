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
    expect(landingPageHtml).toContain('--page: #f5f5f5;')
    expect(landingPageHtml).toContain('img src="./handtyped-icon.png" alt=""')
    expect(landingPageHtml).not.toContain('The fingerprint mark means the words were typed by hand.')
    expect(landingPageHtml).not.toContain('alt="Handtyped"')
    expect(landingPageHtml).toContain('class="mini-replay"')
    expect(landingPageHtml).toContain('id="mini-play"')
    expect(landingPageHtml).toContain('id="mini-track"')
    expect(landingPageHtml).toContain('id="mini-inactive-spans"')
    expect(landingPageHtml).toContain('.mini-inactive-span')
    expect(landingPageHtml).toContain('id="mini-time"')
    expect(landingPageHtml).toContain('id="mini-speed"')
    expect(landingPageHtml).toContain('touch-action: none;')
    expect(landingPageHtml).toContain('overflow: auto;')
    expect(landingPageHtml).toContain('overscroll-behavior: contain;')
    expect(landingPageHtml).toContain('background: var(--page);')
    expect(landingPageHtml).toContain('border-radius: 0;')
    expect(landingPageHtml).toContain('border: 1px solid #e7e7e7;')
    expect(landingPageHtml).toContain('padding: 0 0 76px;')
    expect(landingPageHtml).toContain('height: 360px;')
    expect(landingPageHtml).toContain('border-top: 1px solid var(--line);')
    expect(landingPageHtml).toContain('<option value="10" selected>10x</option>')
    expect(landingPageHtml).toContain('id="mini-document"')
    expect(landingPageHtml).toContain('Watch exactly how this page was written')
    expect(
      landingPageHtml.indexOf('Watch exactly how this page was written'),
    ).toBeGreaterThan(landingPageHtml.indexOf('data-session-id="1seeSaZBfpjwiF8P"'))
    expect(landingPageHtml).toContain('data-session-id="1seeSaZBfpjwiF8P"')
    expect(landingPageHtml).toContain('data-session-url="./landing-replay.json"')
    expect(landingPageHtml).toContain("import {\n      buildInactiveSpans")
    expect(landingPageHtml).toContain('parseFocusEvents')
    expect(landingPageHtml).toContain('buildInactiveSpans')
    expect(landingPageHtml).toContain('renderMarkdownInto')
    expect(landingPageHtml).toContain("from './replay-view.js'")
    expect(landingPageHtml).toContain('fetch(replayEl.dataset.sessionUrl)')
    expect(landingPageHtml).toContain("addEventListener('mousedown', beginTimelineDrag)")
    expect(landingPageHtml).toContain("window.addEventListener('mousemove', dragMoveHandler)")
    expect(landingPageHtml).toContain("window.addEventListener('mouseup', dragUpHandler)")
    expect(landingPageHtml).not.toContain('<iframe')
    expect(landingPageHtml).not.toContain('documentEl.innerHTML = marked.parse(rawText)')
  })

  it('keeps download, education, and GitHub entry points', () => {
    expect(landingPageHtml.match(/Download for macOS/g)).toHaveLength(1)
    expect(landingPageHtml).toContain('id="download-button"')
    expect(landingPageHtml).toContain('href="/downloads/Handtyped-macos.dmg"')
    expect(landingPageHtml).toContain('download="Handtyped-macos.dmg"')
    expect(landingPageHtml).toContain('id="education-button"')
    expect(landingPageHtml).toContain('href="https://edu.handtyped.app"')
    expect(landingPageHtml).toContain('id="github-button"')
    expect(landingPageHtml).toContain('href="https://github.com/dghosef/handtyped"')
    expect(landingPageHtml).toContain('<h2>How it works</h2>')
    expect(landingPageHtml).toContain('https://replay.handtyped.app/1seeSaZBfpjwiF8P')
  })
})
