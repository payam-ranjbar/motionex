// Tool documentation rendered from live registry entries (ToolInfo objects).
// `flattenSchema` turns an input schema into table rows; `renderToolDoc` / `renderToolDocs` turn them into
// markdown for the agent skill (GET /v1/skill/references/tools.md). Nothing here enforces or validates anything.

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @typedef {object} SchemaRow
 * @property {string} field  dotted path; nested objects use "." and array items end with "[]"
 * @property {string} [type] JSON type, types joined by "|", "enum" for an enum, "ref" for an x-mx-ref string
 * @property {boolean} [required] the parent object lists this property in "required"
 * @property {string} [default] the default, JSON-stringified
 * @property {string} [description]
 * @property {unknown[]} [enum] the allowed values, when the schema is an enum
 */

/** The type column: "ref" for refs, "enum" for enums, otherwise the JSON type(s). */
function typeOf(schema) {
  if (schema['x-mx-ref'] === true) return 'ref';
  if (Array.isArray(schema.enum)) return 'enum';
  const t = schema.type;
  if (Array.isArray(t)) return t.join('|');
  return typeof t === 'string' ? t : '';
}

/** A table row for one schema property. */
function makeRow(field, schema, required) {
  const row = { field, type: typeOf(schema), required: Boolean(required) };
  if (Object.hasOwn(schema, 'default')) row.default = JSON.stringify(schema.default);
  row.description = typeof schema.description === 'string' ? schema.description : '';
  if (Array.isArray(schema.enum)) row.enum = [...schema.enum];
  return row;
}

/** A branch of "a OR b" that only says which keys are required. */
const isRequiredOnlyBranch = (branch) =>
  isPlainObject(branch) && Array.isArray(branch.required) && Object.keys(branch).every((k) => k === 'required');

/** Note rows for oneOf/anyOf branches that only list required keys. */
function noteRows(schema) {
  const rows = [];
  for (const key of ['oneOf', 'anyOf']) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const names = branches.filter(isRequiredOnlyBranch).flatMap((b) => b.required.filter((n) => typeof n === 'string'));
    if (names.length) rows.push({ field: '(one of)', description: names.join(' | ') });
  }
  return rows;
}

/** Rows for the children of an object schema (prefix "" at the top level). */
function walkObject(schema, prefix, rows) {
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [name, child] of Object.entries(props)) {
    if (!isPlainObject(child)) continue;
    const field = prefix ? `${prefix}.${name}` : name;
    rows.push(makeRow(field, child, required.has(name)));
    descend(child, field, rows);
  }
  rows.push(...noteRows(schema));
}

/** Rows for the children of one property (nested objects and array items). */
function descend(schema, field, rows) {
  const props = isPlainObject(schema.properties) ? schema.properties : null;
  if (props && Object.keys(props).length > 0) {
    walkObject(schema, field, rows);
    return;
  }
  const item = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  if (!isPlainObject(item) || !typeOf(schema).includes('array')) return;
  const itemField = `${field}[]`;
  if (isPlainObject(item.properties) && Object.keys(item.properties).length > 0) {
    walkObject(item, itemField, rows);
    return;
  }
  rows.push(makeRow(itemField, item, false));
  descend(item, itemField, rows);
}

/**
 * Flatten an input schema into table rows: one row per (nested) property, plus a note row per
 * oneOf/anyOf group that only lists required keys.
 * @param {object} schema JSON Schema (the tool's input_schema)
 * @returns {SchemaRow[]}
 */
export function flattenSchema(schema) {
  const rows = [];
  if (!isPlainObject(schema)) return rows;
  walkObject(schema, '', rows);
  return rows;
}

/** Collapse to one line (table cells and headings cannot hold newlines). */
const oneLine = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** A markdown table cell: one line, with "|" escaped. */
const cell = (value) => oneLine(value).replace(/\|/g, '\\|');

/** The "class: ... · deterministic: ..." line for a tool. */
function metaLine(info) {
  const parts = [
    `class: ${info.resources?.class ?? 'light'}`,
    `deterministic: ${info.deterministic ? 'yes' : 'no'}`,
    `cache: ${info.cache_default ?? 'off'}`,
    `version ${info.version ?? '0.0.0'}`,
  ];
  if (info.available === false) parts.push(`unavailable: ${oneLine(info.unavailable_reason ?? 'unknown reason')}`);
  if (Array.isArray(info.implements) && info.implements.length > 0)
    parts.push(
      `implements: ${info.implements.map((i) => `${oneLine(i.contract)} (provider ${oneLine(i.provider)})`).join(', ')}`,
    );
  if (Array.isArray(info.preset_names) && info.preset_names.length > 0)
    parts.push(`presets: ${info.preset_names.map(oneLine).join(', ')}`);
  return parts.join(' · ');
}

/** The input table rows of a schema as markdown lines. */
function inputTable(schema) {
  const lines = ['| field | type | required | default | description |', '| --- | --- | --- | --- | --- |'];
  for (const row of flattenSchema(schema)) {
    lines.push(
      `| ${cell(row.field)} | ${cell(row.type)} | ${row.required ? 'yes' : ''} | ${cell(row.default)} | ${cell(row.description)} |`,
    );
  }
  return lines;
}

/**
 * Markdown for one contract (contractInfo): heading, summary, providers, the shared input table, examples.
 * @param {object} info
 * @returns {string}
 */
export function renderContractDoc(info) {
  const lines = [`## ${info.name} (contract)`, ''];
  if (info.title || info.summary) lines.push(`**${oneLine(info.title || info.name)}**: ${oneLine(info.summary)}`, '');
  if (info.description) lines.push(oneLine(info.description), '');
  const providers = (info.providers ?? []).map(
    (p) =>
      `${oneLine(p.provider)} → ${oneLine(p.tool)}${p.available ? '' : ` (unavailable: ${oneLine(p.unavailable_reason ?? 'unknown reason')})`}`,
  );
  lines.push(
    `providers: ${providers.length ? providers.join(' · ') : 'none installed'} · version ${info.version ?? '0.0.0'}`,
    '',
  );
  if (info.outputs) lines.push(`outputs: ${oneLine(info.outputs)}`, '');
  lines.push(...inputTable(info.input_schema));
  for (const ex of info.examples ?? []) {
    const job = { tool: info.name, input: ex.input ?? {} };
    lines.push('', `### Example: ${oneLine(ex.title)}`, '', '```json', JSON.stringify(job, null, 2), '```');
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/**
 * Markdown for one tool (ToolInfo): heading, summary, description, meta line, input table, examples.
 * @param {import('../runner/types.mjs').ToolInfo} info
 * @returns {string}
 */
export function renderToolDoc(info) {
  const lines = [`## ${info.name}`, ''];
  if (info.title || info.summary) lines.push(`**${oneLine(info.title || info.name)}**: ${oneLine(info.summary)}`, '');
  if (info.description) lines.push(oneLine(info.description), '');
  lines.push(metaLine(info), '');
  lines.push(...inputTable(info.input_schema));
  for (const ex of info.examples ?? []) {
    lines.push('', `### Example: ${oneLine(ex.title)}`, '', '```json', JSON.stringify(ex.input ?? {}, null, 2), '```');
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

const REFS_INTRO =
  'Every motionex tool takes a JSON object. Any file input is a ref: a workspace path such as ' +
  '`films/a/tone.wav`, `job:<id>/<output-path>` for an output of an earlier job, `pin:<name>` for everything in a pin, ' +
  'or `pin:<name>#<output-path>` for one output of a pin. The service resolves refs to files before the tool runs; ' +
  'write outputs through the tool that produces them. Tools enforce nothing beyond their own parameters: defaults are ' +
  'neutral, and every opinion (ducking, loudness target, fps, size, codec) is an explicit field or a named preset.';

const CONTRACTS_INTRO =
  'A contract is one capability with several providers (voice.speak: piper or elevenlabs). Submit a job with the ' +
  'contract as the tool and pick the provider in the input: `{"tool": "voice.speak", "input": {"provider": "piper", ' +
  '...}}`. Every provider takes the contract fields below with the same meaning and returns the same result fields, ' +
  "so switching provider changes nothing downstream; each provider's own tool (listed) documents its extra fields.";

/**
 * Markdown for a whole registry: title, refs intro, index, contracts, then every tool sorted by name.
 * @param {import('../runner/types.mjs').ToolInfo[]} infos
 * @param {{title?: string, contracts?: object[]}} [opts] contracts: registry.listContracts()
 * @returns {string}
 */
export function renderToolDocs(infos, { title = 'motionex tools', contracts = [] } = {}) {
  const sorted = [...(infos ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const lines = [`# ${title}`, '', REFS_INTRO, '', '## Index', ''];
  if (sorted.length === 0) lines.push('(no tools registered)');
  for (const c of contracts) lines.push(`- **${c.name}** (contract) — ${oneLine(c.summary)}`);
  for (const info of sorted) lines.push(`- **${info.name}** — ${oneLine(info.summary)}`);
  if (contracts.length > 0) lines.push('', '# Contracts', '', CONTRACTS_INTRO);
  for (const c of contracts) lines.push('', renderContractDoc(c).trimEnd());
  if (contracts.length > 0) lines.push('', '# Tools');
  for (const info of sorted) lines.push('', renderToolDoc(info).trimEnd());
  return `${lines.join('\n')}\n`;
}
