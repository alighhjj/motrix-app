// Cross-platform architecture boundary checker.
//
// Replaces the previous `grep -rnE` based implementation, which is unavailable
// on a clean Windows PATH. Instead we recursively walk .ts/.tsx files with
// node:fs and match each line against the same ERE-style patterns.
//
// POSIX class `[[:alnum:]]` has no JS RegExp equivalent, so it is spelled
// `[a-zA-Z0-9]` in the shared-rule pattern below. All other patterns translate
// to JavaScript RegExp unchanged.
//
// Output is unchanged from the grep-era format:
//   [PASS] <label>
//   [FAIL] <label>
//   <relative/path>:<line>:<content>
//
// Exit code is 1 when any rule fails, 0 otherwise.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'

const rules = [
  {
    label: 'core must not import electron',
    pattern: String.raw`from ['"]electron['"]`,
    dir: 'src/core/',
  },
  {
    label: 'core must not import fastify',
    pattern: String.raw`from ['"]@?fastify`,
    dir: 'src/core/',
  },
  {
    label: 'shared must not use Node-specific APIs or globals',
    pattern: String.raw`from ['"]node:|require\(['"]node:|import\(['"]node:|(^|[^a-zA-Z0-9_$])process\.|(^|[^a-zA-Z0-9_$])NodeJS\.`,
    dir: 'src/shared/',
  },
  {
    label: 'renderer must not import core or main',
    pattern: String.raw`from ['"][^'"]*(core|main)/`,
    dir: 'src/renderer/',
  },
  {
    label: 'server must not import electron',
    pattern: String.raw`from ['"]electron['"]`,
    dir: 'src/server/',
  },
  {
    label: 'server must not import src/main',
    pattern: String.raw`from ['"]@main/|from ['"][^'"]*src/main/`,
    dir: 'src/server/',
  },
  {
    label: 'production source must not reference deployment staging contracts',
    pattern: String.raw`(electron|server)-runtime-dependencies\.json|\.motrix-(package|server)-stage\.json|dist/(electron|server)-app`,
    dir: 'src/',
  },
  {
    label:
      'add-task UI must not import transport or protocol commands (except the IPC-aware hook/dialog/form)',
    pattern: String.raw`from ['"](@renderer/lib/transport|@shared/protocol/commands)['"]`,
    dir: 'src/renderer/components/add-task/',
    except: ['use-external-hydration.ts', 'drop-zone.tsx', 'add-task-form.tsx'],
  },
  {
    label: 'web-services must not reference Electron-only command symbols',
    pattern: String.raw`PickSaveDir|CloseCurrentWindow|ResizeWindow|ShowMainWindow`,
    dir: 'src/renderer/platform/web-services.ts',
  },
]

// Recursively collect .ts/.tsx files under `dir`. A `dir` that points at a
// single file (the web-services rule) is handled directly; a missing path
// yields an empty list (treated as a pass by the caller).
function collectTsFiles(dir) {
  const root = resolve(dir)
  let rootStat
  try {
    rootStat = statSync(root)
  } catch {
    return []
  }
  if (rootStat.isFile()) {
    return /\.tsx?$/.test(root) ? [root] : []
  }
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      const p = resolve(d, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(p)
      } else if (/\.tsx?$/.test(name)) {
        out.push(p)
      }
    }
  }
  walk(root)
  return out
}

// Relative-to-repo path with forward slashes for stable, platform-agnostic
// output.
function displayPath(file) {
  return relative(process.cwd(), file).split(sep).join('/')
}

let failed = 0
for (const rule of rules) {
  const re = new RegExp(rule.pattern)
  const files = collectTsFiles(rule.dir)
  const matches = []
  for (const file of files) {
    if (rule.except?.some((suffix) => file.endsWith(suffix))) continue
    const display = displayPath(file)
    let content
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push(`${display}:${i + 1}:${lines[i]}`)
      }
    }
  }
  if (matches.length === 0) {
    console.log(`[PASS] ${rule.label}`)
    continue
  }
  console.log(`[FAIL] ${rule.label}`)
  process.stdout.write(`${matches.join('\n')}\n`)
  failed++
}

process.exit(failed > 0 ? 1 : 0)
