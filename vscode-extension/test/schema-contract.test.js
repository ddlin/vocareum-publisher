const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schemaPath = path.join(__dirname, '..', 'schemas', 'vocareum.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

test('publish_options.on_missing_id supports skip|abort', () => {
  const onMissingId = schema.properties.publish_options.properties.on_missing_id;
  assert.deepEqual(onMissingId.enum, ['skip', 'abort']);
});

test('template schema requires course_id', () => {
  const required = schema.properties.vocareum.properties.templates.items.required;
  assert.ok(required.includes('course_id'));
});

test('assignment schema includes create_from_template and required ids/parts', () => {
  const assignment = schema.properties.assignments.items;
  assert.ok(assignment.required.includes('assignment_id'));
  assert.ok(assignment.required.includes('parts'));
  assert.equal(assignment.properties.create_from_template.type, 'boolean');
});

test('part schema requires part_id and path but not name', () => {
  const part = schema.properties.assignments.items.properties.parts.items;
  assert.ok(part.required.includes('part_id'));
  assert.ok(part.required.includes('path'));
  assert.equal(part.required.includes('name'), false);
});
