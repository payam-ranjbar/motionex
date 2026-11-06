// Ajv 2020 set up for tool schemas, with the `x-mx-ref` keyword that records where refs are.
import Ajv2020Module from 'ajv/dist/2020.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
let collector = null;

/**
 * Strict schema checking (unknown keywords are errors), union types allowed, defaults applied, all errors reported.
 * Rules for tool authors: never put `default` inside oneOf/anyOf/not/if; keep `x-mx-ref` out of oneOf/anyOf.
 */
export function createAjv() {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allowUnionTypes: true,
    useDefaults: true,
    allErrors: true,
  });
  ajv.addKeyword({
    keyword: 'x-mx-ref',
    type: 'string',
    schemaType: 'boolean',
    errors: false,
    validate: function xMxRef(on, _data, _parent, cxt) {
      if (on && collector) collector.push(cxt?.instancePath ?? '');
      return true;
    },
  });
  return ajv;
}

/**
 * Run a compiled validator and collect the JSON pointers of every string validated by an `x-mx-ref: true` schema.
 * Mutates `data` (defaults). @returns {{ok: boolean, refPointers: string[], errors: {field: string, message: string}[]}}
 */
export function validateCollecting(validate, data) {
  const prev = collector;
  collector = [];
  try {
    const ok = validate(data);
    return { ok, refPointers: ok ? [...new Set(collector)] : [], errors: ok ? [] : formatErrors(validate.errors) };
  } finally {
    collector = prev;
  }
}

/** Ajv errors -> [{field: JSON pointer, message}] */
export function formatErrors(errors = []) {
  const out = [];
  const seen = new Set();
  for (const e of errors ?? []) {
    let field = e.instancePath || '';
    if (e.keyword === 'required') field += `/${e.params.missingProperty}`;
    if (e.keyword === 'additionalProperties') field += `/${e.params.additionalProperty}`;
    let message = e.message ?? 'invalid';
    if (e.keyword === 'additionalProperties') message = 'is not a known field';
    if (e.keyword === 'enum') message += `: ${e.params.allowedValues.map((v) => JSON.stringify(v)).join(', ')}`;
    const key = `${field}|${message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ field: field || '/', message });
    }
  }
  return out;
}

/** Read a value at a JSON pointer ("" = root). */
export function getPointer(obj, pointer) {
  if (!pointer) return obj;
  return pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((o, k) => o?.[k], obj);
}

/** Set a value at a JSON pointer (must already exist). */
export function setPointer(obj, pointer, value) {
  const parts = pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const last = parts.pop();
  const parent = parts.reduce((o, k) => o[k], obj);
  parent[last] = value;
}
