import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const replayPageHtml = fs.readFileSync(
  path.join(process.cwd(), 'public', 'replay.html'),
  'utf8',
)

describe('replay page embed mode', () => {
  it('hides the extra chrome and keeps the player compact in embeds', () => {
    expect(replayPageHtml).toContain('body.embed .brand')
    expect(replayPageHtml).toContain('body.embed .share-row')
    expect(replayPageHtml).toContain('body.embed .keyboard-note')
    expect(replayPageHtml).toContain('body.embed .replay-stage-scroll')
    expect(replayPageHtml).toContain('body.embed .doc-page')
    expect(replayPageHtml).toContain('Replay of this page being written.')
    expect(replayPageHtml).toContain('body.embed {')
    expect(replayPageHtml).toContain('flex-wrap: nowrap;')
    expect(replayPageHtml).toContain('body.embed .replay-status')
    expect(replayPageHtml).toContain('border-radius: 0;')
    expect(replayPageHtml).toContain("const isEmbed = new URLSearchParams(location.search).has('embed')")
    expect(replayPageHtml).toContain("document.body.classList.add('embed')")
    expect(replayPageHtml).toContain('touch-action: none;')
    expect(replayPageHtml).toContain('id="replay-time"')
    expect(replayPageHtml).toContain('PST')
    expect(replayPageHtml).toContain('.replay-meta {')
    expect(replayPageHtml).toContain('id="progress-readout"')
    expect(replayPageHtml).toContain('id="progress-tooltip"')
    expect(replayPageHtml).toContain('.progress-tooltip')
    expect(replayPageHtml).toContain('formatAbsoluteReplayTime')
    expect(replayPageHtml).toContain('getFocusStateAtElapsedMs')
    expect(replayPageHtml).toContain('overscroll-behavior: contain;')
    expect(replayPageHtml).toContain('Absolute time: --')
    expect(replayPageHtml).toContain("Mac's trusted built-in keyboard transport")
    expect(replayPageHtml).toContain('Input verification')
    expect(
      replayPageHtml.indexOf('Replay of this page being written.'),
    ).toBeLessThan(replayPageHtml.indexOf('<div class="replay-time" id="replay-time">'))
    expect(
      replayPageHtml.indexOf('<div class="replay-time" id="replay-time">'),
    ).toBeLessThan(replayPageHtml.indexOf('<div class="replay-shell">'))
    expect(
      replayPageHtml.indexOf('<div class="progress-readout" id="progress-readout">Absolute time: --</div>'),
    ).toBeLessThan(replayPageHtml.indexOf('<div class="replay-status" id="status-msg">'))
    expect(replayPageHtml).not.toContain('scrollTop = replayStageScrollEl.scrollHeight')
    expect(replayPageHtml).not.toContain('id="activity-panel"')
    expect(replayPageHtml).not.toContain('id="activity-list"')
    expect(replayPageHtml).not.toContain('Time jump')
    expect(replayPageHtml).not.toContain('Inactive from')
  })
})
