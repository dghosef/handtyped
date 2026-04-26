CREATE TABLE IF NOT EXISTS edu_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  json TEXT NOT NULL,
  email TEXT,
  join_code TEXT,
  classroom_id TEXT,
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS edu_records_kind_updated_at
  ON edu_records(kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS edu_records_teacher_email
  ON edu_records(kind, email);

CREATE INDEX IF NOT EXISTS edu_records_join_code
  ON edu_records(kind, join_code);

CREATE INDEX IF NOT EXISTS edu_records_classroom_id
  ON edu_records(kind, classroom_id);
