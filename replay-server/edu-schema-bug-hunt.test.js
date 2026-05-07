import { describe, expect, it } from 'vitest'

import {
  buildAssignment,
  buildEduReplay,
  buildLiveReplayHead,
  buildLiveSession,
  buildLiveSessionSummary,
  mergeLiveSessionDraft,
} from './edu-schema.js'

describe('edu schema bug hunt', () => {
  it('normalizes malformed assignment targeting, references, and override payloads without leaking junk', () => {
    const assignment = buildAssignment({
      linked_assignment_ids: [' essay-1 ', '', null, 'essay-1', 'essay-2'],
      assigned_students: [' Ada Lovelace ', '', 'Ada Lovelace', 'Grace Hopper'],
      reference_documents: [
        { data_url: 'data:application/pdf;base64,AAAA', title: '  Reader  ' },
        { data_url: 'data:application/pdf;charset=utf-8;base64,CCCC', title: 'Packet' },
        { data_url: 'data:text/plain;base64,BBBB', title: 'Bad ref' },
      ],
      student_overrides: {
        ' Ada Lovelace ': {
          student_name: 'Ada Lovelace',
          policy: { allow_dictation: true, bogus: true },
          editor_policy: { font_size: 28, line_height: 'double', weird: 'x' },
          browser_policy: { browser_enabled: false, home_url: ' https://example.org ', mode: 'blacklist' },
        },
        broken: [],
      },
    })

    expect(assignment.linked_assignment_ids).toEqual(['essay-1', 'essay-2'])
    expect(assignment.assigned_students).toEqual(['Ada Lovelace', 'Grace Hopper'])
    expect(assignment.reference_documents).toEqual([
      expect.objectContaining({
        title: 'Reader',
        mime_type: 'application/pdf',
      }),
      expect.objectContaining({
        title: 'Packet',
        mime_type: 'application/pdf',
      }),
    ])
    expect(assignment.student_overrides).toEqual({
      'ada lovelace': {
        student_name: 'Ada Lovelace',
        policy: { allow_dictation: true },
        editor_policy: { font_size: 28, line_height: 'double' },
        browser_policy: {
          browser_enabled: false,
          home_url: ' https://example.org ',
          mode: 'blacklist',
        },
      },
    })
  })

  it('drops empty student feedback but preserves visible feedback with sorted annotations', () => {
    expect(buildAssignment({ student_feedback: {} }).student_feedback).toBeNull()

    const assignment = buildAssignment({
      student_feedback: {
        teacher_comment: 'Tighten the claim.',
        inline_annotations: [
          { type: 'suggestion', start: 9, end: 14, quote: 'later', replacement: 'now', note: 'Move sooner.' },
          { type: 'comment', start: 1, end: 3, quote: 'A', note: 'Open stronger.' },
        ],
      },
    })

    expect(assignment.student_feedback).toMatchObject({
      teacher_comment: 'Tighten the claim.',
    })
    expect(assignment.student_feedback.inline_annotations.map((item) => item.start)).toEqual([1, 9])
  })

  it('normalizes malformed access request payloads down to valid keyed requests only', () => {
    const assignment = buildAssignment({
      student_access_requests: {
        ' Ada Lovelace ': {
          student_name: ' Ada Lovelace ',
          note: 'Need more time.',
        },
        broken: [],
        '': { note: 'missing name' },
      },
    })

    expect(assignment.student_access_requests).toEqual({
      'ada lovelace': expect.objectContaining({
        student_name: 'Ada Lovelace',
        note: 'Need more time.',
      }),
    })
  })

  it('buildLiveSession sanitizes grading scores and annotation ordering', () => {
    const session = buildLiveSession({
      grading: {
        grade_score: 'not-a-number',
        inline_annotations: [
          { type: 'comment', start: 12, end: 15, quote: 'late', note: 'Late note.', replacement: 'ignored' },
          { type: 'suggestion', start: 3, end: 4, quote: 'a', replacement: 'b', note: 'Swap.' },
        ],
      },
    })

    expect(session.grading.grade_score).toBeNull()
    expect(session.grading.inline_annotations).toEqual([
      expect.objectContaining({ type: 'suggestion', start: 3, replacement: 'b' }),
      expect.objectContaining({ type: 'comment', start: 12, replacement: '' }),
    ])
  })

  it('buildLiveSessionSummary trims noisy histories and clamps negative recent edit counts', () => {
    const summary = buildLiveSessionSummary({
      current_text: 'Latest',
      document_history: Array.from({ length: 40 }, (_, index) => ({ t: index })),
      url_history: Array.from({ length: 8 }, (_, index) => ({ url: `https://example.org/${index}` })),
      violations: Array.from({ length: 8 }, (_, index) => ({ kind: `v-${index}` })),
      focus_events: Array.from({ length: 12 }, (_, index) => ({ state: index % 2 ? 'focused' : 'blurred' })),
      recent_edit_count: -5,
    })

    expect(summary.recent_edit_count).toBe(0)
    expect(summary.url_history).toHaveLength(4)
    expect(summary.violations).toHaveLength(4)
    expect(summary.focus_events).toHaveLength(8)
    expect(summary.document_history).toHaveLength(40)
  })

  it('buildLiveSessionSummary includes enough recent edit history for live teacher graphs', () => {
    const history = Array.from({ length: 500 }, (_, index) => ({
      t: index * 5000,
      absolute_wall_ms: 1_700_000_000_000 + index * 5000,
      pos: index,
      del: '',
      ins: 'x',
    }))
    const summary = buildLiveSessionSummary({
      current_text: 'Latest',
      document_history: history,
    })

    expect(summary.document_history).toEqual(history)
  })

  it('buildLiveReplayHead falls back to safe counts and clamps invalid seq values', () => {
    const head = buildLiveReplayHead({
      document_history: [{ t: 1 }, { t: 2 }, { t: 3 }],
      url_history: [{ url: 'a' }, { url: 'b' }],
      last_event_seq: -10,
    })

    expect(head.snapshot_history_count).toBe(3)
    expect(head.snapshot_url_history_count).toBe(2)
    expect(head.last_event_seq).toBe(0)
  })

  it('buildEduReplay coerces malformed arrays to safe empty collections', () => {
    const replay = buildEduReplay({
      document_history: null,
      focus_events: 'bad',
      url_history: { nope: true },
      violations: 'bad',
    })

    expect(replay.document_history).toEqual([])
    expect(replay.focus_events).toEqual([])
    expect(replay.url_history).toEqual([])
    expect(replay.violations).toEqual([])
  })

  it('mergeLiveSessionDraft appends matching tails and reconstructs current text', () => {
    const merge = mergeLiveSessionDraft(
      {
        history_base_count: 1,
        history_base_t: 100,
        document_history_tail: [{ t: 220, pos: 5, del: '', ins: ' world' }],
      },
      {
        current_text: 'Hello',
        document_history: [{ t: 100, pos: 0, del: '', ins: 'Hello' }],
      },
    )

    expect(merge.error).toBeUndefined()
    expect(merge.session.current_text).toBe('Hello world')
    expect(merge.session.document_history).toHaveLength(2)
    expect(merge.ack).toMatchObject({
      accepted_history_count: 2,
      latest_history_t: 220,
      needs_checkpoint: false,
    })
  })

  it('mergeLiveSessionDraft preserves absolute wall-clock edit timestamps on tails', () => {
    const merge = mergeLiveSessionDraft(
      {
        history_base_count: 1,
        history_base_t: 100,
        document_history_tail: [
          { t: 220, pos: 5, del: '', ins: ' world', absolute_wall_ms: 1_700_000_000_220 },
        ],
      },
      {
        current_text: 'Hello',
        document_history: [{ t: 100, pos: 0, del: '', ins: 'Hello' }],
      },
    )

    expect(merge.error).toBeUndefined()
    expect(merge.session.document_history[1]).toEqual({
      t: 220,
      pos: 5,
      del: '',
      ins: ' world',
      absolute_wall_ms: 1_700_000_000_220,
    })
  })

  it('mergeLiveSessionDraft rejects stale tails without a checkpoint', () => {
    const merge = mergeLiveSessionDraft(
      {
        history_base_count: 0,
        history_base_t: 0,
        document_history_tail: [{ t: 220, pos: 5, del: '', ins: ' world' }],
      },
      {
        current_text: 'Hello',
        document_history: [{ t: 100, pos: 0, del: '', ins: 'Hello' }],
      },
    )

    expect(merge.error.status).toBe(409)
    expect(merge.error.body).toMatchObject({
      error: 'checkpoint_required',
      accepted_history_count: 1,
      latest_history_t: 100,
      needs_checkpoint: true,
    })
  })

  it('mergeLiveSessionDraft accepts checkpoints and avoids duplicate stale tail entries', () => {
    const merge = mergeLiveSessionDraft(
      {
        history_base_count: 0,
        history_base_t: 0,
        current_text_checkpoint: 'Hello world',
        document_history_tail: [
          { t: 100, pos: 0, del: '', ins: 'Hello' },
          { t: 220, pos: 5, del: '', ins: ' world' },
        ],
      },
      {
        current_text: 'Hello',
        document_history: [{ t: 100, pos: 0, del: '', ins: 'Hello' }],
      },
    )

    expect(merge.error).toBeUndefined()
    expect(merge.session.current_text).toBe('Hello world')
    expect(merge.session.document_history).toEqual([
      { t: 100, pos: 0, del: '', ins: 'Hello' },
      { t: 220, pos: 5, del: '', ins: ' world' },
    ])
    expect(merge.ack.used_checkpoint).toBe(true)
  })

  it('mergeLiveSessionDraft refreshes current text when a tail-contract publish has no new tail', () => {
    const merge = mergeLiveSessionDraft(
      {
        history_base_count: 1,
        history_base_t: 100,
        document_history_tail: [],
        current_text: 'Hello live',
      },
      {
        current_text: 'Hello',
        document_history: [{ t: 100, pos: 0, del: '', ins: 'Hello' }],
      },
    )

    expect(merge.error).toBeUndefined()
    expect(merge.session.current_text).toBe('Hello live')
    expect(merge.session.document_history).toEqual([{ t: 100, pos: 0, del: '', ins: 'Hello' }])
    expect(merge.ack).toMatchObject({
      accepted_history_count: 1,
      latest_history_t: 100,
      needs_checkpoint: false,
    })
  })

  it('mergeLiveSessionDraft accepts explicit blank current text as a real draft state', () => {
    const merge = mergeLiveSessionDraft(
      {
        history_base_count: 1,
        history_base_t: 100,
        current_text: '',
        document_history_tail: [],
      },
      {
        current_text: 'Undo me',
        document_history: [{ t: 100, pos: 0, del: '', ins: 'Undo me' }],
      },
    )

    expect(merge.error).toBeUndefined()
    expect(merge.session.current_text).toBe('')
    expect(merge.session.document_history).toEqual([{ t: 100, pos: 0, del: '', ins: 'Undo me' }])
  })

  it('assignment defaults are stable even when browser and editor policy payloads are nonsense', () => {
    const assignment = buildAssignment({
      browser_policy: {
        browser_enabled: 'yes',
        allowed_domains: 'example.org',
      },
      editor_policy: {
        font_family: 'totally-made-up-font',
        font_size: 1000,
        line_height: 'triple',
      },
    })

    expect(assignment.browser_policy).toMatchObject({
      browser_enabled: 'yes',
      home_url: '',
      allowed_domains: [],
    })
    expect(assignment.editor_policy).toMatchObject({
      font_family: 'arial',
      font_size: 12,
      line_height: 'relaxed',
    })
  })
})
