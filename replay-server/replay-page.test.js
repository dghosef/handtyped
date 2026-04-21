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
    expect(replayPageHtml).toContain('body.embed {')
    expect(replayPageHtml).toContain('flex-wrap: nowrap;')
    expect(replayPageHtml).toContain('body.embed .time-meta,')
    expect(replayPageHtml).toContain('body.embed .replay-status')
    expect(replayPageHtml).toContain("const isEmbed = new URLSearchParams(location.search).has('embed')")
    expect(replayPageHtml).toContain("document.body.classList.add('embed')")
    expect(replayPageHtml).toContain('touch-action: none;')
    expect(replayPageHtml).toContain('pointerdown')
    expect(replayPageHtml).toContain('pointermove')
    expect(replayPageHtml).toContain('pointerup')
    expect(replayPageHtml).not.toContain('scrollTop = replayStageScrollEl.scrollHeight')
    expect(replayPageHtml).not.toContain("addEventListener('click', event =>")
  })
})
