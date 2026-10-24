-- JobPilot Edge — D1 schema (migration 0001)
-- SQLite (D1). Mọi timestamp là INTEGER unix epoch (giây), UTC.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Saigon',
  digest_email  TEXT,               -- địa chỉ đã verify để nhận digest (Email Sending free)
  created_at    INTEGER NOT NULL
);

CREATE TABLE profiles (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,    -- nhãn hồ sơ, vd "Kriss Bui — Backend"
  target_roles    TEXT NOT NULL DEFAULT '[]',  -- JSON: ["Backend Developer", ...]
  level           TEXT,             -- junior/middle/senior
  locations       TEXT NOT NULL DEFAULT '[]',  -- JSON
  salary_min      INTEGER,          -- VND/tháng, nullable
  cv_file_id      TEXT,             -- files.id của CV hiện hành
  public_slug     TEXT UNIQUE,      -- /p/<slug>, NULL = không public
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_profiles_user ON profiles(user_id);

CREATE TABLE profile_skills (
  profile_id  TEXT NOT NULL REFERENCES profiles(id),
  skill       TEXT NOT NULL,        -- tên đã chuẩn hoá, vd "Java", "Kafka"
  weight      INTEGER NOT NULL DEFAULT 1,  -- 1..5 mức quan trọng
  source      TEXT NOT NULL DEFAULT 'manual',  -- cv | manual
  PRIMARY KEY (profile_id, skill)
);

CREATE TABLE sources (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,      -- itviec | topdev | rss | company | manual | email
  name          TEXT NOT NULL,
  config        TEXT NOT NULL DEFAULT '{}',  -- JSON cấu hình fetch
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  last_run_at   INTEGER,
  last_status   TEXT,               -- ok | error
  last_error    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  source_id     TEXT REFERENCES sources(id),
  source_url    TEXT NOT NULL,
  title         TEXT NOT NULL,
  company       TEXT NOT NULL,
  location      TEXT,
  salary_text   TEXT,
  jd_text       TEXT NOT NULL DEFAULT '',
  skills        TEXT NOT NULL DEFAULT '[]',  -- JSON skills trích từ JD
  content_hash  TEXT NOT NULL UNIQUE,        -- dedupe lớp 1
  posted_at     INTEGER,
  expires_at    INTEGER,
  first_seen_at INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_jobs_first_seen ON jobs(first_seen_at DESC);
CREATE INDEX idx_jobs_company ON jobs(company);

CREATE TABLE job_matches (
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  profile_id      TEXT NOT NULL REFERENCES profiles(id),
  rule_score      REAL NOT NULL DEFAULT 0,   -- 0..50
  semantic_score  REAL,                      -- 0..30, NULL = chưa tính
  final_score     REAL NOT NULL DEFAULT 0,   -- 0..100
  tier            TEXT NOT NULL DEFAULT 'weak',  -- strong | partial | weak
  matched_skills  TEXT NOT NULL DEFAULT '[]',    -- JSON
  missing_skills  TEXT NOT NULL DEFAULT '[]',    -- JSON
  ai_explanation  TEXT,                          -- cache vĩnh viễn theo (job, profile)
  scored_at       INTEGER NOT NULL,
  PRIMARY KEY (job_id, profile_id)
);
CREATE INDEX idx_matches_profile_score ON job_matches(profile_id, final_score DESC);

CREATE TABLE applications (
  id                TEXT PRIMARY KEY,
  profile_id        TEXT NOT NULL REFERENCES profiles(id),
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  stage             TEXT NOT NULL DEFAULT 'new',  -- new|saved|applied|interview|offer|rejected|archived
  note              TEXT,
  applied_at        INTEGER,
  next_follow_up_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (profile_id, job_id)
);
CREATE INDEX idx_apps_profile_stage ON applications(profile_id, stage);
CREATE INDEX idx_apps_follow_up ON applications(next_follow_up_at);

CREATE TABLE application_events (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(id),
  type            TEXT NOT NULL,    -- created|stage_changed|note|follow_up|cover_letter
  payload         TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_app_events_app ON application_events(application_id, created_at);

CREATE TABLE interviews (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(id),
  round_label     TEXT NOT NULL,    -- HR screen | Technical 1 | ...
  scheduled_at    INTEGER NOT NULL,
  interviewer     TEXT,
  result          TEXT,             -- pending|pass|fail
  note            TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_interviews_time ON interviews(scheduled_at);

CREATE TABLE prep_sessions (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profiles(id),
  job_id        TEXT REFERENCES jobs(id),
  title         TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE prep_items (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES prep_sessions(id),
  kind          TEXT NOT NULL,      -- question | flashcard | checklist
  question      TEXT NOT NULL,
  answer        TEXT,
  topic         TEXT,               -- Kafka | Spring | SQL ...
  status        TEXT NOT NULL DEFAULT 'new',  -- new | learning | mastered
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_prep_items_session ON prep_items(session_id);

CREATE TABLE files (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  r2_key      TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,        -- cv | cover_letter | jd_snapshot | export
  filename    TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE digests (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  date        TEXT NOT NULL,        -- yyyy-mm-dd theo timezone user
  summary     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  sent_at     INTEGER,
  UNIQUE (user_id, date)
);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,        -- strong_match | follow_up | digest | prep
  title       TEXT NOT NULL,
  body        TEXT,
  ref_id      TEXT,                 -- job_id / application_id liên quan
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_notif_user ON notifications(user_id, is_read, created_at DESC);
