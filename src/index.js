/**
 * Grove District — staff hub API
 * Runs as a Cloudflare Worker. Every rule that matters
 * (who is an admin, whose data you can see) is enforced HERE, on the
 * server, not in the browser.
 */

const SESSION_DAYS = 14;
const TZ_OFFSET_MIN = 8 * 60; // Philippines is UTC+8

/* ---------------- helpers ---------------- */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const err = (message, status = 400) => json({ error: message }, status);

function uid() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

/** Today's date (YYYY-MM-DD) in Philippine time, regardless of server location. */
function localToday() {
  const now = new Date(Date.now() + TZ_OFFSET_MIN * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/** PBKDF2 hash — PINs are never stored in readable form. */
async function hashPin(pin, saltB64) {
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return { hash: toBase64(bits), salt: toBase64(salt) };
}

/** Constant-time-ish comparison. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function sessionCookie(token, maxAgeSeconds) {
  return `gd_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** Resolve the logged-in user from their session cookie. Returns null if not valid. */
async function getUser(request, env) {
  const token = readCookie(request, 'gd_session');
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT e.id, e.name, e.username, e.role, e.active, s.expires_at
       FROM sessions s
       JOIN employees e ON e.id = s.employee_id
      WHERE s.token = ?`
  )
    .bind(token)
    .first();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  if (!row.active) return null;

  // Role is read fresh from the DB on every request, so demoting an admin
  // takes effect immediately even if they stay logged in.
  return { id: row.id, name: row.name, username: row.username, role: row.role };
}

function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,}$/.test(pin);
}

function validDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function validTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

function normalizeUsername(name) {
  return String(name || '').trim().toLowerCase();
}

/* ---------------- router ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Anything that isn't /api/... is a static file (the website itself).
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    return handleApi(request, env);
  },
};

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const method = request.method;

  if (!env.DB) {
    return err('Database is not connected. Add the D1 binding named DB in Pages settings, then redeploy.', 500);
  }

  let body = {};
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return err('Could not read the request.', 400);
    }
  }

  try {
    /* ---------- open endpoints ---------- */

    // Is there any admin yet? Drives the first-run setup screen.
    if (path === 'status' && method === 'GET') {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM employees').first();
      return json({ needsSetup: (row?.n ?? 0) === 0 });
    }

    // First-run only: create the very first admin. Refuses once anyone exists.
    if (path === 'setup' && method === 'POST') {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM employees').first();
      if ((row?.n ?? 0) > 0) return err('Setup has already been completed.', 403);

      const name = String(body.name || '').trim();
      const pin = String(body.pin || '');
      if (!name) return err('Enter your name.');
      if (!validPin(pin)) return err('PIN must be at least 4 digits.');

      const { hash, salt } = await hashPin(pin);
      const id = uid();
      await env.DB.prepare(
        `INSERT INTO employees (id, name, username, pin_hash, pin_salt, role, active, created_at)
         VALUES (?, ?, ?, ?, ?, 'admin', 1, ?)`
      )
        .bind(id, name, normalizeUsername(name), hash, salt, Date.now())
        .run();

      const token = uid() + uid();
      const expires = Date.now() + SESSION_DAYS * 86400000;
      await env.DB.prepare(
        'INSERT INTO sessions (token, employee_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
      )
        .bind(token, id, Date.now(), expires)
        .run();

      return json(
        { user: { id, name, role: 'admin' } },
        200,
        { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) }
      );
    }

    if (path === 'login' && method === 'POST') {
      const username = normalizeUsername(body.name);
      const pin = String(body.pin || '');
      if (!username || !pin) return err('Enter your name and PIN.');

      const emp = await env.DB.prepare(
        'SELECT * FROM employees WHERE username = ? AND active = 1'
      )
        .bind(username)
        .first();

      // Same message either way — don't reveal which names exist.
      if (!emp) return err('Name or PIN not recognised.', 401);

      const { hash } = await hashPin(pin, emp.pin_salt);
      if (!safeEqual(hash, emp.pin_hash)) return err('Name or PIN not recognised.', 401);

      const token = uid() + uid();
      const expires = Date.now() + SESSION_DAYS * 86400000;
      await env.DB.prepare(
        'INSERT INTO sessions (token, employee_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
      )
        .bind(token, emp.id, Date.now(), expires)
        .run();

      return json(
        { user: { id: emp.id, name: emp.name, role: emp.role } },
        200,
        { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) }
      );
    }

    if (path === 'logout' && method === 'POST') {
      const token = readCookie(request, 'gd_session');
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    }

    /* ---------- everything below requires a login ---------- */

    const user = await getUser(request, env);
    if (!user) return err('Please log in.', 401);
    const isAdmin = user.role === 'admin';

    if (path === 'me' && method === 'GET') {
      return json({ user });
    }

    // Home screen: today's position + clock state + recent own shifts
    if (path === 'home' && method === 'GET') {
      const today = localToday();

      const todayShifts = await env.DB.prepare(
        `SELECT start_time, end_time, position FROM shifts
          WHERE employee_id = ? AND shift_date = ?
          ORDER BY start_time`
      )
        .bind(user.id, today)
        .all();

      const open = await env.DB.prepare(
        'SELECT id, clock_in FROM clock_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1'
      )
        .bind(user.id)
        .first();

      const recent = await env.DB.prepare(
        'SELECT clock_in, clock_out FROM clock_entries WHERE employee_id = ? ORDER BY clock_in DESC LIMIT 6'
      )
        .bind(user.id)
        .all();

      return json({
        today,
        todayShifts: todayShifts.results || [],
        openEntry: open || null,
        recent: recent.results || [],
      });
    }

    // Clock in / out — always acts on the caller's OWN record only.
    if (path === 'clock' && method === 'POST') {
      const open = await env.DB.prepare(
        'SELECT id FROM clock_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1'
      )
        .bind(user.id)
        .first();

      if (open) {
        await env.DB.prepare('UPDATE clock_entries SET clock_out = ? WHERE id = ?')
          .bind(Date.now(), open.id)
          .run();
        return json({ state: 'out' });
      }
      await env.DB.prepare(
        'INSERT INTO clock_entries (id, employee_id, clock_in, clock_out) VALUES (?, ?, ?, NULL)'
      )
        .bind(uid(), user.id, Date.now())
        .run();
      return json({ state: 'in' });
    }

    // Own time-off requests
    if (path === 'timeoff' && method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT id, start_date, end_date, reason, status, requested_at
           FROM time_off WHERE employee_id = ? ORDER BY requested_at DESC`
      )
        .bind(user.id)
        .all();
      return json({ requests: rows.results || [] });
    }

    if (path === 'timeoff' && method === 'POST') {
      const start = body.startDate;
      const end = body.endDate;
      const reason = String(body.reason || '').trim().slice(0, 300);
      if (!validDate(start) || !validDate(end)) return err('Pick a start and end date.');
      if (end < start) return err('The end date is before the start date.');

      await env.DB.prepare(
        `INSERT INTO time_off (id, employee_id, start_date, end_date, reason, status, requested_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      )
        .bind(uid(), user.id, start, end, reason, Date.now())
        .run();
      return json({ ok: true });
    }

    // Own schedule for a week
    if (path === 'schedule' && method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!validDate(from) || !validDate(to)) return err('Invalid week.');

      const rows = await env.DB.prepare(
        `SELECT shift_date, start_time, end_time, position FROM shifts
          WHERE employee_id = ? AND shift_date BETWEEN ? AND ?
          ORDER BY shift_date, start_time`
      )
        .bind(user.id, from, to)
        .all();
      return json({ shifts: rows.results || [] });
    }

    /* ---------- admin only ----------
       Anything past this line is refused for staff accounts, no matter
       what the browser sends. This is the real lock.                     */

    if (path.startsWith('admin')) {
      if (!isAdmin) return err('Admins only.', 403);

      // --- team ---
      if (path === 'admin/staff' && method === 'GET') {
        const rows = await env.DB.prepare(
          'SELECT id, name, role, active, created_at FROM employees ORDER BY name'
        ).all();
        return json({ staff: rows.results || [] });
      }

      if (path === 'admin/staff' && method === 'POST') {
        const name = String(body.name || '').trim();
        const pin = String(body.pin || '');
        const role = body.role === 'admin' ? 'admin' : 'staff';
        if (!name) return err('Enter a name.');
        if (!validPin(pin)) return err('PIN must be at least 4 digits.');

        const existing = await env.DB.prepare(
          'SELECT id FROM employees WHERE username = ?'
        )
          .bind(normalizeUsername(name))
          .first();
        if (existing) return err('Someone with that name already exists.');

        const { hash, salt } = await hashPin(pin);
        await env.DB.prepare(
          `INSERT INTO employees (id, name, username, pin_hash, pin_salt, role, active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
        )
          .bind(uid(), name, normalizeUsername(name), hash, salt, role, Date.now())
          .run();
        return json({ ok: true });
      }

      // Reset someone's PIN (staff can't reset their own — by design)
      if (path === 'admin/staff/pin' && method === 'POST') {
        const id = String(body.id || '');
        const pin = String(body.pin || '');
        if (!validPin(pin)) return err('PIN must be at least 4 digits.');
        const { hash, salt } = await hashPin(pin);
        const res = await env.DB.prepare(
          'UPDATE employees SET pin_hash = ?, pin_salt = ? WHERE id = ?'
        )
          .bind(hash, salt, id)
          .run();
        if (!res.meta.changes) return err('Staff member not found.', 404);
        // Force them to log in again everywhere.
        await env.DB.prepare('DELETE FROM sessions WHERE employee_id = ?').bind(id).run();
        return json({ ok: true });
      }

      if (path === 'admin/staff' && method === 'DELETE') {
        const id = String(body.id || '');
        if (id === user.id) return err('You cannot remove your own account.');

        // Never allow removing the last admin.
        const target = await env.DB.prepare('SELECT role FROM employees WHERE id = ?')
          .bind(id)
          .first();
        if (!target) return err('Staff member not found.', 404);
        if (target.role === 'admin') {
          const admins = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM employees WHERE role = 'admin' AND active = 1"
          ).first();
          if ((admins?.n ?? 0) <= 1) return err('You need at least one admin.');
        }

        await env.DB.prepare('DELETE FROM sessions WHERE employee_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM employees WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      // --- time off queue ---
      if (path === 'admin/timeoff' && method === 'GET') {
        const rows = await env.DB.prepare(
          `SELECT t.id, t.start_date, t.end_date, t.reason, t.status, t.requested_at, e.name AS employee_name
             FROM time_off t JOIN employees e ON e.id = t.employee_id
            ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END, t.requested_at DESC
            LIMIT 200`
        ).all();
        return json({ requests: rows.results || [] });
      }

      if (path === 'admin/timeoff' && method === 'POST') {
        const id = String(body.id || '');
        const decision = body.status;
        if (decision !== 'approved' && decision !== 'denied') return err('Invalid decision.');

        const res = await env.DB.prepare(
          "UPDATE time_off SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'"
        )
          .bind(decision, user.name, Date.now(), id)
          .run();
        if (!res.meta.changes) return err('That request was already reviewed.', 409);
        return json({ ok: true });
      }

      // --- schedule ---
      if (path === 'admin/shifts' && method === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (!validDate(from) || !validDate(to)) return err('Invalid week.');
        const rows = await env.DB.prepare(
          `SELECT s.id, s.shift_date, s.start_time, s.end_time, s.position, e.name AS employee_name
             FROM shifts s JOIN employees e ON e.id = s.employee_id
            WHERE s.shift_date BETWEEN ? AND ?
            ORDER BY s.shift_date, s.start_time`
        )
          .bind(from, to)
          .all();
        return json({ shifts: rows.results || [] });
      }

      if (path === 'admin/shifts' && method === 'POST') {
        const employeeId = String(body.employeeId || '');
        const date = body.date;
        const start = body.start;
        const end = body.end;
        const position = String(body.position || '').trim().slice(0, 80);

        if (!employeeId) return err('Pick a staff member.');
        if (!validDate(date)) return err('Pick a date.');
        if (!validTime(start) || !validTime(end)) return err('Times must look like 09:00.');
        if (end <= start) return err('The end time must be after the start time.');

        const emp = await env.DB.prepare('SELECT id FROM employees WHERE id = ? AND active = 1')
          .bind(employeeId)
          .first();
        if (!emp) return err('Staff member not found.', 404);

        await env.DB.prepare(
          `INSERT INTO shifts (id, employee_id, shift_date, start_time, end_time, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(uid(), employeeId, date, start, end, position, Date.now())
          .run();
        return json({ ok: true });
      }

      if (path === 'admin/shifts' && method === 'DELETE') {
        const id = String(body.id || '');
        await env.DB.prepare('DELETE FROM shifts WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      // --- clock log ---
      if (path === 'admin/clocklog' && method === 'GET') {
        const rows = await env.DB.prepare(
          `SELECT c.clock_in, c.clock_out, e.name AS employee_name
             FROM clock_entries c JOIN employees e ON e.id = c.employee_id
            ORDER BY c.clock_in DESC LIMIT 100`
        ).all();
        return json({ entries: rows.results || [] });
      }
    }

    return err('Not found.', 404);
  } catch (e) {
    return err('Something went wrong on the server: ' + (e?.message || 'unknown error'), 500);
  }
}
