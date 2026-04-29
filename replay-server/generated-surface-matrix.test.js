import { describe, it, expect } from "vitest";

import {
  buildAssignment,
  buildAssignmentWindow,
  buildClassroom,
  buildEduReplay,
  buildLiveReplayEvent,
  buildLiveReplayHead,
  buildLiveSession,
  buildLiveSessionSummary,
  buildTeacher,
  buildTeacherAuthSession,
  buildTeacherSessionRecord,
} from "./edu-schema.js";
import {
  buildAssignmentAuditRecord,
  buildStudentAssignmentConfig,
  buildStudentConfig,
} from "./edu-store.js";
import {
  EDU_SESSION_COOKIE,
  authenticateTeacher,
  authenticateTeacherWithGoogle,
  clearTeacherSessionCookie,
  createTeacherSession,
  destroyTeacherSession,
  getTeacherSession,
  teacherSessionCookie,
} from "./edu-auth.js";
import {
  buildTeacherPasswordFields,
  hashTeacherPasswordLegacy,
  verifyTeacherPassword,
} from "./edu-password.js";
import { buildReplayUrl } from "./session-store.js";

function makeStore({
  classrooms = [],
  assignments = [],
  liveSessions = [],
  teachers = [],
  teacherSessions = [],
} = {}) {
  const state = {
    classrooms: [...classrooms],
    assignments: [...assignments],
    liveSessions: [...liveSessions],
    teachers: [...teachers],
    teacherSessions: [...teacherSessions],
  };
  return {
    state,
    async listClassrooms() {
      return [...state.classrooms];
    },
    async putClassroom(classroom) {
      state.classrooms = state.classrooms.filter((item) => item.id !== classroom.id);
      state.classrooms.push(classroom);
    },
    async getClassroom(id) {
      return state.classrooms.find((item) => item.id === id) || null;
    },
    async listAssignments() {
      return [...state.assignments];
    },
    async getAssignment(id) {
      return state.assignments.find((item) => item.id === id) || null;
    },
    async listLiveSessions() {
      return [...state.liveSessions];
    },
    async getLiveSession(id) {
      return state.liveSessions.find((item) => item.id === id) || null;
    },
    async getTeacherByEmail(email) {
      return state.teachers.find((item) => item.email === email) || null;
    },
    async putTeacher(teacher) {
      state.teachers = state.teachers.filter((item) => item.id !== teacher.id);
      state.teachers.push(teacher);
    },
    async putTeacherSession(session) {
      state.teacherSessions = state.teacherSessions.filter((item) => item.id !== session.id);
      state.teacherSessions.push(session);
    },
    async getTeacherSession(id) {
      return state.teacherSessions.find((item) => item.id === id) || null;
    },
    async deleteTeacherSession(id) {
      state.teacherSessions = state.teacherSessions.filter((item) => item.id !== id);
    },
  };
}

function baseAssignment(overrides = {}) {
  return buildAssignment({
    id: "assignment-1",
    title: "1984 Essay",
    course: "English 11",
    classroom_id: "class-1",
    classroom_name: "English 11",
    prompt: "Compare 1984 to today.",
    ...overrides,
  });
}

function baseClassroom(overrides = {}) {
  return buildClassroom({
    id: "class-1",
    name: "English 11",
    join_code: "ENG11",
    teacher_name: "Ms. Keating",
    ...overrides,
  });
}

describe("generated edu schema matrix", () => {
  const classroomInputs = [
    { name: "English 11", join_code: "eng11", teacher_name: "Ms. Keating" },
    { name: "", join_code: "", teacher_name: "" },
    { name: " AP Lit ", join_code: "  p1lit ", teacher_name: "Teacher" },
    { name: "Period 5", join_code: "P5", teacher_name: "Ms. K" },
  ];
  classroomInputs.forEach((input, index) => {
    it(`buildClassroom normalization ${index + 1}`, () => {
      const classroom = buildClassroom(input);
      expect(classroom.name).toBe(String(input.name || "Untitled classroom"));
      expect(classroom.join_code).toBe(String(input.join_code || "JOINME").toUpperCase());
      expect(classroom.teacher_name).toBe(String(input.teacher_name || "Teacher"));
    });
  });

  [
    { email: "TEACHER@EDU.HANDTYPED.APP", expected: "teacher@edu.handtyped.app" },
    { email: " teacher@edu.handtyped.app ", expected: "teacher@edu.handtyped.app" },
    { email: "", expected: "teacher@edu.handtyped.app" },
    { email: "person@example.org", expected: "person@example.org" },
  ].forEach((value, index) => {
    it(`buildTeacher normalization ${index + 1}`, () => {
      const teacher = buildTeacher({ email: value.email, password: "secret" });
      expect(teacher.email).toBe(value.expected);
      expect(teacher.password_hash).toBeTruthy();
      expect(teacher.password_salt).toBeTruthy();
      expect(teacher.password_hash).toHaveLength(128);
    });
  });

  it("teacher password verification supports current and legacy hashes", () => {
    const current = buildTeacherPasswordFields({ password: "secret-123" });
    expect(current.password_hash).toHaveLength(128);
    expect(
      verifyTeacherPassword(
        {
          password_hash: current.password_hash,
          password_salt: current.password_salt,
        },
        "secret-123",
      ),
    ).toBe(true);

    const legacySalt = "legacy-salt";
    const legacy = {
      password_hash: hashTeacherPasswordLegacy("secret-123", legacySalt),
      password_salt: legacySalt,
    };
    expect(verifyTeacherPassword(legacy, "secret-123")).toBe(true);
    expect(verifyTeacherPassword(legacy, "wrong-pass")).toBe(false);
  });

  const policyModes = [
    { allow_offline_editing: true, require_lockdown: true, browser_enabled: true, assigned_students: [] },
    { allow_offline_editing: false, require_lockdown: true, browser_enabled: true, assigned_students: ["Ada Lovelace"] },
    { allow_offline_editing: true, require_lockdown: false, browser_enabled: false, assigned_students: ["Ada Lovelace", "Ada Lovelace", "Grace Hopper"] },
    { allow_offline_editing: false, require_lockdown: false, browser_enabled: false, assigned_students: [] },
  ];
  const editorModes = [
    { font_family: "arial", font_size: 16, line_height: "single" },
    { font_family: "mono", font_size: 32, line_height: "double" },
    { font_family: "bad", font_size: 99, line_height: "weird" },
  ];
  const browserModes = [
    { home_url: "https://www.gutenberg.org", allowed_domains: ["gutenberg.org"], log_all_navigation: true },
    { home_url: "", allowed_domains: [], log_all_navigation: false },
  ];
  let assignmentCase = 0;
  for (const policy of policyModes) {
    for (const editorPolicy of editorModes) {
      for (const browserPolicy of browserModes) {
        assignmentCase += 1;
        it(`buildAssignment normalization matrix ${assignmentCase}`, () => {
          const assignment = buildAssignment({
            policy,
            editor_policy: editorPolicy,
            browser_policy: {
              browser_enabled: policy.browser_enabled,
              ...browserPolicy,
            },
            assigned_students: policy.assigned_students,
            linked_assignment_ids: ["a", "a", "b", "", "c"],
            student_feedback: {
              teacher_comment: "Sharper thesis.",
              inline_annotations: [
                { type: "suggestion", start: 4, end: 6, quote: "is", note: "Use stronger verb", replacement: "becomes" },
                { type: "comment", start: 0, end: 4, quote: "This", note: "Clarify" },
              ],
            },
          });
          expect(assignment.policy.allow_offline_editing).toBe(policy.allow_offline_editing);
          expect(assignment.policy.require_lockdown).toBe(policy.require_lockdown);
          expect(["arial", "serif", "sans", "mono"]).toContain(assignment.editor_policy.font_family);
          expect(assignment.editor_policy.font_size).toBeGreaterThanOrEqual(10);
          expect(assignment.editor_policy.font_size).toBeLessThanOrEqual(100);
          expect(["compact", "single", "relaxed", "one-half", "double"]).toContain(assignment.editor_policy.line_height);
          expect(assignment.linked_assignment_ids).toEqual(["a", "b", "c"]);
          expect(new Set(assignment.assigned_students).size).toBe(assignment.assigned_students.length);
          expect(assignment.student_feedback?.inline_annotations?.[0]?.start).toBeLessThanOrEqual(
            assignment.student_feedback?.inline_annotations?.[1]?.start,
          );
        });
      }
    }
  }

  [
    { label: "Writing", start_hour: 8, start_minute: 0, end_hour: 9, end_minute: 30 },
    { label: "", start_hour: 0, start_minute: 0, end_hour: 23, end_minute: 59 },
    { label: "After school", start_hour: 15, start_minute: 15, end_hour: 17, end_minute: 45 },
  ].forEach((value, index) => {
    it(`buildAssignmentWindow normalization ${index + 1}`, () => {
      const window = buildAssignmentWindow(value);
      expect(window.label).toBe(String(value.label || "Writing window"));
      expect(window.start_hour).toBe(Number(value.start_hour));
      expect(window.end_minute).toBe(Number(value.end_minute));
    });
  });

  const liveHistoryLengths = [0, 1, 4, 25, 60];
  liveHistoryLengths.forEach((length, index) => {
    it(`buildLiveSessionSummary truncation ${index + 1}`, () => {
      const document_history = Array.from({ length }, (_, offset) => ({ t: offset + 1 }));
      const url_history = Array.from({ length }, (_, offset) => ({ url: `https://example.com/${offset}` }));
      const violations = Array.from({ length }, (_, offset) => ({ kind: `kind-${offset}` }));
      const focus_events = Array.from({ length }, (_, offset) => ({ t: offset + 1, state: "active" }));
      const summary = buildLiveSessionSummary({
        assignment_id: "assignment-1",
        student_name: "Ada Lovelace",
        document_history,
        url_history,
        violations,
        focus_events,
      });
      expect(summary.recent_edit_count).toBe(Math.min(25, length));
      expect(summary.url_history.length).toBeLessThanOrEqual(4);
      expect(summary.violations.length).toBeLessThanOrEqual(4);
      expect(summary.focus_events.length).toBeLessThanOrEqual(8);
    });
  });

  [
    buildLiveReplayHead({ snapshot_history_count: -5, snapshot_url_history_count: -3, last_event_seq: -1 }),
    buildLiveReplayHead({ document_history: [{ t: 1 }, { t: 2 }], url_history: [{ url: "https://a" }] }),
    buildLiveReplayHead({ replay_origin_wall_ms: 0, recorded_timezone_offset_minutes: -240 }),
  ].forEach((head, index) => {
    it(`buildLiveReplayHead normalization ${index + 1}`, () => {
      expect(head.snapshot_history_count).toBeGreaterThanOrEqual(0);
      expect(head.snapshot_url_history_count).toBeGreaterThanOrEqual(0);
      expect(head.last_event_seq).toBeGreaterThanOrEqual(0);
    });
  });

  [
    buildLiveReplayEvent({ seq: 0 }),
    buildLiveReplayEvent({ seq: 4, document_history_tail: [{ t: 1 }], url_history_tail: [{ url: "https://a" }] }),
    buildLiveReplayEvent({ focused: false, hid_active: false }),
  ].forEach((event, index) => {
    it(`buildLiveReplayEvent normalization ${index + 1}`, () => {
      expect(event.seq).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(event.document_history_tail)).toBe(true);
      expect(Array.isArray(event.url_history_tail)).toBe(true);
    });
  });

  [
    buildEduReplay({ replay_origin_wall_ms: 0 }),
    buildEduReplay({ recorded_timezone: "-04:00", recorded_timezone_offset_minutes: -240 }),
    buildEduReplay({ violation_count: 5, violations: [{ kind: "blocked_url" }] }),
  ].forEach((replay, index) => {
    it(`buildEduReplay normalization ${index + 1}`, () => {
      expect(typeof replay.current_text).toBe("string");
      expect(Array.isArray(replay.document_history)).toBe(true);
      expect(Array.isArray(replay.violations)).toBe(true);
    });
  });

  const auditChanges = [
    { previous: baseAssignment(), next: baseAssignment({ title: "New title" }), expectedChange: "Title" },
    { previous: baseAssignment(), next: baseAssignment({ prompt: "New prompt" }), expectedChange: "Prompt" },
    { previous: baseAssignment(), next: baseAssignment({ temporary_access_until: "2026-04-28T23:00:00.000Z" }), expectedChange: "Temporary access until" },
    { previous: baseAssignment(), next: baseAssignment({ assigned_students: ["Ada Lovelace"] }), expectedChange: "Assigned students" },
    { previous: baseAssignment(), next: baseAssignment({ browser_policy: { browser_enabled: false, home_url: "", allowed_domains: [] } }), expectedChange: "Browser policy" },
  ];
  auditChanges.forEach((value, index) => {
    it(`buildAssignmentAuditRecord changed field ${index + 1}`, () => {
      const audit = buildAssignmentAuditRecord({
        action: "updated",
        assignment: value.next,
        previousAssignment: value.previous,
        actor: { teacher_id: "teacher-1", teacher_name: "Ms. Keating", teacher_email: "teacher@edu.handtyped.app" },
      });
      expect(audit.changes.some((change) => change.label === value.expectedChange)).toBe(true);
      expect(audit.summary.startsWith("Updated")).toBe(true);
    });
  });

  it("buildAssignmentAuditRecord created and deleted summaries are stable", () => {
    expect(
      buildAssignmentAuditRecord({
        action: "created",
        assignment: baseAssignment(),
      }).summary,
    ).toContain("Created assignment");
    expect(
      buildAssignmentAuditRecord({
        action: "deleted",
        previousAssignment: baseAssignment(),
      }).summary,
    ).toContain("Deleted assignment");
  });
});

describe("generated student config matrix", () => {
  const joinCodeModes = ["ENG11", "eng11", "WRONG"];
  const studentModes = ["Ada Lovelace", "Grace Hopper", "", " Student "];
  const targetingModes = [
    [],
    ["Ada Lovelace"],
    ["Grace Hopper"],
  ];
  const overrideModes = [
    null,
    {
      "ada lovelace": {
        student_name: "Ada Lovelace",
        policy: { allow_offline_editing: false },
        browser_policy: { browser_enabled: false },
        editor_policy: { font_family: "mono", font_size: 28, line_height: "double" },
        temporary_access_until: "2026-04-28T23:00:00.000Z",
      },
    },
  ];
  const feedbackModes = [
    [],
    [
      buildLiveSession({
        id: "Ada Lovelace:assignment-1",
        assignment_id: "assignment-1",
        student_name: "Ada Lovelace",
        grading: { teacher_comment: "Tighten paragraph two." },
      }),
    ],
  ];

  let configCase = 0;
  for (const joinCode of joinCodeModes) {
    for (const studentName of studentModes) {
      for (const assignedStudents of targetingModes) {
        for (const studentOverrides of overrideModes) {
          for (const liveSessions of feedbackModes) {
            configCase += 1;
            it(`buildStudentConfig matrix ${configCase}`, async () => {
              const classroom = baseClassroom();
              const assignment = baseAssignment({
                assigned_students: assignedStudents,
                student_overrides: studentOverrides || {},
              });
              const store = makeStore({
                classrooms: [classroom],
                assignments: [assignment],
                liveSessions,
              });
              const result = await buildStudentConfig(store, { joinCode, studentName });
              const joinMatches = String(joinCode).toUpperCase() === classroom.join_code;
              const normalizedStudent = String(studentName || "").trim().toLowerCase();
              const targeted = assignedStudents.length > 0;
              const receivesAssignment = joinMatches && (
                !targeted ||
                !normalizedStudent ||
                assignedStudents.some((name) => name.toLowerCase() === normalizedStudent)
              );
              if (!joinMatches) {
                expect(result).toEqual({ classroom: null, assignments: [] });
                return;
              }
              expect(result.classroom?.id).toBe(classroom.id);
              expect(result.assignments.length).toBe(receivesAssignment ? 1 : 0);
              if (receivesAssignment) {
                const returned = result.assignments[0];
                if (normalizedStudent === "ada lovelace" && studentOverrides) {
                  expect(returned.policy.allow_offline_editing).toBe(false);
                  expect(returned.browser_policy.browser_enabled).toBe(false);
                  expect(returned.editor_policy.font_family).toBe("mono");
                }
                if (liveSessions.length && normalizedStudent === "ada lovelace") {
                  expect(returned.student_feedback?.teacher_comment).toBe("Tighten paragraph two.");
                }
              }
            });
          }
        }
      }
    }
  }

  const assignmentConfigCases = [
    { joinCode: "ENG11", studentName: "Ada Lovelace", assignedStudents: [], expectAssignment: true },
    { joinCode: "eng11", studentName: "Ada Lovelace", assignedStudents: ["Ada Lovelace"], expectAssignment: true },
    { joinCode: "ENG11", studentName: "Grace Hopper", assignedStudents: ["Ada Lovelace"], expectAssignment: false },
    { joinCode: "BAD11", studentName: "Ada Lovelace", assignedStudents: [], expectAssignment: false },
  ];
  assignmentConfigCases.forEach((value, index) => {
    it(`buildStudentAssignmentConfig matrix ${index + 1}`, async () => {
      const classroom = baseClassroom();
      const assignment = baseAssignment({
        assigned_students: value.assignedStudents,
      });
      const store = makeStore({
        classrooms: [classroom],
        assignments: [assignment],
        liveSessions: [
          buildLiveSession({
            id: `${value.studentName}:assignment-1`,
            assignment_id: assignment.id,
            student_name: value.studentName,
            grading: { grade_label: "A-", grade_score: 92 },
          }),
        ],
      });
      const result = await buildStudentAssignmentConfig(store, {
        assignmentId: assignment.id,
        joinCode: value.joinCode,
        studentName: value.studentName,
      });
      expect(result.classroom?.id ?? null).toBe(value.joinCode.toUpperCase() === "ENG11" ? classroom.id : null);
      expect(Boolean(result.assignment)).toBe(value.expectAssignment);
      if (value.expectAssignment) {
        expect(result.assignment.student_feedback?.grade_label).toBe("A-");
      }
    });
  });
});

describe("generated teacher auth and session matrix", () => {
  [
    { email: "teacher@edu.handtyped.app", password: "handtyped-edu", shouldAuth: true },
    { email: "TEACHER@EDU.HANDTYPED.APP", password: "handtyped-edu", shouldAuth: true },
    { email: "teacher@edu.handtyped.app", password: "wrong", shouldAuth: false },
    { email: "missing@edu.handtyped.app", password: "handtyped-edu", shouldAuth: false },
  ].forEach((value, index) => {
    it(`authenticateTeacher password matrix ${index + 1}`, async () => {
      const teacher = buildTeacher({
        id: "teacher-1",
        email: "teacher@edu.handtyped.app",
        password: "handtyped-edu",
      });
      const store = makeStore({ teachers: [teacher] });
      const result = await authenticateTeacher(store, {
        email: value.email,
        password: value.password,
      });
      expect(Boolean(result)).toBe(value.shouldAuth);
    });
  });

  [
    { email: "teacher@edu.handtyped.app", accessCode: "handtyped-edu", shouldAuth: true },
    { email: "teacher@edu.handtyped.app", accessCode: "wrong", shouldAuth: false },
  ].forEach((value, index) => {
    it(`authenticateTeacher access-code matrix ${index + 1}`, async () => {
      const teacher = buildTeacher({
        id: "teacher-1",
        email: "teacher@edu.handtyped.app",
        access_code: "handtyped-edu",
      });
      const store = makeStore({ teachers: [teacher] });
      const result = await authenticateTeacher(store, value);
      expect(Boolean(result)).toBe(value.shouldAuth);
    });
  });

  [
    { profile: { email: "teacher@edu.handtyped.app", sub: "google-1" }, google_subject: null, shouldAuth: true, expectedSubject: "google-1" },
    { profile: { email: "teacher@edu.handtyped.app", sub: "google-1" }, google_subject: "google-1", shouldAuth: true, expectedSubject: "google-1" },
    { profile: { email: "teacher@edu.handtyped.app", sub: "google-2" }, google_subject: "google-1", shouldAuth: false, expectedSubject: "google-1" },
    { profile: { email: "", sub: "" }, google_subject: null, shouldAuth: false, expectedSubject: null },
  ].forEach((value, index) => {
    it(`authenticateTeacherWithGoogle matrix ${index + 1}`, async () => {
      const teacher = buildTeacher({
        id: "teacher-1",
        email: "teacher@edu.handtyped.app",
        google_subject: value.google_subject,
      });
      const store = makeStore({ teachers: [teacher] });
      const result = await authenticateTeacherWithGoogle(store, value.profile);
      expect(Boolean(result)).toBe(value.shouldAuth);
      if (value.shouldAuth) {
        expect(store.state.teachers[0].google_subject).toBe(value.expectedSubject);
      }
    });
  });

  [60, 3_600, 43_200].forEach((maxAgeSeconds, index) => {
    it(`teacherSessionCookie encodes max age ${index + 1}`, () => {
      const cookie = teacherSessionCookie("session-1", maxAgeSeconds);
      expect(cookie).toContain(`${EDU_SESSION_COOKIE}=session-1`);
      expect(cookie).toContain(`Max-Age=${maxAgeSeconds}`);
    });
  });

  it("clearTeacherSessionCookie expires immediately", () => {
    expect(clearTeacherSessionCookie()).toContain("Max-Age=0");
  });

  it("createTeacherSession persists a session record", async () => {
    const store = makeStore();
    const teacher = buildTeacher({ id: "teacher-1", email: "teacher@edu.handtyped.app" });
    const record = await createTeacherSession(store, teacher, "password");
    expect(store.state.teacherSessions).toHaveLength(1);
    expect(record.provider).toBe("password");
  });

  [
    { rawCookie: "", expiresAt: null, authenticated: false },
    { rawCookie: `${EDU_SESSION_COOKIE}=missing`, expiresAt: null, authenticated: false },
    { rawCookie: `${EDU_SESSION_COOKIE}=session-1`, expiresAt: "2999-01-01T00:00:00.000Z", authenticated: true },
    { rawCookie: `${EDU_SESSION_COOKIE}=session-1`, expiresAt: "2000-01-01T00:00:00.000Z", authenticated: false },
  ].forEach((value, index) => {
    it(`getTeacherSession matrix ${index + 1}`, async () => {
      const session = value.expiresAt
        ? buildTeacherSessionRecord({
            id: "session-1",
            teacher_id: "teacher-1",
            teacher_name: "Ms. Keating",
            teacher_email: "teacher@edu.handtyped.app",
            expires_at: value.expiresAt,
          })
        : null;
      const store = makeStore({ teacherSessions: session ? [session] : [] });
      const result = await getTeacherSession(store, value.rawCookie);
      expect(result.authenticated).toBe(value.authenticated);
    });
  });

  it("destroyTeacherSession removes the session when present", async () => {
    const session = buildTeacherSessionRecord({
      id: "session-1",
      teacher_id: "teacher-1",
      teacher_name: "Ms. Keating",
      teacher_email: "teacher@edu.handtyped.app",
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    const store = makeStore({ teacherSessions: [session] });
    await destroyTeacherSession(store, `${EDU_SESSION_COOKIE}=session-1`);
    expect(store.state.teacherSessions).toHaveLength(0);
  });

  [
    { authenticated: true, teacher_name: "Teacher" },
    { authenticated: false, teacher_name: null },
  ].forEach((value, index) => {
    it(`buildTeacherAuthSession normalization ${index + 1}`, () => {
      const session = buildTeacherAuthSession(value);
      expect(session.authenticated).toBe(Boolean(value.authenticated));
      expect(session.provider).toBeTruthy();
    });
  });
});

describe("generated replay url matrix", () => {
  [
    ["https://edu.handtyped.app", "abc123", "https://edu.handtyped.app/abc123"],
    ["https://edu.handtyped.app/", "abc123", "https://edu.handtyped.app/abc123"],
    ["http://localhost:4000/", "replay-1", "http://localhost:4000/replay-1"],
    ["http://localhost:4000", "nested/id", "http://localhost:4000/nested/id"],
  ].forEach(([origin, id, expected], index) => {
    it(`buildReplayUrl case ${index + 1}`, () => {
      expect(buildReplayUrl(origin, id)).toBe(expected);
    });
  });
});
