// Job error vocabulary (job.error.type) and the error class every tool throws.
// API-level errors are Problems (src/lib/problem.mjs); job-level errors are ToolErrors.

/** type -> retryable */
export const JOB_ERROR_TYPES = Object.freeze({
  'invalid-input': false,
  'input-unreadable': false,
  'tool-failed': false,
  timeout: true,
  canceled: false,
  interrupted: true,
  'out-of-memory': false,
  'provider-error': false,
  'rate-limited': true,
  network: true,
  'invalid-output': false,
  internal: false,
});

const TITLES = {
  'invalid-input': 'The input is not valid for this tool',
  'input-unreadable': 'An input file could not be read',
  'tool-failed': 'The tool failed',
  timeout: 'The job timed out',
  canceled: 'The job was canceled',
  interrupted: 'The job was interrupted by a restart',
  'out-of-memory': 'The job ran out of memory',
  'provider-error': 'The provider returned an error',
  'rate-limited': 'The provider rate-limited the request',
  network: 'A network request failed',
  'invalid-output': 'The tool returned a result that does not match its output schema',
  internal: 'Internal error',
};

export class ToolError extends Error {
  /**
   * @param {keyof typeof JOB_ERROR_TYPES} type
   * @param {string} detail human-readable, never contains secrets
   * @param {{retryable?: boolean} & Record<string, unknown>} [opts] extra fields are kept in toJSON()
   */
  constructor(type, detail, { retryable, ...extras } = {}) {
    super(detail);
    this.name = 'ToolError';
    this.type = Object.hasOwn(JOB_ERROR_TYPES, type) ? type : 'internal';
    this.detail = String(detail ?? '');
    this.retryable = retryable ?? JOB_ERROR_TYPES[this.type] ?? false;
    this.extras = extras;
  }

  /** @returns {{type: string, title: string, detail: string, retryable: boolean}} */
  toJSON() {
    return {
      type: this.type,
      title: TITLES[this.type],
      detail: this.detail,
      retryable: this.retryable,
      ...this.extras,
    };
  }
}

export const titleOf = (type) => TITLES[type] ?? TITLES.internal;

/**
 * Turn anything thrown inside a job into a job error object.
 * ToolError keeps its type; a Problem with a 4xx status becomes invalid-input; anything else is tool-failed.
 * @returns {{type: string, title: string, detail: string, retryable: boolean}}
 */
export function toJobError(err) {
  if (err instanceof ToolError || err?.name === 'ToolError') {
    return new ToolError(err.type, err.detail ?? err.message, {
      retryable: err.retryable,
      ...(err.extras ?? {}),
    }).toJSON();
  }
  if (err?.name === 'Problem' && err.status >= 400 && err.status < 500) {
    return new ToolError('invalid-input', err.detail || err.title).toJSON();
  }
  const detail = err?.stack || err?.message || String(err);
  return new ToolError('tool-failed', detail.slice(-4000)).toJSON();
}
