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
