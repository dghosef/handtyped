import { describe, expect, it } from 'vitest'

import {
  LIVE_SESSION_STALE_MS,
  assignmentViewMeta,
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

describe('teacher dashboard UI logic', () => {
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

  it('sorts active sessions ahead of stale ones and then by latest activity', () => {
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
      'active-newer',
      'active-older',
      'stale',
    ])
  })

  it('filters sessions by both classroom and assignment', () => {
    const sessions = [
      { id: 'match', assignment_id: 'assignment-1', classroom: 'Period 1' },
      { id: 'wrong-assignment', assignment_id: 'assignment-2', classroom: 'Period 1' },
      { id: 'wrong-classroom', assignment_id: 'assignment-1', classroom: 'Period 2' },
    ]

    expect(sessionsForAssignment(sessions, 'Period 1', 'assignment-1').map((session) => session.id)).toEqual([
      'match',
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
      selectedClassroomId: '',
      visibleAssignments: [],
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
