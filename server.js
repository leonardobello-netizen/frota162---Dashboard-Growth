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
const SUB_ORIGEM_GOOGLE_CONTACT = 'midia-paga-google-ads'; // valor de sub_origem em CONTATOS (minúsculo)
const PIPELINE_PRE_VENDAS = '691581102';
const PIPELINE_SALES = 'default';
const STAGE_REUNIAO = '1012021273';
const STAGE_DESQUALIFICADO = '1012021274';
// Pipelines de receita do relatório "Total MRR" do HubSpot (exclui Pré-Vendas, POCs, Self-Onboarding, Gestão de Fundos)
const MRR_PIPELINES = ['default', '693151525', '784015251', '772560517', '695821578', '725390999'];

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
  const h = { headers: { 'x-api-key': MB_KEY, 'Content-Type': 'application/json' }, httpsAgent: agent, timeout: 90000 };
  const res = await axios.post(MB_URL + '/api/dataset', {
    database: 2,
    type: 'native',
    native: { query: sql }
  }, h);
  // Detecta erros no corpo da resposta (Metabase retorna HTTP 200 mesmo com erro de query/DB)
  if (res.data.error) {
    console.error('[metabaseQuery] Body error:', res.data.error);
    throw new Error('Metabase query error: ' + res.data.error);
  }
  const rows = res.data.data?.rows || [];
  const cols = res.data.data?.cols?.map(c => c.name) || [];
  console.log(`[metabaseQuery] OK — ${rows.length} linhas, cols: ${cols.join(', ')}`);
  return { cols, rows };
}

async function loadGoogleCampaignsFromMetabase(fromDate, toDate) {
  // Usa DATE '...' em vez de TIMESTAMP '...' para evitar erro de tipo no Athena
  const sql = `
    SELECT
      CAST(date AS DATE) as date,
      cost_brl,
      campaign_name
    FROM data_analytics.google_campaigns
    WHERE CAST(date AS DATE) >= DATE '${toYMD(fromDate)}'
      AND CAST(date AS DATE) <= DATE '${toYMD(toDate)}'
    ORDER BY date DESC
  `;
  try {
    const res = await metabaseQuery(sql);
    if (!res.rows.length) {
      console.warn('[loadGoogleCampaignsFromMetabase] Retornou 0 linhas para', toYMD(fromDate), '→', toYMD(toDate));
    }
    return res.rows.map(r => ({ date: r[0], cost_brl: parseFloat(r[1]) || 0, campaign_name: r[2] }));
  } catch (e) {
    console.error('[loadGoogleCampaignsFromMetabase] Erro:', e.message);
    return [];
  }
}

// ── Google Ads API — fallback de spend quando o Metabase atrasa ──────────────
// DORMENTE até as GOOGLE_ADS_* estarem nas env vars do Railway.
// Retorna null se não configurado OU em erro → o chamador mantém o Metabase + aviso.
const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v18';

async function getGoogleAdsAccessToken() {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    grant_type:    'refresh_token'
  });
  const res = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  return res.data.access_token;
}

// Spend diário do Google Ads via GAQL. Retorna [{date:'YYYY-MM-DD', cost_brl, campaign_name}] ou null.
async function loadGoogleAdsSpend(fromDate, toDate) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  // Não configurado → indisponível (caller mantém Metabase + aviso de defasagem)
  if (!devToken || !customerId || !process.env.GOOGLE_ADS_CLIENT_ID ||
      !process.env.GOOGLE_ADS_CLIENT_SECRET || !process.env.GOOGLE_ADS_REFRESH_TOKEN) {
    return null;
  }
  const cid = String(customerId).replace(/[^0-9]/g, '');
  const from = toYMD(fromDate), to = toYMD(toDate);
  const query = `SELECT segments.date, campaign.name, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'`;
  try {
    const accessToken = await getGoogleAdsAccessToken();
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': devToken,
      'Content-Type': 'application/json'
    };
    if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      headers['login-customer-id'] = String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/[^0-9]/g, '');
    }
    const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${cid}/googleAds:searchStream`;
    const res = await axios.post(url, { query }, { headers, timeout: 60000 });
    // searchStream retorna um array de batches: [{results:[...]}, ...]
    const batches = Array.isArray(res.data) ? res.data : [res.data];
    const out = [];
    batches.forEach(b => (b.results || []).forEach(r => {
      const date = r.segments && r.segments.date;
      const micros = r.metrics && r.metrics.costMicros;
      if (date) out.push({
        date,
        cost_brl: (Number(micros) || 0) / 1e6,
        campaign_name: (r.campaign && r.campaign.name) || '(sem nome)'
      });
    }));
    console.log(`[loadGoogleAdsSpend] ${out.length} linhas ${from}→${to} | total R$ ${out.reduce((s,x)=>s+x.cost_brl,0).toFixed(2)}`);
    return out;
  } catch (e) {
    const detail = e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.message;
    console.error('[loadGoogleAdsSpend] Erro:', detail);
    return null;
  }
}

// ── Fuso de Brasília (UTC-3, sem horário de verão desde 2019) ──
// Todas as datas de CALENDÁRIO (createdate do HubSpot, buckets diários/mensais)
// são tratadas no fuso de Brasília para bater 100% com os relatórios nativos do HubSpot.
// Datas do Metabase já vêm como data pura (string YYYY-MM-DD) e NÃO passam por aqui.
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;

// Converte um instante (Date ou ISO/epoch) para 'YYYY-MM-DD' no fuso de Brasília
function toYMD(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(dt.getTime() - BR_OFFSET_MS).toISOString().slice(0, 10);
}

// Instante UTC correspondente à meia-noite de Brasília de um dia (monthIndex 0-11)
function brMidnight(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day) + BR_OFFSET_MS);
}

// Soma n dias mantendo o instante (24h fixas — válido pois o Brasil não tem DST)
function addDays(d, n) {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

// Meia-noite de Brasília do dia (em Brasília) que contém o instante d
function startOfDay(d) {
  const [y, m, day] = toYMD(d).split('-').map(Number);
  return brMidnight(y, m - 1, day);
}

// "Ontem" (D-1) em Brasília, como instante da meia-noite de Brasília
function getYesterdayDate() {
  const [y, m, day] = toYMD(new Date()).split('-').map(Number);
  return brMidnight(y, m - 1, day - 1); // Date.UTC normaliza day-1
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

  // Datas de calendário derivadas no fuso de Brasília (a partir das partes de 'today')
  const [ty, tm, td] = toYMD(today).split('-').map(Number); // tm = 1-12
  const currentDay = td;
  const monthStart     = brMidnight(ty, tm - 1, 1);
  const monthStartPrev = brMidnight(ty, tm - 2, 1); // Date.UTC normaliza mês negativo
  // Lida com meses de tamanhos diferentes (fev 28/29 etc.)
  const lastMonthMaxDay = new Date(Date.UTC(ty, tm - 1, 0)).getUTCDate();
  const lastMonthDay = Math.min(currentDay, lastMonthMaxDay);
  const datePrev = brMidnight(ty, tm - 2, lastMonthDay);
  // Limites superiores (exclusivos) — incluem D-1 / o mesmo dia do mês anterior por completo
  const todayEnd    = addDays(today, 1);    // início de hoje (D-1 inteiro incluído)
  const datePrevEnd = addDays(datePrev, 1); // mesmo dia do mês anterior, inteiro incluído
  const frotaFrom   = brMidnight(ty, 0, 1); // 1º de janeiro do ano corrente (gráfico de frota = ano todo)

  // ── Todas as queries em PARALELO — reduz ~3min → ~40s ────────
  console.log('[buildP1] Iniciando 7 queries em paralelo...');
  const [
    allDealsRes,
    mqlDealsRes,
    contactsRaw,
    googleCampaigns,
    reunioesRaw,
    campaignsAgg,
    leadsContactsRes,
    mqlContactsRes
  ] = await Promise.all([
    // 1. Deals Google no Pré-Vendas desde 1º/jan (alimenta a barra azul do gráfico de volume — ano todo)
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
        { propertyName: 'sub_origem', operator: 'EQ',  value: SUB_ORIGEM_GOOGLE },
        { propertyName: 'createdate', operator: 'GTE', value: String(frotaFrom.getTime()) },
        { propertyName: 'createdate', operator: 'LT',  value: String(todayEnd.getTime()) }
      ]}],
      properties: ['createdate', 'dealname', 'sub_origem', 'dealstage']
    }),
    // 2. MQL (KPI) = deals do pipeline Pré-Vendas com a MESMA origem do Lead (Google Ads) — cobre MTD + mês anterior
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
        { propertyName: 'sub_origem', operator: 'EQ',  value: SUB_ORIGEM_GOOGLE },
        { propertyName: 'createdate', operator: 'GTE', value: String(monthStartPrev.getTime()) },
        { propertyName: 'createdate', operator: 'LT',  value: String(todayEnd.getTime()) }
      ]}],
      properties: ['createdate', 'sub_origem']
    }),
    // 3. Frota — DEALS Google Ads no Pré-Vendas, EXCLUINDO desqualificados; últimos 3 meses (distribuição por mês)
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
        { propertyName: 'sub_origem',  operator: 'EQ',  value: SUB_ORIGEM_GOOGLE },
        { propertyName: 'dealstage',  operator: 'NEQ', value: STAGE_DESQUALIFICADO },
        { propertyName: 'createdate', operator: 'GTE', value: String(frotaFrom.getTime()) },
        { propertyName: 'createdate', operator: 'LT',  value: String(todayEnd.getTime()) }
      ]}],
      properties: ['createdate', 'dealname', 'qual_a_quantidade_de_veiculos_na_sua_frota_']
    }).catch(e => { console.error('[buildP1] frota erro:', e.message); return []; }),
    // 4. Spend Metabase (por dia, para gráficos de custo)
    loadGoogleCampaignsFromMetabase(d90ago, today).catch(e => { console.error('[buildP1] spend erro:', e.message); return []; }),
    // 5. Reuniões (etapa "Reunião Agendada") Google Ads — mesma origem de Leads/MQL; cobre MTD + mês anterior
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'pipeline',   operator: 'EQ',  value: PIPELINE_PRE_VENDAS },
        { propertyName: 'sub_origem', operator: 'EQ',  value: SUB_ORIGEM_GOOGLE },
        { propertyName: 'dealstage',  operator: 'EQ',  value: STAGE_REUNIAO },
        { propertyName: 'createdate', operator: 'GTE', value: String(monthStartPrev.getTime()) },
        { propertyName: 'createdate', operator: 'LT',  value: String(todayEnd.getTime()) }
      ]}],
      properties: ['createdate']
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
    `).catch(e => { console.error('[buildP1] campaignsAgg erro:', e.message); return null; }),
    // 8. CONTATOS Google Ads (KPI Leads) — cobre MTD + mês anterior (do início do mês anterior até D-1)
    hsSearchAll('contacts', {
      filterGroups: [{ filters: [
        { propertyName: 'sub_origem', operator: 'EQ',  value: SUB_ORIGEM_GOOGLE_CONTACT },
        { propertyName: 'createdate', operator: 'GTE', value: String(monthStartPrev.getTime()) },
        { propertyName: 'createdate', operator: 'LT',  value: String(todayEnd.getTime()) }
      ]}],
      properties: ['createdate', 'sub_origem']
    }).catch(e => { console.error('[buildP1] leads contatos erro:', e.message); return []; }),
    // 9. CONTATOS que viraram MQL (barra verde do gráfico de volume) — pela DATA de entrada no MQL, desde 1º/jan
    hsSearchAll('contacts', {
      filterGroups: [{ filters: [
        { propertyName: 'sub_origem', operator: 'EQ',  value: SUB_ORIGEM_GOOGLE_CONTACT },
        { propertyName: 'hs_v2_date_entered_marketingqualifiedlead', operator: 'GTE', value: String(frotaFrom.getTime()) },
        { propertyName: 'hs_v2_date_entered_marketingqualifiedlead', operator: 'LT',  value: String(todayEnd.getTime()) }
      ]}],
      properties: ['hs_v2_date_entered_marketingqualifiedlead', 'sub_origem']
    }).catch(e => { console.error('[buildP1] mql contatos erro:', e.message); return []; })
  ]);
  console.log(`[buildP1] ✅ Paralelo concluído — leads:${allDealsRes.length} mql:${mqlDealsRes.length} frota:${contactsRaw.length} googleRows:${googleCampaigns.length} reunioes:${reunioesRaw.length} campaignsAgg:${campaignsAgg?.rows?.length ?? 'erro'}`);

  const mqlDealsRaw = mqlDealsRes || [];

  // Build daily maps
  const dailyLeads = {};     // date -> count (Google Ads deals)
  const dailyMQL = {};       // date -> count (Meta Ads deals, for KPI)
  const dailyGoogleMQL = {}; // date -> count (CONTATOS que viraram MQL, pela data do MQL — barra verde do gráfico)
  const dailySpend = {};     // date -> spend

  // D-1 cutoff date
  const yesterday = toYMD(today);

  // LEADS (7D) = All deals created in 7D window
  const leadsDealsRaw = allDealsRes || [];
  console.log(`[P1] Leads Deals (todos pipeline): ${leadsDealsRaw.length} | Filtro KPI: sub_origem=${SUB_ORIGEM_GOOGLE} | Period: ${toYMD(monthStartPrev)} to ${toYMD(today)}`);

  leadsDealsRaw.forEach(d => {
    const dt = toYMD(new Date(d.properties.createdate));
    if (!dt || dt > yesterday) return;
    const subOrigem = d.properties.sub_origem || '';
    // Leads = sub_origem Google Ads (barra azul do gráfico de volume)
    if (subOrigem === SUB_ORIGEM_GOOGLE) {
      dailyLeads[dt] = (dailyLeads[dt] || 0) + 1;
    }
  });

  // Barra verde "Qualificados Google Ads" = CONTATOS que viraram MQL, pela DATA de entrada no MQL
  // (mesma definição do relatório "MQLs gerados" do HubSpot)
  (mqlContactsRes || []).forEach(c => {
    const raw = c.properties.hs_v2_date_entered_marketingqualifiedlead;
    if (!raw) return;
    const dt = toYMD(new Date(raw));
    if (dt && dt <= yesterday) {
      dailyGoogleMQL[dt] = (dailyGoogleMQL[dt] || 0) + 1;
    }
  });
  console.log(`[P1] Contatos MQL (barra verde): ${(mqlContactsRes||[]).length} | dist:`, JSON.stringify(dailyGoogleMQL));

  // MQL (7D) = Deals with sub_origem = "Midia-Paga-Google-Ads" created in 7D
  console.log(`[P1] MQL Deals fetched: ${mqlDealsRes.length} | Filter: pipeline=${PIPELINE_PRE_VENDAS} + sub_origem=${SUB_ORIGEM_GOOGLE} | Period: ${toYMD(monthStartPrev)} to ${toYMD(today)}`);
  mqlDealsRes.forEach(d => {
    const dt = toYMD(new Date(d.properties.createdate));
    if (dt && dt <= yesterday) {
      dailyMQL[dt] = (dailyMQL[dt] || 0) + 1;
    }
  });

  // CONTATOS Google Ads → alimenta o KPI "Leads" (7D)
  const dailyLeadsContacts = {};
  (leadsContactsRes || []).forEach(c => {
    const dt = toYMD(new Date(c.properties.createdate));
    if (dt && dt <= yesterday) {
      dailyLeadsContacts[dt] = (dailyLeadsContacts[dt] || 0) + 1;
    }
  });
  console.log(`[P1] Contatos Google Ads (KPI Leads): ${(leadsContactsRes||[]).length} | dist:`, JSON.stringify(dailyLeadsContacts));

  // REUNIÕES (etapa "Reunião Agendada") → bucket diário para MTD vs mês anterior
  const dailyReuniao = {};
  (reunioesRaw || []).forEach(d => {
    const dt = toYMD(new Date(d.properties.createdate));
    if (dt && dt <= yesterday) {
      dailyReuniao[dt] = (dailyReuniao[dt] || 0) + 1;
    }
  });
  console.log(`[P1] Reuniões fetched: ${(reunioesRaw||[]).length} | dist:`, JSON.stringify(dailyReuniao));

  console.log(`[P1] LEADS distribution:`, JSON.stringify(dailyLeads));
  console.log(`[P1] MQL distribution:`, JSON.stringify(dailyMQL));

  // Load spend from Metabase Google Campaigns (D-1 cutoff)
  googleCampaigns.forEach(row => {
    const dt = typeof row.date === 'string' ? row.date.split('T')[0] : toYMD(row.date);
    if (!dt || dt > yesterday) return; // Skip data from D+1 onwards
    dailySpend[dt] = (dailySpend[dt] || 0) + row.cost_brl;
  });

  // ── Defasagem do spend (Metabase): até que dia há gasto carregado? ──────
  let spendSource = 'metabase';
  let spendDates = Object.keys(dailySpend).filter(d => d <= yesterday).sort();
  let spendLatest = spendDates.length ? spendDates[spendDates.length - 1] : null;
  let spendStale = !!spendLatest && spendLatest < yesterday; // não alcança D-1
  if (spendStale) console.warn(`[P1] ⚠️ Spend Metabase DEFASADO: última data ${spendLatest} < D-1 ${yesterday}`);

  // FALLBACK: Metabase atrasado → troca o MÊS INTEIRO atual pelo Google Ads (se configurado).
  // Dormente sem credenciais (loadGoogleAdsSpend retorna null → mantém Metabase + aviso).
  if (spendStale) {
    const gads = await loadGoogleAdsSpend(monthStart, today);
    if (gads && gads.length) {
      const curYM = toYMD(monthStart).slice(0, 7);
      Object.keys(dailySpend).forEach(d => { if (d.slice(0, 7) === curYM) delete dailySpend[d]; });
      gads.forEach(row => {
        const dt = typeof row.date === 'string' ? row.date.split('T')[0] : toYMD(row.date);
        if (!dt || dt > yesterday || dt.slice(0, 7) !== curYM) return;
        dailySpend[dt] = (dailySpend[dt] || 0) + row.cost_brl;
      });
      spendSource = 'google_ads';
      spendDates = Object.keys(dailySpend).filter(d => d <= yesterday).sort();
      spendLatest = spendDates.length ? spendDates[spendDates.length - 1] : null;
      spendStale = !!spendLatest && spendLatest < yesterday;
      console.log(`[P1] ✅ Fallback Google Ads aplicado em ${curYM}. Última data: ${spendLatest}, stale=${spendStale}`);
    } else {
      console.warn('[P1] Fallback Google Ads indisponível (sem credencial/erro) → mantém Metabase + aviso');
    }
  }

  // KPI 7d current — itera por dia usando addDays (independente do fuso do host)
  function sumRange(map, from, to, label) {
    let s = 0;
    let cur = new Date(from);
    const dates = [];
    while (cur < to) {
      const ym = toYMD(cur);
      const val = map[ym] || 0;
      if (val > 0 || dates.length < 3) dates.push(`${ym}:${val}`);
      s += val;
      cur = addDays(cur, 1);
    }
    if (label) console.log(`[sumRange] ${label}: total=${s}, dates=${dates.join(',')}, map keys=${Object.keys(map).length}`);
    return s;
  }

  // ── KPIs do topo: MTD (mês atual até D-1) vs mesmo período do mês anterior ──
  // Atual:    do dia 1 do mês corrente até D-1 (ontem)
  // Anterior: do dia 1 do mês passado até o mesmo dia do mês passado
  const leadsMTD  = sumRange(dailyLeadsContacts, monthStart,     todayEnd,    'Leads(MTD)');
  const leadsPrev = sumRange(dailyLeadsContacts, monthStartPrev, datePrevEnd, 'Leads(mês ant.)');
  const mqlMTD    = sumRange(dailyMQL, monthStart,     todayEnd,    'MQL(MTD)');
  const mqlPrev   = sumRange(dailyMQL, monthStartPrev, datePrevEnd, 'MQL(mês ant.)');
  const reuniaoMTD  = sumRange(dailyReuniao, monthStart,     todayEnd,    'Reunião(MTD)');
  const reuniaoPrev = sumRange(dailyReuniao, monthStartPrev, datePrevEnd, 'Reunião(mês ant.)');
  const spendMTD  = sumRange(dailySpend, monthStart,     todayEnd);
  const spendPrev = sumRange(dailySpend, monthStartPrev, datePrevEnd);

  function pct(cur, prev) {
    if (!prev) return null;
    return Math.round(((cur - prev) / prev) * 100);
  }

  const costPerLead     = leadsMTD  ? spendMTD  / leadsMTD  : 0;
  const costPerMQL      = mqlMTD    ? spendMTD  / mqlMTD    : 0;
  const costPerLeadPrev = leadsPrev ? spendPrev / leadsPrev : 0;
  const costPerMQLPrev  = mqlPrev   ? spendPrev / mqlPrev   : 0;

  // --- KPIs (MTD vs mesmo período do mês anterior) ---
  console.log(`[P1] KPI MTD: leads=${leadsMTD}(ant ${leadsPrev}) mql=${mqlMTD}(ant ${mqlPrev}) reunião=${reuniaoMTD}(ant ${reuniaoPrev}) spend=${spendMTD}(ant ${spendPrev}) | fonte=${spendSource} stale=${spendStale} até=${spendLatest}`);
  const metabaseOk = spendMTD > 0 || spendPrev > 0; // false = Metabase indisponível
  // Aviso de fonte/defasagem para os cards de dinheiro
  let spendNote = null;
  if (metabaseOk && spendStale && spendLatest) {
    spendNote = `⚠️ spend (${spendSource}) só até ${spendLatest.slice(8,10)}/${spendLatest.slice(5,7)} — parcial`;
  } else if (spendSource === 'google_ads') {
    spendNote = 'via Google Ads (Metabase atrasado)';
  }
  const kpis = [
    { label: 'Leads',        value: leadsMTD,   delta: pct(leadsMTD, leadsPrev),     format: 'number' },
    { label: 'MQL',          value: mqlMTD,     delta: pct(mqlMTD, mqlPrev),         format: 'number' },
    { label: 'Reunião',      value: reuniaoMTD, delta: pct(reuniaoMTD, reuniaoPrev), format: 'number' },
    { label: 'Investimento', value: metabaseOk ? spendMTD : null,     delta: metabaseOk ? pct(spendMTD, spendPrev) : null,            format: 'currency', metabaseWarn: !metabaseOk, note: spendNote },
    { label: 'Custo/Lead',   value: metabaseOk ? costPerLead : null,  delta: metabaseOk ? pct(costPerLead, costPerLeadPrev) : null,   format: 'currency', invertDelta: true, metabaseWarn: !metabaseOk, note: spendNote },
    { label: 'Custo/MQL',    value: metabaseOk ? costPerMQL : null,   delta: metabaseOk ? pct(costPerMQL, costPerMQLPrev) : null,      format: 'currency', invertDelta: true, metabaseWarn: !metabaseOk, note: spendNote }
  ];

  // ── Helpers de mês (compartilhados pelos gráficos de volume e frota) ──
  const MESES_PT = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const currentYM = toYMD(today).slice(0, 7);
  const anoMeses = []; // os 12 meses do ano corrente (YYYY-MM)
  for (let m = 0; m < 12; m++) anoMeses.push(toYMD(brMidnight(ty, m, 1)).slice(0, 7));
  const mesLabel = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    const base = `${MESES_PT[m - 1]}/${String(y).slice(2)}`;
    return ym === currentYM ? `${base} (parcial)` : base;
  };
  // Agrega um mapa diário {YYYY-MM-DD: n} em mensal {YYYY-MM: n}
  const monthlyFromDaily = (map) => {
    const out = {};
    Object.entries(map).forEach(([d, v]) => { const ym = d.slice(0, 7); out[ym] = (out[ym] || 0) + v; });
    return out;
  };

  // --- Gráfico 1: Leads e MQLs por MÊS (jan→dez; meses futuros vazios) ---
  const leadsMensal = monthlyFromDaily(dailyLeads);
  const mqlMensal = monthlyFromDaily(dailyGoogleMQL);
  const g1Labels = anoMeses.map(mesLabel);
  const g1Leads = anoMeses.map(ym => ym > currentYM ? null : (leadsMensal[ym] || 0));
  const g1MQL = anoMeses.map(ym => ym > currentYM ? null : (mqlMensal[ym] || 0));

  // Média móvel de 1 MÊS — a linha acompanha o valor de cada mês (trajetória); null nos meses futuros
  const g1MM7Leads = g1Leads.slice();
  const g1MM7MQL = g1MQL.slice();
  console.log(`[buildP1] Volume mensal: leads=${JSON.stringify(g1Leads)} mql=${JSON.stringify(g1MQL)}`);

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

  // Tabela de % por RANGE × mês (jan→dez). Ranges agrupam as 11 faixas:
  const RANGES = [
    { nome: 'Micro',          faixas: ['1-5 placas','6-10 placas'],                       cat: 'pequena' }, // até 10
    { nome: 'Pequeno',        faixas: ['11-20 placas','21-40 placas','41-80 placas'],      cat: 'pequena' }, // 11-80
    { nome: 'Médio',          faixas: ['81-150 placas','151-300 placas'],                 cat: 'grande'  }, // 81-300
    { nome: 'Grande',         faixas: ['301-600 placas','601-1.200 placas'],              cat: 'grande'  }, // 301-1200
    { nome: 'Enterprise',     faixas: ['+1.200 placas'],                                  cat: 'grande'  }, // +1200
    { nome: 'Não informado',  faixas: ['Não informado'],                                  cat: 'neutro'  }
  ];
  const faixaToRange = {};
  RANGES.forEach(r => r.faixas.forEach(f => faixaToRange[f] = r.nome));

  const monthRangeCount = {}; // ym -> { range -> count }
  const monthTotal = {};      // ym -> total de leads (inclui Não informado)
  anoMeses.forEach(ym => { monthRangeCount[ym] = {}; RANGES.forEach(r => monthRangeCount[ym][r.nome] = 0); monthTotal[ym] = 0; });
  contactsRaw.forEach(d => {
    const ym = toYMD(new Date(d.properties.createdate)).slice(0, 7);
    if (!monthRangeCount[ym]) return; // fora do ano corrente
    const rng = faixaToRange[frotaFaixa(d.properties.qual_a_quantidade_de_veiculos_na_sua_frota_)] || 'Não informado';
    monthRangeCount[ym][rng]++;
    monthTotal[ym]++;
  });

  const mesesMeta = anoMeses.map(ym => ({ ym, label: mesLabel(ym), parcial: ym === currentYM }));
  // cor por DIREÇÃO da % (subindo/caindo) conforme a categoria do range
  const corDirecao = (cat, atual, anterior) => {
    if (cat === 'neutro' || atual === null || anterior === null) return null;
    if (atual > anterior) return (cat === 'pequena') ? 'laranja' : 'verde';   // subindo
    if (atual < anterior) return (cat === 'pequena') ? 'verde'   : 'vermelho'; // caindo
    return null; // igual
  };
  const g2Rows = RANGES.map(r => {
    const pcts = anoMeses.map(ym => monthTotal[ym] === 0 ? null : Math.round((monthRangeCount[ym][r.nome] / monthTotal[ym]) * 1000) / 10);
    const comDados = pcts.filter(p => p !== null);
    const media = comDados.length ? Math.round((comDados.reduce((a, b) => a + b, 0) / comDados.length) * 10) / 10 : null;
    // Cor POR MÊS: compara cada mês com o mês anterior COM dados (1º mês fica sem cor).
    const cores = pcts.map((v, i) => {
      if (v === null) return null;
      let j = i - 1; while (j >= 0 && pcts[j] === null) j--;
      return j < 0 ? null : corDirecao(r.cat, v, pcts[j]);
    });
    // Cor da MÉDIA: tendência dos 2 últimos meses COM dados (inclui o parcial — trocável p/ só fechados).
    let cor = null;
    const idxs = pcts.map((p, i) => p !== null ? i : -1).filter(i => i >= 0);
    if (idxs.length >= 2) cor = corDirecao(r.cat, pcts[idxs[idxs.length - 1]], pcts[idxs[idxs.length - 2]]);
    return { range: r.nome, cat: r.cat, pcts, cores, media, cor };
  });

  console.log(`[buildP1] Frota ranges (% mês): totais ${anoMeses.map(ym => `${ym}=${monthTotal[ym]}`).filter(s => !s.endsWith('=0')).join(' ')}`);

  const g2 = { tipo: 'tabela-ranges', meses: mesesMeta, rows: g2Rows };

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
    let cur = new Date(startD);
    while (cur <= endD) {
      mqlCount += dailyMQL[toYMD(cur)] || 0;
      cur = addDays(cur, 1);
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
    campTable,
    dataAtualizacao: toYMD(today) // D-1: última data fechada dos dados apresentados
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
  const [ty, tm, td] = toYMD(today).split('-').map(Number); // partes em Brasília
  const d24mAgo = brMidnight(ty, tm - 1 - 24, td); // Date.UTC normaliza mês negativo

  // ── Cohort por SAFRA (data de criação) — 2 queries em PARALELO ──────────────
  console.log('[buildP2] Iniciando queries do cohort (safra por createdate)...');
  const [googleDeals, googleCampaigns] = await Promise.all([
    // Deals GOOGLE criados nos últimos 24m (QUALQUER pipeline) — atribuição por SAFRA = mês de createdate.
    // Um deal criado no Pré-Vendas no mês X e ganho no Sales depois conta na safra X (a createdate é preservada).
    hsSearchAll('deals', {
      filterGroups: [{ filters: [
        { propertyName: 'sub_origem', operator: 'EQ',  value: SUB_ORIGEM_GOOGLE },
        { propertyName: 'createdate', operator: 'GTE', value: String(d24mAgo.getTime()) },
        { propertyName: 'createdate', operator: 'LTE', value: String(today.getTime()) }
      ]}],
      properties: ['createdate', 'dealstage', 'pipeline', 'hs_is_closed_won', 'amount_in_home_currency']
    }),
    // Spend Metabase (24m)
    loadGoogleCampaignsFromMetabase(d24mAgo, today)
  ]);
  console.log(`[buildP2] ✅ Concluído — googleDeals:${googleDeals.length} googleRows:${googleCampaigns.length}`);
  const yesterdayStr = toYMD(today);
  const spendByMonth = {};
  googleCampaigns.forEach(row => {
    const dt = typeof row.date === 'string' ? row.date.split('T')[0] : toYMD(row.date);
    if (!dt || dt > yesterdayStr) return; // D-1
    spendByMonth[dt.slice(0, 7)] = (spendByMonth[dt.slice(0, 7)] || 0) + row.cost_brl;
  });

  // Buckets por SAFRA (mês de createdate do deal Google)
  const mqlByMonth = {}, reuniaoByMonth = {}, ganhoByMonth = {}, mrrByMonth = {};
  googleDeals.forEach(d => {
    const ym = toYMD(new Date(d.properties.createdate)).slice(0, 7);
    mqlByMonth[ym] = (mqlByMonth[ym] || 0) + 1; // MQL = todos os deals Google criados na safra
    if (d.properties.dealstage === STAGE_REUNIAO) reuniaoByMonth[ym] = (reuniaoByMonth[ym] || 0) + 1;
    const won = d.properties.hs_is_closed_won === 'true' || d.properties.hs_is_closed_won === true;
    if (won && MRR_PIPELINES.includes(d.properties.pipeline)) { // ganho de RECEITA (exclui POCs/Onboarding)
      ganhoByMonth[ym] = (ganhoByMonth[ym] || 0) + 1;
      mrrByMonth[ym] = (mrrByMonth[ym] || 0) + parseFloat(d.properties.amount_in_home_currency || 0);
    }
  });

  const r2 = x => Math.round(x * 100) / 100;
  const r1 = x => Math.round(x * 10) / 10;

  // 24 meses em ordem cronológica (antigo → recente)
  const months = [];
  for (let i = 23; i >= 0; i--) months.push(toYMD(brMidnight(ty, tm - 1 - i, 1)).slice(0, 7));
  const base = months.map(ym => ({
    ym, mql: mqlByMonth[ym] || 0, reuniao: reuniaoByMonth[ym] || 0,
    ganho: ganhoByMonth[ym] || 0, mrr: r2(mrrByMonth[ym] || 0), spend: r2(spendByMonth[ym] || 0)
  }));

  // Cada linha: reais + Expected (baseline = média das safras n-2, n-3, n-4)
  const rows = base.map((b, i) => {
    const spend = b.spend;
    const roas = spend ? r2(b.mrr / spend) : null;
    const cac = b.ganho ? r2(spend / b.ganho) : null;
    const ltv = r2(b.mrr * 8);
    const ltvCac = (cac && ltv) ? r1(ltv / cac) : null;
    const ticketMedio = b.ganho ? r2(b.mrr / b.ganho) : null;
    const payback = roas ? r1(1 / roas) : null;
    // Expected: usa as 3 safras maduras n-2, n-3, n-4 (pula a atual e a anterior)
    let expGanho = null, expMrr = null;
    const baseIdx = [i - 2, i - 3, i - 4].filter(j => j >= 0);
    if (baseIdx.length === 3) {
      const convs = baseIdx.filter(j => base[j].mql > 0).map(j => base[j].ganho / base[j].mql);
      const tickets = baseIdx.filter(j => base[j].ganho > 0).map(j => base[j].mrr / base[j].ganho);
      if (convs.length) {
        expGanho = r2((convs.reduce((a, c) => a + c, 0) / convs.length) * b.mql);
        if (tickets.length) expMrr = r2(expGanho * (tickets.reduce((a, c) => a + c, 0) / tickets.length));
      }
    }
    const expRoas = (spend && expMrr !== null) ? r2(expMrr / spend) : null;
    const expCac = expGanho ? r2(spend / expGanho) : null;
    const expLtv = (expMrr !== null) ? r2(expMrr * 8) : null;
    const expLtvCac = (expCac && expLtv !== null) ? r1(expLtv / expCac) : null;
    const expTicket = expGanho ? r2(expMrr / expGanho) : null;
    const expPayback = expRoas ? r1(1 / expRoas) : null;
    return {
      mes: b.ym, mql: b.mql, reuniao: b.reuniao, ganho: b.ganho, mrr: b.mrr, spend,
      roas, cac, ltv, ltvCac, ticketMedio, payback,
      expGanho, expMrr, expRoas, expCac, expLtv, expLtvCac, expTicket, expPayback
    };
  });

  // Gráfico (últimos 12 meses): barras empilhadas LTV vs Expected LTV + linha CAC.
  // base = min(LTV, ExpLTV); gap = falta p/ Expected (LTV<Exp); excedente = superou (LTV>Exp).
  const g = rows.slice(-12);
  const g12 = {
    labels:    g.map(r => r.mes),
    ltvBase:   g.map(r => r.expLtv !== null ? Math.min(r.ltv, r.expLtv) : r.ltv),
    gap:       g.map(r => r.expLtv !== null ? Math.max(0, r2(r.expLtv - r.ltv)) : 0),
    excedente: g.map(r => r.expLtv !== null ? Math.max(0, r2(r.ltv - r.expLtv)) : 0),
    cac:       g.map(r => r.cac),
    expLtv:    g.map(r => r.expLtv)
  };

  return { cohort: rows, g12 };
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

  // Gera os meses do ano corrente dinamicamente (janeiro até mês atual) — fuso de Brasília
  const [currentYear, currentMonth] = toYMD(new Date()).split('-').map(Number); // currentMonth = 1-12
  const MONTHS = [];
  for (let m = 1; m <= currentMonth; m++) {
    MONTHS.push(`${currentYear}-${String(m).padStart(2, '0')}`);
  }
  const from = brMidnight(currentYear, 0, 1); // 01/jan meia-noite Brasília
  const to   = new Date(); // até hoje

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
    // Se cache em memória existe e dentro do TTL, retorna imediatamente (< 1ms)
    if (MEM_CACHE['p1'] && MEM_CACHE['p1'].data && Date.now() - MEM_CACHE['p1'].ts < CACHE_TTL) {
      return res.json(MEM_CACHE['p1'].data);
    }
    // Verifica cache em disco
    const disk = readDiskCache('p1');
    if (disk) {
      // Se cache está fresco, carrega na memória e dispara revalidação em background
      const p1File = diskCachePath('p1');
      let diskTs = 0;
      try { diskTs = JSON.parse(fs.readFileSync(p1File, 'utf8')).ts; } catch (_) {}
      const diskFresh = diskTs && Date.now() - diskTs < CACHE_TTL;
      if (diskFresh) {
        MEM_CACHE['p1'] = { ts: diskTs, data: disk };
        return res.json(disk);
      }
      // Cache em disco expirado: serve stale e revalida em background
      console.log('[p1] cache expirado, servindo stale e revalidando em background...');
      MEM_CACHE['p1'] = { ts: Date.now(), data: disk }; // atualiza ts para evitar múltiplos rebuilds
      buildP1()
        .then(d => { MEM_CACHE['p1'] = { ts: Date.now(), data: d }; writeDiskCache('p1', d); console.log('[p1] revalidação OK'); })
        .catch(e => console.error('[p1] revalidação erro:', e.message));
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
    if (MEM_CACHE['p2'] && MEM_CACHE['p2'].data && Date.now() - MEM_CACHE['p2'].ts < CACHE_TTL) {
      return res.json(MEM_CACHE['p2'].data);
    }
    const disk = readDiskCache('p2');
    if (disk) {
      const p2File = diskCachePath('p2');
      let diskTs = 0;
      try { diskTs = JSON.parse(fs.readFileSync(p2File, 'utf8')).ts; } catch (_) {}
      const diskFresh = diskTs && Date.now() - diskTs < CACHE_TTL;
      if (diskFresh) {
        MEM_CACHE['p2'] = { ts: diskTs, data: disk };
        return res.json(disk);
      }
      console.log('[p2] cache expirado, servindo stale e revalidando em background...');
      MEM_CACHE['p2'] = { ts: Date.now(), data: disk };
      buildP2()
        .then(d => { MEM_CACHE['p2'] = { ts: Date.now(), data: d }; writeDiskCache('p2', d); console.log('[p2] revalidação OK'); })
        .catch(e => console.error('[p2] revalidação erro:', e.message));
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

// Diagnóstico Metabase — testa conectividade e retorna dados brutos
app.get('/api/debug/metabase', async (req, res) => {
  const results = {};
  try {
    results.health = await axios.get(MB_URL + '/api/health', {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }), timeout: 10000
    }).then(r => r.data).catch(e => ({ error: e.message, status: e.response?.status }));

    results.simpleQuery = await metabaseQuery(
      'SELECT COUNT(*) as total FROM data_analytics.google_campaigns WHERE YEAR(date) = 2026'
    ).catch(e => ({ error: e.message }));

    results.sampleRows = await metabaseQuery(
      'SELECT date, cost_brl, campaign_name FROM data_analytics.google_campaigns ORDER BY date DESC LIMIT 3'
    ).catch(e => ({ error: e.message }));

    results.monthlySpend = await metabaseQuery(
      "SELECT date_trunc('month', date) as mes, SUM(cost_brl) as spend FROM data_analytics.google_campaigns WHERE YEAR(date) = 2026 GROUP BY 1 ORDER BY 1"
    ).catch(e => ({ error: e.message }));

    // Diagnóstico p/ Ad Group / Keyword: colunas da tabela e tabelas do schema
    results.colunas = await metabaseQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'data_analytics' AND table_name = 'google_campaigns' ORDER BY column_name"
    ).catch(e => ({ error: e.message }));

    results.tabelas = await metabaseQuery(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'data_analytics' ORDER BY table_name"
    ).catch(e => ({ error: e.message }));

    results.colunasKw = await metabaseQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'data_analytics' AND table_name = 'google_keywords' ORDER BY column_name"
    ).catch(e => ({ error: e.message }));

  } catch (e) {
    results.fatalError = e.message;
  }
  res.json(results);
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

// Reconstrói P1+P2 e limpa todos os caches derivados (usado pelo force-refresh e pelo cron diário das 9h)
async function rebuildAllCaches(reason) {
  console.log(`[rebuild] (${reason}) iniciando rebuild do cache...`);
  delete MEM_CACHE['p1'];
  delete MEM_CACHE['p2'];
  memCache.g3Monthly = null;
  memCache.g3ts = 0;
  Object.keys(memCache).filter(k => k.startsWith('campaigns_') || k.startsWith('campts_')).forEach(k => { memCache[k] = null; });
  const [p1, p2] = await Promise.all([buildP1(), buildP2()]);
  MEM_CACHE['p1'] = { ts: Date.now(), data: p1 };
  MEM_CACHE['p2'] = { ts: Date.now(), data: p2 };
  writeDiskCache('p1', p1);
  writeDiskCache('p2', p2);
  console.log(`[rebuild] (${reason}) ✅ cache rebuilt com sucesso`);
}

// Força rebuild do cache (usado pelo agente diário)
app.post('/api/force-refresh', async (req, res) => {
  try {
    await rebuildAllCaches('force-refresh');
    res.json({ ok: true, ts: Date.now() });
  } catch (e) {
    console.error('[force-refresh] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Atualização automática diária (9h Brasília) ───────────────────────────
// Roda no PRÓPRIO servidor (Railway): todo dia, a partir das 9h BRT, fecha o
// D-1 reconstruindo P1+P2 — sem depender de comando externo ou app aberto.
// Também cobre restart/deploy após as 9h (primeiro tick reconstrói o dia).
let lastAutoRefreshDay = null;
setInterval(async () => {
  try {
    const br = new Date(Date.now() - BR_OFFSET_MS); // relógio de Brasília
    const day = br.toISOString().slice(0, 10);
    if (br.getUTCHours() >= 9 && lastAutoRefreshDay !== day) {
      lastAutoRefreshDay = day; // marca antes para evitar rebuilds concorrentes
      await rebuildAllCaches(`auto-9h ${day}`);
    }
  } catch (e) {
    lastAutoRefreshDay = null; // falhou → tenta de novo no próximo tick
    console.error('[auto-refresh-9h] erro:', e.message);
  }
}, 5 * 60 * 1000); // checa a cada 5 minutos

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
