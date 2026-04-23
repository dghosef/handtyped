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
    expect(replayPageHtml).toContain('class="replay-meta"')
    expect(replayPageHtml).toContain('id="progress-gap-markers"')
    expect(replayPageHtml).toContain('id="progress-inactive-spans"')
    expect(replayPageHtml).toContain('Timeline legend')
    expect(replayPageHtml).toContain('Inactive focus')
    expect(replayPageHtml).toContain('Time jump')
    expect(replayPageHtml).toContain('.progress-gap-marker')
    expect(replayPageHtml).toContain('.progress-inactive-span')
    expect(replayPageHtml).toContain('width: 4px;')
    expect(replayPageHtml).toContain('var(--timeline-jump)')
    expect(replayPageHtml).toContain('var(--timeline-inactive)')
    expect(replayPageHtml).toContain('.progress-track.inactive::after')
    expect(replayPageHtml).toContain('repeating-linear-gradient(')
    expect(replayPageHtml).toContain('.progress-track.inactive .progress-fill')
    expect(replayPageHtml).toContain('.progress-track.inactive .progress-thumb')
    expect(replayPageHtml).toContain('buildInactiveSpans')
    expect(replayPageHtml).toContain('parseFocusEvents')
    expect(replayPageHtml).toContain('formatAbsoluteReplayTime')
    expect(replayPageHtml).toContain('getFocusStateAtElapsedMs')
    expect(replayPageHtml).toContain('buildTimelineGapMarkers')
    expect(replayPageHtml).toContain('overscroll-behavior: contain;')
    expect(
      replayPageHtml.indexOf('Replay of this page being written.'),
    ).toBeLessThan(replayPageHtml.indexOf('<div class="replay-time" id="replay-time">'))
    expect(
      replayPageHtml.indexOf('<div class="replay-time" id="replay-time">'),
    ).toBeLessThan(replayPageHtml.indexOf('<div class="replay-shell">'))
    expect(replayPageHtml).not.toContain('scrollTop = replayStageScrollEl.scrollHeight')
    expect(replayPageHtml).not.toContain('id="activity-panel"')
    expect(replayPageHtml).not.toContain('id="activity-list"')
  })
})
