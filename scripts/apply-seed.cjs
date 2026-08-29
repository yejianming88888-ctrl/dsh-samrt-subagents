#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const HOST = process.env.DSH_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_PORT || 3080);
const ROUTE = '/dsh-smart-subagent-orchestrator/settings';

function request(method, urlPath, body, extraHeaders) {
  const headers = Object.assign(
    {},
    body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
    { host: `${HOST}:${PORT}` },
    extraHeaders || {}
  );
  if (method !== 'GET' && body) {
    if (!headers.origin) headers.origin = `http://${HOST}:${PORT}`;
    if (!headers['sec-fetch-site']) headers['sec-fetch-site'] = 'same-origin';
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let payload = null;
          if (text) {
            try { payload = JSON.parse(text); } catch { payload = text; }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: payload });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function loadJson(name) {
  const full = path.join(__dirname, '..', 'drafts', name);
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw);
}

function buildStore() {
  const dev = loadJson('dev-profile.json');
  const drama = loadJson('drama-profile.json');
  const writing = loadJson('writing-profile.json');
  return {
    profiles: [dev, drama, writing],
    globalProfileId: dev.id
  };
}

function toBackendShape(store) {
  return {
    profiles: store.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      settings: profile.settings
    })),
    globalProfileId: store.globalProfileId
  };
}

async function main() {
  const store = buildStore();
  const section = toBackendShape(store);
  console.log(`→ GET ${ROUTE}`);
  const current = await request('GET', ROUTE);
  if (current.status !== 200) {
    console.error('GET failed:', current.status, current.body);
    process.exit(1);
  }
  if (!current.body || current.body.writable !== true) {
    console.error('Settings namespace is not writable from loopback:', current.body);
    process.exit(1);
  }
  const revision = current.body.descriptor?.revision;
  console.log(`  revision=${revision}`);
  console.log(`→ PUT ${ROUTE} with ${section.profiles.length} profiles, global=${section.globalProfileId}`);
  const put = await request(
    'PUT',
    ROUTE,
    JSON.stringify({ section, expectedRevision: revision })
  );
  if (put.status !== 200) {
    console.error('PUT failed:', put.status, put.body);
    process.exit(1);
  }
  console.log('✓ Settings replaced. New revision:', put.body?.descriptor?.revision);
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});