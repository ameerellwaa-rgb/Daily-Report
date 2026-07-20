#!/usr/bin/env node
const https = require('https');
const fs    = require('fs');

const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const PORTAL_ID     = '896030705';

const AM_MAP = {
  'Esraa Ellwaa':    'إسراء',
  'Jenna Ellwaa':    'جنة',
  'fatema ellwaa':   'فاطمة',
  'pola ellwaa':     'بولا',
  'Habiba Ellwaa':   'حبيبة',
  'sherouk ellwaa':  'شروق',
  'Youssef Mellwaa': 'يوسف',
  'Aya Ellwaa':      'آية',
  'roya ellwaa':     'رويا',
  'Mostafa Ellwaa':  'مصطفى',
};
const AM_ORDER = ['Esraa Ellwaa','Jenna Ellwaa','fatema ellwaa','pola ellwaa','Habiba Ellwaa','sherouk ellwaa','Youssef Mellwaa','Aya Ellwaa','roya ellwaa','Mostafa Ellwaa'];
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

// ── Rate-limit-aware request wrapper ─────────────────────────────────────────
let reqCount = 0;
let windowStart = Date.now();

async function zohoGet(token, path) {
  // Proactive rate limiting: stay under 85 calls per 2-minute window
  const now = Date.now();
  const elapsed = now - windowStart;
  if (elapsed >= 120000) {
    reqCount = 0;
    windowStart = Date.now();
  }
  if (reqCount >= 85) {
    const wait = 120000 - elapsed + 3000;
    console.log(`  [rate limit] ${reqCount} calls in ${Math.round(elapsed/1000)}s — waiting ${Math.round(wait/1000)}s`);
    await new Promise(r => setTimeout(r, wait));
    reqCount = 0;
    windowStart = Date.now();
  }
  reqCount++;
  return httpGet(
    `https://projectsapi.zoho.com/restapi${path}`,
    { Authorization: `Zoho-oauthtoken ${token}` }
  ).catch(e => { console.error('GET error:', path, e.message); return {}; });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getAccessToken() {
  const url = `https://accounts.zoho.com/oauth/v2/token?grant_type=refresh_token&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&refresh_token=${REFRESH_TOKEN}`;
  const data = await httpPost(url);
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  console.log('✓ Access token obtained');
  return data.access_token;
}

// ── Project list (v2, no status filter = Active + On Hold) ───────────────────
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

// ── Per-project data ──────────────────────────────────────────────────────────
const _debugSamples = { milestones: [], tasks: [] };

async function getProjectData(token, project) {
  const pid = project.id_string;
  const openTaskCount = (project.task_count && project.task_count.open) || 0;

  const msRes = await zohoGet(token, `/portal/${PORTAL_ID}/projects/${pid}/milestones/`);
  const milestones = msRes.milestones || [];

  if (_debugSamples.milestones.length < 5) {
    const dafaa = milestones.find(m => m.name && m.name.includes('دفعة'));
    if (dafaa) _debugSamples.milestones.push(dafaa);
  }

  let tasks = [];
  if (openTaskCount > 0) {
    const tasksRes = await zohoGet(token, `/portal/${PORTAL_ID}/projects/${pid}/tasks/?status=all`);
    tasks = tasksRes.tasks || [];
    if (_debugSamples.tasks.length < 3 && tasks.length > 0) {
      _debugSamples.tasks.push(tasks[0]);
    }
  }

  return { tasks, milestones };
}

// ── Condition helpers ─────────────────────────────────────────────────────────
const st = t => (t.status?.name || t.status || '').toLowerCase();
const ms = m => (m.status || '').toLowerCase();

function hasTask(tasks, name, status) {
  return tasks.some(t => t.name === name && st(t) === status);
}
function hasTaskLike(tasks, substr, status) {
  return tasks.some(t => (t.name || '').includes(substr) && st(t) === status);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const token    = await getAccessToken();
  const projects = await getAllProjects(token);

  // Build owner map
  const ownerMap = Object.fromEntries(projects.map(p => {
    const name = (p.owner && p.owner.name) || p.owner_name || '';
    return [p.id_string, EXCLUDE.has(name) ? '' : name];
  }));

  // Filter to Active + On Hold projects only using project_ids.json
  const activeIds = new Set(JSON.parse(fs.readFileSync('project_ids.json', 'utf8')).active);
  const activeProjects = projects.filter(p => activeIds.has(p.id_string));
  console.log(`✓ Filtered to ${activeProjects.length} active/on-hold projects (from ${projects.length} total)`);

  // Log first v2 project status fields (for future optimization)
  if (projects.length > 0) {
    const p0 = projects[0];
    console.log(`  v2 project[0] status fields: status=${JSON.stringify(p0.status)}, is_complete=${p0.is_complete}, project_percent=${p0.project_percent}`);
  }

  const buckets = { p2:{}, p3:{}, recv:{}, coll:{}, over:{}, amer:{} };
  let processed = 0;

  for (const project of activeProjects) {
    const pid   = project.id_string;
    const owner = ownerMap[pid];

    const { tasks, milestones } = await getProjectData(token, project);

    const licDone   = hasTask(tasks,     'صدور الترخيص',                   'finished');
    const recvOpen  = hasTask(tasks,     'استلام بيانات الترخيص',           'open');
    const collOpen  = hasTask(tasks,     'جمع بيانات الترخيص',              'open');
    const overOpen  = hasTask(tasks,     'موافقة العميل على الاوفر فيو',    'open');
    const sijilOpen = hasTaskLike(tasks, 'تسليم نسخة من السجل التجارى',     'open');
    const amerOpen  = hasTaskLike(tasks, 'عمل شركة  امريكا',                'open'); // مسافتان

    const m2 = milestones.find(m => m.name === 'الدفعة الثانية');
    const m3 = milestones.find(m => m.name === 'الدفعة الثالثة');

    if (licDone && m2 && ms(m2) !== 'completed')                        buckets.p2[pid]   = owner;
    if (m2 && ms(m2) === 'completed' && m3 && ms(m3) !== 'completed')  buckets.p3[pid]   = owner;
    if (recvOpen)                                                        buckets.recv[pid] = owner;
    if (collOpen && recvOpen)                                            buckets.coll[pid] = owner;
    if (overOpen && !sijilOpen)                                          buckets.over[pid] = owner;
    if (amerOpen)                                                        buckets.amer[pid] = owner;

    processed++;
    if (processed % 50 === 0) console.log(`  ${processed} / ${activeProjects.length} processed`);
  }

  console.log(`✓ ${processed} projects analyzed`);

  function summarize(bucket) {
    const byManager = {};
    for (const owner of Object.values(bucket)) {
      if (AM_MAP[owner]) byManager[owner] = (byManager[owner] || 0) + 1;
    }
    return { total: Object.keys(bucket).length, byManager };
  }

  const data = {
    p2:   summarize(buckets.p2),
    p3:   summarize(buckets.p3),
    recv: summarize(buckets.recv),
    coll: summarize(buckets.coll),
    over: summarize(buckets.over),
    amer: summarize(buckets.amer),
    updatedAt: new Date().toLocaleString('ar-EG', {
      timeZone:'Africa/Cairo', weekday:'long', year:'numeric',
      month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'
    }),
  };

  console.log('\nFinal metrics:');
  for (const [k, v] of Object.entries(data)) {
    if (v && v.total !== undefined) console.log(`  ${k}: ${v.total}`);
  }

  fs.writeFileSync('index.html', buildHTML(data));
  console.log('✓ index.html written');

  // Write debug sample for inspection
  fs.writeFileSync('debug.json', JSON.stringify({
    metrics: { p2: data.p2.total, p3: data.p3.total, recv: data.recv.total, coll: data.coll.total, over: data.over.total, amer: data.amer.total },
    sampleMilestones: _debugSamples.milestones,
    sampleTasks: _debugSamples.tasks,
    ts: new Date().toISOString(),
  }, null, 2));
}

// ── HTML ──────────────────────────────────────────────────────────────────────
function buildHTML(d) {
  const METRICS = ['p2','p3','recv','coll','over','amer'];
  const BADGE   = { p2:'b-red', p3:'b-red', recv:'b-teal', coll:'b-teal', over:'b-gold', amer:'b-green' };

  const totals = Object.fromEntries(METRICS.map(m => [m, 0]));
  let rows = '';
  for (const amEn of AM_ORDER) {
    rows += `<tr><td>${AM_MAP[amEn]}</td>`;
    for (const m of METRICS) {
      const v = d[m].byManager?.[amEn] || 0;
      totals[m] += v;
      rows += `<td><span class="badge ${BADGE[m]}">${v}</span></td>`;
    }
    rows += '</tr>';
  }
  rows += `<tr class="total-row"><td>الإجمالي</td>`;
  for (const m of METRICS) rows += `<td><span class="badge ${BADGE[m]}">${totals[m]}</span></td>`;
  rows += '</tr>';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EL LWAA | التقرير اليومي</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#080F1A;--bg-card:#0C1827;--gold:#C9A961;--gold-muted:rgba(201,169,97,.11);--gold-border:rgba(201,169,97,.22);--teal-bright:#0EA898;--teal-muted:rgba(14,168,152,.11);--red:#D94F4F;--red-muted:rgba(217,79,79,.11);--green:#2EAF80;--green-muted:rgba(46,175,128,.11);--text:#DDE5EE;--text-dim:#7A8FA6;--border:rgba(201,169,97,.18)}
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
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.kpi-card{background:var(--bg-card);border:1px solid var(--border);border-radius:13px;padding:18px 20px;position:relative;overflow:hidden;transition:transform .2s,box-shadow .2s}
.kpi-card:hover{transform:translateY(-3px);box-shadow:0 10px 28px rgba(0,0,0,.38)}
.kpi-card::before{content:'';position:absolute;top:0;right:0;left:0;height:3px;border-radius:13px 13px 0 0}
.c-red::before{background:var(--red)}.c-teal::before{background:var(--teal-bright)}.c-gold::before{background:var(--gold)}.c-green::before{background:var(--green)}
.kpi-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px}
.kpi-label{font-size:12px;color:var(--text-dim);font-weight:600;line-height:1.4;max-width:110px}
.kpi-icon{width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px}
.c-red .kpi-icon{background:var(--red-muted)}.c-teal .kpi-icon{background:var(--teal-muted)}.c-gold .kpi-icon{background:var(--gold-muted)}.c-green .kpi-icon{background:var(--green-muted)}
.kpi-value{font-size:48px;font-weight:900;line-height:1;font-variant-numeric:tabular-nums}
.c-red .kpi-value{color:var(--red)}.c-teal .kpi-value{color:var(--teal-bright)}.c-gold .kpi-value{color:var(--gold)}.c-green .kpi-value{color:var(--green)}
.kpi-foot{font-size:11px;color:var(--text-dim);margin-top:5px}
.sec-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.sec-head h2{font-size:14px;font-weight:700;color:var(--gold);white-space:nowrap}
.sec-line{flex:1;height:1px;background:var(--border)}
.table-wrap{background:var(--bg-card);border:1px solid var(--border);border-radius:13px;overflow:hidden;margin-bottom:16px;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:700px}
thead tr{background:rgba(201,169,97,.07);border-bottom:1px solid var(--border)}
th{padding:12px 13px;font-size:11px;font-weight:700;color:var(--gold);text-align:center;white-space:nowrap;letter-spacing:.03em}
th:first-child{text-align:right;padding-right:20px}
td{padding:11px 13px;font-size:14px;text-align:center;border-bottom:1px solid rgba(201,169,97,.07);font-variant-numeric:tabular-nums}
td:first-child{text-align:right;padding-right:20px;font-weight:700;font-size:15px}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:rgba(201,169,97,.04)}
.total-row{background:rgba(201,169,97,.07)!important;border-top:1px solid var(--gold-border)!important}
.total-row td{border-bottom:none!important}
.total-row td:first-child{color:var(--gold);font-size:14px}
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:32px;padding:3px 10px;border-radius:20px;font-weight:800;font-size:14px}
.b-red{background:var(--red-muted);color:var(--red)}.b-teal{background:var(--teal-muted);color:var(--teal-bright)}.b-gold{background:var(--gold-muted);color:var(--gold)}.b-green{background:var(--green-muted);color:var(--green)}
.iframe-wrap{background:var(--bg-card);border:1px solid var(--border);border-radius:13px;overflow:hidden;margin-bottom:16px}
.iframe-bar{padding:12px 18px;border-bottom:1px solid var(--border)}
.iframe-bar span{font-size:13px;font-weight:700;color:var(--gold)}
iframe{display:block;width:100%;height:700px;border:none;background:#fff}
footer{text-align:center;color:var(--text-dim);font-size:11px;padding:12px}
@media(max-width:860px){.kpi-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:520px){.kpi-grid{grid-template-columns:1fr}}
</style>
</head>
<body>

<header class="header">
  <div class="logo-group">
    <div class="logo-emblem">⚖️</div>
    <div class="logo-text">
      <h1>EL LWAA LAW FIRM</h1>
      <p>التقرير اليومي — لوحة متابعة الأكونت مانجرز</p>
    </div>
  </div>
  <div class="header-meta">
    <div class="live-badge"><span class="pulse-dot"></span>Zoho Projects Live</div>
    <div class="update-time">
      <strong>آخر تحديث</strong>
      ${d.updatedAt}
    </div>
  </div>
</header>

<div class="kpi-grid">
  <div class="kpi-card c-red">
    <div class="kpi-top"><div class="kpi-label">الدفعة الثانية المتأخرة</div><div class="kpi-icon">💰</div></div>
    <div class="kpi-value">${d.p2.total}</div>
    <div class="kpi-foot">عميل متأخر في الدفع</div>
  </div>
  <div class="kpi-card c-red">
    <div class="kpi-top"><div class="kpi-label">الدفعة الثالثة المتأخرة</div><div class="kpi-icon">💸</div></div>
    <div class="kpi-value">${d.p3.total}</div>
    <div class="kpi-foot">عميل متأخر في الدفع</div>
  </div>
  <div class="kpi-card c-teal">
    <div class="kpi-top"><div class="kpi-label">استلام بيانات الترخيص</div><div class="kpi-icon">📋</div></div>
    <div class="kpi-value">${d.recv.total}</div>
    <div class="kpi-foot">مشروع ينتظر البيانات</div>
  </div>
  <div class="kpi-card c-teal">
    <div class="kpi-top"><div class="kpi-label">جمع بيانات الترخيص</div><div class="kpi-icon">📂</div></div>
    <div class="kpi-value">${d.coll.total}</div>
    <div class="kpi-foot">مشروع قيد الجمع</div>
  </div>
  <div class="kpi-card c-gold">
    <div class="kpi-top"><div class="kpi-label">فرق تسليم الأوفر فيو</div><div class="kpi-icon">📄</div></div>
    <div class="kpi-value">${d.over.total}</div>
    <div class="kpi-foot">مشروع يحتاج متابعة</div>
  </div>
  <div class="kpi-card c-green">
    <div class="kpi-top"><div class="kpi-label">عمل شركة امريكا</div><div class="kpi-icon">🌐</div></div>
    <div class="kpi-value">${d.amer.total}</div>
    <div class="kpi-foot">مشروع قيد التنفيذ</div>
  </div>
</div>

<div class="sec-head"><h2>متابعة الأكونت مانجرز</h2><div class="sec-line"></div></div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>الأكونت مانجر</th>
        <th>الدفعة الثانية المتأخرة</th>
        <th>الدفعة الثالثة المتأخرة</th>
        <th>استلام بيانات الترخيص</th>
        <th>جمع بيانات الترخيص</th>
        <th>فرق الأوفر فيو</th>
        <th>عمل شركة امريكا</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<div class="sec-head"><h2>الداشبورد الكامل من Zoho Analytics</h2><div class="sec-line"></div></div>
<div class="iframe-wrap">
  <div class="iframe-bar"><span>📊 تقارير Zoho Analytics</span></div>
  <iframe src="https://analytics.zoho.com/open-view/3307863000000015085" allowfullscreen loading="lazy"></iframe>
</div>

<footer>EL LWAA LAW FIRM © 2025 | جميع الحقوق محفوظة</footer>
</body>
</html>`;
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
