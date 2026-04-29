ALTER TABLE edu_records ADD COLUMN tenant_id TEXT;
ALTER TABLE edu_records ADD COLUMN student_key TEXT;
ALTER TABLE edu_records ADD COLUMN parent_id TEXT;
ALTER TABLE edu_records ADD COLUMN expires_at TEXT;

UPDATE edu_records
SET tenant_id = COALESCE(NULLIF(tenant_id, ''), 'tenant_demo');

CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_updated_at
  ON edu_records(tenant_id, kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_join_code
  ON edu_records(tenant_id, kind, join_code);

CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_classroom_id
  ON edu_records(tenant_id, kind, classroom_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_parent_id
  ON edu_records(tenant_id, kind, parent_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_student_key
  ON edu_records(tenant_id, kind, student_key, updated_at DESC);

CREATE INDEX IF NOT EXISTS edu_records_kind_join_code_global
  ON edu_records(kind, join_code);

CREATE INDEX IF NOT EXISTS edu_records_kind_expires_at
  ON edu_records(kind, expires_at);
