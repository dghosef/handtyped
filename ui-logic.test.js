import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import {
  LIVE_SESSION_STALE_MS,
  applyLiveReplayUpdates,
  assignmentViewMeta,
  reviewDraftRenderMode,
  reviewDraftRenderSignature,
  shouldRenderReviewDraftSurface,
  isSessionActive,
  parseTimestamp,
  sessionStatusLabel,
  sessionsForAssignment,
  sortSessionsForDisplay,
} from './replay-server/public/edu/app-ui.js'
import {
  assignmentsForClassroom,
  reconcileBootstrapSelection,
} from '../handtyped-edu/frontend/bootstrap-ui.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('teacher dashboard UI logic', () => {
  it('keeps the regular Tauri window content protected against screenshots', () => {
    const handtypedLibRs = readFileSync(join(__dirname, 'src', 'lib.rs'), 'utf8')
    expect(handtypedLibRs).toMatch(/fn apply_window_screenshot_protection<R: tauri::Runtime>\(window: &tauri::WebviewWindow<R>\)/)
    expect(handtypedLibRs).toMatch(/let _ = window\.set_content_protected\(true\);/)
    expect(handtypedLibRs).toMatch(/apply_window_screenshot_protection\(&window\);/)
  })

  it('parses timestamps defensively and returns null for bad values', () => {
    expect(parseTimestamp('2026-04-26T02:30:00.000Z')).toBe(Date.parse('2026-04-26T02:30:00.000Z'))
    expect(parseTimestamp('not-a-date')).toBeNull()
    expect(parseTimestamp(undefined)).toBeNull()
  })

  it('treats the stale boundary as active and falls back to updated_at when needed', () => {
    const now = Date.parse('2026-04-26T02:30:15.000Z')

    expect(
      isSessionActive(
        {
          schedule_open: true,
          updated_at: new Date(now - LIVE_SESSION_STALE_MS).toISOString(),
        },
        now,
      ),
    ).toBe(true)

    expect(
      isSessionActive(
        {
          schedule_open: true,
          updated_at: new Date(now - LIVE_SESSION_STALE_MS - 1).toISOString(),
        },
        now,
      ),
    ).toBe(false)
  })

  it('labels stale sessions as offline and counts only active students', () => {
    const now = Date.parse('2026-04-26T02:30:00.000Z')
    const selectedAssignment = { id: 'assignment-1', course: 'English 11' }
    const selectedClassroom = { id: 'class-1', name: 'Period 1' }
    const sessions = [
      {
        id: 'live-1',
        assignment_id: 'assignment-1',
        classroom: 'Period 1',
        focused: true,
        schedule_open: true,
        last_activity_at: new Date(now - 2_000).toISOString(),
      },
      {
        id: 'live-2',
        assignment_id: 'assignment-1',
        classroom: 'Period 1',
        focused: true,
        schedule_open: true,
        last_activity_at: new Date(now - LIVE_SESSION_STALE_MS - 1_000).toISOString(),
      },
      {
        id: 'live-3',
        assignment_id: 'assignment-1',
        classroom: 'Period 1',
        focused: false,
        schedule_open: true,
        last_activity_at: new Date(now - 1_000).toISOString(),
      },
    ]

    expect(sessionStatusLabel(sessions[0], now)).toBe('Focused')
    expect(sessionStatusLabel(sessions[1], now)).toBe('Offline')
    expect(sessionStatusLabel(sessions[2], now)).toBe('Unfocused')
    expect(assignmentViewMeta(selectedAssignment, selectedClassroom, sessions, now)).toBe(
      'English 11 • 2 active students',
    )
  })

  it('sorts higher-risk sessions ahead and then by latest activity', () => {
    const now = Date.parse('2026-04-26T02:30:00.000Z')
    const sessions = [
      {
        id: 'stale',
        schedule_open: true,
        last_activity_at: new Date(now - LIVE_SESSION_STALE_MS - 5_000).toISOString(),
      },
      {
        id: 'active-older',
        schedule_open: true,
        last_activity_at: new Date(now - 5_000).toISOString(),
      },
      {
        id: 'active-newer',
        schedule_open: true,
        last_activity_at: new Date(now - 1_000).toISOString(),
      },
    ]

    expect(sortSessionsForDisplay(sessions, now).map((session) => session.id)).toEqual([
      'stale',
      'active-newer',
      'active-older',
    ])
  })

  it('filters sessions by assignment id', () => {
    const sessions = [
      { id: 'match', assignment_id: 'assignment-1', classroom: 'Period 1' },
      { id: 'wrong-assignment', assignment_id: 'assignment-2', classroom: 'Period 1' },
      { id: 'wrong-classroom', assignment_id: 'assignment-1', classroom: 'Period 2' },
    ]

    expect(sessionsForAssignment(sessions, 'Period 1', 'assignment-1').map((session) => session.id)).toEqual([
      'match',
      'wrong-classroom',
    ])
  })

  it('uses the classroom name when an assignment has no course label', () => {
    const now = Date.parse('2026-04-26T02:30:00.000Z')
    const selectedAssignment = { id: 'assignment-1', course: '' }
    const selectedClassroom = { id: 'class-1', name: 'Period 1' }
    const sessions = [
      {
        id: 'live-1',
        assignment_id: 'assignment-1',
        classroom: 'Period 1',
        focused: true,
        schedule_open: true,
        last_activity_at: new Date(now - 2_000).toISOString(),
      },
    ]

    expect(assignmentViewMeta(selectedAssignment, selectedClassroom, sessions, now)).toBe(
      'Period 1 • 1 active student',
    )
  })

  it('skips expensive review draft rendering when the draft inputs have not changed', () => {
    const previous = reviewDraftRenderSignature({
      text: 'Same draft',
      annotationVersion: 'notes:1',
      highlightVersion: 'range:a',
    })

    expect(
      shouldRenderReviewDraftSurface(previous, {
        text: 'Same draft',
        annotationVersion: 'notes:1',
        highlightVersion: 'range:a',
      }),
    ).toBe(false)

    expect(
      shouldRenderReviewDraftSurface(previous, {
        text: 'Same draft plus one character',
        annotationVersion: 'notes:1',
        highlightVersion: 'range:a',
      }),
    ).toBe(true)
  })

  it('uses lightweight review draft rendering for large documents', () => {
    expect(reviewDraftRenderMode('x'.repeat(49_999))).toBe('rich')
    expect(reviewDraftRenderMode('x'.repeat(50_000))).toBe('plain')
  })

  it('advances replay text from history tails when updates omit full current text', () => {
    const replay = applyLiveReplayUpdates(
      {
        current_text: 'Draft',
        document_history: [{ t: 1, pos: 0, ins: 'Draft' }],
        last_seq: 1,
      },
      {
        last_seq: 2,
        events: [
          {
            seq: 2,
            document_history_tail: [{ t: 2, pos: 5, ins: ' grows' }],
            current_text_length: 11,
          },
        ],
      },
    )

    expect(replay.current_text).toBe('Draft grows')
    expect(replay.document_history).toHaveLength(2)
  })
})

describe('student launcher UI logic', () => {
  it('keeps only assignments for the selected classroom', () => {
    const assignments = [
      { id: 'a1', classroom_id: 'class-1' },
      { id: 'a2', classroom_id: 'class-2' },
      { id: 'a3', classroom_id: 'class-1' },
    ]

    expect(assignmentsForClassroom(assignments, 'class-1').map((assignment) => assignment.id)).toEqual([
      'a1',
      'a3',
    ])
    expect(assignmentsForClassroom(assignments, '')).toEqual([])
  })

  it('clears deleted classroom selections and closes deleted active assignments', () => {
    const bootstrap = {
      memberships: [{ classroom_id: 'class-2', classroom_name: 'Period 2' }],
      assignments: [{ id: 'assignment-2', classroom_id: 'class-2' }],
    }

    expect(
      reconcileBootstrapSelection(bootstrap, 'class-1', {
        id: 'assignment-1',
        classroom_id: 'class-1',
      }),
    ).toEqual({
      selectedClassroomId: 'class-2',
      visibleAssignments: [{ id: 'assignment-2', classroom_id: 'class-2' }],
      shouldCloseAssignment: true,
    })
  })

  it('preserves valid classroom selections and open assignments during refresh', () => {
    const bootstrap = {
      memberships: [{ classroom_id: 'class-1', classroom_name: 'Period 1' }],
      assignments: [
        { id: 'assignment-1', classroom_id: 'class-1' },
        { id: 'assignment-2', classroom_id: 'class-1' },
      ],
    }

    expect(
      reconcileBootstrapSelection(bootstrap, 'class-1', {
        id: 'assignment-1',
        classroom_id: 'class-1',
      }),
    ).toEqual({
      selectedClassroomId: 'class-1',
      visibleAssignments: bootstrap.assignments,
      shouldCloseAssignment: false,
    })
  })
})
