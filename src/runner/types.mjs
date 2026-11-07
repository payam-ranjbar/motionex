// Shared JSDoc types. Import with: /** @typedef {import('../runner/types.mjs').Job} Job */
export {};

/**
 * @typedef {object} Config  (src/lib/config.mjs loadConfig)
 * @property {string} version
 * @property {string} appRoot
 * @property {number} port
 * @property {string} host
 * @property {string} workspace       absolute
 * @property {string} stateDir        absolute, default <workspace>/.mx
 * @property {string} scratchDir      absolute
 * @property {{path: string, origin: 'builtin'|'extension'}[]} toolsDirs
 * @property {string[]} contractsDirs   folders of contract files (<name>.json); extension tool dirs add <dir>/contracts
 * @property {string[]} presetsDirs
 * @property {string[]} voicesDirs
 * @property {string} secretsDir
 * @property {string} sampleCacheDir
 * @property {boolean} offline
 * @property {string} python
 * @property {string} node
 * @property {string|null} ffmpegPath
 * @property {string|null} ffprobePath
 * @property {{channel: string|null, executablePath: string|null}} browser
 * @property {number} cpuSlots
 * @property {Record<string, number>} limits   per-class max concurrent jobs
 * @property {number} maxQueued
 * @property {string[]} allowedOrigins
 * @property {string[]} allowedHosts
 * @property {string|null} apiTokenFile
 * @property {number} maxUploadBytes
 * @property {number} maxJsonBytes
 * @property {number} snapshotMaxBytes
 * @property {number} killGraceMs
 * @property {string} logLevel
 * @property {string} elevenlabsUrl
 * @property {number} elevenlabsDailyCharLimit
 * @property {number} musicMaxSeconds
 * @property {boolean} allowOverride
 * @property {Record<string, string>} libDirs   URL prefix under /_mx/lib/ -> folder
 */

/**
 * @typedef {object} ToolManifest  (tools/<name>/tool.json; schema in src/registry/manifest.schema.json)
 * @property {string} name
 * @property {string} version
 * @property {string} title
 * @property {string} summary
 * @property {string} [description]
 * @property {'node'|'command'} kind
 * @property {string} [handler]        kind=node, relative to the tool folder
 * @property {string[]} [command]      kind=command; ${MX_PYTHON} ${MX_NODE} ${TOOL_DIR} are interpolated
 * @property {boolean} deterministic
 * @property {'auto'|'reuse'|'off'} cache_default
 * @property {{class: string, slots?: number|{from_input: string, default: number}, memory_mb?: number}} resources
 * @property {number} timeout_s        0 = none
 * @property {string} [presets]        preset kind (folder under presets/), enables the `preset` input field
 * @property {{binaries?: string[], secrets?: string[]}} [requires]
 * @property {object} input_schema     JSON Schema 2020-12
 * @property {object} [output_schema]  JSON Schema for `result`
 * @property {{title: string, input: object, fixtures?: Record<string, object>}[]} examples
 * @property {{contract: string, provider: string}[]} [implements]  contracts this tool is a provider of
 */

/**
 * @typedef {object} ToolEntry  (registry internal)
 * @property {string} name
 * @property {string} dir            absolute tool folder
 * @property {'builtin'|'extension'} origin
 * @property {ToolManifest} manifest
 * @property {string} toolHash       sha256 of the tool folder
 * @property {boolean} available
 * @property {string|null} unavailableReason
 */

/**
 * @typedef {object} ToolInfo  (GET /v1/tools) = manifest minus handler/command, plus:
 * @property {boolean} available
 * @property {string|null} unavailable_reason
 * @property {'builtin'|'extension'} origin
 */

/**
 * @typedef {'queued'|'running'|'succeeded'|'failed'|'canceled'} JobStatus
 */

/**
 * @typedef {object} JobOutput
 * @property {string} name        relative POSIX path inside out/, e.g. "mix.wav" or "stems/dialogue.wav"
 * @property {string} ref         "job:<id>/<name>"
 * @property {string} path        workspace-relative, ".mx/jobs/<id>/out/<name>"
 * @property {string} sha256
 * @property {number} bytes
 * @property {string} media_type
 */

/**
 * @typedef {object} JobInput  (one resolved ref)
 * @property {string} pointer     JSON pointer into input, e.g. "/tracks/0/clips/3/src"
 * @property {string} ref         as submitted
 * @property {string} path        workspace-relative resolved path
 * @property {string} sha256
 * @property {number} bytes
 * @property {string|null} snapshot  ".mx/blobs/sha256/<aa>/<sha>" when copied, else null
 */

/**
 * @typedef {object} JobError
 * @property {string} type        a key of JOB_ERROR_TYPES (src/lib/errors.mjs)
 * @property {string} title
 * @property {string} detail
 * @property {boolean} retryable
 */

/**
 * @typedef {object} Job
 * @property {string} id                  "job_<32 hex>"
 * @property {string} tool
 * @property {string|null} [contract]    the contract the job was submitted as (e.g. voice.speak), else null
 * @property {string|null} [provider]    the provider picked for that contract (e.g. piper), else null
 * @property {string} tool_version
 * @property {string} tool_hash
 * @property {JobStatus} status
 * @property {string|null} label
 * @property {string|null} project
 * @property {string|null} note
 * @property {string} created_at          ISO-8601 UTC
 * @property {string|null} started_at
 * @property {string|null} finished_at
 * @property {{fraction: number|null, message: string|null}} progress
 * @property {{input: object, cache: 'auto'|'reuse'|'off', timeout_s: number|null}} request
 * @property {object} input               validated, presets merged, defaults applied, refs as strings
 * @property {JobInput[]} inputs
 * @property {string|null} cache_key
 * @property {string|null} cached_from    job id this job's outputs come from (cache hit)
 * @property {object|null} result
 * @property {JobOutput[]} outputs
 * @property {JobError|null} error
 * @property {string|null} idempotency_key
 * @property {string|null} deleted_at
 * @property {{self: string, events: string, log: string, dir: string}} links
 */

/**
 * @typedef {object} JobEvent
 * @property {number} seq       1-based, per job
 * @property {string} at        ISO-8601
 * @property {'state'|'progress'|'log'|'output'} type
 * @property {JobStatus} [status]
 * @property {number|null} [fraction]
 * @property {string} [message]
 * @property {string} [name]
 */

/**
 * @typedef {object} Ctx  (second argument of a node handler; built by src/runner/context.mjs)
 * @property {{id: string, tool: string, tool_version: string}} job
 * @property {object} rawInput            input with ref strings unresolved
 * @property {string} workspace           absolute
 * @property {string} outDir              absolute, exists, empty; write outputs here only
 * @property {string} scratchDir          absolute, exists, empty; temp files, removed after the job
 * @property {string} toolDir             absolute tool folder
 * @property {string} blobDir             absolute .mx/blobs
 * @property {AbortSignal} signal         aborted on cancel or timeout
 * @property {Config} config
 * @property {(fraction: number|null, message?: string) => void} progress
 * @property {(message: string) => void} log
 * @property {(name: string) => Promise<string|null>} secret     reads <secretsDir>/<name>, trimmed; null when missing
 * @property {(pid: number) => void} trackProcess  report a child process group (e.g. a browser) so cancel can kill it
 * @property {{path: string, probePath: string|null, run: typeof import('../lib/ffmpeg.mjs').runFfmpeg}} ffmpeg
 */

/**
 * @typedef {object} HandlerResult
 * @property {object} result
 * @property {{name: string, media_type?: string}[]} [outputs]   default: every file under outDir
 */
