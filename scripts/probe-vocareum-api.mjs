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

async function main() {
  loadDotEnvIfNeeded();

  const apiKey = (process.env.VOCAREUM_API_KEY || process.env.VOCAREUM_API_TOKEN)?.trim();
  if (!apiKey) {
    console.error(
      'Missing token. Add VOCAREUM_API_KEY=... (or VOCAREUM_API_TOKEN=...) to .env.'
    );
    process.exit(1);
  }

  const courseId = argValue('--course-id');
  const assignmentId = argValue('--assignment-id');
  const partId = argValue('--part-id');
  const templateId = argValue('--template-id') ?? assignmentId;
  const baseUrl = (process.env.VOCAREUM_API_BASE_URL || 'https://api.vocareum.com').replace(/\/+$/, '');

  const headers = {
    Authorization: `Token ${apiKey}`,
  };

  const probes = [
    { name: 'course-v1', method: 'GET', path: `/v1/courses/${courseId ?? 'COURSE_ID'}` },
    { name: 'course-v2', method: 'GET', path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}` },
    { name: 'assignments-v1', method: 'GET', path: `/v1/courses/${courseId ?? 'COURSE_ID'}/assignments` },
    { name: 'assignments-v2', method: 'GET', path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments` },
    { name: 'parts-v1', method: 'GET', path: `/v1/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts` },
    { name: 'parts-v2', method: 'GET', path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts` },
    {
      name: 'upload-v1-multipart-endpoint-shape',
      method: 'POST',
      path: `/v1/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}/files`,
      body: { type: 'startercode' },
    },
    {
      name: 'upload-v2-generic',
      method: 'POST',
      path: '/api/v2/upload',
      body: { type: 'startercode' },
    },
    {
      name: 'copy-v2-doc-contract',
      method: 'POST',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments`,
      body: {
        method: 'copy',
        source: templateId ?? 'ASSIGNMENT_ID',
        name: 'Probe Copy',
      },
    },
  ];

  console.log(`Base URL: ${baseUrl}`);
  console.log('Endpoint probe results:');

  for (const probe of probes) {
    if (
      probe.path.includes('COURSE_ID') ||
      probe.path.includes('ASSIGNMENT_ID') ||
      probe.path.includes('PART_ID')
    ) {
      console.log(`${probe.name.padEnd(36)} SKIP (missing required IDs for this probe)`);
      continue;
    }

    try {
      const res = await axios.request({
        method: probe.method,
        url: `${baseUrl}${probe.path}`,
        headers,
        data: probe.body,
        timeout: 20000,
        validateStatus: () => true,
      });

      const contentType = String(res.headers['content-type'] || '');
      const shape =
        Array.isArray(res.data) ? 'array' : res.data && typeof res.data === 'object' ? 'object' : typeof res.data;
      const snippet =
        typeof res.data === 'string'
          ? res.data.slice(0, 120).replace(/\s+/g, ' ')
          : JSON.stringify(res.data).slice(0, 160);
      console.log(
        `${probe.name.padEnd(36)} ${String(res.status).padEnd(4)} ${probe.method} ${probe.path} ${shape} ${contentType} ${snippet}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${probe.name.padEnd(36)} ERR  ${probe.method} ${probe.path} ${message}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Probe failed: ${message}`);
  process.exit(1);
});
