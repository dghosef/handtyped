import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  buildAssignment,
  buildClassroom,
  buildEduReplay,
  buildLiveSession,
  buildTeacher,
  nowIso,
} from './edu-schema.js'

const CLASSROOM_PREFIX = 'edu:classrooms:'
const ASSIGNMENT_PREFIX = 'edu:assignments:'
const LIVE_PREFIX = 'edu:live_sessions:'
const REPLAY_PREFIX = 'edu:replays:'
const TEACHER_PREFIX = 'edu:teachers:'
const TEACHER_SESSION_PREFIX = 'edu:teacher_sessions:'
const D1_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS edu_records (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    json TEXT NOT NULL,
    email TEXT,
    join_code TEXT,
    classroom_id TEXT,
    PRIMARY KEY (kind, id)
  )`,
  'CREATE INDEX IF NOT EXISTS edu_records_kind_updated_at ON edu_records(kind, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS edu_records_teacher_email ON edu_records(kind, email)',
  'CREATE INDEX IF NOT EXISTS edu_records_join_code ON edu_records(kind, join_code)',
  'CREATE INDEX IF NOT EXISTS edu_records_classroom_id ON edu_records(kind, classroom_id)',
]

function recordUpdatedAt(record) {
  return String(record?.updated_at || nowIso())
}

function normalizeJoinCode(joinCode) {
  return String(joinCode || '').trim().toUpperCase()
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function sortByUpdatedDesc(items) {
  return [...items].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
}

export function createNodeEduStore(baseDir) {
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }

  function filePath(name) {
    return join(baseDir, `${name}.json`)
  }

  function readCollection(name) {
    const path = filePath(name)
    if (!existsSync(path)) {
      return []
    }
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  function writeCollection(name, value) {
    writeFileSync(filePath(name), JSON.stringify(value, null, 2))
  }

  return {
    async listClassrooms() {
      return sortByUpdatedDesc(readCollection('classrooms'))
    },
    async putClassroom(classroom) {
      const classrooms = readCollection('classrooms')
      const next = classrooms.filter((item) => item.id !== classroom.id)
      next.push(classroom)
      writeCollection('classrooms', next)
    },
    async getClassroom(id) {
      return readCollection('classrooms').find((item) => item.id === id) || null
    },
    async deleteClassroom(id) {
      const classrooms = readCollection('classrooms')
      writeCollection(
        'classrooms',
        classrooms.filter((item) => item.id !== id),
      )
    },
    async listAssignments() {
      return sortByUpdatedDesc(readCollection('assignments'))
    },
    async putAssignment(assignment) {
      const assignments = readCollection('assignments')
      const next = assignments.filter((item) => item.id !== assignment.id)
      next.push(assignment)
      writeCollection('assignments', next)
    },
    async getAssignment(id) {
      return readCollection('assignments').find((item) => item.id === id) || null
    },
    async deleteAssignment(id) {
      const assignments = readCollection('assignments')
      writeCollection(
        'assignments',
        assignments.filter((item) => item.id !== id),
      )
    },
    async listTeachers() {
      return sortByUpdatedDesc(readCollection('teachers'))
    },
    async putTeacher(teacher) {
      const teachers = readCollection('teachers')
      const next = teachers.filter((item) => item.id !== teacher.id)
      next.push(teacher)
      writeCollection('teachers', next)
    },
    async getTeacherByEmail(email) {
      return readCollection('teachers').find((item) => item.email === email) || null
    },
    async putTeacherSession(session) {
      const sessions = readCollection('teacher_sessions')
      const next = sessions.filter((item) => item.id !== session.id)
      next.push(session)
      writeCollection('teacher_sessions', next)
    },
    async getTeacherSession(id) {
      return readCollection('teacher_sessions').find((item) => item.id === id) || null
    },
    async deleteTeacherSession(id) {
      const sessions = readCollection('teacher_sessions')
      writeCollection(
        'teacher_sessions',
        sessions.filter((item) => item.id !== id),
      )
    },
    async listLiveSessions() {
      return sortByUpdatedDesc(readCollection('live_sessions'))
    },
    async putLiveSession(session) {
      const sessions = readCollection('live_sessions')
      const next = sessions.filter((item) => item.id !== session.id)
      next.push(session)
      writeCollection('live_sessions', next)
    },
    async getLiveSession(id) {
      return readCollection('live_sessions').find((item) => item.id === id) || null
    },
    async listReplays() {
      return sortByUpdatedDesc(readCollection('replays'))
    },
    async putReplay(replay) {
      const replays = readCollection('replays')
      const next = replays.filter((item) => item.id !== replay.id)
      next.push(replay)
      writeCollection('replays', next)
    },
    async getReplay(id) {
      return readCollection('replays').find((item) => item.id === id) || null
    },
  }
}

export function createKvEduStore(kv) {
  async function listByPrefix(prefix) {
    const response = await kv.list({ prefix })
    const items = []
    for (const key of response.keys || []) {
      const raw = await kv.get(key.name)
      if (raw) {
        items.push(JSON.parse(raw))
      }
    }
    return items
  }

  return {
    async listClassrooms() {
      return sortByUpdatedDesc(await listByPrefix(CLASSROOM_PREFIX))
    },
    async putClassroom(classroom) {
      await kv.put(`${CLASSROOM_PREFIX}${classroom.id}`, JSON.stringify(classroom))
    },
    async getClassroom(id) {
      const raw = await kv.get(`${CLASSROOM_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
    async deleteClassroom(id) {
      await kv.delete(`${CLASSROOM_PREFIX}${id}`)
    },
    async listAssignments() {
      return sortByUpdatedDesc(await listByPrefix(ASSIGNMENT_PREFIX))
    },
    async putAssignment(assignment) {
      await kv.put(`${ASSIGNMENT_PREFIX}${assignment.id}`, JSON.stringify(assignment))
    },
    async getAssignment(id) {
      const raw = await kv.get(`${ASSIGNMENT_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
    async deleteAssignment(id) {
      await kv.delete(`${ASSIGNMENT_PREFIX}${id}`)
    },
    async listTeachers() {
      return sortByUpdatedDesc(await listByPrefix(TEACHER_PREFIX))
    },
    async putTeacher(teacher) {
      await kv.put(`${TEACHER_PREFIX}${teacher.id}`, JSON.stringify(teacher))
    },
    async getTeacherByEmail(email) {
      const teachers = await listByPrefix(TEACHER_PREFIX)
      return teachers.find((item) => item.email === email) || null
    },
    async putTeacherSession(session) {
      await kv.put(`${TEACHER_SESSION_PREFIX}${session.id}`, JSON.stringify(session))
    },
    async getTeacherSession(id) {
      const raw = await kv.get(`${TEACHER_SESSION_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
    async deleteTeacherSession(id) {
      await kv.delete(`${TEACHER_SESSION_PREFIX}${id}`)
    },
    async listLiveSessions() {
      return sortByUpdatedDesc(await listByPrefix(LIVE_PREFIX))
    },
    async putLiveSession(session) {
      await kv.put(`${LIVE_PREFIX}${session.id}`, JSON.stringify(session))
    },
    async getLiveSession(id) {
      const raw = await kv.get(`${LIVE_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
    async listReplays() {
      return sortByUpdatedDesc(await listByPrefix(REPLAY_PREFIX))
    },
    async putReplay(replay) {
      await kv.put(`${REPLAY_PREFIX}${replay.id}`, JSON.stringify(replay))
    },
    async getReplay(id) {
      const raw = await kv.get(`${REPLAY_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
  }
}

export function createD1EduStore(db) {
  let schemaReady = null

  async function ensureSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        for (const statement of D1_SCHEMA_STATEMENTS) {
          await db.prepare(statement).run()
        }
      })()
    }
    await schemaReady
  }

  async function listKind(kind) {
    await ensureSchema()
    const response = await db
      .prepare('SELECT json FROM edu_records WHERE kind = ? ORDER BY updated_at DESC, id DESC')
      .bind(kind)
      .all()
    return (response.results || []).map((row) => JSON.parse(row.json))
  }

  async function getByKindAndId(kind, id) {
    await ensureSchema()
    const row = await db
      .prepare('SELECT json FROM edu_records WHERE kind = ? AND id = ? LIMIT 1')
      .bind(kind, id)
      .first()
    return row ? JSON.parse(row.json) : null
  }

  async function putRecord(kind, id, record, extras = {}) {
    await ensureSchema()
    await db
      .prepare(
        `INSERT INTO edu_records (kind, id, updated_at, json, email, join_code, classroom_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET
           updated_at = excluded.updated_at,
           json = excluded.json,
           email = excluded.email,
           join_code = excluded.join_code,
           classroom_id = excluded.classroom_id`,
      )
      .bind(
        kind,
        id,
        recordUpdatedAt(record),
        JSON.stringify(record),
        extras.email || null,
        extras.join_code || null,
        extras.classroom_id || null,
      )
      .run()
  }

  return {
    async listClassrooms() {
      return listKind('classroom')
    },
    async putClassroom(classroom) {
      await putRecord('classroom', classroom.id, classroom, {
        join_code: normalizeJoinCode(classroom.join_code),
      })
    },
    async getClassroom(id) {
      return getByKindAndId('classroom', id)
    },
    async deleteClassroom(id) {
      await ensureSchema()
      await db.prepare('DELETE FROM edu_records WHERE kind = ? AND id = ?').bind('classroom', id).run()
    },
    async listAssignments() {
      return listKind('assignment')
    },
    async putAssignment(assignment) {
      await putRecord('assignment', assignment.id, assignment, {
        classroom_id: assignment.classroom_id || null,
      })
    },
    async getAssignment(id) {
      return getByKindAndId('assignment', id)
    },
    async deleteAssignment(id) {
      await ensureSchema()
      await db.prepare('DELETE FROM edu_records WHERE kind = ? AND id = ?').bind('assignment', id).run()
    },
    async listTeachers() {
      return listKind('teacher')
    },
    async putTeacher(teacher) {
      await putRecord('teacher', teacher.id, teacher, {
        email: normalizeEmail(teacher.email),
      })
    },
    async getTeacherByEmail(email) {
      await ensureSchema()
      const row = await db
        .prepare('SELECT json FROM edu_records WHERE kind = ? AND email = ? LIMIT 1')
        .bind('teacher', normalizeEmail(email))
        .first()
      return row ? JSON.parse(row.json) : null
    },
    async putTeacherSession(session) {
      await putRecord('teacher_session', session.id, session)
    },
    async getTeacherSession(id) {
      return getByKindAndId('teacher_session', id)
    },
    async deleteTeacherSession(id) {
      await ensureSchema()
      await db.prepare('DELETE FROM edu_records WHERE kind = ? AND id = ?').bind('teacher_session', id).run()
    },
    async listLiveSessions() {
      return listKind('live_session')
    },
    async putLiveSession(session) {
      await putRecord('live_session', session.id, session, {
        classroom_id: session.assignment_id || null,
      })
    },
    async getLiveSession(id) {
      return getByKindAndId('live_session', id)
    },
    async listReplays() {
      return listKind('replay')
    },
    async putReplay(replay) {
      await putRecord('replay', replay.id, replay, {
        classroom_id: replay.assignment_id || null,
      })
    },
    async getReplay(id) {
      return getByKindAndId('replay', id)
    },
  }
}

export async function ensureEduSeedData(store) {
  const classrooms = await store.listClassrooms()
  const assignments = await store.listAssignments()
  const liveSessions = await store.listLiveSessions()
  const teachers = await store.listTeachers()

  if (!teachers.length) {
    const runtimeEnv = globalThis.process?.env || {}
    await store.putTeacher(
      buildTeacher({
        id: 'teacher_default',
        name: 'Joseph Tan',
        email: runtimeEnv.EDU_TEACHER_EMAIL || 'teacher@edu.handtyped.app',
        access_code: runtimeEnv.EDU_TEACHER_ACCESS_CODE || 'handtyped-edu',
      }),
    )
  }

  if (classrooms.length || assignments.length || liveSessions.length) {
    return
  }

  const classroomOne = buildClassroom({
    id: 'period-1',
    name: 'English 11 - Period 1',
    join_code: 'P1EN11',
    teacher_name: 'Joseph Tan',
    students: ['Ava L.', 'Mason R.'],
  })
  const classroomTwo = buildClassroom({
    id: 'period-3',
    name: 'English 11 - Period 3',
    join_code: 'P3EN11',
    teacher_name: 'Joseph Tan',
    students: ['Nina T.', 'Leo C.'],
  })

  await store.putClassroom(classroomOne)
  await store.putClassroom(classroomTwo)

  const assignmentOne = buildAssignment({
    id: 'gatsby-close-reading',
    title: 'Gatsby Close Reading',
    course: 'English 11',
    classroom_id: classroomOne.id,
    classroom_name: classroomOne.name,
    prompt: 'Write an in-class essay responding to the assigned reading.',
    instructions: 'Use only this computer. Build your argument from memory and class notes.',
    browser_policy: {
      browser_enabled: true,
      home_url: 'https://www.gutenberg.org',
      allowed_domains: ['gutenberg.org'],
      log_all_navigation: true,
    },
  })
  const assignmentTwo = buildAssignment({
    id: 'macbeth-timed-essay',
    title: 'Macbeth Timed Essay',
    course: 'English 11',
    classroom_id: classroomTwo.id,
    classroom_name: classroomTwo.name,
    prompt: 'Explain how ambition reshapes Macbeth over the course of the play.',
    instructions: 'No outside materials. Cite from memory only.',
    browser_policy: {
      browser_enabled: false,
      home_url: '',
      allowed_domains: [],
      log_all_navigation: true,
    },
  })

  await store.putAssignment(assignmentOne)
  await store.putAssignment(assignmentTwo)

  await store.putLiveSession(
    buildLiveSession({
      id: 'live_ava',
      assignment_id: assignmentOne.id,
      assignment_title: assignmentOne.title,
      course: assignmentOne.course,
      classroom: classroomOne.name,
      student_name: 'Ava L.',
      current_text: 'Nick becomes credible because he sees wealth from both inside and outside the circle.',
      current_url: 'https://www.gutenberg.org/files/64317/64317-h/64317-h.htm',
      violation_count: 0,
      replay_session_id: 'edu_replay_ava',
    }),
  )
  await store.putLiveSession(
    buildLiveSession({
      id: 'live_mason',
      assignment_id: assignmentTwo.id,
      assignment_title: assignmentTwo.title,
      course: assignmentTwo.course,
      classroom: classroomTwo.name,
      student_name: 'Mason R.',
      current_text: 'Macbeth treats prophecy as permission, and that choice turns fear into policy.',
      current_url: null,
      violation_count: 1,
      violations: [{ t: Date.now() * 1_000_000, kind: 'focus_lost', detail: 'Student app lost focus once.' }],
    }),
  )
  await store.putReplay(
    buildEduReplay({
      id: 'edu_replay_ava',
      live_session_id: 'live_ava',
      assignment_id: assignmentOne.id,
      assignment_title: assignmentOne.title,
      course: assignmentOne.course,
      classroom: classroomOne.name,
      student_name: 'Ava L.',
      current_text:
        'Nick becomes credible because he sees wealth from both inside and outside the circle.',
      document_history: [{ op: 'insert', text: 'Nick becomes credible because he sees wealth.' }],
      current_url: 'https://www.gutenberg.org/files/64317/64317-h/64317-h.htm',
      url_history: [
        {
          t: Date.now() * 1_000_000,
          url: 'https://www.gutenberg.org/files/64317/64317-h/64317-h.htm',
          allowed: true,
          source: 'seed',
        },
      ],
    }),
  )
}

export async function buildEduDashboard(store) {
  const classrooms = await store.listClassrooms()
  const assignments = await store.listAssignments()
  const live_sessions = await store.listLiveSessions()
  const replays = await store.listReplays()

  return {
    product: {
      host: 'edu.handtyped.app',
      teacher_surface: 'web',
      student_surface: 'native',
      student_runtime: 'native-app',
    },
    summary: {
      classrooms: classrooms.length,
      assignments: assignments.length,
      live_sessions: live_sessions.length,
      replays_available: replays.length,
    },
    classrooms,
    assignments,
    live_sessions,
    architecture: {
      teacher_web_origin: 'https://edu.handtyped.app',
      replay_origin: 'https://replay.handtyped.app',
      student_delivery: 'native desktop app',
    },
  }
}

export async function buildStudentConfig(store, { joinCode }) {
  const classrooms = await store.listClassrooms()
  const classroom = classrooms.find((item) => item.join_code.toUpperCase() === String(joinCode || '').toUpperCase())
  if (!classroom) {
    return { classroom: null, assignments: [] }
  }
  const assignments = (await store.listAssignments()).filter((item) => item.classroom_id === classroom.id)
  return { classroom, assignments }
}
