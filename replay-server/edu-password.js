import { createHash, randomBytes } from 'crypto'

const PASSWORD_HASH_VERSION = 'handtyped-edu-password-v1'

export function generateTeacherPasswordSalt() {
  return randomBytes(16).toString('hex')
}

export function hashTeacherPassword(password, salt) {
  return createHash('sha256')
    .update(`${PASSWORD_HASH_VERSION}:${String(salt || '')}:${String(password || '')}`)
    .digest('hex')
}

export function buildTeacherPasswordFields(input = {}) {
  if (input.password_hash && input.password_salt) {
    return {
      password_hash: String(input.password_hash),
      password_salt: String(input.password_salt),
    }
  }

  const rawPassword = input.password ?? input.access_code ?? 'handtyped-edu'
  const salt = generateTeacherPasswordSalt()
  return {
    password_hash: hashTeacherPassword(rawPassword, salt),
    password_salt: salt,
  }
}

export function verifyTeacherPassword(teacher, password) {
  if (teacher?.password_hash && teacher?.password_salt) {
    return hashTeacherPassword(password, teacher.password_salt) === teacher.password_hash
  }

  if (typeof teacher?.password === 'string') {
    return teacher.password === String(password || '')
  }

  return teacher?.access_code === String(password || '')
}
