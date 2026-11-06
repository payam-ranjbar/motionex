// RFC 9457 problem details for the HTTP API (application/problem+json),
// mirroring contavex: type urn:motionex:problem:<code>, title, status, detail, request_id.

/** code -> [status, title] */
export const PROBLEMS = Object.freeze({
  'malformed-json': [400, 'The request body is not valid JSON'],
  'invalid-request': [422, 'The request is not valid'],
  'invalid-input': [422, 'The input is not valid for this tool'],
  'unknown-tool': [404, 'No tool by that name'],
  'tool-unavailable': [422, 'The tool exists but cannot run here'],
  'unknown-ref': [422, 'A referenced job, pin or output does not exist'],
  'file-not-found': [404, 'File not found'],
  'path-outside-workspace': [422, 'The path is outside the workspace'],
  'reserved-path': [403, 'The path is reserved for motionex state'],
  'file-locked': [409, 'The file is locked by another program'],
  'idempotency-key-invalid': [400, 'The Idempotency-Key header is not valid'],
  'idempotency-key-reused': [422, 'The Idempotency-Key was already used with a different request'],
  'not-found': [404, 'Not found'],
  pinned: [409, 'The job is pinned'],
  'job-busy': [409, 'The job is still running'],
  'payload-too-large': [413, 'The request body is too large'],
  'unsupported-media-type': [415, 'Unsupported media type'],
  'origin-not-allowed': [403, 'The request Origin is not allowed'],
  'host-not-allowed': [403, 'The request Host is not allowed'],
  unauthenticated: [401, 'Authentication required'],
  'method-not-allowed': [405, 'Method not allowed'],
  'queue-full': [503, 'The job queue is full'],
  'not-ready': [503, 'The service is not ready'],
  internal: [500, 'Internal error'],
});

export class Problem extends Error {
  /**
   * @param {number} status
   * @param {string} code a key of PROBLEMS (or a new kebab-case code)
   * @param {string} title
   * @param {string} [detail]
   * @param {Record<string, unknown>} [extras] extra members, e.g. {errors:[{field,message}]} or {job_id}
   */
  constructor(status, code, title, detail = '', extras = {}) {
    super(detail || title);
    this.name = 'Problem';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.extras = extras;
  }
}

/** Shorthand: problem('unknown-tool', 'no tool "x"') */
export function problem(code, detail = '', extras = {}) {
  const [status, title] = PROBLEMS[code] ?? PROBLEMS.internal;
  return new Problem(status, PROBLEMS[code] ? code : 'internal', title, detail, extras);
}

/** The JSON body for a Problem. */
export function problemBody(p, requestId) {
  return {
    type: `urn:motionex:problem:${p.code}`,
    title: p.title,
    status: p.status,
    detail: p.detail || undefined,
    request_id: requestId,
    ...p.extras,
  };
}
