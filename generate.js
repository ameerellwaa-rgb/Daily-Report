#!/usr/bin/env node
const https = require('https');
const fs    = require('fs');

const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const PORTAL_ID     = '896030705';
const SHEET_ID      = '11P7XJlm19FMGwgEv5OvyETpjK8qef-Vt6amrCru9bKY';

const AM_MAP = {
  'Esraa Ellwaa':    'إسراء',
  'Jenna Ellwaa':    'جنة',
  'fatema ellwaa':   'فاطمة',
  'pola ellwaa':     'بولا',
  'Youssef Mellwaa': 'يوسف',
  'Mostafa Ellwaa':  'مصطفى',
};
const AM_ORDER = ['Esraa Ellwaa','Jenna Ellwaa','fatema ellwaa','pola ellwaa','Youssef Mellwaa','Mostafa Ellwaa'];
const EXCLUDE  = new Set(['Walid Mohsen']);

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpPost(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST' }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error(body.slice(0,300))); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error(body.slice(0,300))); } });
    }).on('error', reject);
  });
}

function httpGetText(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        return resolve(httpGetText(res.headers.location, maxRedirects - 1));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = [];
    let i = 0;
    while (i <= line.length) {
      if (i === line.length) { cells.push(''); break; }
      if (line[i] === '"') {
        let j = i + 1, val = '';
        while (j < line.length) {
          if (line[j] === '"') {
            if (j+1 < line.length && line[j+1] === '"') { val += '"'; j += 2; }
            else { j++; break; }
          } else { val += line[j++]; }
        }
        cells.push(val);
        if (j < line.length && line[j] === ',') j++;
        i = j;
      } else {
        const end = line.indexOf(',', i);
        const to  = end === -1 ? line.length : end;
        cells.push(line.slice(i, to));
        i = to + 1;
      }
    }
    rows.push(cells);
  }
  return rows;
}

// ── Rate-limit-aware request wrapper ─────────────────────────────────────────
let reqCount = 0;
let windowStart = Date.now();

async function zohoGet(token, path, v3 = false, _retry = 1) {
  const now = Date.now();
  const elapsed = now - windowStart;
  if (elapsed >= 120000) { reqCount = 0; windowStart = Date.now(); }
  if (reqCount >= 85) {
    const wait = 120000 - elapsed + 3000;
    console.log(`  [rate limit] ${reqCount} calls in ${Math.round(elapsed/1000)}s — waiting ${Math.round(wait/1000)}s`);
    await new Promise(r => setTimeout(r, wait));
    reqCount = 0;
    windowStart = Date.now();
  }
  reqCount++;
  let base;
  if (v3 === 'web') base = 'https://projects.zoho.com/api/v3';
  else if (v3) base = 'https://projectsapi.zoho.com';
  else base = 'https://projectsapi.zoho.com/restapi';
  const res = await httpGet(
    `${base}${path}`,
    { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'json' }
  ).catch(e => { console.error('GET error:', path, e.message); return {}; });

  if (res.error?.title === 'URL_ROLLING_THROTTLES_LIMIT_EXCEEDED' && _retry > 0) {
    console.log(`  [rolling-throttle] ${path.split('/').slice(-2).join('/')} — waiting 3 min then retry`);
    await new Promise(r => setTimeout(r, 185000));
    reqCount = 0; windowStart = Date.now();
    return zohoGet(token, path, v3, _retry - 1);
  }

  return res;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getAccessToken() {
  const url = `https://accounts.zoho.com/oauth/v2/token?grant_type=refresh_token&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&refresh_token=${REFRESH_TOKEN}`;
  const data = await httpPost(url);
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  console.log('✓ Access token obtained');
  return data.access_token;
}


// ── Status IDs (from DevTools inspection) ────────────────────────────────────
const STATUS_CFID      = '2533013000000020044';
const STATUS_ON_HOLD   = '2533013000000020104';
const STATUS_COMPLETED = '2533013000000020116';

async function getProjectsByStatus(token, statusId) {
  const out = [];
  let index = 1;
  const criteria = encodeURIComponent(JSON.stringify({
    criteria: [{ criteria_condition: 'is', value: [statusId], cfid: STATUS_CFID }],
    pattern: '1',
  }));
  while (true) {
    const res = await zohoGet(token, `/portal/${PORTAL_ID}/projects/?criteria=${criteria}&index=${index}&range=100`);
    if (res.error) {
      console.log(`  [criteria] error for statusId=${statusId}:`, res.error.title || JSON.stringify(res.error).slice(0,200));
      return null;
    }
    const batch = res.projects || [];
    out.push(...batch);
    if (batch.length < 100) break;
    index += 100;
  }
  return out;
}

// ── Project list ──────────────────────────────────────────────────────────────
async function getAllProjects(token) {
  const out = [];
  let index = 1;
  while (true) {
    const res = await zohoGet(token, `/portal/${PORTAL_ID}/projects/?index=${index}&range=100`);
    const batch = res.projects || [];
    out.push(...batch);
    console.log(`  projects page: got ${batch.length} (total so far: ${out.length})`);
    if (batch.length < 100) break;
    index += 100;
  }
  console.log(`✓ ${out.length} total projects from v2`);
  return out;
}

// ── Google Sheet: الدفعة الأولى المتأخرة ─────────────────────────────────────
async function getP1Delayed() {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
    const text = await httpGetText(url);
    const rows = parseCSV(text);
    const result = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length < 11) continue;
      const theRest = parseFloat((row[10] || '0').replace(/,/g, '')) || 0;
      if (theRest === 0) continue;
      result.push({
        name:          row[1] || '',
        owner:         row[2] || '',
        paymentMethod: row[5] || '',
        first:         parseFloat((row[6] || '0').replace(/,/g, '')) || 0,
        tax:           parseFloat((row[7] || '0').replace(/,/g, '')) || 0,
        theRest,
      });
    }
    console.log(`✓ ${result.length} P1 delayed from Google Sheet`);
    return result;
  } catch (e) {
    console.error('getP1Delayed error:', e.message);
    return [];
  }
}

// ── Per-project data ──────────────────────────────────────────────────────────
const _debugSamples = { milestones: [], tasks: [] };
let _diagLicCount = 0;
let taskCache  = {};
let cacheHits  = 0;
let cacheMisses = 0;

// Cache entry keys:
//   u   — project.last_updated_time_long (invalidation key)
//   lic — null=not finished, 0=finished/no-timestamp, N=finished timestamp
//   rv  — استلام open, co — جمع open, ap — موافقة open, am — امريكا open
//   sj  — sijil finished, sjE — sijil end_date_long if open, ovE — overview end_date_long if open
//   m2/m3 — milestone status string (null if milestone doesn't exist)
async function getProjectData(token, project) {
  const pid   = project.id_string;
  const utime = project.last_updated_time_long || 0;

  const cached = taskCache[pid];
  if (cached && cached.u === utime) {
    cacheHits++;
    return cached;
  }
  cacheMisses++;

  // ── Milestones ──
  const msRes = await zohoGet(token, `/portal/${PORTAL_ID}/projects/${pid}/milestones/`);
  const milestones = msRes.milestones || [];

  if (_debugSamples.milestones.length < 3) {
    const d = milestones.find(m => m.name && m.name.includes('دفعة'));
    if (d) _debugSamples.milestones.push(d);
  }

  // ── Tasks ──
  const tasks = [];
  let taskIdx = 1;
  while (true) {
    const res = await zohoGet(token, `/portal/${PORTAL_ID}/projects/${pid}/tasks/?status=all&index=${taskIdx}&range=100`);
    const batch = res.tasks || [];
    tasks.push(...batch);
    if (batch.length < 100) break;
    taskIdx += 100;
  }

  if (_debugSamples.tasks.length < 2 && tasks.length > 0) {
    _debugSamples.tasks.push(tasks[0]);
  }
  const licTask = tasks.find(t => t.name === 'صدور الترخيص');
  if (licTask && _diagLicCount < 5) {
    _diagLicCount++;
    console.log(`  [diag] pid=${pid} licTask status="${licTask.status?.name}" type="${licTask.status?.type}"`);
  }

  // ── Compute derived metrics and cache ──
  const st       = t => (t.status?.name || '').toLowerCase();
  const licFin   = licTask && st(licTask) === 'finished';
  const sijilOpen = tasks.find(t => (t.name || '').includes('تسليم نسخة من السجل التجارى') && st(t) === 'open');
  const ovOpen    = tasks.find(t => (t.name || '').includes('عمل الاوفر فيو')                && st(t) === 'open');
  const m2   = milestones.find(m => m.name === 'الدفعة الثانية');
  const m3   = milestones.find(m => m.name === 'الدفعة الثالثة');
  const m3st = m3 ? (m3.status || '').toLowerCase() : null;
  const m3t  = m3st === 'completed'
    ? (m3.completed_time_long || m3.completed_date_long || m3.end_date_long || 0)
    : null;

  const entry = {
    u:   utime,
    lic: licFin ? (licTask.completed_time_long || 0) : null,
    rv:  tasks.some(t => t.name === 'استلام بيانات الترخيص'        && st(t) === 'open'),
    co:  tasks.some(t => t.name === 'جمع بيانات الترخيص'            && st(t) === 'open'),
    ap:  tasks.some(t => t.name === 'موافقة العميل على الاوفر فيو'  && st(t) === 'open'),
    am:  tasks.some(t => (t.name || '').includes('عمل شركة  امريكا') && st(t) === 'open'),
    sj:  tasks.some(t => (t.name || '').includes('تسليم نسخة من السجل التجارى') && st(t) === 'finished'),
    sjE: sijilOpen ? (sijilOpen.end_date_long || null) : null,
    ovE: ovOpen    ? (ovOpen.end_date_long    || null) : null,
    m2:  m2 ? (m2.status || '').toLowerCase() : null,
    m3:  m3st,
    m3t,
  };

  taskCache[pid] = entry;
  return entry;
}

// ── Lightweight milestone-only fetch (for done-project completedMonth check) ──
async function getProjectM3(token, project) {
  const pid   = project.id_string;
  const utime = project.last_updated_time_long || 0;
  const cKey  = 'ms_' + pid;
  const cached = taskCache[cKey];
  if (cached && cached.u === utime) { cacheHits++; return cached; }
  cacheMisses++;

  const msRes = await zohoGet(token, `/portal/${PORTAL_ID}/projects/${pid}/milestones/`);
  const milestones = msRes.milestones || [];
  const m3   = milestones.find(m => m.name === 'الدفعة الثالثة');
  const m3st = m3 ? (m3.status || '').toLowerCase() : null;
  const m3t  = m3st === 'completed'
    ? (m3.completed_time_long || m3.completed_date_long || m3.end_date_long || 0)
    : null;

  if (m3 && m3st === 'completed' && cacheMisses <= 5) {
    console.log(`  [m3-dbg] pid=${pid} keys=${Object.keys(m3).join(',')} m3t=${m3t}`);
  }

  const entry = { u: utime, m3: m3st, m3t };
  taskCache[cKey] = entry;
  return entry;
}

// ── Condition helpers ─────────────────────────────────────────────────────────
const msStatus   = m => (m.status || '').toLowerCase();
const isOpen     = t => (t.status?.name || '').toLowerCase() === 'open';
const isOnHold   = p => {
  const n = (p.status?.name || p.status || '');
  return typeof n === 'string' && n.toLowerCase().replace(/[\s_]+/g, '') === 'onhold';
};
const isFinished = t => (t.status?.name || '').toLowerCase() === 'finished';
const isOverdue  = t => isOpen(t) && t.end_date_long && t.end_date_long < Date.now();

function isThisMonth(t, now) {
  if (!t.completed_time_long) return false;
  const d = new Date(t.completed_time_long);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function isThisMonthMs(ms, now) {
  if (!ms) return false;
  const d = new Date(ms);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

const findTask     = (tasks, name, pred)   => tasks.some(t => t.name === name && pred(t));
const findTaskLike = (tasks, substr, pred) => tasks.some(t => (t.name || '').includes(substr) && pred(t));

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load task cache (reduces ~187 API calls to ~20-40 on repeat runs)
  try {
    taskCache = JSON.parse(fs.readFileSync('task_cache.json', 'utf8'));
    console.log(`✓ Loaded task_cache.json (${Object.keys(taskCache).length} entries)`);
  } catch {
    taskCache = {};
    console.log('  task_cache.json not found — starting fresh');
  }

  const token    = await getAccessToken();
  const projects = await getAllProjects(token);

  // Build owner and name maps (all projects)
  const ownerMap = {};
  const nameMap  = {};
  for (const p of projects) {
    const owner = (p.owner && p.owner.name) || p.owner_name || '';
    ownerMap[p.id_string] = EXCLUDE.has(owner) ? '' : owner;
    nameMap[p.id_string]  = p.name || p.id_string;
  }

  // Get P1 delayed from Google Sheet
  const p1Delayed = await getP1Delayed();
  const is112 = name => /-112-/i.test(name || '');

  const now = new Date();

  // Try criteria-based status filtering from Zoho API
  console.log('Trying Zoho criteria API for On Hold & Completed...');
  const apiOnHold    = await getProjectsByStatus(token, STATUS_ON_HOLD);
  const apiCompleted = await getProjectsByStatus(token, STATUS_COMPLETED);

  let onHoldSet, doneProjectIds, projectMsMap = {};

  const criteriaWorked = apiOnHold !== null && apiCompleted !== null
    && apiOnHold.length < projects.length && apiCompleted.length < projects.length
    && apiOnHold.length > 0;

  if (criteriaWorked) {
    // Full automation: Zoho status via criteria API
    console.log(`✓ Criteria API works: onHold=${apiOnHold.length} completed=${apiCompleted.length}`);
    onHoldSet     = new Set(apiOnHold.map(p => p.id_string));
    doneProjectIds = new Set(apiCompleted.map(p => p.id_string));
  } else {
    if (apiOnHold !== null) console.log(`  Criteria ignored by API (returned ${apiOnHold?.length} for onHold) — falling back`);
    // Fallback: project_ids.json for on_hold + milestone pre-pass for done
    console.log('  Criteria API failed — falling back to project_ids.json + milestone pre-pass');
    const ids  = JSON.parse(fs.readFileSync('project_ids.json', 'utf8'));
    onHoldSet  = new Set(ids.on_hold);
    doneProjectIds = new Set();
    console.log(`Pre-pass: checking م3 for ${projects.length - onHoldSet.size} projects...`);
    for (const p of projects) {
      if (onHoldSet.has(p.id_string)) continue;
      const ms = await getProjectM3(token, p);
      projectMsMap[p.id_string] = ms;
      if (ms.m3 === 'completed') doneProjectIds.add(p.id_string);
    }
  }

  const doneProjects   = projects.filter(p => doneProjectIds.has(p.id_string));
  const onHoldProjects = projects.filter(p => onHoldSet.has(p.id_string));
  const activeProjects = projects.filter(p => !doneProjectIds.has(p.id_string) && !onHoldSet.has(p.id_string));
  console.log(`✓ active: ${activeProjects.length}  on_hold: ${onHoldProjects.length}  done: ${doneProjects.length}`);

  // Count Active / OnHold per AM for the AM summary table
  const amActive = {};
  const amOnHold = {};
  for (const p of activeProjects) {
    const owner = ownerMap[p.id_string];
    if (owner && AM_MAP[owner]) amActive[owner] = (amActive[owner] || 0) + 1;
  }
  for (const p of onHoldProjects) {
    const owner = ownerMap[p.id_string];
    if (owner && AM_MAP[owner]) amOnHold[owner] = (amOnHold[owner] || 0) + 1;
  }

  // Metric buckets — all Active-only
  const B = {
    p2:{}, p3:{}, recv:{}, coll:{},
    licMonth:{}, sijilSaudi:{}, clientApproval:{}, overDue:{},
    sijilDelay:{}, sijilAmer:{}, amer:{},
  };

  const completedMonthIds = [];
  const completed112Ids   = [];
  let processed = 0;

  for (const project of activeProjects) {
    const pid   = project.id_string;
    const owner = ownerMap[pid];

    const e     = await getProjectData(token, project);
    const nowMs = Date.now();

    const licThisMonth = e.lic > 0 && isThisMonthMs(e.lic, now);
    const sijilOvr     = e.sjE !== null && e.sjE < nowMs;
    const overviewOvr  = e.ovE !== null && e.ovE < nowMs;

    if (e.lic !== null && e.m2 !== null && e.m2 !== 'completed')              B.p2[pid]            = owner;
    if (e.m2 === 'completed' && e.m3 !== null && e.m3 !== 'completed')        B.p3[pid]            = owner;
    if (e.rv)                                                                  B.recv[pid]          = owner;
    if (e.co && e.rv)                                                          B.coll[pid]          = owner;
    if (licThisMonth)                                                          B.licMonth[pid]      = owner;
    if (e.sj)                                                                  B.sijilSaudi[pid]    = owner;
    if (e.ap)                                                                  B.clientApproval[pid]= owner;
    if (overviewOvr)                                                           B.overDue[pid]       = owner;
    if (sijilOvr)                                                              B.sijilDelay[pid]    = owner;
    if (e.sj && e.am)                                                          B.sijilAmer[pid]     = owner;
    if (e.am)                                                                  B.amer[pid]          = owner;
    if (e.m3t && isThisMonthMs(e.m3t, now)) {
      if (is112(nameMap[pid] || pid)) completed112Ids.push(pid);
      else                            completedMonthIds.push(pid);
    }

    processed++;
    if (processed % 50 === 0) console.log(`  ${processed} / ${activeProjects.length} processed`);
  }

  console.log(`✓ ${processed} active projects analyzed`);

  // Secondary loop: done projects — check if م3 completed this month
  console.log(`Checking ${doneProjects.length} done projects for completedMonth...`);
  for (const project of doneProjects) {
    const pid = project.id_string;
    const ms  = projectMsMap[pid] || await getProjectM3(token, project);
    if (ms && isThisMonthMs(ms.m3t, now)) {
      const full  = await getProjectData(token, project);
      const owner = ownerMap[pid] || '';
      if (is112(nameMap[pid] || pid)) completed112Ids.push(pid);
      else                            completedMonthIds.push(pid);
      if (full.lic > 0 && isThisMonthMs(full.lic, now) && !B.licMonth[pid]) {
        B.licMonth[pid] = owner;
      }
    }
  }
  console.log(`✓ licMonth total: ${Object.keys(B.licMonth).length} (completedMonth=${completedMonthIds.length} completed112=${completed112Ids.length})`);

  function summarize(bucket) {
    const byManager = {};
    const details   = [];
    for (const [pid, owner] of Object.entries(bucket)) {
      details.push({ name: nameMap[pid] || pid, owner: AM_MAP[owner] || owner || '—' });
      if (AM_MAP[owner]) byManager[owner] = (byManager[owner] || 0) + 1;
    }
    return { total: details.length, byManager, details };
  }

  const makeCompletedDetails = pidList =>
    pidList.map(pid => ({
      name:  nameMap[pid] || pid,
      owner: AM_MAP[ownerMap[pid]] || ownerMap[pid] || '—',
    }));

  const METRIC_KEYS = ['p2','p3','recv','coll','licMonth','sijilSaudi','clientApproval',
                       'overDue','sijilDelay','sijilAmer','amer'];

  const data = {
    ...Object.fromEntries(METRIC_KEYS.map(k => [k, summarize(B[k])])),
    completedMonth: { total: completedMonthIds.length,  details: makeCompletedDetails(completedMonthIds) },
    completed112:   { total: completed112Ids.length,    details: makeCompletedDetails(completed112Ids) },
    p1Delayed:      { total: p1Delayed.length, details: p1Delayed },
    onHold: (() => {
      const list = [...onHoldSet].map(pid => ({
        name:  nameMap[pid] || pid,
        owner: AM_MAP[ownerMap[pid]] || ownerMap[pid] || '—',
      }));
      return { total: list.length, details: list };
    })(),
    amData: { active: amActive, onHold: amOnHold },
    updatedAt: new Date().toLocaleString('ar-EG', {
      timeZone:'Africa/Cairo', weekday:'long', year:'numeric',
      month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'
    }),
    month: new Date().toISOString().slice(0,7),
    dateKey: new Date().toISOString().slice(0, 10),
  };

  console.log('\nFinal metrics:');
  for (const k of [...METRIC_KEYS, 'completedMonth', 'completed112']) {
    console.log(`  ${k}: ${data[k].total}`);
  }
  console.log('  AM Active:', amActive);
  console.log('  AM OnHold:', amOnHold);

  // ── Save history snapshot ────────────────────────────────────────────────────
  const dateKey = new Date().toISOString().slice(0, 10); // "2026-07-20"
  if (!fs.existsSync('history')) fs.mkdirSync('history');

  const ALL_KEYS = [...METRIC_KEYS, 'completedMonth', 'completed112', 'onHold'];
  const histEntry = {
    date:      dateKey,
    updatedAt: data.updatedAt,
    metrics:   { ...Object.fromEntries(ALL_KEYS.map(k => [k, data[k].total])), p1Delayed: data.p1Delayed.total },
    amData:    data.amData,
    details:   { ...Object.fromEntries(ALL_KEYS.map(k => [k, data[k].details])), p1Delayed: data.p1Delayed.details },
  };
  fs.writeFileSync(`history/${dateKey}.json`, JSON.stringify(histEntry));

  let histIndex = [];
  try { histIndex = JSON.parse(fs.readFileSync('history/index.json', 'utf8')); } catch {}
  if (!histIndex.includes(dateKey)) histIndex = [dateKey, ...histIndex].slice(0, 90);
  fs.writeFileSync('history/index.json', JSON.stringify(histIndex));
  console.log(`✓ history/${dateKey}.json saved (${histIndex.length} entries in index)`);

  // Push history files directly to GitHub API (bypasses workflow git add restriction)
  await pushHistoryToGitHub(dateKey, histEntry, histIndex);

  // Save updated task cache
  fs.writeFileSync('task_cache.json', JSON.stringify(taskCache));
  console.log(`✓ task_cache.json saved (${Object.keys(taskCache).length} entries; hits=${cacheHits} misses=${cacheMisses})`);

  fs.writeFileSync('index.html', buildHTML(data));
  console.log('✓ index.html written');

  fs.writeFileSync('debug.json', JSON.stringify({
    metrics: Object.fromEntries([...METRIC_KEYS,'completedMonth','completed112'].map(k => [k, data[k].total])),
    amActive, amOnHold,
    cacheStats: { total: Object.keys(taskCache).length, hits: cacheHits, misses: cacheMisses },
    doneProjectsCount: doneProjects.length,
    sampleMilestones: _debugSamples.milestones,
    sampleTasks: _debugSamples.tasks,
    ts: new Date().toISOString(),
  }, null, 2));
}

// ── Commit history files (CI: git-stage them; local: GitHub API push) ────────
async function pushHistoryToGitHub(dateKey, histEntry, histIndex) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Inside GitHub Actions: just stage the files — the workflow's git commit picks them up
    try {
      require('child_process').execSync('git add history/', { stdio: 'inherit' });
      console.log('  [history] staged history/ — workflow will commit it');
    } catch (e) {
      console.error('  [history] git add history/ failed:', e.message);
    }
    return;
  }

  // Outside CI: push via GitHub API for local testing / manual runs
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.log('  [history push] no GITHUB_TOKEN — skipping'); return; }

  const repo = 'ameerellwaa-rgb/Daily-Report';

  function ghGet(filePath) {
    return new Promise(resolve => {
      const opts = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${filePath}`,
        method: 'GET',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'daily-report-generator',
        },
      };
      https.get(opts, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });
  }

  function ghPut(filePath, contentStr, message, sha) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        message,
        content: Buffer.from(contentStr).toString('base64'),
        ...(sha ? { sha } : {}),
      });
      const opts = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${filePath}`,
        method: 'PUT',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'daily-report-generator',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(opts, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 200) }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function upsert(filePath, content, message) {
    const existing = await ghGet(filePath);
    const sha = existing && existing.sha ? existing.sha : null;
    const r = await ghPut(filePath, content, message, sha);
    if (r.status === 200 || r.status === 201) {
      console.log(`  [history push] ✓ ${filePath}`);
    } else {
      console.log(`  [history push] ✗ ${filePath} HTTP ${r.status}: ${r.body}`);
    }
  }

  try {
    await upsert(`history/${dateKey}.json`, JSON.stringify(histEntry), `history: ${dateKey}`);
    await upsert('history/index.json',       JSON.stringify(histIndex),  `history index: ${dateKey}`);
  } catch (e) {
    console.error('  [history push] error:', e.message);
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────
function buildHTML(d) {
  const dataForDownload = JSON.stringify(
    Object.fromEntries(
      ['p2','p3','recv','coll','licMonth','sijilSaudi','clientApproval',
       'overDue','sijilDelay','sijilAmer','amer','completedMonth','completed112','onHold']
      .map(k => [k, d[k].details])
    )
  ).replace(/<\/script>/gi, '<\\/script>')
   .replace(/[^\x00-\x7F]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  const p1DJson = JSON.stringify(d.p1Delayed.details)
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/[^\x00-\x7F]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  const fmtN = n => Math.round(n||0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const p1DelayedRows = d.p1Delayed.details.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:20px 0">لا توجد بيانات</td></tr>`
    : d.p1Delayed.details.map((item, i) =>
        `<tr><td style="color:var(--text-dim);width:36px">${i+1}</td><td style="text-align:right">${item.name}</td><td>${item.owner}</td><td>${item.paymentMethod}</td><td style="direction:ltr;font-variant-numeric:tabular-nums">${fmtN(item.first)}</td><td style="direction:ltr;font-variant-numeric:tabular-nums">${fmtN(item.tax)}</td><td style="direction:ltr;font-variant-numeric:tabular-nums;color:var(--red)">${fmtN(item.theRest)}</td></tr>`
      ).join('');

  // AM summary table rows
  const amRows = AM_ORDER.map(amEn => {
    const ar = AM_MAP[amEn];
    const ac = d.amData.active[amEn]  || 0;
    const oh = d.amData.onHold[amEn]  || 0;
    const p2 = d.p2.byManager[amEn]   || 0;
    const p3 = d.p3.byManager[amEn]   || 0;
    return `<tr id="am-row-${amEn.replace(/ /g,'_')}"><td class="am-name">${ar}</td><td><span class="badge b-green">${ac}</span></td><td><span class="badge b-gold">${oh}</span></td><td><span class="badge b-red">${p2}</span></td><td><span class="badge b-red">${p3}</span></td></tr>`;
  }).join('');

  const totActive = AM_ORDER.reduce((s,am) => s + (d.amData.active[am] || 0), 0);
  const totOnHold = AM_ORDER.reduce((s,am) => s + (d.amData.onHold[am] || 0), 0);
  const totP2     = AM_ORDER.reduce((s,am) => s + (d.p2.byManager[am]  || 0), 0);
  const totP3     = AM_ORDER.reduce((s,am) => s + (d.p3.byManager[am]  || 0), 0);

  // Detail section builder
  const DETAILS_DEF = [
    { key:'onHold',        label:'عملاء أون هولد',                                       color:'b-gold'  },
    { key:'p2',            label:'الدفعة الثانية المتأخرة',                              color:'b-red'   },
    { key:'p3',            label:'الدفعة الثالثة المتأخرة',                              color:'b-red'   },
    { key:'recv',          label:'استلام بيانات الترخيص',                                color:'b-teal'  },
    { key:'coll',          label:'جمع بيانات الترخيص',                                   color:'b-teal'  },
    { key:'licMonth',      label:'صدور الترخيص في الشهر',                                color:'b-gold'  },
    { key:'completedMonth',label:'العملاء المنتهون في الشهر',                             color:'b-green' },
    { key:'completed112',  label:'العملاء المنتهون شغل مصر فقط',                        color:'b-green' },
    { key:'sijilSaudi',    label:'تسليم السجل التجاري لقسم السعودية',                     color:'b-teal'  },
    { key:'clientApproval',label:'موافقة العميل على الأوفر فيو',                         color:'b-gold'  },
    { key:'overDue',       label:'التأخير في الأوفر فيو',                                color:'b-red'   },
    { key:'sijilDelay',    label:'تأخير تسليم السجل التجاري',                            color:'b-red'   },
    { key:'sijilAmer',     label:'السجل التجاري جاهز وعمل امريكا مفتوح',                color:'b-green' },
    { key:'amer',          label:'عمل شركة امريكا',                                      color:'b-green' },
  ];

  const detailSections = DETAILS_DEF.map(({ key, label, color }) => {
    const total   = d[key].total;
    const details = d[key].details || [];
    const tbodyRows = details.length === 0
      ? `<tr><td colspan="3" style="text-align:center;color:var(--text-dim);padding:20px 0">لا توجد بيانات</td></tr>`
      : details.map((item, i) =>
          `<tr><td style="color:var(--text-dim);width:36px">${i+1}</td><td style="text-align:right">${item.name}</td><td>${item.owner}</td></tr>`
        ).join('');
    return `
<div class="detail-block" id="detail-block-${key}">
  <div class="detail-head">
    <div style="display:flex;align-items:center;gap:10px">
      <span id="db-${key}" class="badge ${color}" style="font-size:14px;padding:4px 14px;min-width:38px">${total}</span>
      <h3 style="font-size:13px;font-weight:700;color:var(--text)">${label}</h3>
    </div>
    <button class="dl-btn" data-key="${key}" data-lbl="${label}" onclick="dlCSV(this.dataset.key,this.dataset.lbl)">⬇ Excel</button>
  </div>
  <div class="detail-scroll">
    <table>
      <thead><tr><th style="width:36px">#</th><th style="text-align:right">اسم المشروع</th><th>المسؤول</th></tr></thead>
      <tbody id="dtb-${key}">${tbodyRows}</tbody>
    </table>
  </div>
</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EL LWAA | التقرير اليومي</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#080F1A;--bg-card:#0C1827;
  --gold:#C9A961;--gold-muted:rgba(201,169,97,.11);--gold-border:rgba(201,169,97,.22);
  --teal:#0EA898;--teal-muted:rgba(14,168,152,.11);
  --red:#D94F4F;--red-muted:rgba(217,79,79,.11);
  --green:#2EAF80;--green-muted:rgba(46,175,128,.11);
  --text:#DDE5EE;--text-dim:#7A8FA6;--border:rgba(201,169,97,.18)
}
body{font-family:'Cairo','Segoe UI',Tahoma,Arial,sans-serif;background:var(--bg);color:var(--text);direction:rtl;min-height:100vh;padding:16px}
.header{display:flex;align-items:center;justify-content:space-between;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:16px 24px;margin-bottom:16px;position:relative;overflow:hidden;flex-wrap:wrap;gap:14px}
.header::after{content:'';position:absolute;bottom:0;right:0;left:0;height:2px;background:linear-gradient(90deg,transparent,var(--gold) 40%,transparent)}
.logo-group{display:flex;align-items:center;gap:14px}
.logo-emblem{width:48px;height:48px;background:linear-gradient(145deg,var(--gold),#8B6914);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 0 16px rgba(201,169,97,.3)}
.logo-text h1{font-size:18px;font-weight:900;color:var(--gold);letter-spacing:.06em;line-height:1.1}
.logo-text p{font-size:11px;color:var(--text-dim);margin-top:3px}
.header-meta{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.live-badge{display:flex;align-items:center;gap:7px;border:1px solid var(--gold-border);background:var(--gold-muted);color:var(--gold);padding:6px 13px;border-radius:24px;font-size:11px;font-weight:700}
.pulse-dot{width:6px;height:6px;background:var(--gold);border-radius:50%;animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
.update-time{font-size:11px;color:var(--text-dim);text-align:center}
.update-time strong{display:block;font-size:13px;color:var(--text);margin-bottom:2px}
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin-bottom:16px}
.kpi-card{background:var(--bg-card);border:1px solid var(--border);border-radius:13px;padding:18px 20px;position:relative;overflow:hidden;transition:transform .2s,box-shadow .2s;cursor:pointer}
.kpi-card:hover{transform:translateY(-3px);box-shadow:0 10px 28px rgba(0,0,0,.38)}
.kpi-card::before{content:'';position:absolute;top:0;right:0;left:0;height:3px;border-radius:13px 13px 0 0}
.c-red::before{background:var(--red)}.c-teal::before{background:var(--teal)}.c-gold::before{background:var(--gold)}.c-green::before{background:var(--green)}
.kpi-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px}
.kpi-label{font-size:12px;color:var(--text-dim);font-weight:600;line-height:1.5;max-width:120px}
.kpi-icon{width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.c-red .kpi-icon{background:var(--red-muted)}.c-teal .kpi-icon{background:var(--teal-muted)}.c-gold .kpi-icon{background:var(--gold-muted)}.c-green .kpi-icon{background:var(--green-muted)}
.kpi-value{font-size:48px;font-weight:900;line-height:1;font-variant-numeric:tabular-nums}
.c-red .kpi-value{color:var(--red)}.c-teal .kpi-value{color:var(--teal)}.c-gold .kpi-value{color:var(--gold)}.c-green .kpi-value{color:var(--green)}
.sec-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.sec-head h2{font-size:14px;font-weight:700;color:var(--gold);white-space:nowrap}
.sec-line{flex:1;height:1px;background:var(--border)}
.table-wrap{background:var(--bg-card);border:1px solid var(--border);border-radius:13px;overflow:hidden;margin-bottom:16px;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:420px}
thead tr{background:rgba(201,169,97,.08);border-bottom:1px solid var(--border)}
th{padding:11px 12px;font-size:11px;font-weight:700;color:var(--gold);text-align:center;white-space:nowrap;letter-spacing:.03em}
th:first-child{text-align:right;padding-right:18px}
td{padding:10px 12px;font-size:13px;text-align:center;border-bottom:1px solid rgba(201,169,97,.06)}
td:first-child{text-align:right;padding-right:18px}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:rgba(201,169,97,.04)}
.am-name{font-weight:700;font-size:14px}
.total-row td{background:rgba(201,169,97,.07)!important;border-top:1px solid var(--gold-border);border-bottom:none!important;font-weight:700;color:var(--gold)}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:30px;padding:3px 10px;border-radius:20px;font-weight:800;font-size:13px}
.b-red{background:var(--red-muted);color:var(--red)}.b-teal{background:var(--teal-muted);color:var(--teal)}.b-gold{background:var(--gold-muted);color:var(--gold)}.b-green{background:var(--green-muted);color:var(--green)}
.detail-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:16px}
.detail-block{background:var(--bg-card);border:1px solid var(--border);border-radius:13px;overflow:hidden;display:flex;flex-direction:column}
.detail-head{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid var(--border);flex-shrink:0}
.dl-btn{background:var(--gold-muted);border:1px solid var(--gold-border);color:var(--gold);padding:5px 12px;border-radius:8px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;transition:background .2s;white-space:nowrap}
.dl-btn:hover{background:rgba(201,169,97,.22)}
.detail-scroll{max-height:370px;overflow-y:auto}
.detail-scroll table{min-width:unset}
.detail-scroll thead tr{position:sticky;top:0;z-index:1}
footer{text-align:center;color:var(--text-dim);font-size:11px;padding:12px}
.hist-bar{display:flex;align-items:center;gap:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:8px 16px;margin-bottom:12px;flex-wrap:wrap}
.hist-btn{background:var(--gold-muted);border:1px solid var(--gold-border);color:var(--gold);width:30px;height:30px;border-radius:7px;font-size:16px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.hist-btn:hover{background:rgba(201,169,97,.22)}.hist-btn:disabled{opacity:.3;cursor:default}
.hist-label{font-size:13px;font-weight:700;color:var(--text);min-width:110px;text-align:center}
#hist-select{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 10px;border-radius:7px;font-family:inherit;font-size:12px;cursor:pointer;margin-right:auto}
.hist-tag{font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px}
.tag-live{background:var(--green-muted);color:var(--green)}.tag-past{background:var(--gold-muted);color:var(--gold)}
@media(max-width:900px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.detail-grid{grid-template-columns:1fr}}
@media(max-width:500px){.kpi-grid{grid-template-columns:1fr}}
.quality-btn{background:var(--teal-muted);border:1px solid rgba(14,168,152,.35);color:var(--teal);padding:7px 14px;border-radius:8px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;transition:background .2s;white-space:nowrap}
.quality-btn:hover{background:rgba(14,168,152,.2)}
.pw-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;align-items:center;justify-content:center}
.pw-overlay.open{display:flex}
.pw-box{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:32px;width:320px;text-align:center}
.pw-box h3{color:var(--teal);font-size:15px;font-weight:900;margin-bottom:6px}
.pw-box p{color:var(--text-dim);font-size:11px;margin-bottom:20px}
.pw-input{width:100%;background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:11px 14px;font-family:inherit;font-size:15px;text-align:center;letter-spacing:6px;margin-bottom:12px}
.pw-input:focus{border-color:var(--teal);outline:none}
.pw-err{color:var(--red);font-size:11px;margin-bottom:10px;min-height:16px}
.pw-ok{background:var(--teal);color:#000;border:none;padding:11px 28px;border-radius:8px;font-family:inherit;font-size:13px;font-weight:900;cursor:pointer;width:100%;margin-bottom:8px}
.pw-cancel{background:none;border:none;color:var(--text-dim);font-family:inherit;font-size:12px;cursor:pointer}
</style>
<script>
const _D   = ${dataForDownload};
const _M   = ${JSON.stringify(Object.fromEntries(
  ['p2','p3','recv','coll','licMonth','sijilSaudi','clientApproval','overDue','sijilDelay','sijilAmer','amer',
   'completedMonth','completed112','onHold'].map(k => [k, d[k].total])
))};
const _A   = ${JSON.stringify(d.amData)};
const _TODAY = '${d.dateKey}';
let   _Dcur = _D;
const _P1D = ${p1DJson};

const AM_ORDER_AR = ${JSON.stringify(AM_ORDER.map(e => ({ en: e, ar: AM_MAP[e] })))};

// ── CSV download ──────────────────────────────────────────────────────────────
function dlCSVP1(label) {
  const rows = _P1D;
  const bom  = String.fromCharCode(0xFEFF);
  const hdr  = 'اسم المشروع,المسؤول,طريقة الدفع,الدفعة الأولى,الضريبة,المتبقي\\n';
  const body = rows.map(r =>
    '"' + (r.name||'').replace(/"/g,'""') + '",' +
    '"' + (r.owner||'').replace(/"/g,'""') + '",' +
    '"' + (r.paymentMethod||'').replace(/"/g,'""') + '",' +
    (r.first||0) + ',' + (r.tax||0) + ',' + (r.theRest||0)
  ).join('\\n');
  const blob = new Blob([bom + hdr + body], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = label + '.csv';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function dlCSV(key, label) {
  const rows = _Dcur[key] || [];
  const bom  = String.fromCharCode(0xFEFF);
  const hdr  = 'اسم المشروع,المسؤول\\n';
  const body = rows.map(r =>
    '"' + (r.name||'').replace(/"/g,'""') + '","' + (r.owner||'').replace(/"/g,'""') + '"'
  ).join('\\n');
  const blob = new Blob([bom + hdr + body], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = label + '.csv';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Render functions ──────────────────────────────────────────────────────────
const KPI_KEYS = ['onHold','p2','p3','licMonth','completedMonth','completed112','overDue','sijilDelay','sijilAmer'];
const ALL_KEYS = ['p2','p3','recv','coll','licMonth','sijilSaudi','clientApproval','overDue','sijilDelay','sijilAmer','amer','completedMonth','completed112','onHold'];

function renderKPIs(metrics) {
  KPI_KEYS.forEach(k => {
    const el = document.getElementById('kv-' + k);
    if (el) el.textContent = metrics[k] ?? 0;
  });
}

function renderAM(amData) {
  AM_ORDER_AR.forEach(({ en, ar }) => {
    const row = document.getElementById('am-row-' + en.replace(/ /g,'_'));
    if (!row) return;
    const cells = row.querySelectorAll('td');
    if (cells.length < 5) return;
    cells[1].querySelector('.badge').textContent = amData.active[en] || 0;
    cells[2].querySelector('.badge').textContent = amData.onHold[en] || 0;
    // p2/p3 byManager not in history — show 0 if not available
    cells[3].querySelector('.badge').textContent = 0;
    cells[4].querySelector('.badge').textContent = 0;
  });
  // totals
  const totAc = AM_ORDER_AR.reduce((s,{en}) => s + (amData.active[en]||0), 0);
  const totOh = AM_ORDER_AR.reduce((s,{en}) => s + (amData.onHold[en]||0), 0);
  const tot = document.getElementById('am-totals');
  if (tot) {
    tot.children[1].querySelector('.badge').textContent = totAc;
    tot.children[2].querySelector('.badge').textContent = totOh;
    tot.children[3].querySelector('.badge').textContent = 0;
    tot.children[4].querySelector('.badge').textContent = 0;
  }
}

function renderDetails(metrics, details) {
  ALL_KEYS.forEach(k => {
    const badge = document.getElementById('db-' + k);
    if (badge) badge.textContent = metrics[k] ?? 0;
    const tbody = document.getElementById('dtb-' + k);
    if (!tbody) return;
    const rows = details[k] || [];
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-dim);padding:20px 0">لا توجد بيانات</td></tr>';
    } else {
      tbody.innerHTML = rows.map((r,i) =>
        '<tr><td style="color:var(--text-dim);width:36px">' + (i+1) + '</td>' +
        '<td style="text-align:right">' + (r.name||'') + '</td>' +
        '<td>' + (r.owner||'') + '</td></tr>'
      ).join('');
    }
  });
}

// ── P1 Delayed render ─────────────────────────────────────────────────────────
function renderP1Delayed(details, total) {
  const badge = document.getElementById('db-p1Delayed');
  if (badge) badge.textContent = total ?? 0;
  const kv = document.getElementById('kv-p1Delayed');
  if (kv) kv.textContent = total ?? 0;
  const tbody = document.getElementById('dtb-p1Delayed');
  if (!tbody) return;
  const rows = details || [];
  const fmtN = n => Math.round(n||0).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:20px 0">لا توجد بيانات</td></tr>';
  } else {
    tbody.innerHTML = rows.map((r,i) =>
      '<tr>' +
      '<td style="color:var(--text-dim);width:36px">' + (i+1) + '</td>' +
      '<td style="text-align:right">' + (r.name||'') + '</td>' +
      '<td>' + (r.owner||'') + '</td>' +
      '<td>' + (r.paymentMethod||'') + '</td>' +
      '<td style="direction:ltr;font-variant-numeric:tabular-nums">' + fmtN(r.first) + '</td>' +
      '<td style="direction:ltr;font-variant-numeric:tabular-nums">' + fmtN(r.tax) + '</td>' +
      '<td style="direction:ltr;font-variant-numeric:tabular-nums;color:var(--red)">' + fmtN(r.theRest) + '</td>' +
      '</tr>'
    ).join('');
  }
}

// ── History navigation ────────────────────────────────────────────────────────
let _histIndex = [];
let _histPos   = -1; // -1 = today

async function initHistory() {
  try {
    const r = await fetch('history/index.json');
    _histIndex = await r.json();
    const sel = document.getElementById('hist-select');
    if (sel) sel.innerHTML =
      '<option value="-1">اليوم</option>' +
      _histIndex
        .map((d,i) => ({ d, i }))
        .filter(({ d }) => d !== _TODAY)
        .map(({ d, i }) => '<option value="' + i + '">' + d + '</option>')
        .join('');
  } catch {}
  updateHistNav();
}

function updateHistNav() {
  const lbl = document.getElementById('hist-label');
  const tag = document.getElementById('hist-tag');
  const sel = document.getElementById('hist-select');
  const btnP = document.getElementById('hist-prev');
  const btnN = document.getElementById('hist-next');
  if (_histPos === -1) {
    if (lbl) lbl.textContent = _TODAY;
    if (tag) { tag.textContent = 'مباشر'; tag.className = 'hist-tag tag-live'; }
    if (sel) sel.value = '-1';
    if (btnN) btnN.disabled = true;
  } else {
    if (lbl) lbl.textContent = _histIndex[_histPos] || '';
    if (tag) { tag.textContent = 'تاريخي'; tag.className = 'hist-tag tag-past'; }
    if (sel) sel.value = String(_histPos);
    if (btnN) btnN.disabled = _histPos <= 0;
  }
  if (btnP) btnP.disabled = _histPos >= _histIndex.length - 1;
}

async function loadHistPos(pos) {
  _histPos = pos;
  if (pos === -1) {
    _Dcur = _D;
    renderKPIs(_M); renderAM(_A); renderDetails(_M, _D);
    renderP1Delayed(_P1D, _P1D.length);
    document.getElementById('upd-at').textContent = '${d.updatedAt}';
    updateHistNav(); return;
  }
  const dateStr = _histIndex[pos];
  if (!dateStr) return;
  try {
    const r = await fetch('history/' + dateStr + '.json');
    const h = await r.json();
    _Dcur = h.details || {};
    renderKPIs(h.metrics || {}); renderAM(h.amData || {active:{},onHold:{}}); renderDetails(h.metrics || {}, h.details || {});
    renderP1Delayed((h.details || {}).p1Delayed, (h.metrics || {}).p1Delayed);
    document.getElementById('upd-at').textContent = h.updatedAt || dateStr;
  } catch { console.error('failed to load history', dateStr); }
  updateHistNav();
}

function histNav(dir) { loadHistPos(Math.max(-1, Math.min(_histIndex.length - 1, _histPos + dir))); }
function histSelect(v) { loadHistPos(parseInt(v)); }

// ── Quality section ───────────────────────────────────────────────────────────
function checkPW() {
  const pw = document.getElementById('pw-input').value;
  if (pw === 'amir1230') {
    sessionStorage.setItem('qa_auth', 'ok');
    window.open('quality.html', '_blank');
    closePW();
  } else {
    const err = document.getElementById('pw-err');
    err.textContent = 'كلمة المرور غلط ❌';
    document.getElementById('pw-input').value = '';
    document.getElementById('pw-input').focus();
    setTimeout(() => { err.textContent = ''; }, 2500);
  }
}
function closePW() {
  document.getElementById('pw-overlay').classList.remove('open');
  document.getElementById('pw-input').value = '';
  document.getElementById('pw-err').textContent = '';
}

function scrollToDetail(key) {
  const el = document.getElementById('detail-block-' + key);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

window.addEventListener('DOMContentLoaded', initHistory);
</script>
</head>
<body>

<header class="header">
  <div class="logo-group">
    <div class="logo-emblem">⚖️</div>
    <div class="logo-text">
      <h1>EL LWAA LAW FIRM</h1>
      <p>التقرير اليومي — متابعة المشاريع</p>
    </div>
  </div>
  <div class="header-meta">
    <div class="live-badge"><span class="pulse-dot"></span>Zoho Projects Live</div>
    <button class="quality-btn" onclick="document.getElementById('pw-overlay').classList.add('open');document.getElementById('pw-input').focus()">🎯 قسم Quality</button>
    <div class="update-time"><strong>آخر تحديث</strong><span id="upd-at">${d.updatedAt}</span></div>
  </div>
</header>

<div class="pw-overlay" id="pw-overlay" onclick="if(event.target===this)closePW()">
  <div class="pw-box">
    <h3>🎯 قسم الجودة والمتابعة</h3>
    <p>أدخل كلمة المرور للدخول</p>
    <input type="password" class="pw-input" id="pw-input" placeholder="••••••••" onkeydown="if(event.key==='Enter')checkPW()">
    <div class="pw-err" id="pw-err"></div>
    <button class="pw-ok" onclick="checkPW()">دخول</button>
    <button class="pw-cancel" onclick="closePW()">إلغاء</button>
  </div>
</div>

<div class="hist-bar">
  <button class="hist-btn" id="hist-prev" onclick="histNav(1)" title="يوم سابق">◀</button>
  <span class="hist-label" id="hist-label">${d.dateKey}</span>
  <button class="hist-btn" id="hist-next" onclick="histNav(-1)" title="يوم تالٍ" disabled>▶</button>
  <span class="hist-tag tag-live" id="hist-tag">مباشر</span>
  <select id="hist-select" onchange="histSelect(this.value)"><option value="-1">اليوم</option></select>
</div>

<div class="kpi-grid">
  <div class="kpi-card c-red" style="grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:16px 28px" onclick="scrollToDetail('p1Delayed')">
    <div style="display:flex;align-items:center;gap:16px">
      <div class="kpi-icon">💳</div>
      <span style="font-size:15px;font-weight:700;color:var(--text)">الدفعة الأولى المتأخرة</span>
    </div>
    <div class="kpi-value" id="kv-p1Delayed" style="font-size:56px">${d.p1Delayed.total}</div>
  </div>
  <div class="kpi-card c-gold" onclick="scrollToDetail('onHold')">
    <div class="kpi-top"><div class="kpi-label">عملاء أون هولد</div><div class="kpi-icon">⏸️</div></div>
    <div class="kpi-value" id="kv-onHold">${d.onHold.total}</div>
  </div>
  <div class="kpi-card c-red" onclick="scrollToDetail('p2')">
    <div class="kpi-top"><div class="kpi-label">الدفعة الثانية المتأخرة</div><div class="kpi-icon">💰</div></div>
    <div class="kpi-value" id="kv-p2">${d.p2.total}</div>
  </div>
  <div class="kpi-card c-red" onclick="scrollToDetail('p3')">
    <div class="kpi-top"><div class="kpi-label">الدفعة الثالثة المتأخرة</div><div class="kpi-icon">💸</div></div>
    <div class="kpi-value" id="kv-p3">${d.p3.total}</div>
  </div>

  <div class="kpi-card c-gold" onclick="scrollToDetail('licMonth')">
    <div class="kpi-top"><div class="kpi-label">صدور الترخيص في الشهر</div><div class="kpi-icon">📜</div></div>
    <div class="kpi-value" id="kv-licMonth">${d.licMonth.total}</div>
  </div>
  <div class="kpi-card c-green" onclick="scrollToDetail('completedMonth')">
    <div class="kpi-top"><div class="kpi-label">العملاء المنتهون في الشهر</div><div class="kpi-icon">✅</div></div>
    <div class="kpi-value" id="kv-completedMonth">${d.completedMonth.total}</div>
  </div>
  <div class="kpi-card c-green" onclick="scrollToDetail('completed112')">
    <div class="kpi-top"><div class="kpi-label">المنتهون شغل مصر فقط</div><div class="kpi-icon">🇪🇬</div></div>
    <div class="kpi-value" id="kv-completed112">${d.completed112.total}</div>
  </div>

  <div class="kpi-card c-red" onclick="scrollToDetail('overDue')">
    <div class="kpi-top"><div class="kpi-label">التأخير في الأوفر فيو</div><div class="kpi-icon">⏰</div></div>
    <div class="kpi-value" id="kv-overDue">${d.overDue.total}</div>
  </div>
  <div class="kpi-card c-red" onclick="scrollToDetail('sijilDelay')">
    <div class="kpi-top"><div class="kpi-label">تأخير تسليم السجل التجاري</div><div class="kpi-icon">🗂️</div></div>
    <div class="kpi-value" id="kv-sijilDelay">${d.sijilDelay.total}</div>
  </div>
  <div class="kpi-card c-green" onclick="scrollToDetail('sijilAmer')">
    <div class="kpi-top"><div class="kpi-label">السجل جاهز وامريكا مفتوحة</div><div class="kpi-icon">🌐</div></div>
    <div class="kpi-value" id="kv-sijilAmer">${d.sijilAmer.total}</div>
  </div>
</div>

<div class="sec-head"><h2>ملخص</h2><div class="sec-line"></div></div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>المسؤول</th>
        <th>عملاء نشطين</th>
        <th>أون هولد</th>
        <th>دفعة 2 متأخرة</th>
        <th>دفعة 3 متأخرة</th>
      </tr>
    </thead>
    <tbody>
      ${amRows}
      <tr class="total-row" id="am-totals">
        <td>الإجمالي</td>
        <td><span class="badge b-green">${totActive}</span></td>
        <td><span class="badge b-gold">${totOnHold}</span></td>
        <td><span class="badge b-red">${totP2}</span></td>
        <td><span class="badge b-red">${totP3}</span></td>
      </tr>
    </tbody>
  </table>
</div>

<div class="sec-head"><h2>التفاصيل والتصدير</h2><div class="sec-line"></div></div>
<div class="detail-grid">
<div class="detail-block" id="detail-block-p1Delayed" style="grid-column:1/-1">
  <div class="detail-head">
    <div style="display:flex;align-items:center;gap:10px">
      <span id="db-p1Delayed" class="badge b-red" style="font-size:14px;padding:4px 14px;min-width:38px">${d.p1Delayed.total}</span>
      <h3 style="font-size:13px;font-weight:700;color:var(--text)">الدفعة الأولى المتأخرة</h3>
    </div>
    <button class="dl-btn" onclick="dlCSVP1('الدفعة الأولى المتأخرة')">⬇ Excel</button>
  </div>
  <div class="detail-scroll" style="max-height:420px">
    <table>
      <thead><tr>
        <th style="width:36px">#</th>
        <th style="text-align:right">اسم المشروع</th>
        <th>المسؤول</th>
        <th>طريقة الدفع</th>
        <th>الدفعة الأولى</th>
        <th>الضريبة</th>
        <th style="color:var(--red)">المتبقي</th>
      </tr></thead>
      <tbody id="dtb-p1Delayed">${p1DelayedRows}</tbody>
    </table>
  </div>
</div>
${detailSections}
</div>

<footer>EL LWAA LAW FIRM © 2025 | جميع الحقوق محفوظة</footer>
</body>
</html>`;
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
