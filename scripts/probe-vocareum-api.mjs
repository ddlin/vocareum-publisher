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
    // === Assignment Settings Update Probes ===
    // Test various field combinations to discover which are accepted
    {
      name: 'asn-settings-name-only',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { name: 'Test Assignment Name' },
    },
    {
      name: 'asn-settings-description',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { description: 'Test description' },
    },
    {
      name: 'asn-settings-points',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { points: '100' },
    },
    {
      name: 'asn-settings-grade',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { grade: '100' },
    },
    {
      name: 'asn-settings-maxgrade',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { maxgrade: '100' },
    },
    {
      name: 'asn-settings-published',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { published: true },
    },
    {
      name: 'asn-settings-visible',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { visible: true },
    },
    {
      name: 'asn-settings-active',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { active: true },
    },
    {
      name: 'asn-settings-status',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { status: 'active' },
    },
    {
      name: 'asn-settings-due_date',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { due_date: '2026-12-31T23:59:00Z' },
    },
    {
      name: 'asn-settings-duedate',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { duedate: '2026-12-31T23:59:00Z' },
    },
    {
      name: 'asn-settings-update-flag',
      method: 'PUT',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { name: 'Test Name', update: 1 },
    },
    // === Part Settings Update Probes ===
    {
      name: 'part-settings-name-only',
      method: 'PUT',
      path: `/api/v2/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test Part Name' },
    },
    {
      name: 'part-settings-description',
      method: 'PUT',
      path: `/api/v2/parts/${partId ?? 'PART_ID'}`,
      body: { description: 'Test part description' },
    },
    {
      name: 'part-settings-update-flag',
      method: 'PUT',
      path: `/api/v2/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test Part', update: 1 },
    },
    {
      name: 'part-settings-cloud_labs',
      method: 'PUT',
      path: `/api/v2/parts/${partId ?? 'PART_ID'}`,
      body: { cloud_labs: true },
    },
    {
      name: 'part-settings-cloudlabs',
      method: 'PUT',
      path: `/api/v2/parts/${partId ?? 'PART_ID'}`,
      body: { cloudlabs: true },
    },
    {
      name: 'part-settings-session_length',
      method: 'PUT',
      path: `/api/v2/parts/${partId ?? 'PART_ID'}`,
      body: { session_length: '3600' },
    },
    {
      name: 'part-settings-sessionlength',
      method: 'PUT',
      path: `/api/v2/parts/${partId ?? 'PART_ID'}`,
      body: { sessionlength: '3600' },
    },
    {
      name: 'part-settings-submission_filters',
      method: 'PUT',
      path: `/api/v2/parts/${partId ?? 'PART_ID'}`,
      body: { submission_filters: { include: ['*.py'], exclude: ['*.pyc'] } },
    },
    // Test GET endpoints for assignment/part to see what fields are returned
    {
      name: 'asn-get-single',
      method: 'GET',
      path: `/api/v2/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
    },
    {
      name: 'part-get-single',
      method: 'GET',
      path: `/api/v2/parts/${partId ?? 'PART_ID'}`,
    },
    // === Course-scoped assignment/part endpoints (alternative paths) ===
    {
      name: 'asn-course-scoped-get',
      method: 'GET',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
    },
    {
      name: 'asn-course-scoped-put-name',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { name: 'Test Assignment Name' },
    },
    {
      name: 'asn-course-scoped-put-update',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { name: 'Test Assignment Name', update: 1 },
    },
    {
      name: 'asn-course-scoped-put-published',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { published: true, update: 1 },
    },
    {
      name: 'asn-course-scoped-put-points',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { points: '100', update: 1 },
    },
    {
      name: 'asn-course-scoped-put-description',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { description: 'Test description', update: 1 },
    },
    {
      name: 'part-course-scoped-get',
      method: 'GET',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
    },
    {
      name: 'part-course-scoped-put-name',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test Part Name' },
    },
    {
      name: 'part-course-scoped-put-update',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test Part Name', update: 1 },
    },
    {
      name: 'part-course-scoped-put-description',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { description: 'Test part description', update: 1 },
    },
    // Empty body variants
    {
      name: 'asn-course-scoped-put-empty',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: {},
    },
    {
      name: 'part-course-scoped-put-empty',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: {},
    },
    // === Test actual fields from GET response ===
    // Assignment fields (from GET response)
    {
      name: 'asn-put-nosubmit',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { nosubmit: true },
    },
    {
      name: 'asn-put-auto_submit',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { auto_submit: true },
    },
    {
      name: 'asn-put-grading_on_submit',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { grading_on_submit: false },
    },
    {
      name: 'asn-put-gradespublished',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}`,
      body: { gradespublished: true },
    },
    // Part fields (from GET response)
    {
      name: 'part-put-cloud_labs-bool',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', cloud_labs: true },
    },
    {
      name: 'part-put-session_length',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', session_length: '3600' },
    },
    {
      name: 'part-put-instant_aws',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', instant_aws_access: true },
    },
    {
      name: 'part-put-submission_filters',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', submission_filters: ['*.py'] },
    },
    {
      name: 'part-put-labtype',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', labtype: 'Visual Studio Code' },
    },
    {
      name: 'part-put-monthly_dollar',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', monthly_dollar: '10' },
    },
    {
      name: 'part-put-total_time',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', total_time: '600' },
    },
    // Test name-only for parts again (separate to avoid rate limit)
    {
      name: 'part-put-name-only-v2',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Part 1 Updated' },
    },
    // === Additional part settings from user list ===
    {
      name: 'part-put-late_penalty_percent',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', late_penalty_percent: 10 },
    },
    {
      name: 'part-put-late_penalty_rule',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', late_penalty_percent_rule: 'max score' },
    },
    {
      name: 'part-put-deadlinedate',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', deadlinedate: '2026-12-31T23:59:00Z' },
    },
    {
      name: 'part-put-endlab',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', endlab: 'stop' },
    },
    {
      name: 'part-put-number_of_submissions',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', number_of_submissions: 5 },
    },
    {
      name: 'part-put-lab_interface',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', lab_interface: { panels: ['Console'], controls: ['Reset'], information: [], launch_behavior: [], grades: [] } },
    },
    {
      name: 'part-put-tags',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', tags: ['python', 'beginner'] },
    },
    {
      name: 'part-put-container_image',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', labtype: 'Visual Studio Code', container_image: 'Visual Studio Code v2.24' },
    },
    {
      name: 'part-put-databricks_maxusers',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', databricks_maxusers: 100 },
    },
    {
      name: 'part-put-total_dollar',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', total_dollar: '50' },
    },
    {
      name: 'part-put-monthly_time',
      method: 'PUT',
      path: `/api/v2/courses/${courseId ?? 'COURSE_ID'}/assignments/${assignmentId ?? 'ASSIGNMENT_ID'}/parts/${partId ?? 'PART_ID'}`,
      body: { name: 'Test', monthly_time: '1000' },
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
