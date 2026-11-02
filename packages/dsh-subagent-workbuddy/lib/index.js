/**
 * One-shot WorkBuddy subagent provider.
 *
 * WorkBuddy ships no dedicated CLI: its desktop app bundles the CodeBuddy agent
 * CLI (`codebuddy`, also published as `@tencent-ai/codebuddy-code`). Every
 * accepted delegation spawns a fresh `codebuddy --print` process in the child
 * workspace, waits for the single JSON result document, and settles the shared
 * run with either the selected answer or a safe failure diagnostic. Native
 * WorkBuddy/CodeBuddy authentication and settings stay authoritative; the
 * provider forwards only an optional model, permission mode, turn cap,
 * fallback model, extra directories, and explicit environment entries.
 *
 * @module dsh-subagent-workbuddy
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'subagent-workbuddy'

/** Services this plugin needs before it may register. */
export const inject = ['subagents']

const DEFAULT_PROVIDER_NAME = 'workbuddy'
const DEFAULT_PERMISSION_MODE = 'auto'
const PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'default', 'plan', 'dontAsk', 'auto']
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
    throw new Error('subagent-workbuddy: the one-shot task must contain only text blocks')
  }
  const texts = []
  for (const block of prompt) {
    if (block === null || typeof block !== 'object' || block.type !== 'text') {
      throw new Error('subagent-workbuddy: the one-shot task must contain only text blocks')
    }
    texts.push(typeof block.text === 'string' ? block.text : '')
  }
  if (texts.every((text) => text.trim().length === 0)) {
    throw new Error('subagent-workbuddy: the one-shot task must not be empty')
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
 * Collect the well-known CodeBuddy CLI locations, including nvm installs and
 * the executable bundled inside WorkBuddy.app.
 * @returns {string[]}
 */
function candidateCommands() {
  const candidates = []
  const home = homedir()
  candidates.push(join(home, '.local', 'bin', 'codebuddy'))
  const nvmRoot = join(home, '.nvm', 'versions', 'node')
  try {
    for (const version of readdirSync(nvmRoot)) {
      candidates.push(join(nvmRoot, version, 'bin', 'codebuddy'))
    }
  } catch {
    // nvm absent
  }
  candidates.push('/opt/homebrew/bin/codebuddy')
  candidates.push('/usr/local/bin/codebuddy')
  candidates.push('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy')
  return candidates
}

/**
 * Resolve the CodeBuddy/WorkBuddy executable: explicit config, env override,
 * well-known install locations, then bare `codebuddy` on PATH.
 * @param {string | undefined} configured
 * @returns {string}
 */
function resolveCommand(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured
  for (const envName of ['CODEBUDDY_BIN', 'WORKBUDDY_BIN']) {
    const fromEnv = process.env[envName]
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv
  }
  for (const candidate of candidateCommands()) {
    if (existsSync(candidate)) return candidate
  }
  return 'codebuddy'
}

/**
 * Map provider config into the fixed non-interactive codebuddy argument list.
 * @param {Record<string, unknown>} config
 * @param {string} task
 * @returns {string[]}
 */
function buildArgs(config, task) {
  const args = ['--print', task, '--output-format', 'json']
  if (typeof config.model === 'string' && config.model.length > 0) args.push('--model', config.model)
  if (typeof config.fallbackModel === 'string' && config.fallbackModel.length > 0) {
    args.push('--fallback-model', config.fallbackModel)
  }
  if (typeof config.permissionMode === 'string' && config.permissionMode.length > 0) {
    args.push('--permission-mode', config.permissionMode)
  }
  if (config.dangerouslySkipPermissions === true) args.push('-y')
  const maxTurns = Number(config.maxTurns ?? 0)
  if (Number.isFinite(maxTurns) && maxTurns > 0) args.push('--max-turns', String(Math.floor(maxTurns)))
  if (Array.isArray(config.addDir) && config.addDir.length > 0) {
    args.push('--add-dir', ...config.addDir.filter((entry) => typeof entry === 'string' && entry.length > 0))
  }
  return args
}

/**
 * Parse the JSON document emitted on stdout (an array of session messages or a
 * single object) and return its terminal `result` message.
 * @param {string} stdout
 * @returns {Record<string, unknown> | undefined}
 */
function parseResult(stdout) {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return undefined
  const findResult = (value) => {
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const entry = value[index]
        if (entry !== null && typeof entry === 'object' && entry.type === 'result') return entry
      }
      return undefined
    }
    if (value !== null && typeof value === 'object' && value.type === 'result') return value
    return undefined
  }
  try {
    return findResult(JSON.parse(trimmed))
  } catch {
    // Tolerate leading non-JSON noise by trying the last JSON-looking line.
    const lines = trimmed.split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim()
      if (!line.startsWith('[') && !line.startsWith('{')) continue
      try {
        const found = findResult(JSON.parse(line))
        if (found !== undefined) return found
      } catch {
        // keep scanning
      }
    }
    return undefined
  }
}

/**
 * Build the shared result from one codebuddy `result` message.
 * @param {Record<string, unknown> | undefined} doc
 * @returns {{output: readonly {type: 'text', text: string}[], stopReason: string, diagnostic?: string}}
 */
function settleResult(doc) {
  if (doc === undefined) {
    return {
      output: [],
      stopReason: 'error',
      diagnostic: 'Product subagent failure (product: WorkBuddy; stage: parse; category: invalid-result)',
    }
  }
  const subtype = typeof doc.subtype === 'string' ? doc.subtype : ''
  const answer = typeof doc.result === 'string' ? doc.result : ''
  if (subtype === 'success' && doc.is_error !== true && answer.trim().length > 0) {
    return { output: [{ type: 'text', text: answer }], stopReason: 'completed' }
  }
  const denials = Array.isArray(doc.permission_denials) ? doc.permission_denials.length : 0
  const detail = answer.trim().length > 0
    ? answer
    : `subtype ${subtype || 'unknown'}; is_error ${String(doc.is_error === true)}; permission denials ${denials}`
  return {
    output: [],
    stopReason: 'error',
    diagnostic: truncateDiagnostic(`Product subagent failure (product: WorkBuddy; stage: result; category: product-error): ${detail}`),
  }
}

/** One registered one-shot WorkBuddy provider. */
class WorkBuddyProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.name = config.providerName
    this.capabilities = NO_START_CAPABILITIES
    this.inheritsParentContext = false
  }

  /**
   * Spawn one codebuddy process and publish its run.
   * @param {{cwd: string, prompt: readonly {type: string, text?: string}[], signal: AbortSignal}} request
   */
  async start(request) {
    const task = textTask(request.prompt)
    const cwd = request.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('subagent-workbuddy: child cwd is required')
    }
    if (request.signal.aborted) {
      throw new Error('subagent-workbuddy: request was aborted before startup')
    }

    const command = resolveCommand(this.config.command)
    const args = buildArgs(this.config, task)
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
            `Product subagent failure (product: WorkBuddy; stage: process; category: process; exit code: ${exitInfo?.code ?? 'null'}; signal: ${exitInfo?.signal ?? 'none'}): ${tail}`,
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
 * Register one WorkBuddy provider instance.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const resolved = {
    ...config,
    providerName: typeof config.providerName === 'string' && config.providerName.length > 0
      ? config.providerName
      : DEFAULT_PROVIDER_NAME,
    permissionMode: typeof config.permissionMode === 'string' && config.permissionMode.length > 0
      ? config.permissionMode
      : DEFAULT_PERMISSION_MODE,
  }
  if (!PERMISSION_MODES.includes(resolved.permissionMode)) {
    throw new Error(`subagent-workbuddy: permissionMode must be one of ${PERMISSION_MODES.join(', ')}`)
  }
  ctx.subagents.registerProvider(new WorkBuddyProvider(ctx, resolved))
}
