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

// PROBE 2 — write shapes. Scratch course only.
//
// These shapes are not guesses; they were established live on 2026-09-04 against org 335.
// The known-rejected variants are kept on purpose,
// as a regression check that the contract has not shifted.
async function probeWrite(http, c, a, p) {
  const rejected = [
    { label: 'bare-object (expect 400: missing rubrics array)',
      body: { name: 'vocgit probe rejected A', maxscore: '3' } },
    { label: 'wrapped-array WITH seqnum (expect 400: Invalid attribure post rubric request: seqnum)',
      body: { rubrics: [{ name: 'vocgit probe rejected B', seqnum: '98', maxscore: '2' }] } },
  ];
  for (const { label, body } of rejected) {
    const res = await http.post(rubricsUrl(c, a, p), body);
    console.log(JSON.stringify({ probe: 'POST-rejected', label, status: res.status, data: res.data }, null, 2));
    if (res.status === 200) { console.log('!! CONTRACT CHANGED: a previously rejected POST shape now succeeds.'); }
  }

  // Known-GOOD: wrapped array, NO seqnum (server assigns it by append order).
  const good = await http.post(rubricsUrl(c, a, p), { rubrics: [
    { name: 'vocgit probe A', maxscore: '7' },
    { name: 'vocgit probe B auto', maxscore: '3', auto: true },
    { name: 'vocgit probe C excluded', maxscore: '4', exclude: true },
  ] });
  console.log(JSON.stringify({ probe: 'POST', label: 'wrapped-array, no seqnum', status: good.status, data: good.data }, null, 2));
  // NOTE: POST responses type `id`/`seqnum` as NUMBERS; GET returns them as strings.
  const created = (good.data?.rubrics ?? []).map((r) => String(r.id));

  console.log(JSON.stringify({ probe: 'POST-readback', rubrics: (await http.get(rubricsUrl(c, a, p))).data?.rubrics }, null, 2));

  // PUT is COLLECTION-scoped and partial; /rubrics/{id} returns 400 "missing rubrics array".
  const putById = await http.put(`${rubricsUrl(c, a, p)}/${created[0]}`, { maxscore: '9' });
  console.log(JSON.stringify({ probe: 'PUT-by-id (expect 400)', status: putById.status, data: putById.data }, null, 2));
  const put = await http.put(rubricsUrl(c, a, p), { rubrics: [{ id: created[0], maxscore: '9' }] });
  console.log(JSON.stringify({ probe: 'PUT-collection', status: put.status, data: put.data }, null, 2));

  // Reordering: a single-row seqnum was accepted-and-ignored on 2026-09-04.
  // UNRESOLVED then: whether sending the FULL array in the desired order reorders. Tested here.
  const one = await http.put(rubricsUrl(c, a, p), { rubrics: [{ id: created[2], seqnum: '1' }] });
  console.log(JSON.stringify({ probe: 'PUT-seqnum-single', status: one.status, data: one.data }, null, 2));

  const rows = ((await http.get(rubricsUrl(c, a, p))).data?.rubrics ?? []).map((r) => String(r.id)).reverse();
  const all = await http.put(rubricsUrl(c, a, p), { rubrics: rows.map((id, i) => ({ id, seqnum: String(i + 1) })) });
  console.log(JSON.stringify({ probe: 'PUT-seqnum-full-array', sentOrder: rows, status: all.status, data: all.data }, null, 2));
  console.log(JSON.stringify({ probe: 'PUT-seqnum-full-array-readback', rubrics: (await http.get(rubricsUrl(c, a, p))).data?.rubrics }, null, 2));

  // DELETE is COLLECTION-scoped like POST and PUT; /rubrics/{id} returns the same
  // 400 "missing rubrics array". Batch delete works — several ids in one call.
  const delById = await http.delete(`${rubricsUrl(c, a, p)}/${created[0]}`);
  console.log(JSON.stringify({ probe: 'DELETE-by-id (expect 400)', status: delById.status, data: delById.data }, null, 2));
  const del = await http.delete(rubricsUrl(c, a, p), { data: { rubrics: created.map((id) => ({ id })) } });
  console.log(JSON.stringify({ probe: 'DELETE-collection (batch)', status: del.status, data: del.data }, null, 2));
  if (del.status === 403) {
    console.log('   (403 = this token lacks the rubrics DELETE scope, not a wrong shape)');
  }
  console.log(JSON.stringify({ probe: 'DELETE-readback', rubrics: (await http.get(rubricsUrl(c, a, p))).data?.rubrics }, null, 2));
}

// PROBE 3 — is max_points derived from rubric maxscore?
//
// Reads max_points and the rubric total before, after adding a criterion, and after
// excluding that same criterion. The exclude step is the control that separates
// "derived from all rows" from "derived from non-excluded rows" — without it, a single
// add only shows the two move together.
async function probeMaxPoints(http, c, a, p) {
  const readPoints = async (label) => {
    const r = await http.get(`/courses/${c}/assignments/${a}/parts`);
    const part = (r.data?.parts ?? []).find((x) => String(x.id) === String(p));
    console.log(JSON.stringify({ probe: `max_points-${label}`, max_points: part?.max_points }, null, 2));
  };
  const rubricTotal = async (label) => {
    const rows = (await http.get(rubricsUrl(c, a, p))).data?.rubrics ?? [];
    const sumAll = rows.reduce((s, x) => s + Number(x.maxscore || 0), 0);
    const sumIncluded = rows.filter((x) => x.exclude !== true).reduce((s, x) => s + Number(x.maxscore || 0), 0);
    console.log(JSON.stringify({ probe: `rubric-total-${label}`, rows: rows.length, sumAll, sumIncluded }, null, 2));
  };

  await readPoints('before'); await rubricTotal('before');

  const res = await http.post(rubricsUrl(c, a, p), { rubrics: [{ name: 'vocgit points probe', maxscore: '13' }] });
  console.log(JSON.stringify({ probe: 'max_points-create', status: res.status, data: res.data }, null, 2));
  const id = String((res.data?.rubrics ?? [])[0]?.id ?? '');
  await readPoints('after-add'); await rubricTotal('after-add');

  if (id) {
    const ex = await http.put(rubricsUrl(c, a, p), { rubrics: [{ id, exclude: true }] });
    console.log(JSON.stringify({ probe: 'max_points-exclude', status: ex.status, data: ex.data }, null, 2));
    await readPoints('after-exclude'); await rubricTotal('after-exclude');
  }

  console.log('NOTE: this probe leaves a criterion behind; remove it by hand (DELETE scope permitting).');
}

const c = argValue('--course');
const a = argValue('--assignment');
const p = argValue('--part');
if (!c || !a || !p) {
  console.error('Usage: npm run probe:rubrics -- --course C --assignment A --part P [--write] [--points]');
  process.exit(1);
}

let http;
try {
  http = client();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

await probePagination(http, c, a, p);
if (process.argv.includes('--write')) { await probeWrite(http, c, a, p); }
if (process.argv.includes('--points')) { await probeMaxPoints(http, c, a, p); }
