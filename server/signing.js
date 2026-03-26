const crypto = require('crypto')

const SECRET = process.env.SERVER_SECRET || 'dev-secret-change-in-production'

function sign(payload) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(JSON.stringify(payload))
    .digest('hex')
}

function verify(payload, sig) {
  return sign(payload) === sig
}

module.exports = { sign, verify }
