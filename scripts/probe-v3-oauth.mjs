#!/usr/bin/env node
// Live v3 OAuth smoke. Read-only by default.
//   node scripts/probe-v3-oauth.mjs                 # token exchange + list courses/assignments
//   node scripts/probe-v3-oauth.mjs --write --rw-template-id <id>
// --write copies a template into a "vocgit-smoke-YYYYMMDD-HHMMSS" assignment,
// polls the transaction, updates the copied assignment + part name, verifies
// readback, and NEVER deletes. Manual cleanup required in the Vocareum UI.
import { existsSync, readFileSync } from 'fs';
import axios from 'axios';
import { createHash } from 'crypto';

const envPath = new URL('../.env', import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i <= 0) continue;
    const k = t.slice(0, i).trim().replace(/^export\s+/, ''); let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const doWrite = process.argv.includes('--write');
const clientId = process.env.VOCAREUM_OAUTH_CLIENT_ID ?? process.env.VOCAREUM_INSTRUCTOR_RW_V3;
const clientSecret = process.env.VOCAREUM_OAUTH_CLIENT_SECRET ?? process.env.VOCAREUM_INSTRUCTOR_RW_SEC_V3;
const courseId = process.env.VOCAREUM_API_TEST_COURSEID ?? arg('--course-id');
const V3 = process.env.VOCAREUM_API_V3_BASE_URL ?? 'https://labs.vocareum.com/api/v3';
const TOKEN_URL = process.env.VOCAREUM_OAUTH_TOKEN_URL ?? `${V3}/oauth/token`;
if (!clientId || !clientSecret || !courseId) { console.error('Missing client creds or course id'); process.exit(1); }
console.log(`client sha256=${createHash('sha256').update(clientId).digest('hex').slice(0, 12)}…  course=${courseId}  write=${doWrite}`);

const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

try {
  const tok = await axios.post(TOKEN_URL, form({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  console.log(`token: ${tok.status} type=${tok.data.token_type} expires_in=${tok.data.expires_in}`);
  const api = axios.create({ baseURL: V3, headers: { Authorization: `Bearer ${tok.data.access_token}`, 'Content-Type': 'application/json' }, timeout: 30000 });

  const courses = await api.get('/courses');
  console.log(`GET /courses -> ${courses.status} count=${(courses.data.courses ?? []).length}`);
  const asn = await api.get(`/courses/${courseId}/assignments`);
  console.log(`GET /courses/${courseId}/assignments -> ${asn.status} count=${(asn.data.assignments ?? []).length}`);

  if (!doWrite) { console.log('read-only smoke OK'); process.exit(0); }

  const templateId = arg('--rw-template-id');
  if (!templateId) { console.error('--write requires --rw-template-id <id>'); process.exit(1); }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = `vocgit-smoke-${stamp}`;
  const copy = await api.post(`/courses/${courseId}/assignments`, { method: 'copy', source: templateId, name });
  console.log(`copy -> ${copy.status} txn=${copy.data.transactionid ?? copy.data.objid}`);
  let objid = copy.data.objid;
  if (copy.data.transactionid) {
    for (let i = 0; i < 15; i++) {
      const txn = await api.get(`/transaction/${copy.data.transactionid}`);
      if (txn.data.state === 'success') { objid = txn.data.objid ?? objid; break; }
      if (txn.data.state === 'error' || txn.data.state === 'failed') { console.error(`txn ${txn.data.state}`); process.exit(2); }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log(`created assignment ${objid} ("${name}") — LEFT IN COURSE, manual cleanup`);
  const upd = await api.put(`/courses/${courseId}/assignments/${objid}`, { name: `${name}-renamed` });
  console.log(`update assignment name -> ${upd.status}`);
  const back = await api.get(`/courses/${courseId}/assignments`);
  const found = (back.data.assignments ?? []).find((a) => String(a.id) === String(objid));
  console.log(`assignment readback name="${found?.name}" (expected "${name}-renamed")`);

  const partsRes = await api.get(`/courses/${courseId}/assignments/${objid}/parts`);
  const parts = partsRes.data.parts ?? [];
  if (parts.length === 0) { console.error('copied assignment has no parts to update'); process.exit(2); }
  const partId = parts[0].id;
  const partName = `${name}-part-renamed`;
  const pUpd = await api.put(`/courses/${courseId}/assignments/${objid}/parts/${partId}`, { name: partName });
  console.log(`update part name -> ${pUpd.status}`);
  if (pUpd.data?.transactionid) {
    for (let i = 0; i < 15; i++) {
      const txn = await api.get(`/transaction/${pUpd.data.transactionid}`);
      if (txn.data.state === 'success') break;
      if (txn.data.state === 'error' || txn.data.state === 'failed') { console.error(`part txn ${txn.data.state}`); process.exit(2); }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const partsBack = await api.get(`/courses/${courseId}/assignments/${objid}/parts`);
  const pFound = (partsBack.data.parts ?? []).find((p) => String(p.id) === String(partId));
  console.log(`part readback name="${pFound?.name}" (expected "${partName}")`);
  console.log('write smoke OK');
  process.exit(0);
} catch (e) {
  // Redacted: never print the error object/config (an axios error's config.data
  // can contain the urlencoded client_secret).
  const status = e?.response?.status;
  const apiErr = e?.response?.data?.error ?? e?.response?.data?.message;
  console.error(`smoke failed: ${status ? `HTTP ${status}` : (e?.code ?? 'error')}${apiErr ? ` (${apiErr})` : ''}`);
  process.exit(1);
}
