import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildStudentConfig,
  createD1EduStore,
  createNodeEduStore,
  ensureEduSeedData,
  lockStudentAssignmentForFocusLoss,
} from './edu-store.js'
import { buildAssignment, buildClassroom, buildTeacher } from './edu-schema.js'

class FakeD1PreparedStatement {
  constructor(db, sql, args = []) {
    this.db = db
    this.sql = sql
    this.args = args
  }

  bind(...args) {
    return new FakeD1PreparedStatement(this.db, this.sql, args)
  }

  async all() {
    return { results: this.db.query(this.sql, this.args) }
  }

  async first() {
    return this.db.query(this.sql, this.args)[0] || null
  }

  async run() {
    this.db.execute(this.sql, this.args)
    return { success: true }
  }
}

class FakeD1Database {
  constructor({ legacySchema = false } = {}) {
    this.records = new Map()
    this.queryLog = []
    this.executeLog = []
    this.columns = legacySchema
      ? ['kind', 'id', 'updated_at', 'json', 'email', 'join_code', 'classroom_id']
      : ['kind', 'id', 'updated_at', 'json', 'tenant_id', 'email', 'join_code', 'classroom_id', 'student_key', 'parent_id', 'expires_at']
  }

  async exec(_sql) {}

  prepare(sql) {
    return new FakeD1PreparedStatement(this, sql)
  }

  key(kind, id) {
    return `${kind}::${id}`
  }

  execute(sql, args) {
    this.executeLog.push({ sql, args })
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS edu_records')) {
      return
    }

    if (sql.startsWith('CREATE INDEX IF NOT EXISTS edu_records_')
      || sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS edu_records_')) {
      return
    }

    if (sql.startsWith('ALTER TABLE edu_records ADD COLUMN ')) {
      const match = sql.match(/^ALTER TABLE edu_records ADD COLUMN ([a-z_]+) /i)
      if (!match) {
        throw new Error(`Unsupported ALTER TABLE SQL in test: ${sql}`)
      }
      const [, column] = match
      if (!this.columns.includes(column)) {
        this.columns.push(column)
      }
      for (const row of this.records.values()) {
        if (!(column in row)) {
          row[column] = null
        }
      }
      return
    }

    if (sql.includes('INSERT INTO edu_records')) {
      const [kind, id, updated_at, json, tenant_id, email, join_code, classroom_id, student_key, parent_id, expires_at] = args
      this.records.set(this.key(kind, id), {
        kind,
        id,
        updated_at,
        json,
        tenant_id,
        email,
        join_code,
        classroom_id,
        student_key,
        parent_id,
        expires_at,
      })
      return
    }

    if (sql.startsWith('UPDATE edu_records')) {
      const [defaultTenantId] = args
      for (const row of this.records.values()) {
        const parsed = JSON.parse(row.json)
        row.tenant_id = row.tenant_id || parsed.tenant_id || defaultTenantId
        row.classroom_id = row.classroom_id || parsed.classroom_id || parsed.assignment_id || null
        row.student_key = row.student_key || String(parsed.student_name || '').trim().toLowerCase() || null
        row.parent_id = row.parent_id || parsed.live_session_id || parsed.replay_session_id || null
      }
      return
    }

    if (sql.startsWith('DELETE FROM edu_records')) {
      if (sql.includes('expires_at')) {
        const [cutoff] = args
        for (const [key, row] of this.records.entries()) {
          if (row.expires_at && String(row.expires_at) < String(cutoff)) {
            this.records.delete(key)
          }
        }
        return
      }
      const [kind, id] = args
      this.records.delete(this.key(kind, id))
      return
    }

    throw new Error(`Unsupported D1 execute SQL in test: ${sql}`)
  }

  query(sql, args) {
    this.queryLog.push({ sql, args })
    const records = [...this.records.values()]

    if (sql.startsWith('PRAGMA table_info(edu_records)')) {
      return this.columns.map((name, index) => ({ cid: index, name }))
    }

    if (sql.startsWith('SELECT json FROM edu_records WHERE tenant_id = ? AND kind = ? ORDER BY updated_at DESC')
      || sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? ORDER BY updated_at DESC')) {
      const [tenant_id, kind] = args
      return records
        .filter((row) => row.kind === kind && row.tenant_id === tenant_id)
        .sort((a, b) => {
          const updatedCompare = String(b.updated_at).localeCompare(String(a.updated_at))
          return updatedCompare || String(b.id).localeCompare(String(a.id))
        })
        .map((row) => ({ ...row }))
    }

    if (sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE kind = ? ORDER BY updated_at DESC')) {
      const [kind] = args
      return records
        .filter((row) => row.kind === kind)
        .sort((a, b) => {
          const updatedCompare = String(b.updated_at).localeCompare(String(a.updated_at))
          return updatedCompare || String(b.id).localeCompare(String(a.id))
        })
        .map((row) => ({ ...row }))
    }

    if (sql.startsWith('SELECT json FROM edu_records WHERE kind = ? AND id = ? LIMIT 1')
      || sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE kind = ? AND id = ? LIMIT 1')) {
      const [kind, id] = args
      const row = this.records.get(this.key(kind, id))
      return row ? [{ ...row }] : []
    }

    if (sql.startsWith('SELECT json FROM edu_records WHERE tenant_id = ? AND kind = ? AND email = ? LIMIT 1')
      || sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? AND email = ? LIMIT 1')) {
      const [tenant_id, kind, email] = args
      const row = records.find((item) => item.tenant_id === tenant_id && item.kind === kind && item.email === email)
      return row ? [{ ...row }] : []
    }

    if (sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE kind = ? AND email = ? LIMIT 1')) {
      const [kind, email] = args
      const row = records.find((item) => item.kind === kind && item.email === email)
      return row ? [{ ...row }] : []
    }

    if (sql.startsWith('SELECT json FROM edu_records WHERE kind = ? AND join_code = ? LIMIT 1')
      || sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE kind = ? AND join_code = ? LIMIT 1')) {
      const [kind, join_code] = args
      const row = records.find((item) => item.kind === kind && item.join_code === join_code)
      return row ? [{ ...row }] : []
    }

    if (sql.startsWith('SELECT json FROM edu_records WHERE tenant_id = ? AND kind = ? AND classroom_id = ? ORDER BY updated_at DESC')
      || sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? AND classroom_id = ? ORDER BY updated_at DESC')) {
      const [tenant_id, kind, classroom_id] = args
      return records
        .filter((item) => item.tenant_id === tenant_id && item.kind === kind && item.classroom_id === classroom_id)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id)))
        .map((row) => ({ ...row }))
    }

    if (sql.startsWith('SELECT json FROM edu_records WHERE tenant_id = ? AND kind = ? AND parent_id = ? ORDER BY updated_at DESC')
      || sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? AND parent_id = ? ORDER BY updated_at DESC')) {
      const [tenant_id, kind, parent_id] = args
      return records
        .filter((item) => item.tenant_id === tenant_id && item.kind === kind && item.parent_id === parent_id)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id)))
        .map((row) => ({ ...row }))
    }

    if (sql.startsWith('SELECT json FROM edu_records WHERE tenant_id = ? AND kind = ? AND classroom_id = ? AND student_key = ? ORDER BY updated_at DESC')
      || sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? AND classroom_id = ? AND student_key = ? ORDER BY updated_at DESC')) {
      const [tenant_id, kind, classroom_id, student_key] = args
      const row = records
        .filter((item) => item.tenant_id === tenant_id && item.kind === kind && item.classroom_id === classroom_id && item.student_key === student_key)
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id)))[0]
      return row ? [{ ...row }] : []
    }

    throw new Error(`Unsupported D1 query SQL in test: ${sql}`)
  }
}

describe('createD1EduStore', () => {
  it('does not seed a shared default teacher account', async () => {
    const store = createD1EduStore(new FakeD1Database())

    await ensureEduSeedData(store)

    await expect(store.listTeachers()).resolves.toEqual([])
    await expect(store.getTeacherByEmail('teacher@edu.handtyped.app')).resolves.toBeNull()
  })

  it('removes a persisted shared default teacher account during seed maintenance', async () => {
    const store = createD1EduStore(new FakeD1Database())
    await store.putTeacher(
      buildTeacher({
        tenant_id: 'tenant_demo',
        id: 'teacher_default',
        name: 'Joseph Tan',
        email: 'teacher@edu.handtyped.app',
        access_code: 'handtyped-edu',
      }),
    )

    await ensureEduSeedData(store)

    await expect(store.getTeacherByEmail('teacher@edu.handtyped.app')).resolves.toBeNull()
    await expect(store.listTeachers()).resolves.toEqual([])
  })

  it('stores classrooms, assignments, teachers, and sessions without KV semantics', async () => {
    const store = createD1EduStore(new FakeD1Database())

    const classroom = buildClassroom({
      id: 'class-a',
      name: 'English 11',
      join_code: 'en11',
      teacher_name: 'Joseph',
      updated_at: '2026-04-25T13:00:00.000Z',
    })
    const assignment = buildAssignment({
      id: 'essay-a',
      title: 'Timed Essay',
      course: 'English 11',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      updated_at: '2026-04-25T13:05:00.000Z',
    })
    const teacher = buildTeacher({
      id: 'teacher-1',
      name: 'Joseph Tan',
      email: 'Teacher@Edu.Handtyped.App',
      access_code: 'secret',
      updated_at: '2026-04-25T13:10:00.000Z',
    })

    await store.putClassroom(classroom)
    await store.putAssignment(assignment)
    await store.putTeacher(teacher)
    await store.putTeacherSession({
      id: 'session-1',
      teacher_id: teacher.id,
      teacher_email: teacher.email,
      created_at: '2026-04-25T13:15:00.000Z',
      updated_at: '2026-04-25T13:15:00.000Z',
    })

    await expect(store.getClassroom(classroom.id)).resolves.toMatchObject({
      id: 'class-a',
      join_code: 'EN11',
    })
    await expect(store.getAssignment(assignment.id)).resolves.toMatchObject({
      id: 'essay-a',
      classroom_id: 'class-a',
    })
    await expect(store.getTeacherByEmail('teacher@edu.handtyped.app')).resolves.toMatchObject({
      id: 'teacher-1',
    })
    await expect(store.getTeacherSession('session-1')).resolves.toMatchObject({
      teacher_id: 'teacher-1',
    })

    const classrooms = await store.listClassrooms()
    const assignments = await store.listAssignments()
    expect(classrooms.map((item) => item.id)).toEqual(['class-a'])
    expect(assignments.map((item) => item.id)).toEqual(['essay-a'])

    await store.deleteTeacherSession('session-1')
    await expect(store.getTeacherSession('session-1')).resolves.toBeNull()
  })

  it('does not full-scan dashboard collections for each D1 live session heartbeat', async () => {
    const db = new FakeD1Database()
    const store = createD1EduStore(db)

    const classroom = buildClassroom({ id: 'class-hot', name: 'English 11', join_code: 'HOT11' })
    const assignment = buildAssignment({
      id: 'essay-hot',
      title: 'Timed Essay',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
    })

    await store.putClassroom(classroom)
    await store.putAssignment(assignment)
    db.queryLog = []

    await store.putLiveSession({
      id: 'Ada Lovelace:essay-hot',
      assignment_id: assignment.id,
      assignment_title: assignment.title,
      classroom: classroom.name,
      student_name: 'Ada Lovelace',
      current_text: 'Draft',
      document_history: [],
      updated_at: '2026-05-11T18:00:00.000Z',
    })

    const fullDashboardKindScans = db.queryLog
      .filter(({ sql }) =>
        sql.startsWith('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? ORDER BY updated_at DESC'),
      )
      .map(({ args }) => args[1])

    expect(fullDashboardKindScans).toEqual([])
  })

  it('upgrades a legacy D1 schema and backfills tenant-aware columns', async () => {
    const db = new FakeD1Database({ legacySchema: true })
    db.records.set(db.key('classroom', 'legacy-class'), {
      kind: 'classroom',
      id: 'legacy-class',
      updated_at: '2026-04-28T21:00:00.000Z',
      json: JSON.stringify(
        buildClassroom({
          id: 'legacy-class',
          name: 'Legacy English',
          join_code: 'LEGACY1',
        }),
      ),
      email: null,
      join_code: 'LEGACY1',
      classroom_id: null,
    })
    db.records.set(db.key('assignment', 'legacy-assignment'), {
      kind: 'assignment',
      id: 'legacy-assignment',
      updated_at: '2026-04-28T21:05:00.000Z',
      json: JSON.stringify(
        buildAssignment({
          id: 'legacy-assignment',
          title: 'Legacy essay',
          classroom_id: 'legacy-class',
          classroom_name: 'Legacy English',
        }),
      ),
      email: null,
      join_code: null,
      classroom_id: 'legacy-class',
    })

    const store = createD1EduStore(db)
    const classrooms = await store.listClassrooms()
    const assignments = await store.listAssignments()

    expect(classrooms).toHaveLength(1)
    expect(assignments).toHaveLength(1)
    expect(db.columns).toEqual(
      expect.arrayContaining(['tenant_id', 'student_key', 'parent_id', 'expires_at']),
    )
    expect(db.records.get(db.key('classroom', 'legacy-class')).tenant_id).toBe('tenant_demo')
    expect(db.records.get(db.key('assignment', 'legacy-assignment')).tenant_id).toBe('tenant_demo')
  })

  it('only backfills legacy D1 columns when a missing value can actually be derived', async () => {
    const db = new FakeD1Database({ legacySchema: true })
    const store = createD1EduStore(db)

    await store.listClassrooms()

    const backfill = db.executeLog.find(({ sql }) => sql.startsWith('UPDATE edu_records'))
    expect(backfill?.sql).toMatch(/\(classroom_id IS NULL OR classroom_id = ''\)\s+AND \(\s+NULLIF\(json_extract\(json, '\$\.classroom_id'\), ''\) IS NOT NULL/m)
    expect(backfill?.sql).toMatch(/\(student_key IS NULL OR student_key = ''\)\s+AND NULLIF\(trim\(COALESCE\(json_extract\(json, '\$\.student_name'\), ''\)\), ''\) IS NOT NULL/m)
    expect(backfill?.sql).toMatch(/\(parent_id IS NULL OR parent_id = ''\)\s+AND \(\s+NULLIF\(json_extract\(json, '\$\.live_session_id'\), ''\) IS NOT NULL/m)
  })

  it('deletes classrooms and assignments by id', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({ id: 'class-delete', name: 'Delete Me', join_code: 'DEL123' })
    const assignment = buildAssignment({
      id: 'assignment-delete',
      title: 'Delete Me Too',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
    })

    await store.putClassroom(classroom)
    await store.putAssignment(assignment)
    await store.deleteAssignment(assignment.id)
    await store.deleteClassroom(classroom.id)

    await expect(store.getAssignment(assignment.id)).resolves.toBeNull()
    await expect(store.getClassroom(classroom.id)).resolves.toBeNull()
  })

  it('stores policy flags on assignments', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const assignment = buildAssignment({
      id: 'assignment-printing',
      title: 'Printing rules',
      policy: {
        allow_offline_editing: false,
        copy_paste_allowed: false,
        export_allowed: true,
        require_lockdown: false,
        require_fullscreen: false,
      },
    })

    await store.putAssignment(assignment)

    await expect(store.getAssignment(assignment.id)).resolves.toMatchObject({
      id: 'assignment-printing',
      policy: {
        allow_offline_editing: false,
        export_allowed: true,
      },
    })
  })

  it('personalizes temporary access per student in student config', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({ id: 'class-personal', name: 'English 11', join_code: 'ENG11' })
    const assignment = buildAssignment({
      id: 'assignment-personal',
      title: 'Timed write',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      temporary_access_until: '2026-04-27T18:00:00.000Z',
      student_temporary_access_until: {
        'ada lovelace': '2026-04-27T19:30:00.000Z',
      },
    })

    await store.putClassroom(classroom)
    await store.putAssignment(assignment)

    const adaConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Ada Lovelace',
    })
    const graceConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Grace Hopper',
    })

    expect(adaConfig.assignments[0]).toMatchObject({
      id: 'assignment-personal',
      temporary_access_until: '2026-04-27T19:30:00.000Z',
      student_temporary_access_until: {},
    })
    expect(graceConfig.assignments[0]).toMatchObject({
      id: 'assignment-personal',
      temporary_access_until: '2026-04-27T18:00:00.000Z',
      student_temporary_access_until: {},
    })
  })

  it('deduplicates classroom joins by normalized first and last name', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({ id: 'class-roster', name: 'English 11', join_code: 'ENG11' })

    await store.putClassroom(classroom)

    await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Ada Lovelace',
    })
    await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: ' ada   lovelace ',
    })

    const updated = await store.getClassroom(classroom.id)
    expect(updated.students).toEqual(['Ada Lovelace'])
  })

  it('rejects fresh joins that reuse an existing student full name', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({ id: 'class-join-dedupe', name: 'English 11', join_code: 'ENG11' })

    await store.putClassroom(classroom)

    await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Ada Lovelace',
    })
    const duplicate = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: ' ada   lovelace ',
      joining: true,
    })

    expect(duplicate).toMatchObject({
      classroom: null,
      assignments: [],
      canonical_student_name: 'ada lovelace',
      duplicate_student_name: true,
    })
    expect((await store.getClassroom(classroom.id)).students).toEqual(['Ada Lovelace'])
  })

  it('keeps the later class extension when a student has an older personal extension', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({ id: 'class-later', name: 'English 11', join_code: 'LATER' })
    const assignment = buildAssignment({
      id: 'assignment-later',
      title: 'Long extension',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      temporary_access_until: '2026-04-28T23:00:00.000Z',
      student_temporary_access_until: {
        'ada lovelace': '2026-04-28T15:00:00.000Z',
      },
    })

    await store.putClassroom(classroom)
    await store.putAssignment(assignment)

    const adaConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Ada Lovelace',
    })

    expect(adaConfig.assignments[0]).toMatchObject({
      id: 'assignment-later',
      temporary_access_until: '2026-04-28T23:00:00.000Z',
      student_temporary_access_until: {},
    })
  })

  it('preserves linked assignment ids in student config', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({ id: 'class-linked', name: 'English 11', join_code: 'LINK11' })
    const priorAssignment = buildAssignment({
      id: 'assignment-prior',
      title: 'Draft one',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      updated_at: '2026-04-27T18:00:00.000Z',
    })
    const currentAssignment = buildAssignment({
      id: 'assignment-current',
      title: 'Draft two',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      linked_assignment_ids: ['assignment-prior'],
      updated_at: '2026-04-27T19:00:00.000Z',
    })

    await store.putClassroom(classroom)
    await store.putAssignment(priorAssignment)
    await store.putAssignment(currentAssignment)

    const config = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Ada Lovelace',
    })
    const linked = config.assignments.find((assignment) => assignment.id === 'assignment-current')

    expect(linked).toMatchObject({
      id: 'assignment-current',
      linked_assignment_ids: ['assignment-prior'],
    })
  })

  it('filters targeted assignments by student name and learns the classroom roster', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({ id: 'class-targeted', name: 'English 11', join_code: 'ENG11', students: [] })
    const wholeClass = buildAssignment({
      id: 'assignment-all',
      title: 'Whole class draft',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
    })
    const targeted = buildAssignment({
      id: 'assignment-ada',
      title: 'Ada only draft',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      assigned_students: ['Ada Lovelace'],
    })

    await store.putClassroom(classroom)
    await store.putAssignment(wholeClass)
    await store.putAssignment(targeted)

    const adaConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Ada Lovelace',
    })
    const graceConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Grace Hopper',
    })

    expect(adaConfig.assignments.map((item) => item.id).sort()).toEqual(['assignment-ada', 'assignment-all'])
    expect(graceConfig.assignments.map((item) => item.id).sort()).toEqual(['assignment-all'])

    await expect(store.getClassroom(classroom.id)).resolves.toMatchObject({
      students: ['Ada Lovelace', 'Grace Hopper'],
    })
  })

  it('matches targeted assignments case-insensitively and avoids duplicate roster entries', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({
      id: 'class-targeted-normalized',
      name: 'English 11',
      join_code: 'ENG12',
      students: ['Ada Lovelace'],
    })
    const targeted = buildAssignment({
      id: 'assignment-normalized',
      title: 'Ada only draft',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      assigned_students: [' ada lovelace ', 'ADA LOVELACE'],
    })

    await store.putClassroom(classroom)
    await store.putAssignment(targeted)

    const adaConfig = await buildStudentConfig(store, {
      joinCode: 'eng12',
      studentName: '  Ada Lovelace  ',
    })
    const graceConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Grace Hopper',
    })

    expect(adaConfig.assignments.map((item) => item.id)).toEqual(['assignment-normalized'])
    expect(graceConfig.assignments).toEqual([])
    await expect(store.getClassroom(classroom.id)).resolves.toMatchObject({
      students: ['Ada Lovelace', 'Grace Hopper'],
    })
  })

  it('merges student-specific setting overrides into the student config assignment', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({ id: 'class-overrides', name: 'English 11', join_code: 'OVR11' })
    const assignment = buildAssignment({
      id: 'assignment-overrides',
      title: 'Differentiated write',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      policy: {
        allow_dictation: false,
        allow_offline_editing: true,
        copy_paste_allowed: false,
        require_lockdown: true,
      },
      editor_policy: {
        font_family: 'arial',
        font_size: 22,
        line_height: 'relaxed',
      },
      browser_policy: {
        browser_enabled: true,
        home_url: 'https://www.gutenberg.org',
        allowed_domains: ['gutenberg.org'],
      },
      student_overrides: {
        'ada lovelace': {
          student_name: 'Ada Lovelace',
          policy: {
            allow_dictation: true,
            allow_offline_editing: false,
            copy_paste_allowed: true,
          },
          editor_policy: {
            font_size: 28,
          },
          browser_policy: {
            browser_enabled: false,
            home_url: 'https://example.com',
            allowed_domains: ['example.com'],
          },
        },
      },
    })

    await store.putClassroom(classroom)
    await store.putAssignment(assignment)

    const adaConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Ada Lovelace',
    })
    const graceConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Grace Hopper',
    })

    expect(adaConfig.assignments[0]).toMatchObject({
      id: 'assignment-overrides',
      student_overrides: {},
      policy: {
        allow_dictation: true,
        allow_offline_editing: false,
        copy_paste_allowed: true,
        require_lockdown: true,
      },
      editor_policy: {
        font_family: 'arial',
        font_size: 28,
        line_height: 'relaxed',
      },
      browser_policy: {
        browser_enabled: false,
        home_url: 'https://example.com',
        allowed_domains: ['example.com'],
      },
    })

    expect(graceConfig.assignments[0]).toMatchObject({
      id: 'assignment-overrides',
      student_overrides: {},
      policy: {
        allow_dictation: false,
        allow_offline_editing: true,
        copy_paste_allowed: false,
        require_lockdown: true,
      },
      editor_policy: {
        font_family: 'arial',
        font_size: 22,
        line_height: 'relaxed',
      },
      browser_policy: {
        browser_enabled: true,
        home_url: 'https://www.gutenberg.org',
        allowed_domains: ['gutenberg.org'],
      },
    })
  })

  it('revokes student access immediately when a lockdown assignment loses focus', () => {
    const now = new Date('2026-05-07T21:14:28.000Z')
    const assignment = buildAssignment({
      id: 'assignment-focus-lockout',
      title: 'Lockdown focus test',
      classroom_id: 'class-focus-lockout',
      classroom_name: 'English 11',
      policy: {
        require_lockdown: true,
        require_permission_to_rejoin: true,
      },
      windows: [
        {
          label: 'Test window',
          days: { thursday: true },
          start_hour: 20,
          start_minute: 0,
          end_hour: 22,
          end_minute: 0,
        },
      ],
    })

    const result = lockStudentAssignmentForFocusLoss(assignment, 'Ada Lovelace', now, {
      reason: 'Attempted to leave the window with the Windows key + G.',
    })

    expect(result.updated).toBe(true)
    expect(result.access_revoked).toBe(true)
    expect(result.assignment.student_access_revoked['ada lovelace']).toBe(true)
    expect(result.history.events).toEqual([
      expect.objectContaining({
        type: 'focus_lost_locked',
        at: now.toISOString(),
        reason: 'Attempted to leave the window with the Windows key + G.',
      }),
    ])
  })

  it('does not revoke student access for focus loss outside lockdown assignments', () => {
    const assignment = buildAssignment({
      id: 'assignment-free-focus',
      title: 'Free focus test',
      classroom_id: 'class-free-focus',
      classroom_name: 'English 11',
      policy: {
        require_lockdown: false,
        require_permission_to_rejoin: true,
      },
    })

    const result = lockStudentAssignmentForFocusLoss(assignment, 'Ada Lovelace', new Date('2026-05-07T21:14:28.000Z'))

    expect(result.updated).toBe(false)
    expect(result.access_revoked).toBe(false)
    expect(result.assignment.student_access_revoked['ada lovelace']).toBeUndefined()
  })

  it('keeps base settings when a student override only changes a few fields', async () => {
    const store = createD1EduStore(new FakeD1Database())
    const classroom = buildClassroom({ id: 'class-override-fallbacks', name: 'English 11', join_code: 'OVR12' })
    const assignment = buildAssignment({
      id: 'assignment-override-fallbacks',
      title: 'Targeted supports',
      classroom_id: classroom.id,
      classroom_name: classroom.name,
      temporary_access_until: '2026-04-27T18:00:00.000Z',
      policy: {
        allow_dictation: false,
        allow_offline_editing: true,
        copy_paste_allowed: false,
        require_lockdown: true,
      },
      editor_policy: {
        font_family: 'arial',
        font_size: 22,
        line_height: 'relaxed',
      },
      browser_policy: {
        browser_enabled: true,
        home_url: 'https://www.gutenberg.org',
        allowed_domains: ['gutenberg.org'],
      },
      student_overrides: {
        'ada lovelace': {
          student_name: 'Ada Lovelace',
          temporary_access_until: '2026-04-27T19:30:00.000Z',
          policy: {
            allow_dictation: true,
          },
          editor_policy: {
            font_size: 28,
          },
          browser_policy: {
            browser_enabled: false,
          },
        },
      },
    })

    await store.putClassroom(classroom)
    await store.putAssignment(assignment)

    const adaConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Ada Lovelace',
    })
    const graceConfig = await buildStudentConfig(store, {
      joinCode: classroom.join_code,
      studentName: 'Grace Hopper',
    })

    expect(adaConfig.assignments[0]).toMatchObject({
      id: 'assignment-override-fallbacks',
      temporary_access_until: '2026-04-27T19:30:00.000Z',
      student_overrides: {},
      policy: {
        allow_dictation: true,
        allow_offline_editing: true,
        copy_paste_allowed: false,
        require_lockdown: true,
      },
      editor_policy: {
        font_family: 'arial',
        font_size: 28,
        line_height: 'relaxed',
      },
      browser_policy: {
        browser_enabled: false,
        home_url: 'https://www.gutenberg.org',
        allowed_domains: ['gutenberg.org'],
      },
    })

    expect(graceConfig.assignments[0]).toMatchObject({
      id: 'assignment-override-fallbacks',
      temporary_access_until: '2026-04-27T18:00:00.000Z',
      student_overrides: {},
      policy: {
        allow_dictation: false,
        allow_offline_editing: true,
        copy_paste_allowed: false,
        require_lockdown: true,
      },
      editor_policy: {
        font_family: 'arial',
        font_size: 22,
        line_height: 'relaxed',
      },
      browser_policy: {
        browser_enabled: true,
        home_url: 'https://www.gutenberg.org',
        allowed_domains: ['gutenberg.org'],
      },
    })
  })
})

describe('createNodeEduStore', () => {
  it('repeated updates keep only the newest assignment record per id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handtyped-edu-store-'))
    try {
      const store = createNodeEduStore(dir)
      const original = buildAssignment({
        id: 'assignment-repeat',
        title: 'Original title',
        updated_at: '2026-04-25T13:00:00.000Z',
      })
      const updated = buildAssignment({
        ...original,
        title: 'Updated title',
        updated_at: '2026-04-25T13:05:00.000Z',
      })

      await store.putAssignment(original)
      await store.putAssignment(updated)
      await store.putAssignment(updated)

      const assignments = await store.listAssignments()
      expect(assignments).toHaveLength(1)
      expect(assignments[0].id).toBe('assignment-repeat')
      expect(assignments[0].title).toBe('Updated title')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('repeated deletes are idempotent for classrooms and assignments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handtyped-edu-store-'))
    try {
      const store = createNodeEduStore(dir)
      const classroom = buildClassroom({
        id: 'classroom-repeat-delete',
        name: 'English 11',
        join_code: 'ENG11',
      })
      const assignment = buildAssignment({
        id: 'assignment-repeat-delete',
        classroom_id: classroom.id,
        classroom_name: classroom.name,
      })

      await store.putClassroom(classroom)
      await store.putAssignment(assignment)

      await store.deleteAssignment(assignment.id)
      await store.deleteAssignment(assignment.id)
      await store.deleteClassroom(classroom.id)
      await store.deleteClassroom(classroom.id)

      await expect(store.getAssignment(assignment.id)).resolves.toBeNull()
      await expect(store.getClassroom(classroom.id)).resolves.toBeNull()
      await expect(store.listAssignments()).resolves.toEqual([])
      await expect(store.listClassrooms()).resolves.toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
