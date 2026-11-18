// Named section markers in Strudel songs. A marker is a top-level assignment whose value is a plain
// number, e.g. `let DROP = 34;`. Builds rewrite these lines to move scenes instead of regenerating the
// song.
import { ToolError } from './errors.mjs';

// `<indent><let|const|var> NAME = <value>; <rest-of-line>`; the value may not cross a `;` or a newline.
const MARKER_LINE = /^(\s*)(let|const|var)(\s+)([A-Za-z_$][\w$]*)(\s*=\s*)([^;\n]*);(.*)$/;
// Semicolon-less style (common in Strudel): `let DROP = 34` or `let DROP = 34 // comment`; numbers only.
const MARKER_LINE_NO_SEMI = /^(\s*)(let|const|var)(\s+)([A-Za-z_$][\w$]*)(\s*=\s*)(-?\d+(?:\.\d+)?)(\s*(?:\/\/.*)?)$/;

/**
 * Parse one line as a marker declaration, or null when it is not one. A trailing `\r` (CRLF files written on
 * Windows) is kept aside and restored on rewrite, so CRLF and LF songs behave the same.
 */
function parseMarkerLine(line) {
  const cr = line.endsWith('\r') ? '\r' : '';
  const body = cr ? line.slice(0, -1) : line;
  const m = MARKER_LINE.exec(body);
  if (m) return { indent: m[1], kw: m[2], name: m[4], value: m[6].trim(), after: m[7], semi: ';', cr };
  const n = MARKER_LINE_NO_SEMI.exec(body);
  if (n) return { indent: n[1], kw: n[2], name: n[4], value: n[6], after: n[7], semi: '', cr };
  return null;
}

/**
 * Every `let|const|var NAME = value;` line in the source, in file order.
 * @param {string} code Strudel source
 * @returns {{name: string, value: string, line: number}[]} `line` is 1-based
 */
export function findMarkers(code) {
  const out = [];
  const lines = String(code ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const marker = parseMarkerLine(lines[i]);
    if (marker) out.push({ name: marker.name, value: marker.value, line: i + 1 });
  }
  return out;
}

// One token of a marker value: a number, a name, or + - * / % ( ). Anything else means "not arithmetic".
const TOKEN = /\s*(?:(\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_$][\w$]*)|([-+*/%()]))/y;

/** Tokens of an arithmetic value, or null when the text is anything else (a call, a string, a function...). */
function tokenize(text) {
  const src = text.trim();
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) return null;
    i = TOKEN.lastIndex;
    if (m[1] !== undefined) tokens.push({ num: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ name: m[2] });
    else tokens.push({ op: m[3] });
  }
  return tokens.length ? tokens : null;
}

/**
 * Evaluate arithmetic tokens (unary +/-, + - * / %, parentheses) with `names` for earlier markers.
 * @returns {{ok: false} | {ok: true, value: number|null}} ok false = not arithmetic; value null = unresolved name
 */
function evaluate(tokens, names) {
  let pos = 0;
  let unresolved = false;
  const fail = () => {
    throw new SyntaxError('not arithmetic');
  };
  const primary = () => {
    const t = tokens[pos++];
    if (!t) fail();
    if (t.num !== undefined) return t.num;
    if (t.name !== undefined) {
      if (names.has(t.name)) return names.get(t.name);
      unresolved = true;
      return Number.NaN;
    }
    if (t.op !== '(') fail();
    const v = sum();
    if (tokens[pos++]?.op !== ')') fail();
    return v;
  };
  const unary = () => {
    const op = tokens[pos]?.op;
    if (op === '-' || op === '+') {
      pos++;
      return op === '-' ? -unary() : unary();
    }
    return primary();
  };
  const product = () => {
    let v = unary();
    for (let op = tokens[pos]?.op; op === '*' || op === '/' || op === '%'; op = tokens[pos]?.op) {
      pos++;
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    for (let op = tokens[pos]?.op; op === '+' || op === '-'; op = tokens[pos]?.op) {
      pos++;
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  try {
    const value = sum();
    if (pos !== tokens.length) return { ok: false };
    return { ok: true, value: unresolved || !Number.isFinite(value) ? null : value };
  } catch {
    return { ok: false };
  }
}

/**
 * The song's form: every marker line whose value is a number (`let DROP = 34;`) or arithmetic over numbers and
 * earlier markers (`let OUTRO = DROP + 8;`), in file order, with the time it lands at. Markers count Strudel cycles
 * from 0, so `at_s = value / cps` and `bar = value` (one cycle is one bar, which is what `beats_per_cycle` means:
 * `bar: 6` is the 7th bar). A value that needs a name the song does not give as a marker is listed as its text,
 * without `at_s` and `bar`. Lines that hold anything else (functions, patterns, strings) are not markers here.
 * @param {string} code Strudel source
 * @param {number} cps cycles per second of the render
 * @returns {{name: string, value: number|string, line: number, expression?: string, at_s?: number, bar?: number}[]}
 */
export function markerForm(code, cps) {
  const out = [];
  const names = new Map();
  for (const marker of findMarkers(code)) {
    const tokens = tokenize(marker.value);
    if (!tokens) continue;
    const { ok, value } = evaluate(tokens, names);
    if (!ok) continue;
    if (value == null) {
      if (tokens.some((t) => t.num !== undefined)) out.push({ ...marker });
      continue;
    }
    names.set(marker.name, value);
    const last = tokens[tokens.length - 1];
    const literal =
      last.num !== undefined && (tokens.length === 1 || (tokens.length === 2 && /^[-+]$/.test(tokens[0].op ?? '')));
    const entry = { name: marker.name, value, line: marker.line };
    if (!literal) entry.expression = marker.value;
    if (cps > 0) entry.at_s = Math.round((value / cps) * 1000) / 1000;
    entry.bar = value;
    out.push(entry);
  }
  return out;
}

/**
 * Rewrite the FIRST declaration line of every named marker to `<kw> NAME = <value>;`, keeping the
 * indentation and anything after the `;`. Throws ToolError('invalid-input') when a name is missing.
 * @param {string} code Strudel source
 * @param {Record<string, number|string>} markers `{NAME: value}` (values are usually numbers)
 * @returns {{code: string, applied: {name: string, value: number|string, line: number}[]}}
 */
export function applyMarkers(code, markers) {
  const names = Object.keys(markers ?? {});
  if (names.length === 0) return { code, applied: [] };
  const found = findMarkers(code);
  const missing = names.filter((name) => !found.some((m) => m.name === name));
  if (missing.length > 0) {
    const known = found.map((m) => m.name).join(', ') || '(none)';
    throw new ToolError('invalid-input', `marker ${missing.join(', ')} not found; markers in this song: ${known}`);
  }
  const lines = String(code).split('\n');
  const applied = [];
  for (const name of names) {
    const index = lines.findIndex((line) => parseMarkerLine(line)?.name === name);
    const marker = parseMarkerLine(lines[index]);
    const value = markers[name];
    lines[index] = `${marker.indent}${marker.kw} ${name} = ${value}${marker.semi}${marker.after}${marker.cr}`;
    applied.push({ name, value, line: index + 1 });
  }
  return { code: lines.join('\n'), applied };
}
