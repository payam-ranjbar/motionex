// Found by the headful agent test: a song saved with CRLF line endings (Python on Windows) had "no markers".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMarkers, findMarkers } from '../../src/lib/strudel-markers.mjs';

test('markers are found and rewritten in CRLF files, keeping the CRLF', () => {
  const code = 'setcpm(30)\r\nlet DARK = 0;\r\nlet DROP = 5; // the drop\r\n$: s("bd")\r\n';
  assert.deepEqual(
    findMarkers(code).map((m) => [m.name, m.value, m.line]),
    [
      ['DARK', '0', 2],
      ['DROP', '5', 3],
    ],
  );
  const { code: out, applied } = applyMarkers(code, { DROP: 7 });
  assert.equal(out, 'setcpm(30)\r\nlet DARK = 0;\r\nlet DROP = 7; // the drop\r\n$: s("bd")\r\n');
  assert.deepEqual(applied, [{ name: 'DROP', value: 7, line: 3 }]);
});

test('semicolon-less numeric markers (common Strudel style) work too', () => {
  const code = 'let HUNT = 4\nconst DROP = 26 // works for 20..34\nlet NAME = "x"\n';
  assert.deepEqual(
    findMarkers(code).map((m) => m.name),
    ['HUNT', 'DROP'],
  );
  assert.equal(
    applyMarkers(code, { DROP: 30 }).code,
    'let HUNT = 4\nconst DROP = 30 // works for 20..34\nlet NAME = "x"\n',
  );
});

test('a missing marker still names the ones that exist', () => {
  assert.throws(
    () => applyMarkers('let A = 1;\r\n', { B: 2 }),
    (e) => e.type === 'invalid-input' && /markers in this song: A/.test(e.detail),
  );
});
