-- ─────────────────────────────────────────────────────────────────────────────
-- Real Deal Fitness — AB Challenge PP
-- Supabase / PostgreSQL Schema
-- Run this in: Supabase dashboard → SQL Editor → New query → Run
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  TEXT        UNIQUE NOT NULL,
  name          TEXT        NOT NULL,
  level         TEXT        NOT NULL CHECK (level IN ('Beginner', 'Intermediate', 'Advanced')),
  start_date    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Check-ins ─────────────────────────────────────────────────────────────────
-- One row per day completed. UNIQUE constraint prevents double check-ins.
CREATE TABLE IF NOT EXISTS checkins (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week           INT         NOT NULL CHECK (week BETWEEN 1 AND 4),
  day_of_week    INT         NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  challenge_day  INT         NOT NULL CHECK (challenge_day BETWEEN 1 AND 28),
  completed_at   TIMESTAMPTZ DEFAULT NOW(),
  is_late        BOOLEAN     DEFAULT FALSE,

  UNIQUE (user_id, challenge_day)   -- prevents duplicate check-ins for the same day
);

-- ── Leaderboard ───────────────────────────────────────────────────────────────
-- Maintained by the server after every check-in (not a view — fast reads).
CREATE TABLE IF NOT EXISTS leaderboard (
  user_id             UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rank                INT,
  completed_days      INT         DEFAULT 0,
  total_time_seconds  BIGINT,                  -- NULL until all 28 days done
  consistency_score   NUMERIC(5,2) DEFAULT 0,  -- % of days done on-schedule
  finished_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_checkins_user      ON checkins (user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_day       ON checkins (challenge_day);
CREATE INDEX IF NOT EXISTS idx_leaderboard_rank   ON leaderboard (rank);
CREATE INDEX IF NOT EXISTS idx_users_phone        ON users (phone_number);

-- ── Row-Level Security ────────────────────────────────────────────────────────
-- The Node server uses the SERVICE ROLE key and bypasses RLS automatically.
-- These policies only govern direct Supabase client calls (e.g. future mobile app).

ALTER TABLE users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins     ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaderboard  ENABLE ROW LEVEL SECURITY;

-- Anyone can read the leaderboard (for the public app)
CREATE POLICY "leaderboard_public_read"
  ON leaderboard FOR SELECT USING (true);

-- Service role (backend) gets full access — enforced by using service role key
-- If you add auth later, scope these to auth.uid() = user_id
CREATE POLICY "users_service_all"       ON users       USING (true) WITH CHECK (true);
CREATE POLICY "checkins_service_all"    ON checkins    USING (true) WITH CHECK (true);
CREATE POLICY "leaderboard_service_all" ON leaderboard USING (true) WITH CHECK (true);

-- ── Helpful views (optional) ─────────────────────────────────────────────────

-- Full leaderboard with user info — use this for admin dashboards
CREATE OR REPLACE VIEW leaderboard_full AS
SELECT
  lb.rank,
  u.name,
  u.level,
  u.phone_number,
  lb.completed_days,
  lb.consistency_score,
  lb.total_time_seconds,
  lb.finished_at,
  u.start_date,
  lb.updated_at
FROM leaderboard lb
JOIN users u ON u.id = lb.user_id
ORDER BY lb.rank NULLS LAST;

-- Per-user check-in history
CREATE OR REPLACE VIEW checkin_history AS
SELECT
  u.name,
  u.level,
  c.challenge_day,
  c.week,
  c.day_of_week,
  c.completed_at,
  c.is_late
FROM checkins c
JOIN users u ON u.id = c.user_id
ORDER BY u.name, c.challenge_day;
