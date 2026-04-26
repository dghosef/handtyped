import { describe, it, expect } from 'vitest'
import { createD1EduStore } from './edu-store.js'
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
  constructor() {
    this.records = new Map()
  }

  async exec(_sql) {}

  prepare(sql) {
    return new FakeD1PreparedStatement(this, sql)
  }

  key(kind, id) {
    return `${kind}::${id}`
  }

  execute(sql, args) {
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS edu_records')) {
      return
    }

    if (sql.startsWith('CREATE INDEX IF NOT EXISTS edu_records_')) {
      return
    }

    if (sql.includes('INSERT INTO edu_records')) {
      const [kind, id, updated_at, json, email, join_code, classroom_id] = args
      this.records.set(this.key(kind, id), {
        kind,
        id,
        updated_at,
        json,
        email,
        join_code,
        classroom_id,
      })
      return
    }

    if (sql.startsWith('DELETE FROM edu_records')) {
      const [kind, id] = args
      this.records.delete(this.key(kind, id))
      return
    }

    throw new Error(`Unsupported D1 execute SQL in test: ${sql}`)
  }

  query(sql, args) {
    const records = [...this.records.values()]

    if (sql.startsWith('SELECT json FROM edu_records WHERE kind = ? ORDER BY updated_at DESC')) {
      const [kind] = args
      return records
        .filter((row) => row.kind === kind)
        .sort((a, b) => {
          const updatedCompare = String(b.updated_at).localeCompare(String(a.updated_at))
          return updatedCompare || String(b.id).localeCompare(String(a.id))
        })
        .map((row) => ({ json: row.json }))
    }

    if (sql.startsWith('SELECT json FROM edu_records WHERE kind = ? AND id = ? LIMIT 1')) {
      const [kind, id] = args
      const row = this.records.get(this.key(kind, id))
      return row ? [{ json: row.json }] : []
    }

    if (sql.startsWith('SELECT json FROM edu_records WHERE kind = ? AND email = ? LIMIT 1')) {
      const [kind, email] = args
      const row = records.find((item) => item.kind === kind && item.email === email)
      return row ? [{ json: row.json }] : []
    }

    throw new Error(`Unsupported D1 query SQL in test: ${sql}`)
  }
}

describe('createD1EduStore', () => {
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
})
