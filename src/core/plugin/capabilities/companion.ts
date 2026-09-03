// companion capability — run a plugin-bundled script as a managed child
// process, so plugins can host a small local helper (e.g. a yt-dlp bridge
// server) alongside the sandboxed VM.
//
// Constraints (deliberately tighter than a general `exec` capability):
//   - executable is fixed to the host-provided Node runtime. The Electron
//     shell injects `ELECTRON_RUN_AS_NODE=1` so `process.execPath` runs as
//     plain Node; the server shell passes its own `process.execPath`.
//   - script path is sandbox-resolved inside the plugin's install directory
//     (symlink escapes and `..` traversal are rejected at that layer).
//   - at most ONE companion per plugin at a time.
//   - lifecycle is host-owned: `stopAllForPlugin` / `dispose` terminate and
//     reap every child (SIGTERM → 5s grace → SIGKILL).
//
// Error codes are prefixed `plugin.companion.*` and surface through the
// capability bridge's dispatch catch block.
//
// Boundary: MUST NOT import electron, @main/, or @server/.

import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { FsSandboxError } from './fs-sandbox'
import { resolveInsideSandbox } from './fs-sandbox'

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class CompanionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CompanionError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompanionStartOptions {
  /** Script path relative to the plugin install dir (e.g. `bridge/foo.mjs`). */
  script: string
  /** Extra args appended to the script path. */
  args?: string[]
  /** Extra env vars merged over the host-injected baseline. */
  env?: Record<string, string>
  /** How long to wait for the process to report a successful spawn. */
  timeoutMs?: number
}

export type CompanionState = 'starting' | 'running' | 'exited' | 'error'

export interface CompanionStatus {
  id: string
  state: CompanionState
  pid?: number
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  /** Tail of stderr captured for diagnosis (only populated on exit/error). */
  stderrTail?: string
}

export interface CompanionCapabilityHostOptions {
  /** Resolves a plugin id to its install directory (script sandbox root). */
  pluginDirFor: (pluginId: string) => string
  /** Node executable used to run the script. */
  nodeExecPath: string
  /** Baseline env injected for run-as-node / runtime differences. */
  baseEnv?: Record<string, string>
  /** Override the spawn function (tests). */
  spawnFn?: typeof spawn
}

interface CompanionEntry {
  id: string
  pluginId: string
  proc: ChildProcess
  state: CompanionState
  pid: number | undefined
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
  killTimer: ReturnType<typeof setTimeout> | undefined
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_START_TIMEOUT_MS = 10_000
const SIGKILL_GRACE_MS = 5_000
const STDERR_TAIL_BYTES = 8 * 1024

// ---------------------------------------------------------------------------
// CompanionCapabilityHost
// ---------------------------------------------------------------------------

export class CompanionCapabilityHost {
  private readonly pluginDirFor: (pluginId: string) => string
  private readonly nodeExecPath: string
  private readonly baseEnv: Record<string, string>
  private readonly spawnFn: typeof spawn
  private readonly entries = new Map<string, CompanionEntry>()

  constructor(opts: CompanionCapabilityHostOptions) {
    this.pluginDirFor = opts.pluginDirFor
    this.nodeExecPath = opts.nodeExecPath
    this.baseEnv = opts.baseEnv ?? {}
    this.spawnFn = opts.spawnFn ?? spawn
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  start(
    pluginId: string,
    opts: CompanionStartOptions
  ): Promise<{ id: string }> {
    this.assertIdle(pluginId)

    const timeoutMs =
      opts.timeoutMs !== undefined && opts.timeoutMs >= 0
        ? opts.timeoutMs
        : DEFAULT_START_TIMEOUT_MS

    return resolveInsideSandbox(this.pluginDirFor(pluginId), opts.script)
      .then((scriptAbs) => this.launch(pluginId, scriptAbs, opts, timeoutMs))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'FsSandboxError') {
          const fse = e as FsSandboxError
          throw new CompanionError(
            fse.code,
            `companion script rejected: ${fse.message}`
          )
        }
        throw e
      })
  }

  private launch(
    pluginId: string,
    scriptAbs: string,
    opts: CompanionStartOptions,
    timeoutMs: number
  ): Promise<{ id: string }> {
    const id = randomUUID()
    const proc = this.spawnFn(
      this.nodeExecPath,
      [scriptAbs, ...(opts.args ?? [])],
      {
        cwd: this.pluginDirFor(pluginId),
        env: {
          ...process.env,
          ...this.baseEnv,
          MOTRIX_COMPANION: '1',
          MOTRIX_COMPANION_PLUGIN_ID: pluginId,
          ...(opts.env ?? {}),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    )

    const entry: CompanionEntry = {
      id,
      pluginId,
      proc,
      state: 'starting',
      pid: undefined,
      exitCode: null,
      signal: null,
      stderrTail: '',
      killTimer: undefined,
    }
    this.entries.set(id, entry)

    proc.stderr?.on('data', (chunk: Buffer) => {
      if (entry.stderrTail.length < STDERR_TAIL_BYTES) {
        entry.stderrTail += chunk.toString()
      }
    })

    proc.on('error', (err: Error) => {
      if (entry.state !== 'exited') {
        entry.state = 'error'
      }
      entry.stderrTail = `${entry.stderrTail}\n${err.message}`.slice(
        -STDERR_TAIL_BYTES
      )
    })

    proc.on('spawn', () => {
      entry.state = 'running'
      entry.pid = proc.pid ?? undefined
    })

    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      entry.state = 'exited'
      entry.exitCode = code
      entry.signal = signal
      if (entry.killTimer) {
        clearTimeout(entry.killTimer)
        entry.killTimer = undefined
      }
    })

    return new Promise<{ id: string }>((resolve, reject) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settle()
        this.stop(id)
        reject(
          new CompanionError(
            'plugin.companion.start_timeout',
            `companion did not spawn within ${timeoutMs}ms`
          )
        )
      }, timeoutMs)

      proc.once('error', (err: Error) => {
        if (settled) return
        settle()
        reject(
          new CompanionError(
            'plugin.companion.spawn_error',
            `companion spawn error: ${err.message}`
          )
        )
      })

      proc.once('spawn', () => {
        if (settled) return
        settle()
        resolve({ id })
      })
    })
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  status(id: string): Promise<CompanionStatus> {
    const entry = this.entries.get(id)
    if (!entry) {
      return Promise.reject(
        new CompanionError(
          'plugin.companion.not_found',
          `companion not found: ${id}`
        )
      )
    }
    const stderrTail =
      entry.state === 'exited' || entry.state === 'error'
        ? entry.stderrTail || undefined
        : undefined
    return Promise.resolve({
      id: entry.id,
      state: entry.state,
      pid: entry.pid,
      exitCode: entry.exitCode ?? undefined,
      signal: entry.signal ?? undefined,
      ...(stderrTail ? { stderrTail } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  stop(id: string): Promise<{ stopped: boolean }> {
    const entry = this.entries.get(id)
    if (!entry) return Promise.resolve({ stopped: false })
    this.kill(entry)
    return Promise.resolve({ stopped: true })
  }

  stopAllForPlugin(pluginId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.pluginId === pluginId) this.kill(entry)
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.kill(entry)
    }
    this.entries.clear()
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private assertIdle(pluginId: string): void {
    for (const entry of this.entries.values()) {
      if (
        entry.pluginId === pluginId &&
        (entry.state === 'starting' || entry.state === 'running')
      ) {
        throw new CompanionError(
          'plugin.companion.already_running',
          `plugin ${pluginId} already has a running companion`
        )
      }
    }
  }

  private kill(entry: CompanionEntry): void {
    if (entry.state === 'exited' || entry.killTimer) return
    try {
      entry.proc.kill('SIGTERM')
    } catch {
      // process may already be gone
    }
    entry.killTimer = setTimeout(() => {
      try {
        entry.proc.kill('SIGKILL')
      } catch {
        // ignore
      }
      entry.killTimer = undefined
    }, SIGKILL_GRACE_MS)
  }
}
