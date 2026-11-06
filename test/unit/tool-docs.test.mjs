import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/lib/config.mjs';
import { flattenSchema, renderToolDoc, renderToolDocs } from '../../src/lib/tool-docs.mjs';
import { loadRegistry } from '../../src/registry/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKES = path.join(ROOT, 'test', 'fixtures', 'tools');
const manifest = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const loudness = () => manifest(path.join('tools', 'audio.loudness', 'tool.json'));
const loudnessInfo = (extra = {}) => ({
  ...loudness(),
  origin: 'builtin',
  available: true,
  unavailable_reason: null,
  ...extra,
});

test('flattenSchema: audio.loudness refs, nested objects, enums and defaults', () => {
  const rows = flattenSchema(loudness().input_schema);
  const input = rows.find((r) => r.field === 'input');
  assert.equal(input.type, 'ref');
  assert.equal(input.required, true);

  const curve = rows.find((r) => r.field === 'curve');
  assert.equal(curve.type, 'object');
  assert.equal(curve.required, false);
  assert.match(curve.description, /Also return a loudness curve/);

  const window = rows.find((r) => r.field === 'curve.window');
  assert.equal(window.type, 'enum');
  assert.equal(window.default, '"momentary"');
  assert.equal(window.required, false);
  assert.deepEqual(window.enum, ['momentary', 'short-term']);

  const step = rows.find((r) => r.field === 'curve.step_s');
  assert.equal(step.type, 'number');
  assert.equal(step.default, '0.1');
});

test('flattenSchema: array items use [], unions use |, required-only branches become a note', () => {
  const rows = flattenSchema({
    type: 'object',
    additionalProperties: false,
    required: ['name', 'tracks'],
    properties: {
      name: { type: 'string', description: 'A name.' },
      tracks: {
        type: 'array',
        description: 'The tracks.',
        items: {
          type: 'object',
          required: ['src'],
          properties: {
            src: { type: 'string', 'x-mx-ref': true, description: 'A file.' },
            clips: {
              type: 'array',
              description: 'The clips.',
              items: { type: 'object', properties: { start_s: { type: 'number', description: 'When.' } } },
            },
          },
        },
      },
      rate: { type: ['number', 'null'], description: 'Playback rate.' },
    },
    oneOf: [{ required: ['name'] }, { required: ['rate'] }],
  });
  assert.deepEqual(
    rows.map((r) => r.field),
    ['name', 'tracks', 'tracks[].src', 'tracks[].clips', 'tracks[].clips[].start_s', 'rate', '(one of)'],
  );
  assert.equal(rows.find((r) => r.field === 'tracks[].src').type, 'ref');
  assert.equal(rows.find((r) => r.field === 'tracks[].src').required, true);
  assert.equal(rows.find((r) => r.field === 'tracks[].clips[].start_s').type, 'number');
  assert.equal(rows.find((r) => r.field === 'rate').type, 'number|null');
  assert.deepEqual(rows.at(-1), { field: '(one of)', description: 'name | rate' });
});

test('renderToolDoc: heading, meta line, input table and an example block', () => {
  const md = renderToolDoc(loudnessInfo());
  assert.match(md, /^## audio\.loudness$/m);
  assert.match(md, /^\*\*Loudness \(EBU R128\)\*\*: Integrated loudness, loudness range/m);
  assert.match(md, /Measures the first audio stream with ffmpeg's ebur128 filter\./);
  assert.match(md, /^class: audio · deterministic: yes · cache: auto · version 1\.0\.0$/m);
  assert.match(md, /^\| field \| type \| required \| default \| description \|$/m);
  assert.match(md, /^\| --- \| --- \| --- \| --- \| --- \|$/m);
  assert.match(md, /^\| input \| ref \| yes \| {2}\| /m);
  assert.match(md, /^\| curve \| object \| {2}\| {2}\| /m);
  assert.match(md, /^\| curve\.window \| enum \| {2}\| "momentary" \| /m);
  assert.match(md, /^### Example: Summary of a file$/m);
  assert.match(md, /```json\n\{\n {2}"input": "tone\.wav"\n\}\n```/);
});

test('renderToolDoc: unavailability and preset names go on the meta line', () => {
  const md = renderToolDoc(
    loudnessInfo({ available: false, unavailable_reason: 'ffmpeg not found', preset_names: ['a', 'b'] }),
  );
  assert.match(
    md,
    /^class: audio · deterministic: yes · cache: auto · version 1\.0\.0 · unavailable: ffmpeg not found · presets: a, b$/m,
  );
});

test('renderToolDoc: a pipe in a description is escaped and does not split the row', () => {
  const md = renderToolDoc({
    name: 'fake.pipe',
    version: '1.0.0',
    title: 'Pipes',
    summary: 'Cells with | inside.',
    deterministic: true,
    cache_default: 'off',
    resources: { class: 'light' },
    available: true,
    unavailable_reason: null,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { enum: ['a|b', 'c'], description: 'left | right' },
      },
    },
    examples: [{ title: 'none', input: {} }],
  });
  assert.match(md, /left \\\| right/);
  assert.match(md, /Cells with \| inside\./); // prose outside tables keeps the plain pipe
  const row = md.split('\n').find((l) => l.startsWith('| mode '));
  assert.ok(row, 'mode row is rendered');
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 6, `5 columns in: ${row}`);
  assert.ok(row.includes('left \\| right'));
});

test('renderToolDocs: title, refs intro, index and every tool sorted by name', async () => {
  const config = loadConfig({ ...process.env, MX_TOOLS_DIRS: '' });
  const registry = await loadRegistry({ dirs: [{ path: FAKES, origin: 'builtin' }], config });
  const infos = registry.list();
  const md = renderToolDocs(infos);

  assert.match(md, /^# motionex tools$/m);
  assert.match(md, /`job:<id>\/<output-path>`/);
  assert.match(md, /`pin:<name>#<output-path>`/);
  assert.deepEqual(
    infos.map((t) => t.name),
    ['fake.cmd', 'fake.echo', 'fake.fail', 'fake.linger', 'fake.sleep'],
  );
  for (const name of ['fake.cmd', 'fake.echo', 'fake.fail', 'fake.linger', 'fake.sleep']) {
    assert.match(md, new RegExp(`^## ${name.replace(/\./g, '\\.')}$`, 'm'));
    assert.ok(md.includes(`- **${name}** — `), `index lists ${name}`);
  }
  assert.deepEqual(
    [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    ['Index', 'fake.cmd', 'fake.echo', 'fake.fail', 'fake.linger', 'fake.sleep'],
  );
  assert.match(renderToolDocs(infos, { title: 'custom title' }), /^# custom title$/m);
});
