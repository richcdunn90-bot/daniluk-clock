#!/usr/bin/env node
'use strict';
/*
 * Digital Job Clock — standalone hosted version.
 * The Daniluk Corporation. Node.js standard library only.
 * Data: JSON file (data.json) in this directory, atomic writes.
 * Listens on 0.0.0.0:$PORT (default 8931). All times America/Chicago.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8931', 10);
const DIR = __dirname;
const DATA_FILE = path.join(DIR, 'data.json');
const TZ = 'America/Chicago';

/* ---------------- Seed data ---------------- */
const SEED_WORKERS = ['Rich', 'Jose', 'David', 'Clone Geek', 'Wan', 'Paul',
  'Megal', 'Lil Jose', 'Painter', 'Jd', 'Phillip'];
const SEED_JOBS = [
  ['D25-RB-004', 'Process Baron — Rebuild 30 x 300 CNC lathe'],
  ['D26-SC-008', 'NOV XL — Replace input shaft bearings - NB60 spindle dr'],
  ['D26-RB-001', 'Progress Rail - AL — Build 4-axis Cinturn'],
  ['D26-RB-002', 'Progress Rail - AL — Build Cim-X yoke cutter'],
  ['D26-RB-003', 'Mingo Aerospace — Build 40 x 40 spherical grinder'],
  ['D26-SJ-002', 'Lincoln Park Boring — Replace X-axis screw'],
  ['D26-SJ-003', 'Metaltek - WI — 3412 Z1-axis conversion'],
  ['D26-SJ-007', 'Mingo Aerospace — Build 40" long part head center'],
  ['D26-SJ-008', 'Solar Turbine — Build 4 part load stations'],
  ['D26-SJ-017', 'Metaltek - WI — Repair G&L 48" VBM rail & ram'],
  ['D26-SJ-018', 'Spuncast — Rebuild 20HC headstock'],
  ['D26-SJ-022', 'Spuncast — Repair freight damage'],
];

function seedData() {
  return {
    workers: SEED_WORKERS.map((name, i) => ({ id: i + 1, name })),
    jobs: SEED_JOBS.map(([code, label]) => ({ code, label })),
    sessions: [],
    nextWorkerId: SEED_WORKERS.length + 1,
    nextSessionId: 1,
    pin: null,          // { salt, hash } once the manager sets it
    tokens: [],         // { token, createdAt }
  };
}

let DB;
function loadDb() {
  try {
    DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    DB = seedData();
    saveDb();
  }
}
function saveDb() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
loadDb();

/* ---------------- Chicago time helpers ---------------- */
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function chicagoParts(date) {
  const o = {};
  for (const p of partsFmt.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, ss: +o.second };
}
function chicagoDateStr(date) {
  const p = chicagoParts(date);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
function tzOffsetMs(date) {
  const p = chicagoParts(date);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(date.getTime() / 1000) * 1000;
}
/* UTC instant of Chicago local midnight on calendar day (y, m, d). */
function dayStartUtc(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let start = guess - tzOffsetMs(new Date(guess));
  start = guess - tzOffsetMs(new Date(start));
  return start;
}
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}
function dayRange(dateStr) {
  const { y, m, d } = parseDateStr(dateStr);
  const start = dayStartUtc(y, m, d);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = dayStartUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return { start, end };
}
function addDays(dateStr, n) {
  const { y, m, d } = parseDateStr(dateStr);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
/* Monday (YYYY-MM-DD, Chicago calendar) of the week containing dateStr. */
function weekMonday(dateStr) {
  const { y, m, d } = parseDateStr(dateStr);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return addDays(dateStr, -((dow + 6) % 7));
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function prettyDate(dateStr) {
  const { y, m, d } = parseDateStr(dateStr);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd}, ${MONTHS[m - 1]} ${d}`;
}
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
function prettyTime(iso) { return timeFmt.format(new Date(iso)); }
function fmtHrs(ms) { return (ms / 3600000).toFixed(1); }


/* UTC instant for a Chicago local date (YYYY-MM-DD) + time (HH:MM). */
function chicagoLocalToUtc(dateStr, timeStr) {
  const { y, m, d } = parseDateStr(dateStr);
  const [hh, mm] = timeStr.split(':').map(Number);
  return dayStartUtc(y, m, d) + hh * 3600000 + mm * 60000;
}

/* ---------------- Session math ---------------- */
function openSession(workerId) {
  return DB.sessions.find(s => s.workerId === workerId && !s.clockOut) || null;
}
function sessionOnBreak(s) { return s.breaks.some(b => !b.end); }
/* Net milliseconds of a session inside [rangeStart, rangeEnd): clocked overlap minus manual-break overlap. */
function netMsInRange(s, rangeStart, rangeEnd, now) {
  const sIn = Date.parse(s.clockIn);
  const sOut = s.clockOut ? Date.parse(s.clockOut) : now;
  const lo = Math.max(sIn, rangeStart), hi = Math.min(sOut, rangeEnd);
  if (hi <= lo) return 0;
  let net = hi - lo;
  for (const b of s.breaks) {
    const bIn = Date.parse(b.start);
    const bOut = b.end ? Date.parse(b.end) : sOut;
    const blo = Math.max(bIn, rangeStart, sIn), bhi = Math.min(bOut, rangeEnd, sOut);
    if (bhi > blo) net -= (bhi - blo);
  }
  return Math.max(0, net);
}
function workerName(id) { const w = DB.workers.find(w => w.id === id); return w ? w.name : '?'; }
function jobLabel(code) { const j = DB.jobs.find(j => j.code === code); return j ? j.label : ''; }

/* Totals for one Chicago day. */
function daySummary(dateStr, now) {
  const { start, end } = dayRange(dateStr);
  const peopleMap = new Map(); // workerId -> { name, ms, jobs: Map code->ms }
  const jobMap = new Map();    // code -> ms
  let total = 0;
  for (const s of DB.sessions) {
    const ms = netMsInRange(s, start, end, now);
    if (ms <= 0) continue;
    total += ms;
    if (!peopleMap.has(s.workerId)) peopleMap.set(s.workerId, { name: workerName(s.workerId), ms: 0, jobs: new Map() });
    const p = peopleMap.get(s.workerId);
    p.ms += ms;
    if (s.jobId) {
      p.jobs.set(s.jobId, (p.jobs.get(s.jobId) || 0) + ms);
      jobMap.set(s.jobId, (jobMap.get(s.jobId) || 0) + ms);
    }
  }
  const people = [...peopleMap.values()].sort((a, b) => b.ms - a.ms)
    .map(p => ({ name: p.name, hrs: fmtHrs(p.ms), jobs: [...p.jobs.entries()].map(([code, ms]) => ({ code, label: jobLabel(code), hrs: fmtHrs(ms) })) }));
  const byJob = [...jobMap.entries()].sort((a, b) => b[1] - a[1])
    .map(([code, ms]) => ({ code, label: jobLabel(code), hrs: fmtHrs(ms) }));
  return { date: dateStr, totalHrs: fmtHrs(total), people, byJob };
}
function stillClockedNames() {
  return DB.sessions.filter(s => !s.clockOut).map(s => workerName(s.workerId));
}

/* ---------------- Briefings (plain machinist wording, numbers only) ---------------- */
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return names.join(' and ');
  return names.slice(0, -1).join(', ') + ' and ' + names[ names.length - 1 ];
}
function briefingDay(dateStr, now) {
  const s = daySummary(dateStr, now);
  const head = `End of day, ${prettyDate(dateStr)}.`;
  if (parseFloat(s.totalHrs) <= 0) return `${head} No time was clocked today.`;
  const jobCount = s.byJob.length;
  let txt = `${head} The shop put in ${s.totalHrs} hours across ${jobCount} job${jobCount === 1 ? '' : 's'}.`;
  if (s.byJob.length) {
    const top = s.byJob[0];
    txt += ` Most of the time went to ${top.code} — ${top.label.split(' — ')[0]}, ${top.hrs} hours.`;
  }
  txt += ' ' + s.people.map(p => `${p.name} put in ${p.hrs} hours`).join('. ') + '.';
  const still = stillClockedNames();
  if (still.length && dateStr === chicagoDateStr(new Date(now))) {
    txt += ` ${joinNames(still)} ${still.length === 1 ? 'is' : 'are'} still on the clock, so these numbers aren't final.`;
  }
  return txt;
}
function briefingWeek(mondayStr, now) {
  let total = 0; const peopleMap = new Map(); const jobMap = new Map();
  for (let i = 0; i < 7; i++) {
    const ds = addDays(mondayStr, i);
    const s = daySummary(ds, now);
    total += parseFloat(s.totalHrs);
    for (const p of s.people) peopleMap.set(p.name, (peopleMap.get(p.name) || 0) + parseFloat(p.hrs));
    for (const j of s.byJob) jobMap.set(j.code, (jobMap.get(j.code) || 0) + parseFloat(j.hrs));
  }
  const head = `End of week, week of ${prettyDate(mondayStr)}.`;
  if (total <= 0) return `${head} No time was clocked this week.`;
  const people = [...peopleMap.entries()].sort((a, b) => b[1] - a[1]);
  const jobs = [...jobMap.entries()].sort((a, b) => b[1] - a[1]);
  let txt = `${head} The shop put in ${total.toFixed(1)} hours across ${jobs.length} job${jobs.length === 1 ? '' : 's'}.`;
  if (jobs.length) {
    const [code, hrs] = jobs[0];
    txt += ` Most of the time went to ${code} — ${jobLabel(code).split(' — ')[0]}, ${hrs.toFixed(1)} hours.`;
  }
  txt += ' ' + people.map(([n, h]) => `${n} put in ${h.toFixed(1)} hours`).join('. ') + '.';
  const still = stillClockedNames();
  if (still.length) txt += ` ${joinNames(still)} ${still.length === 1 ? 'is' : 'are'} still on the clock, so these numbers aren't final.`;
  return txt;
}

/* ---------------- PIN / tokens ---------------- */
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function setPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  DB.pin = { salt, hash: hashPin(pin, salt) };
}
function checkPin(pin) {
  if (!DB.pin) return false;
  const h = Buffer.from(hashPin(pin, DB.pin.salt), 'hex');
  const want = Buffer.from(DB.pin.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  DB.tokens.push({ token, createdAt: Date.now() });
  saveDb();
  return token;
}
function validToken(req) {
  const t = req.headers['x-manager-token'];
  return !!t && DB.tokens.some(x => x.token === t);
}

/* ---------------- HTTP plumbing ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    /* Static front end */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(DIR, 'index.html')));
      return;
    }

    /* ---------- Employee API (no hours/totals ever exposed) ---------- */
    if (p === '/api/employee' && req.method === 'GET') {
      sendJson(res, 200, {
        workers: DB.workers.map(w => ({ id: w.id, name: w.name, onShift: !!openSession(w.id) })),
        jobs: DB.jobs.map(j => ({ code: j.code, label: j.label })),
      });
      return;
    }
    const stateMatch = p.match(/^\/api\/worker\/(\d+)\/state$/);
    if (stateMatch && req.method === 'GET') {
      const wid = +stateMatch[1];
      const s = openSession(wid);
      if (!s) { sendJson(res, 200, { onShift: false }); return; }
      sendJson(res, 200, {
        onShift: true, clockIn: s.clockIn,
        onBreak: sessionOnBreak(s),
        breaks: s.breaks.map(b => ({ start: b.start, end: b.end })),
      });
      return;
    }
    if (p === '/api/clock-in' && req.method === 'POST') {
      const { workerId } = await readBody(req);
      const w = DB.workers.find(w => w.id === workerId);
      if (!w) { sendJson(res, 400, { error: 'Unknown worker' }); return; }
      let s = openSession(workerId);
      if (!s) {
        s = { id: DB.nextSessionId++, workerId, jobId: null, clockIn: new Date().toISOString(), clockOut: null, breaks: [] };
        DB.sessions.push(s);
        saveDb();
      }
      sendJson(res, 200, { ok: true, clockIn: s.clockIn });
      return;
    }
    if (p === '/api/break' && req.method === 'POST') {
      const { workerId, action } = await readBody(req);
      const s = openSession(workerId);
      if (!s) { sendJson(res, 400, { error: 'Not on shift' }); return; }
      const nowIso = new Date().toISOString();
      if (action === 'start') {
        if (!sessionOnBreak(s)) { s.breaks.push({ start: nowIso, end: null }); saveDb(); }
      } else if (action === 'end') {
        const b = s.breaks.find(b => !b.end);
        if (b) { b.end = nowIso; saveDb(); }
      } else { sendJson(res, 400, { error: 'Bad action' }); return; }
      sendJson(res, 200, { ok: true, onBreak: sessionOnBreak(s) });
      return;
    }
    if (p === '/api/clock-out' && req.method === 'POST') {
      const { workerId, jobId } = await readBody(req);
      const s = openSession(workerId);
      if (!s) { sendJson(res, 400, { error: 'Not on shift' }); return; }
      if (!jobId || !DB.jobs.some(j => j.code === jobId)) {
        sendJson(res, 400, { error: 'Pick a job to clock out' });
        return;
      }
      const nowIso = new Date().toISOString();
      const open = s.breaks.find(b => !b.end);
      if (open) open.end = nowIso;
      s.jobId = jobId;
      s.clockOut = nowIso;
      saveDb();
      sendJson(res, 200, { ok: true });
      return;
    }


    if (p === '/api/manual-entry' && req.method === 'POST') {
      const { workerId, jobId, date, inTime, outTime, breakMinutes } = await readBody(req);
      const w = DB.workers.find(w => w.id === workerId);
      if (!w) { sendJson(res, 400, { error: 'Unknown worker' }); return; }
      if (!jobId || !DB.jobs.some(j => j.code === jobId)) {
        sendJson(res, 400, { error: 'Pick the job you worked' });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ||
          !/^\d{2}:\d{2}$/.test(String(inTime || '')) ||
          !/^\d{2}:\d{2}$/.test(String(outTime || ''))) {
        sendJson(res, 400, { error: 'Enter the date, clock-in time and clock-out time' });
        return;
      }
      const inMs = chicagoLocalToUtc(date, inTime);
      const outMs = chicagoLocalToUtc(date, outTime);
      if (!(outMs > inMs)) { sendJson(res, 400, { error: 'Clock-out has to be after clock-in' }); return; }
      if (outMs - inMs > 24 * 3600000) { sendJson(res, 400, { error: 'That shift is over 24 hours - check the times' }); return; }
      if (outMs > Date.now() + 60000) { sendJson(res, 400, { error: "That time hasn't happened yet" }); return; }
      const brkMin = Math.max(0, Math.floor(Number(breakMinutes) || 0));
      if (brkMin * 60000 >= outMs - inMs) { sendJson(res, 400, { error: 'Break is longer than the shift itself' }); return; }
      for (const o of DB.sessions.filter(x => x.workerId === workerId)) {
        const oIn = Date.parse(o.clockIn);
        const oOut = o.clockOut ? Date.parse(o.clockOut) : Infinity;
        if (inMs < oOut && outMs > oIn) {
          sendJson(res, 400, { error: 'That overlaps time already on the clock for you' });
          return;
        }
      }
      const inIso = new Date(inMs).toISOString();
      const sess = {
        id: DB.nextSessionId++, workerId, jobId,
        clockIn: inIso, clockOut: new Date(outMs).toISOString(),
        breaks: brkMin > 0 ? [{ start: inIso, end: new Date(inMs + brkMin * 60000).toISOString() }] : [],
        manual: true,
      };
      DB.sessions.push(sess);
      saveDb();
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---------- Manager auth ---------- */
    if (p === '/api/manager/status' && req.method === 'GET') {
      sendJson(res, 200, { hasPin: !!DB.pin });
      return;
    }
    if (p === '/api/manager/setup' && req.method === 'POST') {
      const { pin } = await readBody(req);
      if (DB.pin) { sendJson(res, 400, { error: 'A manager PIN is already set' }); return; }
      if (!pin || String(pin).length < 4) { sendJson(res, 400, { error: 'PIN must be at least 4 digits' }); return; }
      setPin(pin);
      sendJson(res, 200, { token: issueToken() });
      return;
    }
    if (p === '/api/manager/login' && req.method === 'POST') {
      const { pin } = await readBody(req);
      if (!DB.pin) { sendJson(res, 400, { error: 'No manager PIN set yet' }); return; }
      if (!checkPin(pin)) { sendJson(res, 401, { error: 'Wrong PIN' }); return; }
      sendJson(res, 200, { token: issueToken() });
      return;
    }
    if (p === '/api/manager/logout' && req.method === 'POST') {
      const t = req.headers['x-manager-token'];
      DB.tokens = DB.tokens.filter(x => x.token !== t);
      saveDb();
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---------- Manager API (token required) ---------- */
    if (p.startsWith('/api/manager/')) {
      if (!validToken(req)) { sendJson(res, 401, { error: 'Manager sign-in required' }); return; }
      const now = Date.now();
      const todayStr = chicagoDateStr(new Date(now));
      const mondayStr = weekMonday(todayStr);
      const wk = dayRange(mondayStr), wkEnd = dayRange(addDays(mondayStr, 6));

      if (p === '/api/manager/overview' && req.method === 'GET') {
        const byJob = new Map(); const noJob = [];
        for (const s of DB.sessions.filter(s => !s.clockOut)) {
          const person = { workerId: s.workerId, name: workerName(s.workerId), clockIn: s.clockIn, onBreak: sessionOnBreak(s), breaks: s.breaks };
          if (s.jobId) {
            if (!byJob.has(s.jobId)) byJob.set(s.jobId, { code: s.jobId, label: jobLabel(s.jobId), people: [] });
            byJob.get(s.jobId).people.push(person);
          } else noJob.push(person);
        }
        const today = daySummary(todayStr, now);
        let weekTotal = 0;
        for (let i = 0; i < 7; i++) weekTotal += parseFloat(daySummary(addDays(mondayStr, i), now).totalHrs);
        sendJson(res, 200, {
          floor: [...byJob.values()], noJob,
          onFloor: DB.sessions.filter(s => !s.clockOut).length,
          todayHrs: today.totalHrs, weekHrs: weekTotal.toFixed(1),
          today: todayStr,
        });
        return;
      }
      if (p === '/api/manager/people' && req.method === 'GET') {
        const byJob = new Map(); const notIn = [];
        for (const w of DB.workers) {
          const s = openSession(w.id);
          if (s && s.jobId) {
            if (!byJob.has(s.jobId)) byJob.set(s.jobId, { code: s.jobId, label: jobLabel(s.jobId), people: [] });
            byJob.get(s.jobId).people.push({ name: w.name });
          } else if (s) {
            if (!byJob.has('__nojob')) byJob.set('__nojob', { code: null, label: 'Clocked in — job not picked yet', people: [] });
            byJob.get('__nojob').people.push({ name: w.name });
          } else notIn.push({ name: w.name });
        }
        sendJson(res, 200, { groups: [...byJob.values()], notClockedIn: notIn });
        return;
      }
      if (p === '/api/manager/workers' && req.method === 'POST') {
        const { name } = await readBody(req);
        const clean = String(name || '').trim();
        if (!clean) { sendJson(res, 400, { error: 'Name required' }); return; }
        const w = { id: DB.nextWorkerId++, name: clean };
        DB.workers.push(w);
        saveDb();
        sendJson(res, 200, { ok: true, worker: w });
        return;
      }
      if (p === '/api/manager/timesheets' && req.method === 'GET') {
        const out = DB.workers.map(w => {
          const days = new Map();
          for (const s of DB.sessions.filter(s => s.workerId === w.id)) {
            const ds = chicagoDateStr(new Date(s.clockIn));
            if (!days.has(ds)) days.set(ds, { date: ds, sessions: [], totalMs: 0 });
            const { start, end } = dayRange(ds);
            const net = netMsInRange(s, start, end, now);
            days.get(ds).sessions.push({
              jobCode: s.jobId, jobLabel: s.jobId ? jobLabel(s.jobId) : 'Job not picked yet',
              inTime: prettyTime(s.clockIn), outTime: s.clockOut ? prettyTime(s.clockOut) : null,
              open: !s.clockOut, manual: !!s.manual, netHrs: fmtHrs(net),
            });
            days.get(ds).totalMs += net;
          }
          return {
            name: w.name,
            days: [...days.values()].sort((a, b) => b.date.localeCompare(a.date))
              .map(d => ({ date: d.date, totalHrs: fmtHrs(d.totalMs), sessions: d.sessions })),
          };
        });
        sendJson(res, 200, { workers: out });
        return;
      }
      if (p === '/api/manager/summary/day' && req.method === 'GET') {
        const dateStr = url.searchParams.get('date') || todayStr;
        const s = daySummary(dateStr, now);
        sendJson(res, 200, { ...s, label: prettyDate(dateStr), stillClocked: stillClockedNames(), briefing: briefingDay(dateStr, now) });
        return;
      }
      if (p === '/api/manager/summary/week' && req.method === 'GET') {
        const anchor = url.searchParams.get('date') || todayStr;
        const mon = weekMonday(anchor);
        const days = [];
        const peopleMap = new Map(); const jobMap = new Map(); let total = 0;
        for (let i = 0; i < 7; i++) {
          const ds = addDays(mon, i);
          const s = daySummary(ds, now);
          days.push({ date: ds, label: prettyDate(ds), totalHrs: s.totalHrs });
          total += parseFloat(s.totalHrs);
          for (const person of s.people) {
            if (!peopleMap.has(person.name)) peopleMap.set(person.name, { name: person.name, total: 0, byDay: {} });
            const rec = peopleMap.get(person.name);
            rec.total += parseFloat(person.hrs);
            rec.byDay[ds] = person.hrs;
          }
          for (const j of s.byJob) jobMap.set(j.code, (jobMap.get(j.code) || 0) + parseFloat(j.hrs));
        }
        sendJson(res, 200, {
          monday: mon, sunday: addDays(mon, 6), totalHrs: total.toFixed(1), days,
          people: [...peopleMap.values()].sort((a, b) => b.total - a.total)
            .map(r => ({ name: r.name, totalHrs: r.total.toFixed(1), byDay: r.byDay })),
          byJob: [...jobMap.entries()].sort((a, b) => b[1] - a[1])
            .map(([code, hrs]) => ({ code, label: jobLabel(code), hrs: hrs.toFixed(1) })),
          stillClocked: stillClockedNames(),
          briefing: briefingWeek(mon, now),
        });
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Digital Job Clock listening on 0.0.0.0:${PORT}`);
});
