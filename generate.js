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

// ── Rate-limit-aware request wrapper ─────────────────────────────────────────
let reqCount = 0;
let windowStart = Date.now();

async function zohoGet(token, path) {
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

// ── Project list (v2 returns all ~892 projects incl. Completed) ───────────────
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
  const tc  = project.task_count || {};
  const hasTasks = (tc.open || 0) + (tc.closed || 0) > 0;

  const msRes = await zohoGet(token, `/portal/${PORTAL_ID}/projects/${pid}/milestones/`);
  const milestones = msRes.milestones || [];

  if (_debugSamples.milestones.length < 3) {
    const d = milestones.find(m => m.name && m.name.includes('دفعة'));
    if (d) _debugSamples.milestones.push(d);
  }

  let tasks = [];
  if (hasTasks) {
    const tasksRes = await zohoGet(token, `/portal/${PORTAL_ID}/projects/${pid}/tasks/?status=all`);
    tasks = tasksRes.tasks || [];
    if (_debugSamples.tasks.length < 2 && tasks.length > 0) {
      _debugSamples.tasks.push(tasks[0]);
    }
  }

  return { tasks, milestones };
}

// ── Condition helpers ─────────────────────────────────────────────────────────
const msStatus   = m => (m.status || '').toLowerCase();
const isOpen     = t => (t.status?.name || '').toLowerCase() === 'open';
const isFinished = t => (t.status?.name || '').toLowerCase() === 'finished';
const isOverdue  = t => isOpen(t) && t.end_date_long && t.end_date_long < Date.now();

function isThisMonth(t, now) {
  if (!t.completed_time_long) return false;
  const d = new Date(t.completed_time_long);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

const findTask     = (tasks, name, pred)   => tasks.some(t => t.name === name && pred(t));
const findTaskLike = (tasks, substr, pred) => tasks.some(t => (t.name || '').includes(substr) && pred(t));

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const token    = await getAccessToken();
  const projects = await getAllProjects(token);

  // Build owner and name maps (all projects, including Completed)
  const ownerMap = {};
  const nameMap  = {};
  for (const p of projects) {
    const owner = (p.owner && p.owner.name) || p.owner_name || '';
    ownerMap[p.id_string] = EXCLUDE.has(owner) ? '' : owner;
    nameMap[p.id_string]  = p.name || p.id_string;
  }

  // Load project_ids.json (active_only, on_hold, completed_this_month, completed_this_month_112)
  const ids = JSON.parse(fs.readFileSync('project_ids.json', 'utf8'));
  const activeOnlySet = new Set(ids.active_only);
  const onHoldSet     = new Set(ids.on_hold);

  const activeOnlyProjects = projects.filter(p => activeOnlySet.has(p.id_string));
  console.log(`✓ active_only: ${activeOnlyProjects.length}  on_hold: ${onHoldSet.size}`);

  // Count Active / OnHold per AM for the AM summary table
  const amActive = {};
  const amOnHold = {};
  for (const p of projects) {
    const owner = ownerMap[p.id_string];
    if (!owner || !AM_MAP[owner]) continue;
    if (activeOnlySet.has(p.id_string))  amActive[owner] = (amActive[owner] || 0) + 1;
    else if (onHoldSet.has(p.id_string)) amOnHold[owner] = (amOnHold[owner] || 0) + 1;
  }

  // Metric buckets — all Active-only
  const B = {
    p2:{}, p3:{}, recv:{}, coll:{},
    licMonth:{}, sijilSaudi:{}, clientApproval:{}, overDue:{},
    sijilDelay:{}, sijilAmer:{}, amer:{},
  };

  const now = new Date();
  let processed = 0;

  for (const project of activeOnlyProjects) {
    const pid   = project.id_string;
    const owner = ownerMap[pid];

    const { tasks, milestones } = await getProjectData(token, project);

    const licDone       = findTask(tasks,     'صدور الترخيص',                    isFinished);
    const licThisMonth  = findTask(tasks,     'صدور الترخيص',                    t => isFinished(t) && isThisMonth(t, now));
    const recvOpen      = findTask(tasks,     'استلام بيانات الترخيص',            isOpen);
    const collOpen      = findTask(tasks,     'جمع بيانات الترخيص',               isOpen);
    const approvalOpen  = findTask(tasks,     'موافقة العميل على الاوفر فيو',     isOpen);
    const amerOpen      = findTaskLike(tasks, 'عمل شركة  امريكا',                 isOpen);  // double space
    const sijilDone     = findTaskLike(tasks, 'تسليم نسخه من السجل التجارى',      isFinished);
    const sijilOvr      = findTaskLike(tasks, 'تسليم نسخه من السجل التجارى',      isOverdue);
    const overviewOvr   = findTaskLike(tasks, 'عمل الاوفر فيو',                   isOverdue);

    const m2 = milestones.find(m => m.name === 'الدفعة الثانية');
    const m3 = milestones.find(m => m.name === 'الدفعة الثالثة');

    if (licDone && m2 && msStatus(m2) !== 'completed')                         B.p2[pid]            = owner;
    if (m2 && msStatus(m2) === 'completed' && m3 && msStatus(m3) !== 'completed') B.p3[pid]         = owner;
    if (recvOpen)                                                               B.recv[pid]          = owner;
    if (collOpen && recvOpen)                                                   B.coll[pid]          = owner;
    if (licThisMonth)                                                           B.licMonth[pid]      = owner;
    if (sijilDone)                                                              B.sijilSaudi[pid]    = owner;
    if (approvalOpen)                                                           B.clientApproval[pid]= owner;
    if (overviewOvr)                                                            B.overDue[pid]       = owner;
    if (sijilOvr)                                                               B.sijilDelay[pid]    = owner;
    if (sijilDone && amerOpen)                                                  B.sijilAmer[pid]     = owner;
    if (amerOpen)                                                               B.amer[pid]          = owner;

    processed++;
    if (processed % 50 === 0) console.log(`  ${processed} / ${activeOnlyProjects.length} processed`);
  }

  console.log(`✓ ${processed} projects analyzed`);

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
    completedMonth: { total: ids.completed_this_month.length,    details: makeCompletedDetails(ids.completed_this_month) },
    completed112:   { total: ids.completed_this_month_112.length, details: makeCompletedDetails(ids.completed_this_month_112) },
    amData: { active: amActive, onHold: amOnHold },
    updatedAt: new Date().toLocaleString('ar-EG', {
      timeZone:'Africa/Cairo', weekday:'long', year:'numeric',
      month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'
    }),
    month: ids.month || new Date().toISOString().slice(0,7),
  };

  console.log('\nFinal metrics:');
  for (const k of [...METRIC_KEYS, 'completedMonth', 'completed112']) {
    console.log(`  ${k}: ${data[k].total}`);
  }
  console.log('  AM Active:', amActive);
  console.log('  AM OnHold:', amOnHold);

  fs.writeFileSync('index.html', buildHTML(data));
  console.log('✓ index.html written');

  fs.writeFileSync('debug.json', JSON.stringify({
    metrics: Object.fromEntries([...METRIC_KEYS,'completedMonth','completed112'].map(k => [k, data[k].total])),
    amActive, amOnHold,
    sampleMilestones: _debugSamples.milestones,
    sampleTasks: _debugSamples.tasks,
    ts: new Date().toISOString(),
  }, null, 2));
}

// ── HTML ──────────────────────────────────────────────────────────────────────
function buildHTML(d) {
  // Embed details data for client-side Excel download
  const dataForDownload = JSON.stringify(
    Object.fromEntries(
      ['p2','p3','recv','coll','licMonth','sijilSaudi','clientApproval',
       'overDue','sijilDelay','sijilAmer','amer','completedMonth','completed112']
      .map(k => [k, d[k].details])
    )
  );

  // AM summary table rows
  const amRows = AM_ORDER.map(amEn => {
    const ar = AM_MAP[amEn];
    const ac = d.amData.active[amEn]  || 0;
    const oh = d.amData.onHold[amEn]  || 0;
    const p2 = d.p2.byManager[amEn]   || 0;
    const p3 = d.p3.byManager[amEn]   || 0;
    return `<tr>
      <td class="am-name">${ar}</td>
      <td><span class="badge b-green">${ac}</span></td>
      <td><span class="badge b-gold">${oh}</span></td>
      <td><span class="badge b-red">${p2}</span></td>
      <td><span class="badge b-red">${p3}</span></td>
    </tr>`;
  }).join('');

  const totActive = AM_ORDER.reduce((s,am) => s + (d.amData.active[am] || 0), 0);
  const totOnHold = AM_ORDER.reduce((s,am) => s + (d.amData.onHold[am] || 0), 0);
  const totP2     = AM_ORDER.reduce((s,am) => s + (d.p2.byManager[am]  || 0), 0);
  const totP3     = AM_ORDER.reduce((s,am) => s + (d.p3.byManager[am]  || 0), 0);

  // Detail section builder
  const DETAILS_DEF = [
    { key:'p2',            label:'الدفعة الثانية المتأخرة',                              color:'b-red'   },
    { key:'p3',            label:'الدفعة الثالثة المتأخرة',                              color:'b-red'   },
    { key:'recv',          label:'استلام بيانات الترخيص',                                 color:'b-teal'  },
    { key:'coll',          label:'جمع بيانات الترخيص',                                    color:'b-teal'  },
    { key:'licMonth',      label:'صدور الترخيص في الشهر',                                 color:'b-gold'  },
    { key:'completedMonth',label:'العملاء المنتهون في الشهر',                              color:'b-green' },
    { key:'completed112',  label:'العملاء المنتهون شغل مصر فقط',                         color:'b-green' },
    { key:'sijilSaudi',    label:'تسليم السجل التجاري لقسم السعودية',                      color:'b-teal'  },
    { key:'clientApproval',label:'موافقة العميل على الأوفر فيو',                          color:'b-gold'  },
    { key:'overDue',       label:'التأخير في الأوفر فيو',                                 color:'b-red'   },
    { key:'sijilDelay',    label:'تأخير تسليم السجل التجاري',                             color:'b-red'   },
    { key:'sijilAmer',     label:'الفرق بين تسليم السجل التجاري وعمل شركة امريكا',      color:'b-green' },
    { key:'amer',          label:'عمل شركة امريكا',                                       color:'b-green' },
  ];

  const detailSections = DETAILS_DEF.map(({ key, label, color }) => {
    const total = d[key].total;
    const details = d[key].details || [];
    const tbodyRows = details.length === 0
      ? `<tr><td colspan="3" style="text-align:center;color:var(--text-dim);padding:20px 0">لا توجد بيانات</td></tr>`
      : details.map((item, i) =>
          `<tr><td style="color:var(--text-dim)">${i+1}</td><td style="text-align:right">${item.name}</td><td>${item.owner}</td></tr>`
        ).join('');

    return `
<div class="detail-block">
  <div class="detail-head">
    <div style="display:flex;align-items:center;gap:10px">
      <span class="badge ${color}" style="font-size:14px;padding:4px 16px;min-width:40px">${total}</span>
      <h3 style="font-size:14px;font-weight:700;color:var(--text)">${label}</h3>
    </div>
    <button class="dl-btn" onclick="dlCSV('${key}','${label.replace(/'/g,"\\'")}')">⬇ Excel</button>
  </div>
  <div class="table-wrap" style="margin-bottom:0">
    <table>
      <thead><tr><th style="width:40px">#</th><th style="text-align:right">اسم المشروع</th><th>الأكونت مانجر</th></tr></thead>
      <tbody>${tbodyRows}</tbody>
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

/* Header */
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

/* KPI Cards */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin-bottom:16px}
.kpi-card{background:var(--bg-card);border:1px solid var(--border);border-radius:13px;padding:16px 18px;position:relative;overflow:hidden;transition:transform .2s,box-shadow .2s;cursor:default}
.kpi-card:hover{transform:translateY(-3px);box-shadow:0 10px 28px rgba(0,0,0,.38)}
.kpi-card::before{content:'';position:absolute;top:0;right:0;left:0;height:3px;border-radius:13px 13px 0 0}
.c-red::before{background:var(--red)}.c-teal::before{background:var(--teal)}.c-gold::before{background:var(--gold)}.c-green::before{background:var(--green)}
.kpi-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px}
.kpi-label{font-size:11px;color:var(--text-dim);font-weight:600;line-height:1.5;max-width:100px}
.kpi-icon{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.c-red .kpi-icon{background:var(--red-muted)}.c-teal .kpi-icon{background:var(--teal-muted)}.c-gold .kpi-icon{background:var(--gold-muted)}.c-green .kpi-icon{background:var(--green-muted)}
.kpi-value{font-size:44px;font-weight:900;line-height:1;font-variant-numeric:tabular-nums}
.c-red .kpi-value{color:var(--red)}.c-teal .kpi-value{color:var(--teal)}.c-gold .kpi-value{color:var(--gold)}.c-green .kpi-value{color:var(--green)}
.kpi-foot{font-size:10px;color:var(--text-dim);margin-top:5px}

/* Section headings */
.sec-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.sec-head h2{font-size:14px;font-weight:700;color:var(--gold);white-space:nowrap}
.sec-line{flex:1;height:1px;background:var(--border)}

/* Tables */
.table-wrap{background:var(--bg-card);border:1px solid var(--border);border-radius:13px;overflow:hidden;margin-bottom:16px;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:500px}
thead tr{background:rgba(201,169,97,.07);border-bottom:1px solid var(--border)}
th{padding:11px 12px;font-size:11px;font-weight:700;color:var(--gold);text-align:center;white-space:nowrap;letter-spacing:.03em}
th:first-child{text-align:right;padding-right:18px}
td{padding:10px 12px;font-size:13px;text-align:center;border-bottom:1px solid rgba(201,169,97,.06);font-variant-numeric:tabular-nums}
td:first-child{text-align:right;padding-right:18px}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:rgba(201,169,97,.04)}
.am-name{font-weight:700;font-size:14px}
.total-row td{background:rgba(201,169,97,.07)!important;border-top:1px solid var(--gold-border);border-bottom:none!important;font-weight:700;color:var(--gold)}

/* Badges */
.badge{display:inline-flex;align-items:center;justify-content:center;min-width:30px;padding:3px 10px;border-radius:20px;font-weight:800;font-size:13px}
.b-red{background:var(--red-muted);color:var(--red)}.b-teal{background:var(--teal-muted);color:var(--teal)}.b-gold{background:var(--gold-muted);color:var(--gold)}.b-green{background:var(--green-muted);color:var(--green)}

/* Detail sections */
.detail-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:16px}
.detail-block{background:var(--bg-card);border:1px solid var(--border);border-radius:13px;overflow:hidden}
.detail-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border)}
.dl-btn{background:var(--gold-muted);border:1px solid var(--gold-border);color:var(--gold);padding:5px 13px;border-radius:8px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;transition:background .2s;white-space:nowrap}
.dl-btn:hover{background:rgba(201,169,97,.22)}
.detail-block .table-wrap{border:none;border-radius:0;margin-bottom:0}

footer{text-align:center;color:var(--text-dim);font-size:11px;padding:12px}

@media(max-width:1100px){.kpi-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:780px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.detail-grid{grid-template-columns:1fr}}
@media(max-width:480px){.kpi-grid{grid-template-columns:1fr}}
</style>
<script>
const _D = ${dataForDownload};
function dlCSV(key, label) {
  const rows = _D[key] || [];
  const bom  = '﻿';
  const hdr  = 'اسم المشروع,الأكونت مانجر\n';
  const body = rows.map(r =>
    '"' + (r.name||'').replace(/"/g,'""') + '","' + (r.owner||'').replace(/"/g,'""') + '"'
  ).join('\n');
  const blob = new Blob([bom + hdr + body], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = label + '.csv';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
</script>
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

<!-- KPI Cards -->
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
    <div class="kpi-top"><div class="kpi-label">صدور الترخيص في الشهر</div><div class="kpi-icon">📜</div></div>
    <div class="kpi-value">${d.licMonth.total}</div>
    <div class="kpi-foot">ترخيص صدر هذا الشهر</div>
  </div>
  <div class="kpi-card c-green">
    <div class="kpi-top"><div class="kpi-label">العملاء المنتهون في الشهر</div><div class="kpi-icon">✅</div></div>
    <div class="kpi-value">${d.completedMonth.total}</div>
    <div class="kpi-foot">عميل أُنجز هذا الشهر</div>
  </div>
  <div class="kpi-card c-green">
    <div class="kpi-top"><div class="kpi-label">المنتهون شغل مصر فقط</div><div class="kpi-icon">🇪🇬</div></div>
    <div class="kpi-value">${d.completed112.total}</div>
    <div class="kpi-foot">عميل مصري منتهي هذا الشهر</div>
  </div>
  <div class="kpi-card c-teal">
    <div class="kpi-top"><div class="kpi-label">تسليم السجل لقسم السعودية</div><div class="kpi-icon">📤</div></div>
    <div class="kpi-value">${d.sijilSaudi.total}</div>
    <div class="kpi-foot">سجل سُلِّم لقسم السعودية</div>
  </div>

  <div class="kpi-card c-gold">
    <div class="kpi-top"><div class="kpi-label">موافقة العميل على الأوفر فيو</div><div class="kpi-icon">📄</div></div>
    <div class="kpi-value">${d.clientApproval.total}</div>
    <div class="kpi-foot">ينتظر موافقة العميل</div>
  </div>
  <div class="kpi-card c-red">
    <div class="kpi-top"><div class="kpi-label">التأخير في الأوفر فيو</div><div class="kpi-icon">⏰</div></div>
    <div class="kpi-value">${d.overDue.total}</div>
    <div class="kpi-foot">أوفر فيو متأخر</div>
  </div>
  <div class="kpi-card c-red">
    <div class="kpi-top"><div class="kpi-label">تأخير تسليم السجل التجاري</div><div class="kpi-icon">🗂️</div></div>
    <div class="kpi-value">${d.sijilDelay.total}</div>
    <div class="kpi-foot">سجل تجاري متأخر</div>
  </div>
  <div class="kpi-card c-green">
    <div class="kpi-top"><div class="kpi-label">السجل جاهز وامريكا مفتوحة</div><div class="kpi-icon">🌐</div></div>
    <div class="kpi-value">${d.sijilAmer.total}</div>
    <div class="kpi-foot">تسليم السجل ✓ — امريكا ○</div>
  </div>
  <div class="kpi-card c-green" style="grid-column:span 2">
    <div class="kpi-top"><div class="kpi-label">عمل شركة امريكا</div><div class="kpi-icon">🇺🇸</div></div>
    <div class="kpi-value">${d.amer.total}</div>
    <div class="kpi-foot">مشروع قيد التنفيذ</div>
  </div>
</div>

<!-- AM Summary Table -->
<div class="sec-head"><h2>ملخص الأكونت مانجرز</h2><div class="sec-line"></div></div>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>الأكونت مانجر</th>
        <th>عملاء نشطين</th>
        <th>عملاء أون هولد</th>
        <th>دفعة 2 متأخرة</th>
        <th>دفعة 3 متأخرة</th>
      </tr>
    </thead>
    <tbody>
      ${amRows}
      <tr class="total-row">
        <td>الإجمالي</td>
        <td><span class="badge b-green">${totActive}</span></td>
        <td><span class="badge b-gold">${totOnHold}</span></td>
        <td><span class="badge b-red">${totP2}</span></td>
        <td><span class="badge b-red">${totP3}</span></td>
      </tr>
    </tbody>
  </table>
</div>

<!-- Detail Tables -->
<div class="sec-head"><h2>التفاصيل والتصدير</h2><div class="sec-line"></div></div>
<div class="detail-grid">
${detailSections}
</div>

<footer>EL LWAA LAW FIRM © 2025 | جميع الحقوق محفوظة</footer>
</body>
</html>`;
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
