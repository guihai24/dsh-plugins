/**
 * One-shot Antigravity CLI (`agy`) subagent provider.
 *
 * Every accepted delegation spawns a fresh `agy --print` process in the child
 * workspace, waits for its single JSON result document, and settles the shared
 * run with either the selected answer or a safe failure diagnostic. Native
 * Antigravity authentication and settings stay authoritative: the provider
 * only forwards an optional model, reasoning effort, execution mode, sandbox
 * flag, timeout, and explicit environment entries.
 *
 * @module dsh-subagent-antigravity
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'subagent-antigravity'

/** Services this plugin needs before it may register. */
export const inject = ['subagents']

const DEFAULT_PROVIDER_NAME = 'antigravity'
const DEFAULT_MODE = 'auto'
const MODES = ['accept-edits', 'auto', 'plan']
const MAX_DIAGNOSTIC_BYTES = 4096
const DEFAULT_KILL_GRACE_MS = 3000

/** Capabilities: this provider is one-shot and supports no start-time options. */
const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

/**
 * Accept only non-empty text blocks and join them into one prompt.
 * @param {readonly {type: string, text?: string}[]} prompt
 * @returns {string}
 */
function textTask(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new Error('subagent-antigravity: the one-shot task must contain only text blocks')
  }
  const texts = []
  for (const block of prompt) {
    if (block === null || typeof block !== 'object' || block.type !== 'text') {
      throw new Error('subagent-antigravity: the one-shot task must contain only text blocks')
    }
    texts.push(typeof block.text === 'string' ? block.text : '')
  }
  if (texts.every((text) => text.trim().length === 0)) {
    throw new Error('subagent-antigravity: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Truncate diagnostics to the seam's byte budget without splitting a character.
 * @param {string} text
 * @returns {string}
 */
function truncateDiagnostic(text) {
  const value = String(text ?? '')
  if (Buffer.byteLength(value, 'utf8') <= MAX_DIAGNOSTIC_BYTES) return value
  let out = ''
  for (const char of value) {
    if (Buffer.byteLength(out + char, 'utf8') > MAX_DIAGNOSTIC_BYTES - 3) break
    out += char
  }
  return `${out}...`
}

/**
 * Resolve the agy executable: explicit config, env override, the usual user
 * install location, then bare `agy` on PATH.
 * @param {string | undefined} configured
 * @returns {string}
 */
function resolveCommand(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured
  const fromEnv = process.env.AGY_BIN
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  const local = join(homedir(), '.local', 'bin', 'agy')
  if (existsSync(local)) return local
  return 'agy'
}

/**
 * Map provider config into the fixed non-interactive agy argument list.
 * @param {Record<string, unknown>} config
 * @param {string} task
 * @param {string} logFile
 * @returns {string[]}
 */
function buildArgs(config, task, logFile) {
  const args = ['--print', task, '--output-format', 'json', '--log-file', logFile]
  if (typeof config.model === 'string' && config.model.length > 0) args.push('--model', config.model)
  if (typeof config.effort === 'string' && config.effort.length > 0) args.push('--effort', config.effort)
  if (typeof config.mode === 'string' && config.mode.length > 0) args.push('--mode', config.mode)
  if (config.sandbox === true) args.push('--sandbox')
  if (config.dangerouslySkipPermissions === true) args.push('--dangerously-skip-permissions')
  const timeoutSeconds = Number(config.timeoutSeconds ?? 0)
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    args.push('--print-timeout', `${Math.floor(timeoutSeconds)}s`)
  }
  return args
}

/**
 * Parse the single JSON result document emitted on stdout.
 * @param {string} stdout
 * @returns {Record<string, unknown> | undefined}
 */
function parseResult(stdout) {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    // Tolerate leading non-JSON noise by trying the last JSON-looking line.
    const lines = trimmed.split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim()
      if (!line.startsWith('{')) continue
      try {
        const parsed = JSON.parse(line)
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined
      } catch {
        // keep scanning
      }
    }
    return undefined
  }
}

/**
 * Build the shared result from one agy JSON document.
 * @param {Record<string, unknown> | undefined} doc
 * @returns {{output: readonly {type: 'text', text: string}[], stopReason: string, diagnostic?: string}}
 */
function settleResult(doc) {
  if (doc === undefined) {
    return { output: [], stopReason: 'error', diagnostic: 'Product subagent failure (product: Antigravity; stage: parse; category: invalid-result)' }
  }
  const status = typeof doc.status === 'string' ? doc.status : ''
  const response = typeof doc.response === 'string' ? doc.response : ''
  if (status === 'SUCCESS' && response.trim().length > 0) {
    return { output: [{ type: 'text', text: response }], stopReason: 'completed' }
  }
  if (status === 'SUCCESS') {
    return { output: [], stopReason: 'error', diagnostic: 'Product subagent failure (product: Antigravity; stage: result; category: invalid-result; reason: empty answer)' }
  }
  const detail = typeof doc.error === 'string' && doc.error.length > 0 ? doc.error : `status ${status || 'unknown'}`
  return {
    output: [],
    stopReason: 'error',
    diagnostic: truncateDiagnostic(`Product subagent failure (product: Antigravity; stage: result; category: product-error): ${detail}`),
  }
}

/** One registered one-shot Antigravity provider. */
class AntigravityProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.name = config.providerName
    this.capabilities = NO_START_CAPABILITIES
    this.inheritsParentContext = false
  }

  /**
   * Spawn one agy process and publish its run.
   * @param {{cwd: string, prompt: readonly {type: string, text?: string}[], signal: AbortSignal}} request
   */
  async start(request) {
    const task = textTask(request.prompt)
    const cwd = request.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('subagent-antigravity: child cwd is required')
    }
    if (request.signal.aborted) {
      throw new Error('subagent-antigravity: request was aborted before startup')
    }

    const command = resolveCommand(this.config.command)
    const logFile = join(this.config.logDir || tmpdir(), `agy-${randomUUID()}.log`)
    const args = buildArgs(this.config, task, logFile)
    const childEnv = { ...process.env, ...(this.config.env || {}) }

    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })

    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64) stderr.push(chunk)
    })

    let exitInfo
    let aborted = false
    let killTimer
    const closed = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        exitInfo = { code, signal }
        resolve()
      })
    })

    const onAbort = () => {
      aborted = true
      if (exitInfo === undefined) {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        killTimer = setTimeout(() => {
          if (exitInfo === undefined) {
            try { child.kill('SIGKILL') } catch { /* already gone */ }
          }
        }, DEFAULT_KILL_GRACE_MS)
        killTimer.unref?.()
      }
    }
    request.signal.addEventListener('abort', onAbort, { once: true })

    const result = closed.then(() => {
      request.signal.removeEventListener('abort', onAbort)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (aborted || request.signal.aborted) {
        return { output: [], stopReason: 'aborted' }
      }
      const stdoutText = Buffer.concat(stdout).toString('utf8')
      const doc = parseResult(stdoutText)
      if (doc === undefined) {
        const tail = truncateDiagnostic(Buffer.concat(stderr).toString('utf8'))
        return {
          output: [],
          stopReason: 'error',
          diagnostic: truncateDiagnostic(
            `Product subagent failure (product: Antigravity; stage: process; category: process; exit code: ${exitInfo?.code ?? 'null'}; signal: ${exitInfo?.signal ?? 'none'}): ${tail}`,
          ),
        }
      }
      return settleResult(doc)
    })

    return {
      id: randomUUID(),
      result,
      dispose: async () => {
        if (exitInfo === undefined) {
          try { child.kill('SIGTERM') } catch { /* already gone */ }
        }
        await closed
        request.signal.removeEventListener('abort', onAbort)
        if (killTimer !== undefined) clearTimeout(killTimer)
      },
    }
  }
}

/**
 * Register one Antigravity provider instance.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const resolved = {
    ...config,
    providerName: typeof config.providerName === 'string' && config.providerName.length > 0
      ? config.providerName
      : DEFAULT_PROVIDER_NAME,
    mode: typeof config.mode === 'string' && config.mode.length > 0 ? config.mode : DEFAULT_MODE,
  }
  if (!MODES.includes(resolved.mode)) {
    throw new Error(`subagent-antigravity: mode must be one of ${MODES.join(', ')}`)
  }
  ctx.subagents.registerProvider(new AntigravityProvider(ctx, resolved))
}
