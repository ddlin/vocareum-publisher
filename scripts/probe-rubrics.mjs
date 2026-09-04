import { existsSync, readFileSync } from 'fs';
import axios from 'axios';

function loadDotEnvIfNeeded() {
  if (
    (process.env.VOCAREUM_API_KEY && process.env.VOCAREUM_API_KEY.trim().length > 0) ||
    (process.env.VOCAREUM_API_TOKEN && process.env.VOCAREUM_API_TOKEN.trim().length > 0)
  ) {
    return;
  }
  if (!existsSync('.env')) {
    return;
  }

  const content = readFileSync('.env', 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const rawKey = trimmed.slice(0, idx).trim();
    const key = rawKey.replace(/^export\s+/, '');
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[idx + 1];
}

const BASE = process.env.VOCAREUM_API_BASE_URL ?? 'https://api.vocareum.com/api/v2';

function client() {
  loadDotEnvIfNeeded();
  const token = process.env.VOCAREUM_API_KEY ?? process.env.VOCAREUM_API_TOKEN;
  if (!token) { throw new Error('Set VOCAREUM_API_KEY or VOCAREUM_API_TOKEN'); }
  return axios.create({
    baseURL: BASE,
    headers: { Authorization: `Token ${token}` },
    validateStatus: () => true,
  });
}

function rubricsUrl(c, a, p) {
  return `/courses/${c}/assignments/${a}/parts/${p}/rubrics`;
}

// PROBE 1 — pagination. Does the endpoint page, and does `page` advance it?
async function probePagination(http, c, a, p) {
  const page0 = await http.get(rubricsUrl(c, a, p), { params: { page: 0, size: 100 } });
  const bare = await http.get(rubricsUrl(c, a, p));
  const page1 = await http.get(rubricsUrl(c, a, p), { params: { page: 1, size: 100 } });
  const ids = (r) => (r.data?.rubrics ?? []).map((x) => x.id);
  console.log(JSON.stringify({
    probe: 'pagination',
    total_records: bare.data?.total_records,
    bare_count: ids(bare).length,
    page0_count: ids(page0).length,
    page1_count: ids(page1).length,
    page1_ids_overlap_page0: ids(page1).filter((i) => ids(page0).includes(i)).length,
  }, null, 2));
}

// PROBE 2 — write shape. Scratch course only.
async function probeWrite(http, c, a, p) {
  const bodies = [
    { label: 'bare-object', body: { name: 'vocgit probe A', seqnum: '99', maxscore: '3' } },
    { label: 'wrapped-array', body: { rubrics: [{ name: 'vocgit probe B', seqnum: '98', maxscore: '2' }] } },
    { label: 'with-flags', body: { name: 'vocgit probe C', seqnum: '97', maxscore: '1', auto: true, exclude: false } },
  ];
  const created = [];
  for (const { label, body } of bodies) {
    const res = await http.post(rubricsUrl(c, a, p), body);
    console.log(JSON.stringify({ probe: 'POST', label, status: res.status, data: res.data }, null, 2));
    for (const r of res.data?.rubrics ?? []) { created.push(r.id); }
    if (res.data?.id) { created.push(res.data.id); }
  }
  const after = await http.get(rubricsUrl(c, a, p));
  console.log(JSON.stringify({ probe: 'POST-readback', rubrics: after.data?.rubrics }, null, 2));

  for (const id of created) {
    const put = await http.put(`${rubricsUrl(c, a, p)}/${id}`, { maxscore: '7' });
    console.log(JSON.stringify({ probe: 'PUT', id, status: put.status, data: put.data }, null, 2));
  }
  const afterPut = await http.get(rubricsUrl(c, a, p));
  console.log(JSON.stringify({ probe: 'PUT-readback', rubrics: afterPut.data?.rubrics }, null, 2));

  for (const id of created) {
    const del = await http.delete(`${rubricsUrl(c, a, p)}/${id}`);
    console.log(JSON.stringify({ probe: 'DELETE', id, status: del.status, data: del.data }, null, 2));
  }
}

// PROBE 3 — does creating rubric rows move the part's max_points?
async function probeMaxPoints(http, c, a, p) {
  const before = await http.get(`/courses/${c}/assignments/${a}/parts/${p}`);
  console.log(JSON.stringify({ probe: 'max_points-before', max_points: before.data?.parts?.[0]?.max_points }, null, 2));
  const res = await http.post(rubricsUrl(c, a, p), { name: 'vocgit points probe', seqnum: '96', maxscore: '13' });
  console.log(JSON.stringify({ probe: 'max_points-create', status: res.status, data: res.data }, null, 2));
  const after = await http.get(`/courses/${c}/assignments/${a}/parts/${p}`);
  console.log(JSON.stringify({ probe: 'max_points-after', max_points: after.data?.parts?.[0]?.max_points }, null, 2));
  console.log('NOTE: delete the probe row by hand or re-run --write to clean up.');
}

const http = client();
const c = argValue('--course');
const a = argValue('--assignment');
const p = argValue('--part');
if (!c || !a || !p) {
  console.error('Usage: npm run probe:rubrics -- --course C --assignment A --part P [--write] [--points]');
  process.exit(1);
}
await probePagination(http, c, a, p);
if (process.argv.includes('--write')) { await probeWrite(http, c, a, p); }
if (process.argv.includes('--points')) { await probeMaxPoints(http, c, a, p); }
