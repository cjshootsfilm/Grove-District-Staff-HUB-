-- Grove District staff hub — database schema

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS clock_entries;
DROP TABLE IF EXISTS shifts;
DROP TABLE IF EXISTS time_off;
DROP TABLE IF EXISTS employees;

CREATE TABLE employees (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  username     TEXT NOT NULL UNIQUE,
  pin_hash     TEXT NOT NULL,
  pin_salt     TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'staff',   -- 'staff' | 'admin'
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE sessions (
  token        TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_employee ON sessions(employee_id);

CREATE TABLE time_off (
  id           TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL,
  start_date   TEXT NOT NULL,        -- YYYY-MM-DD
  end_date     TEXT NOT NULL,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied
  requested_at INTEGER NOT NULL,
  reviewed_by  TEXT,
  reviewed_at  INTEGER,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX idx_timeoff_employee ON time_off(employee_id);
CREATE INDEX idx_timeoff_status ON time_off(status);

CREATE TABLE shifts (
  id           TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL,
  shift_date   TEXT NOT NULL,        -- YYYY-MM-DD
  start_time   TEXT NOT NULL,        -- HH:MM
  end_time     TEXT NOT NULL,
  position     TEXT,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX idx_shifts_employee_date ON shifts(employee_id, shift_date);
CREATE INDEX idx_shifts_date ON shifts(shift_date);

CREATE TABLE clock_entries (
  id           TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL,
  clock_in     INTEGER NOT NULL,
  clock_out    INTEGER,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX idx_clock_employee ON clock_entries(employee_id, clock_in);
