'use strict';
// Agente diário de refresh do cache — roda via Windows Task Scheduler às 06:00
// Bate no endpoint /api/force-refresh para rebuild do P1 e P2

const http = require('http');

const PORT = process.env.PORT || 3002;
const LOG  = `[refresh-cache ${new Date().toISOString()}]`;

function post(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: PORT, path, method: 'POST' }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { resolve({ raw: body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('timeout 5min')); });
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: 'localhost', port: PORT, path }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { resolve({ raw: body }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log(`${LOG} iniciando...`);

  // Verifica se servidor está no ar
  try {
    const status = await get('/api/status');
    console.log(`${LOG} servidor OK — cache P1 age: ${status.cache?.p1?.age_min}min, P2 age: ${status.cache?.p2?.age_min}min`);
  } catch (e) {
    console.error(`${LOG} servidor não responde em localhost:${PORT} — abortando`);
    process.exit(1);
  }

  // Força rebuild do cache
  console.log(`${LOG} disparando force-refresh...`);
  try {
    const result = await post('/api/force-refresh');
    if (result.ok) {
      console.log(`${LOG} cache rebuilt com sucesso — ts: ${new Date(result.ts).toISOString()}`);
    } else {
      console.error(`${LOG} force-refresh retornou erro:`, result);
      process.exit(1);
    }
  } catch (e) {
    console.error(`${LOG} erro no force-refresh:`, e.message);
    process.exit(1);
  }

  console.log(`${LOG} concluído.`);
}

main();
