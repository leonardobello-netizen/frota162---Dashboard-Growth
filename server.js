'use strict';

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3002;
const HS_TOKEN = process.env.HUBSPOT_TOKEN;
const MB_URL = process.env.METABASE_URL;
const MB_KEY = process.env.METABASE_API_KEY;
const DASH_USER = process.env.DASH_USER;
const DASH_PASS = process.env.DASH_PASS;

// ── Sessões em memória ─────────────────────────────────────────
const SESSIONS = new Map(); // token -> expiresAt
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 horas

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(token, Date.now() + SESSION_TTL);
  return token;
}

function isValidSession(token) {
  if (!token || !SESSIONS.has(token)) return false;
  if (Date.now() > SESSIONS.get(token)) { SESSIONS.delete(token); return false; }
  return true;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

// Middleware de autenticação — bloqueia tudo exceto /login e /logout
function requireAuth(req, res, next) {
  if (req.path === '/login' || req.path === '/logout') return next();
  const token = getCookie(req, 'dash_session');
  if (isValidSession(token)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  res.redirect('/login');
}

const CACHE_DIR = path.join(__dirname, 'data', 'cache');

// Garante que o diretório de cache existe (necessário no Railway que parte do zero)
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch (_) {}

const MEM_CACHE = {};
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h (D-1 data only changes once per day)

// Clear MEM_CACHE on startup to ensure fresh data with latest code
if (process.env.NODE_ENV !== 'test') {
  Object.keys(MEM_CACHE).forEach(key => delete MEM_CACHE[key]);
}

// ── HubSpot IDs ───────────────────────────────────────────────
const SUB_ORIGEM_META   = 'Midia-Paga-Meta-Ads';
const SUB_ORIGEM_GOOGLE = 'Midia-Paga-Google-Ads';
const PIPELINE_PRE_VENDAS = '691581102';
const PIPELINE_SALES = 'default';
const STAGE_REUNIAO = '1012021273';

// ── Helpers ───────────────────────────────────────────────────
function diskCachePath(key) {
  return path.join(CACHE_DIR, key.replace(/[^a-z0-9]/gi, '_') + '.json');
}

function readDiskCache(key) {
  try {
    const p = diskCachePath(key);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() - raw.ts < CACHE_TTL) return raw.data;
    return raw.data; // stale-while-revalidate: return stale, refresh async
  } catch (_) { return null; }
}

function writeDiskCache(key, data) {
  try {
    fs.writeFileSync(diskCachePath(key), JSON.stringify({ ts: Date.now(), data }));
  } catch (_) {}
}

async function withCache(key, fn) {
  if (MEM_CACHE[key] && Date.now() - MEM_CACHE[key].ts < CACHE_TTL) {
    console.log(`[cache] HIT mem: ${key}`);
    return MEM_CACHE[key].data;
  }
  const disk = readDiskCache(key);
  if (disk !== null) {
    console.log(`[cache] HIT disk (stale): ${key}, refreshing in background`);
    // refresh in background
    fn().then(d => { MEM_CACHE[key] = { ts: Date.now(), data: d }; writeDiskCache(key, d); }).catch(() => {});
    return disk;
  }
  console.log(`[cache] MISS: ${key}, fetching fresh data`);
  const data = await fn();
  MEM_CACHE[key] = { ts: Date.now(), data };
  writeDiskCache(key, data);
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function hsSearch(objectType, body, allResults = []) {
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/search`;
  let delay = 2000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const https = require('https');
      const agent = new https.Agent({ rejectUnauthorized: false });
      const res = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 60000, // 60 second timeout for large requests
        httpAgent: agent,
        httpsAgent: agent
      });
      return res.data;
    } catch (e) {
      if (e.response && e.response.status === 429) {
        await sleep(delay);
        delay *= 2;
      } else {
        if (e.response) {
          console.error('HubSpot 400 body:', JSON.stringify(e.response.data));
          console.error('HubSpot 400 request body:', JSON.stringify(body));
        }
        console.error(`[hsSearch] Error on attempt ${attempt + 1}:`, e.message);
        throw e;
      }
    }
  }
  throw new Error('HubSpot rate limit exceeded');
}

async function hsSearchAll(objectType, body) {
  const results = [];
  let after = undefined;
  do {
    const payload = after ? { ...body, after } : body;
    const res = await hsSearch(objectType, payload);
    results.push(...(res.results || []));
    after = res.paging && res.paging.next ? res.paging.next.after : undefined;
    // HubSpot Search API hard-caps at 10,000 results total (after >= 10000 causes 400)
    if (after && parseInt(after) >= 10000) break;
  } while (after);
  return results;
}

// ── Metabase query helper ─────────────────────────────────────
async function metabaseQuery(sql) {
  const agent = new https.Agent({ rejectUnauthorized: false });
  const h = { headers: { 'x-api-key': MB_KEY, 'Content-Type': 'application/json' }, httpsAgent: agent, timeout: 60000 };
  const res = await axios.post(MB_URL + '/api/dataset', {
    database: 2,
    type: 'native',
    native: { query: sql }
  }, h);
  return { cols: res.data.data?.cols?.map(c => c.name) || [], rows: res.data.data?.rows || [] };
}

async function loadGoogleCampaignsFromMetabase(fromDate, toDate) {
  // Returns array of {date, cost_brl, campaign_name} for spend by day and campaign
  const sql = `
    SELECT
      CAST(date AS DATE) as date,
      cost_brl,
      campaign_name
    FROM data_analytics.google_campaigns
    WHERE date >= TIMESTAMP '${toYMD(fromDate)} 00:00:00'
      AND date <= TIMESTAMP '${toYMD(toDate)} 23:59:59'
    ORDER BY date DESC
  `;
  try {
    const res = await metabaseQuery(sql);
    return res.rows.map(r => ({ date: r[0], cost_brl: parseFloat(r[1]) || 0, campaign_name: r[2] }));
  } catch (e) {
    console.error('[loadGoogleCampaignsFromMetabase] Error:', e.message);
    return [];
  }
}

function toYMD(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function getYesterdayDate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return startOfDay(yesterday);
}

// ── /api/p1 ───────────────────────────────────────────────────
async function buildP1() {
  try {
    console.log('[buildP1] STARTING - About to calculate MM7Leads and MM7MQL');
    const now = new Date();
    const today = getYesterdayDate(); // D-1: yesterday
    const d7ago = addDays(today, -7);
  const d30ago = addDays(today, -30);
  const d35ago = addDays(today, -35);
  const d60ago = addDays(today, -60);
  const d90ago = addDays(today, -90);

  // Dynamic monthly comparison: 01-today(current month) vs 01-sameday(previous month) [Opção B]
  const currentDay = today.getDate();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthStartPrev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  // Handle months with different days (e.g., February has 28/29, others have 31)
  const lastMonthMaxDay = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
  const lastMonthDay = Math.min(currentDay, lastMonthMaxDay);
  const datePrev = new Date(monthStartPrev.getFullYear(), monthStartPrev.getMonth(), lastMonthDay);

  // ── Todas as queries em PARALELO — reduz ~3min → ~40s ────────
  console.log('[buildP1] Iniciando 7 queries em paralelo...');
  const [
    allDealsRes,
    mqlDealsRes,
    contactsRaw,
    googleCampaigns,
    reunioesRaw,
    reunioesPrevRes,
    campaignsAgg
  ] = await Promise.all([
    // 1. Todos os deals 30d (leads + driva detection)
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
        { propertyName: 'createdate', operator: 'GTE', value: String(d30ago.getTime()) },
        { propertyName: 'createdate', operator: 'LTE', value: String(today.getTime()) }
      ]}],
      properties: ['createdate', 'dealname', 'sub_origem', 'dealstage']
    }),
    // 2. MQL 30d (Meta Ads)
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
        { propertyName: 'sub_origem', operator: 'EQ',  value: SUB_ORIGEM_META },
        { propertyName: 'createdate', operator: 'GTE', value: String(d30ago.getTime()) },
        { propertyName: 'createdate', operator: 'LTE', value: String(today.getTime()) }
      ]}],
      properties: ['createdate', 'sub_origem']
    }),
    // 3. Frota 90d — Google Ads apenas
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'sub_origem',  operator: 'EQ',  value: SUB_ORIGEM_GOOGLE },
        { propertyName: 'createdate', operator: 'GTE', value: String(d90ago.getTime()) }
      ]}],
      properties: ['createdate', 'dealname', 'qual_a_quantidade_de_veiculos_na_suas_frota_']
    }).catch(e => { console.error('[buildP1] frota erro:', e.message); return []; }),
    // 4. Spend Metabase (por dia, para gráficos de custo)
    loadGoogleCampaignsFromMetabase(d90ago, today).catch(e => { console.error('[buildP1] spend erro:', e.message); return []; }),
    // 5. Reuniões 7D
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
        { propertyName: 'dealstage',  operator: 'EQ',  value: STAGE_REUNIAO },
        { propertyName: 'createdate', operator: 'GTE', value: String(d7ago.getTime()) },
        { propertyName: 'createdate', operator: 'LTE', value: String(today.getTime()) }
      ]}],
      properties: ['createdate']
    }),
    // 6. Reuniões mês anterior
    hsSearch('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
        { propertyName: 'dealstage',  operator: 'EQ',  value: STAGE_REUNIAO },
        { propertyName: 'createdate', operator: 'GTE', value: String(monthStartPrev.getTime()) },
        { propertyName: 'createdate', operator: 'LTE', value: String(addDays(datePrev, 1).getTime()) }
      ]}],
      properties: ['createdate'],
      limit: 100
    }),
    // 7. Campanhas agregadas (30d) — com conversões e clicks do Metabase
    metabaseQuery(`
      SELECT campaign_name,
             SUM(cost_brl)    AS spend,
             SUM(conversions) AS conversions,
             SUM(clicks)      AS clicks
      FROM data_analytics.google_campaigns
      WHERE date >= date_add('day', -30, current_date)
      GROUP BY campaign_name
      ORDER BY spend DESC
    `).catch(e => { console.error('[buildP1] campaignsAgg erro:', e.message); return null; })
  ]);
  console.log(`[buildP1] ✅ Paralelo concluído — leads:${allDealsRes.length} mql:${mqlDealsRes.length} frota:${contactsRaw.length} googleRows:${googleCampaigns.length} reunioes:${reunioesRaw.length} campaignsAgg:${campaignsAgg?.rows?.length ?? 'erro'}`);

  const mqlDealsRaw = mqlDealsRes || [];

  // Build daily maps
  const dailyLeads = {};     // date -> count (Google Ads deals)
  const dailyMQL = {};       // date -> count (Meta Ads deals, for KPI)
  const dailyGoogleMQL = {}; // date -> count (Google Ads + stage Reunião, for chart)
  const dailySpend = {};     // date -> spend

  // D-1 cutoff date
  const yesterday = toYMD(today);

  // LEADS (7D) = All deals created in 7D window
  const leadsDealsRaw = allDealsRes || [];
  console.log(`[P1] Leads Deals (todos pipeline): ${leadsDealsRaw.length} | Filtro KPI: sub_origem=${SUB_ORIGEM_GOOGLE} | Period: ${toYMD(d30ago)} to ${toYMD(today)}`);

  leadsDealsRaw.forEach(d => {
    const dt = toYMD(new Date(d.properties.createdate));
    if (!dt || dt > yesterday) return;
    const subOrigem = d.properties.sub_origem || '';
    // Leads = sub_origem Google Ads
    if (subOrigem === SUB_ORIGEM_GOOGLE) {
      dailyLeads[dt] = (dailyLeads[dt] || 0) + 1;
      // Google Ads qualificados (stage Reunião) para barra verde do gráfico de volume
      if (d.properties.dealstage === STAGE_REUNIAO) {
        dailyGoogleMQL[dt] = (dailyGoogleMQL[dt] || 0) + 1;
      }
    }
  });

  // MQL (7D) = Deals with sub_origem = "Midia-Paga-Google-Ads" created in 7D
  console.log(`[P1] MQL Deals fetched: ${mqlDealsRes.length} | Filter: pipeline=${PIPELINE_PRE_VENDAS} + sub_origem="${SUB_ORIGEM_META}" | Period: ${toYMD(d7ago)} to ${toYMD(today)}`);
  mqlDealsRes.forEach(d => {
    const dt = toYMD(new Date(d.properties.createdate));
    if (dt && dt <= yesterday) {
      dailyMQL[dt] = (dailyMQL[dt] || 0) + 1;
    }
  });

  console.log(`[P1] LEADS distribution:`, JSON.stringify(dailyLeads));
  console.log(`[P1] MQL distribution:`, JSON.stringify(dailyMQL));

  // Load spend from Metabase Google Campaigns (D-1 cutoff)
  googleCampaigns.forEach(row => {
    const dt = typeof row.date === 'string' ? row.date.split('T')[0] : toYMD(row.date);
    if (!dt || dt > yesterday) return; // Skip data from D+1 onwards
    dailySpend[dt] = (dailySpend[dt] || 0) + row.cost_brl;
  });

  // KPI 7d current
  function sumRange(map, from, to, label) {
    let s = 0;
    const cur = new Date(from);
    const dates = [];
    while (cur < to) {
      const ym = toYMD(cur);
      const val = map[ym] || 0;
      if (val > 0 || dates.length < 3) dates.push(`${ym}:${val}`);
      s += val;
      cur.setDate(cur.getDate() + 1);
    }
    if (label) console.log(`[sumRange] ${label}: total=${s}, dates=${dates.join(',')}, map keys=${Object.keys(map).length}`);
    return s;
  }

  // MTD: do início do mês até D-1
  const leadsMTD  = sumRange(dailyLeads, monthStart,     addDays(today, 1), 'Leads(MTD)');
  const mqlMTD    = sumRange(dailyMQL,   monthStart,     addDays(today, 1), 'MQL(MTD)');
  const spendMTD  = sumRange(dailySpend, monthStart,     addDays(today, 1));
  // LMTD: mesmo período do mês anterior
  const leadsPrev = sumRange(dailyLeads, monthStartPrev, addDays(datePrev, 1));
  const mqlPrev   = sumRange(dailyMQL,   monthStartPrev, addDays(datePrev, 1));
  const spendPrev = sumRange(dailySpend, monthStartPrev, addDays(datePrev, 1));

  function pct(cur, prev) {
    if (!prev) return null;
    return Math.round(((cur - prev) / prev) * 100);
  }

  const costPerLead7d = leadsMTD ? spendMTD / leadsMTD : 0;
  const costPerMQL7d = mqlMTD ? spendMTD / mqlMTD : 0;
  const costPerLeadPrev = leadsPrev ? spendPrev / leadsPrev : 0;
  const costPerMQLPrev = mqlPrev ? spendPrev / mqlPrev : 0;

  const reuniao7d = reunioesRaw.length;
  const reunioesPrevRaw = (reunioesPrevRes && reunioesPrevRes.results) ? reunioesPrevRes.results : (Array.isArray(reunioesPrevRes) ? reunioesPrevRes : []);
  const reuniaoPrev = reunioesPrevRaw.length;
  console.log(`[P1] Reuniões — 7D: ${reuniao7d} | anterior: ${reuniaoPrev}`);

  // --- KPIs ---
  console.log(`[P1] Final KPI values: leadsMTD=${leadsMTD}, mqlMTD=${mqlMTD}, leadsPrev=${leadsPrev}, mqlPrev=${mqlPrev}`);
  const kpis = [
    { label: 'Leads', value: leadsMTD, delta: pct(leadsMTD, leadsPrev), format: 'number' },
    { label: 'MQL', value: mqlMTD, delta: pct(mqlMTD, mqlPrev), format: 'number' },
    { label: 'Reunião', value: reuniao7d, delta: pct(reuniao7d, reuniaoPrev), format: 'number' },
    { label: 'Investimento', value: spendMTD, delta: pct(spendMTD, spendPrev), format: 'currency' },
    { label: 'Custo/Lead', value: costPerLead7d, delta: pct(costPerLead7d, costPerLeadPrev), format: 'currency', invertDelta: true },
    { label: 'Custo/MQL', value: costPerMQL7d, delta: pct(costPerMQL7d, costPerMQLPrev), format: 'currency', invertDelta: true }
  ];

  // --- Gráfico 1: Leads e MQL diários últimos 30d ---
  const g1Labels = [];
  const g1Leads = [];
  const g1MQL = [];
  const g1MM7Leads = []; // rolling 7d average of Leads
  const g1MM7MQL = []; // rolling 7d average of MQL
  for (let i = 29; i >= 0; i--) {
    const d = toYMD(addDays(today, -i));
    g1Labels.push(d);
    g1Leads.push(dailyLeads[d] || 0);
    g1MQL.push(dailyGoogleMQL[d] || 0);
  }

  // Calculate 7-day moving averages for both Leads and MQL
  console.log(`[buildP1] Starting MM7 calculation: g1Labels.length=${g1Labels.length}, g1Leads.length=${g1Leads.length}, g1MQL.length=${g1MQL.length}`);
  for (let i = 0; i < g1Labels.length; i++) {
    const leadsSlice = g1Leads.slice(Math.max(0, i - 6), i + 1);
    const mqlSlice = g1MQL.slice(Math.max(0, i - 6), i + 1);

    const leadsAvg = leadsSlice.reduce((a, b) => a + b, 0) / leadsSlice.length;
    const mqlAvg = mqlSlice.reduce((a, b) => a + b, 0) / mqlSlice.length;

    g1MM7Leads.push(Math.round(leadsAvg * 10) / 10);
    g1MM7MQL.push(Math.round(mqlAvg * 10) / 10);
  }
  console.log(`[buildP1] MM7 calculated: g1MM7Leads.length=${g1MM7Leads.length}, g1MM7MQL.length=${g1MM7MQL.length}`);

  // --- Gráfico 2: Qualidade frota ---
  // Labels exatos conforme HubSpot (campo: "Qual a quantidade de placas na sua Frota?")
  const faixas = ['1-5 placas', '6-10 placas', '11-20 placas', '21-40 placas', '41-80 placas',
                  '81-150 placas', '151-300 placas', '301-600 placas', '601-1.200 placas', '+1.200 placas', 'Não informado'];

  const FROTA_MAP = {
    'de 1 a 5 veículos':      '1-5 placas',
    'de 6 a 10 veículos':     '6-10 placas',
    'de 11 a 20 veículos':    '11-20 placas',
    'de 21 a 40 veículos':    '21-40 placas',
    'de 41 a 80 veículos':    '41-80 placas',
    'de 81 a 150 veículos':   '81-150 placas',
    'de 151 a 300 veículos':  '151-300 placas',
    'de 301 a 600 veículos':  '301-600 placas',
    'de 601 a 1.200 veículos':'601-1.200 placas',
    'acima de 1200 veículos': '+1.200 placas',
    'não tenho frota':        'Não informado',
  };

  function frotaFaixa(val) {
    if (!val) return 'Não informado';
    const key = val.toLowerCase().trim();
    return FROTA_MAP[key] || 'Não informado';
  }

  function frotaCounts(contacts) {
    const counts = {};
    faixas.forEach(f => counts[f] = 0);
    const frotaDistribution = {};

    // Debug: log sample contact properties to find correct field name
    if (contacts.length > 0) {
      const sample = contacts[0];
      console.log(`[buildP1] Sample contact properties keys:`, Object.keys(sample.properties || {}));
      console.log(`[buildP1] Sample contact full object:`, JSON.stringify(sample).substring(0, 500));
    }

    contacts.forEach(c => {
      // Get frota from the correct HubSpot field
      const v = c.properties.qual_a_quantidade_de_veiculos_na_sua_frota_;

      const faixa = frotaFaixa(v);
      counts[faixa]++;
      frotaDistribution[v || 'undefined'] = (frotaDistribution[v || 'undefined'] || 0) + 1;
    });
    if (contacts.length > 0) {
      console.log(`[buildP1] Frota distribution by value: ${JSON.stringify(frotaDistribution)}`);
      console.log(`[buildP1] Frota distribution by range: ${JSON.stringify(counts)}`);
    }
    return faixas.map(f => counts[f]);
  }

  const contacts30 = contactsRaw.filter(c => new Date(new Date(c.properties.createdate).getTime()) >= d30ago);
  const contacts60 = contactsRaw.filter(c => new Date(new Date(c.properties.createdate).getTime()) >= d60ago);
  const contacts90 = contactsRaw;

  console.log(`[buildP1] Frota distribution - Total: ${contactsRaw.length}, 30D: ${contacts30.length}, 60D: ${contacts60.length}, 90D: ${contacts90.length}`);

  // Log frota values for debugging
  const frotaValues30 = contacts30.map(c => c.properties.qual_a_quantidade_de_veiculos_na_sua_frota_).filter(v => v);
  const frotaValues60 = contacts60.map(c => c.properties.qual_a_quantidade_de_veiculos_na_sua_frota_).filter(v => v);
  const frotaValues90 = contacts90.map(c => c.properties.qual_a_quantidade_de_veiculos_na_sua_frota_).filter(v => v);

  console.log(`[buildP1] Frota values with data - 30D: ${frotaValues30.length}, 60D: ${frotaValues60.length}, 90D: ${frotaValues90.length}`);
  if (frotaValues30.length > 0) console.log(`[buildP1] Sample frota values (30D):`, frotaValues30.slice(0, 5));

  const g2 = {
    labels: faixas,
    d30: frotaCounts(contacts30),
    d60: frotaCounts(contacts60),
    d90: frotaCounts(contacts90)
  };

  // --- Gráfico 3: Custo/MQL rolling 7d ---
  const g3Labels = [];
  const g3CostMQL = [];
  for (let i = 29; i >= 0; i--) {
    const endD = addDays(today, -i);
    const startD = addDays(endD, -6);
    const label = toYMD(endD);
    g3Labels.push(label);
    const sp = sumRange(dailySpend, startD, addDays(endD, 1));
    let mqlCount = 0;
    const cur = new Date(startD);
    while (cur <= endD) {
      mqlCount += dailyMQL[toYMD(cur)] || 0;
      cur.setDate(cur.getDate() + 1);
    }
    g3CostMQL.push(mqlCount ? Math.round(sp / mqlCount) : null);
  }

  // --- Tabela campanhas (30d) ---
  let campTable = [];
  if (campaignsAgg && campaignsAgg.rows && campaignsAgg.rows.length > 0) {
    // Dados ricos do Metabase: spend + conversions + clicks
    campTable = campaignsAgg.rows.map(row => {
      const name  = row[0] || '—';
      const spend = Math.round(parseFloat(row[1] || 0) * 100) / 100;
      const convs = Math.round(parseFloat(row[2] || 0) * 100) / 100;
      const clicks = Math.round(parseFloat(row[3] || 0) * 100) / 100;
      return {
        name,
        spend,
        conversions: convs,
        clicks,
        ctr: (clicks > 0) ? Math.round((convs / clicks) * 10000) / 100 : 0,
        costPerConversion: (convs > 0 && spend > 0) ? Math.round(spend / convs * 100) / 100 : null
      };
    });
    console.log(`[buildP1] campTable: ${campTable.length} campanhas (Metabase ✅)`);
  } else {
    // Fallback: apenas spend por campanha (sem conversions/clicks)
    const cutoff30 = addDays(today, -30);
    const campMap = {};
    googleCampaigns.forEach(row => {
      const dt = typeof row.date === 'string' ? new Date(row.date) : row.date;
      if (dt < cutoff30) return;
      const camp = row.campaign_name || 'Desconhecida';
      if (!campMap[camp]) campMap[camp] = { spend: 0 };
      campMap[camp].spend += row.cost_brl;
    });
    campTable = Object.entries(campMap)
      .map(([name, d]) => ({
        name,
        spend: Math.round(d.spend * 100) / 100,
        conversions: null,
        clicks: null,
        ctr: null,
        costPerConversion: null
      }))
      .sort((a, b) => b.spend - a.spend);
    console.log(`[buildP1] campTable: ${campTable.length} campanhas (fallback sem conversões)`);
  }

  console.log(`[buildP1] g1MQL (Google Ads Reunião, first 10 values):`, g1MQL.slice(0, 10));

  const result = {
    kpis,
    g1: {
      labels: g1Labels,
      leads: g1Leads,
      mql: g1MQL,
      mm7Leads: g1MM7Leads,
      mm7MQL: g1MM7MQL
    },
    g2,
    g3: { labels: g3Labels, costMQL: g3CostMQL },
    campTable
  };
    console.log(`[buildP1] g1 keys being returned:`, Object.keys(result.g1));
    console.log(`[buildP1] Full g1 structure:`, JSON.stringify({
      labels: result.g1.labels.length,
      leads: result.g1.leads.length,
      mql: result.g1.mql.length,
      mm7Leads: result.g1.mm7Leads.length,
      mm7MQL: result.g1.mm7MQL.length
    }));
    return result;
  } catch (err) {
    console.error(`[buildP1] CRITICAL ERROR:`, err.message, err.stack);
    throw err;
  }
}

// ── /api/p2 ───────────────────────────────────────────────────
async function buildP2() {
  const now = new Date();
  const today = getYesterdayDate(); // D-1: yesterday
  const d24mAgo = new Date(today);
  d24mAgo.setMonth(d24mAgo.getMonth() - 24);

  // ── 3 queries em PARALELO ─────────────────────────────────────
  console.log('[buildP2] Iniciando 3 queries em paralelo...');
  const [wonDeals, pvDeals, googleCampaigns] = await Promise.all([
    // 1. Deals Sales ganhos (24m)
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_SALES },
        { propertyName: 'dealstage',  operator: 'EQ',  value: 'closedwon' },
        { propertyName: 'closedate',  operator: 'GTE', value: String(d24mAgo.getTime()) },
        { propertyName: 'closedate',  operator: 'LTE', value: String(today.getTime()) }
      ]}],
      properties: ['closedate', 'amount', 'dealname'],
      limit: 100
    }),
    // 2. Deals Pré-Vendas Google Ads (24m)
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
        { propertyName: 'sub_origem', operator: 'EQ',  value: SUB_ORIGEM_GOOGLE },
        { propertyName: 'createdate', operator: 'GTE', value: String(d24mAgo.getTime()) },
        { propertyName: 'createdate', operator: 'LTE', value: String(today.getTime()) }
      ]}],
      properties: ['createdate', 'dealstage', 'amount'],
      limit: 100
    }),
    // 3. Spend Metabase (24m)
    loadGoogleCampaignsFromMetabase(d24mAgo, today)
  ]);
  console.log(`[buildP2] ✅ Paralelo concluído — wonDeals:${wonDeals.length} pvDeals:${pvDeals.length} googleRows:${googleCampaigns.length}`);
  const spendByMonth = {};
  const yesterdayStr = toYMD(today);
  googleCampaigns.forEach(row => {
    const dt = typeof row.date === 'string' ? row.date.split('T')[0] : toYMD(row.date);
    if (!dt || dt > yesterdayStr) return; // Filter to D-1
    const ym = dt.slice(0, 7);
    spendByMonth[ym] = (spendByMonth[ym] || 0) + row.cost_brl;
  });

  // MQL by month (deals entering pré-vendas)
  const mqlByMonth = {};
  pvDeals.forEach(d => {
    const ym = toYMD(new Date(new Date(d.properties.createdate).getTime())).slice(0, 7);
    mqlByMonth[ym] = (mqlByMonth[ym] || 0) + 1;
  });

  // Reunião by month (pré-vendas stage)
  const reuniaoByMonth = {};
  pvDeals.filter(d => d.properties.dealstage === STAGE_REUNIAO).forEach(d => {
    const ym = toYMD(new Date(new Date(d.properties.createdate).getTime())).slice(0, 7);
    reuniaoByMonth[ym] = (reuniaoByMonth[ym] || 0) + 1;
  });

  // Won deals by close month
  const wonByMonth = {};
  wonDeals.forEach(d => {
    const ym = toYMD(new Date(new Date(d.properties.closedate).getTime())).slice(0, 7);
    if (!wonByMonth[ym]) wonByMonth[ym] = { count: 0, mrr: 0 };
    wonByMonth[ym].count++;
    wonByMonth[ym].mrr += parseFloat(d.properties.amount || 0);
  });

  // Build cohort rows
  const rows = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(today);
    d.setMonth(d.getMonth() - i);
    const ym = toYMD(d).slice(0, 7);
    const mql = mqlByMonth[ym] || 0;
    const reuniao = reuniaoByMonth[ym] || 0;
    const ganho = wonByMonth[ym] ? wonByMonth[ym].count : 0;
    const mrr = wonByMonth[ym] ? wonByMonth[ym].mrr : 0;
    const spend = Math.round((spendByMonth[ym] || 0) * 100) / 100;
    const ltv = mrr * 8;
    const roas = spend ? Math.round((mrr / spend) * 100) / 100 : null;
    const cac = ganho ? Math.round(spend / ganho * 100) / 100 : null;
    const ticketMedio = ganho ? Math.round(mrr / ganho * 100) / 100 : null;
    const payback = cac && ticketMedio ? Math.round(cac / ticketMedio * 10) / 10 : null;
    const ltvCac = cac && ltv ? Math.round(ltv / cac * 10) / 10 : null;

    rows.push({ mes: ym, mql, reuniao, ganho, mrr: Math.round(mrr * 100) / 100, spend, roas, cac, ltv: Math.round(ltv * 100) / 100, ltvCac, ticketMedio, payback });
  }

  // Calcula Expected = média dos últimos 6 meses para cada métrica
  const last6 = rows.slice(-6).filter(r => r.mql > 0);
  function avg6(field) {
    const vals = last6.map(r => r[field]).filter(v => v !== null && v !== undefined && v > 0);
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  }
  const expected = {
    roas:        avg6('roas'),
    cac:         avg6('cac'),
    ltv:         avg6('ltv'),
    ltvCac:      avg6('ltvCac'),
    mrr:         avg6('mrr'),
    payback:     avg6('payback'),
    ticketMedio: avg6('ticketMedio')
  };

  // Adiciona expected a cada row como campo separado
  rows.forEach(r => { r.expected = expected; });

  // Gráfico: últimos 12 meses
  const g12 = rows.slice(-12);

  return { cohort: rows, g12: { labels: g12.map(r => r.mes), roas: g12.map(r => r.roas), cac: g12.map(r => r.cac) }, expected };
}

// ── Memory cache para endpoints separados ──────────────────────
const memCache = { g3Monthly: null, campaigns: null, g3ts: 0, campts: 0 };
const CACHE_TTL_SEPARATE = 60 * 60 * 1000; // 1 hora para endpoints separados

// ── Helper: Custo/MQL por mês 2026 ────────────────────────────
async function buildCostMQLMonthly() {
  if (memCache.g3Monthly && (Date.now() - memCache.g3ts < CACHE_TTL_SEPARATE)) {
    console.log('[buildCostMQLMonthly] Retornando do cache de memória');
    return memCache.g3Monthly;
  }

  const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const from = new Date('2026-01-01T00:00:00.000Z');
  const to   = new Date('2026-06-30T23:59:59.999Z');

  try {
    // Leads reais do HubSpot: pipeline Pré-Vendas + sub_origem = Google Ads
    const mqlDeals = await Promise.race([
      hsSearchAll('deals', {
        filterGroups: [{
          filters: [
            { propertyName: 'pipeline',    operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
            { propertyName: 'sub_origem',  operator: 'EQ',  value: SUB_ORIGEM_GOOGLE },
            { propertyName: 'createdate',  operator: 'GTE', value: String(from.getTime()) },
            { propertyName: 'createdate',  operator: 'LTE', value: String(to.getTime()) }
          ]
        }],
        properties: ['createdate']
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('HubSpot timeout')), 120000))
    ]);

    const mqlByMonth = {};
    mqlDeals.forEach(d => {
      const ym = toYMD(new Date(d.properties.createdate)).slice(0, 7);
      mqlByMonth[ym] = (mqlByMonth[ym] || 0) + 1;
    });
    console.log('[buildCostMQLMonthly] Leads por mês (Google Ads):', JSON.stringify(mqlByMonth));

    // Spend do Metabase (google_campaigns)
    const spendRows = await loadGoogleCampaignsFromMetabase(from, to);
    const spendByMonth = {};
    spendRows.forEach(row => {
      const dt = typeof row.date === 'string' ? row.date.split('T')[0] : toYMD(row.date);
      if (!dt) return;
      const ym = dt.slice(0, 7);
      spendByMonth[ym] = (spendByMonth[ym] || 0) + row.cost_brl;
    });

    const g3Monthly = MONTHS.map(mes => {
      const mql   = mqlByMonth[mes] || 0;
      const spend = Math.round((spendByMonth[mes] || 0) * 100) / 100;
      return { mes, spend, mql, costPerMQL: mql ? Math.round(spend / mql) : null };
    });

    memCache.g3Monthly = g3Monthly;
    memCache.g3ts = Date.now();
    return g3Monthly;
  } catch (err) {
    console.error('[buildCostMQLMonthly] Erro:', err.message);
    return MONTHS.map(m => ({ mes: m, spend: 0, mql: 0, costPerMQL: null }));
  }
}

// ── Helper: Campanhas com conversões reais (suporta campaign/adgroup/keyword) ──
async function buildCampaignsEnriched(groupBy = 'campaign') {
  const cacheKey = `campaigns_${groupBy}`;
  const tsKey    = `campts_${groupBy}`;

  if (memCache[cacheKey] && (Date.now() - (memCache[tsKey] || 0) < CACHE_TTL_SEPARATE)) {
    console.log(`[buildCampaignsEnriched] cache HIT: ${groupBy}`);
    return memCache[cacheKey];
  }
  // Mapeia groupBy para coluna real na tabela (nomes padrão Google Ads export)
  const GROUP_COL = {
    campaign: 'campaign_name',
    adgroup:  'ad_group_name',
    keyword:  'keyword_text'
  };
  const col = GROUP_COL[groupBy] || 'campaign_name';

  // Para adgroup e keyword inclui campaign_name como coluna extra (contexto)
  const extraColSelect = groupBy !== 'campaign' ? `, campaign_name` : '';
  const extraColGroup  = groupBy !== 'campaign' ? `, campaign_name` : '';

  // Usa date_add nativo do Athena para evitar problemas de tipo com TIMESTAMP vs DATE
  const sql = `
    SELECT
      ${col}${extraColSelect},
      SUM(cost_brl)    AS spend,
      SUM(conversions) AS conversions,
      SUM(clicks)      AS clicks
    FROM data_analytics.google_campaigns
    WHERE date >= date_add('day', -30, current_date)
    GROUP BY ${col}${extraColGroup}
    ORDER BY spend DESC
  `;

  console.log(`[buildCampaignsEnriched] Executando query (${groupBy}):`, sql.trim().split('\n')[3]);

  try {
    const metabaseRes = await Promise.race([
      metabaseQuery(sql),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Metabase timeout 30s')), 30000))
    ]);

    console.log(`[buildCampaignsEnriched] Metabase retornou ${metabaseRes.rows.length} linhas para ${groupBy}`);

    // Índices dependem se há coluna extra ou não
    const hasExtra = groupBy !== 'campaign';
    const rows = metabaseRes.rows.map(row => {
      const name     = row[0] || '—';
      const campaign = hasExtra ? row[1] : null;
      const si       = hasExtra ? 2 : 1; // spend index
      const spend    = Math.round(parseFloat(row[si])   * 100) / 100;
      const convs    = Math.round(parseFloat(row[si+1]) * 100) / 100;
      const clicks   = Math.round(parseFloat(row[si+2]) * 100) / 100;
      return {
        name,
        campaign,
        spend,
        conversions: convs,
        clicks,
        ctr: (clicks && convs) ? Math.round((convs / clicks) * 10000) / 100 : 0,
        costPerConversion: (convs && spend) ? Math.round(spend / convs * 100) / 100 : null
      };
    });

    memCache[cacheKey] = rows;
    memCache[tsKey]    = Date.now();
    return rows;
  } catch (err) {
    console.error(`[buildCampaignsEnriched] ERRO (${groupBy}):`, err.message);
    // Retorna erro para o endpoint poder sinalizar ao frontend
    throw err;
  }
}

// ── Routes ────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(requireAuth);

// Serve login page diretamente (sem passar pelo static antes do auth)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === DASH_USER && password === DASH_PASS) {
    const token = createSession();
    res.setHeader('Set-Cookie', `dash_session=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}; Path=/`);
    return res.redirect('/');
  }
  console.warn(`[auth] Tentativa de login inválida: usuário="${username}" ip=${req.ip}`);
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  const token = getCookie(req, 'dash_session');
  if (token) SESSIONS.delete(token);
  res.setHeader('Set-Cookie', 'dash_session=; HttpOnly; Max-Age=0; Path=/');
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  const p1 = readDiskCache('p1');
  const p2 = readDiskCache('p2');
  const p1File = diskCachePath('p1');
  const p2File = diskCachePath('p2');
  let p1ts = null, p2ts = null;
  try { p1ts = JSON.parse(fs.readFileSync(p1File, 'utf8')).ts; } catch (_) {}
  try { p2ts = JSON.parse(fs.readFileSync(p2File, 'utf8')).ts; } catch (_) {}
  res.json({
    ok: true,
    cache: {
      p1: { loaded: p1 !== null, ts: p1ts, age_min: p1ts ? Math.round((Date.now() - p1ts) / 60000) : null },
      p2: { loaded: p2 !== null, ts: p2ts, age_min: p2ts ? Math.round((Date.now() - p2ts) / 60000) : null }
    }
  });
});

app.get('/api/p1', async (req, res) => {
  try {
    // Se cache em memória existe, retorna imediatamente (< 1ms)
    if (MEM_CACHE['p1'] && MEM_CACHE['p1'].data) {
      return res.json(MEM_CACHE['p1'].data);
    }
    // Verifica cache em disco
    const disk = readDiskCache('p1');
    if (disk) {
      MEM_CACHE['p1'] = { ts: Date.now(), data: disk };
      return res.json(disk);
    }
    // Cache ainda sendo construído em background — avisa frontend para tentar novamente
    return res.status(202).json({ loading: true, message: 'Dados sendo carregados do HubSpot, tente novamente em 30 segundos.' });
  } catch (e) {
    console.error('P1 error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Endpoint leve — só KPIs (responde do mesmo cache, sem nova chamada HubSpot)
app.get('/api/p1/kpis', async (req, res) => {
  try {
    const data = await withCache('p1', buildP1);
    res.json({ kpis: data.kpis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/p2', async (req, res) => {
  try {
    if (MEM_CACHE['p2'] && MEM_CACHE['p2'].data) {
      return res.json(MEM_CACHE['p2'].data);
    }
    const disk = readDiskCache('p2');
    if (disk) {
      MEM_CACHE['p2'] = { ts: Date.now(), data: disk };
      return res.json(disk);
    }
    return res.status(202).json({ loading: true, message: 'Dados sendo carregados do HubSpot, tente novamente em 30 segundos.' });
  } catch (e) {
    console.error('P2 error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Novo endpoint: Custo/MQL por mês 2026
app.get('/api/p1/cost-mql-monthly', async (req, res) => {
  try {
    console.log('[API] /api/p1/cost-mql-monthly chamado');
    const data = await buildCostMQLMonthly();
    console.log('[API] /api/p1/cost-mql-monthly respondendo com', data.length, 'meses');
    res.json({ g3Monthly: data });
  } catch (e) {
    console.error('[API] Cost MQL monthly error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Novo endpoint: Campanhas com conversões reais
app.get('/api/p1/campaigns-enriched', async (req, res) => {
  try {
    const groupBy = ['campaign', 'adgroup', 'keyword'].includes(req.query.groupBy)
      ? req.query.groupBy : 'campaign';
    const data = await buildCampaignsEnriched(groupBy);
    res.json({ campaigns: data, groupBy });
  } catch (e) {
    console.error('Campaigns enriched error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Força rebuild do cache (usado pelo agente diário)
app.post('/api/force-refresh', async (req, res) => {
  console.log('[force-refresh] iniciando rebuild do cache...');
  delete MEM_CACHE['p1'];
  delete MEM_CACHE['p2'];
  try {
    const [p1, p2] = await Promise.all([buildP1(), buildP2()]);
    MEM_CACHE['p1'] = { ts: Date.now(), data: p1 };
    MEM_CACHE['p2'] = { ts: Date.now(), data: p2 };
    writeDiskCache('p1', p1);
    writeDiskCache('p2', p2);
    console.log('[force-refresh] cache rebuilt com sucesso');
    res.json({ ok: true, ts: Date.now() });
  } catch (e) {
    console.error('[force-refresh] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Frota 162 Dash v2 rodando em http://localhost:${PORT}`);

  // Na inicialização: se cache em disco existe e é recente, carrega na memória sem rebuild
  const p1disk = readDiskCache('p1');
  const p2disk = readDiskCache('p2');
  if (p1disk) { MEM_CACHE['p1'] = { ts: Date.now(), data: p1disk }; console.log('[startup] P1 carregado do disco'); }
  if (p2disk) { MEM_CACHE['p2'] = { ts: Date.now(), data: p2disk }; console.log('[startup] P2 carregado do disco'); }

  // Se cache não existe, faz rebuild imediato em background (sem delay — crítico no Railway)
  if (!p1disk || !p2disk) {
    console.log('[preload] cache ausente, iniciando build imediato em background...');
    if (!p1disk) {
      buildP1()
        .then(d => { MEM_CACHE['p1'] = { ts: Date.now(), data: d }; writeDiskCache('p1', d); console.log('[preload] P1 pronto ✅'); })
        .catch(e => console.error('[preload] P1 erro:', e.message));
    }
    if (!p2disk) {
      buildP2()
        .then(d => { MEM_CACHE['p2'] = { ts: Date.now(), data: d }; writeDiskCache('p2', d); console.log('[preload] P2 pronto ✅'); })
        .catch(e => console.error('[preload] P2 erro:', e.message));
    }
  }
});
