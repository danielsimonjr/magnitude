/**
 * Shell Command Classifier
 *
 * Tiers:
 * - readonly: positive allowlist of read-only commands
 * - normal: everything else that isn't mass-destructive/forbidden
 * - mass-destructive: bulk/recursive deletion operations
 * - forbidden: catastrophic patterns + non-allowlisted git commands
 */

import { resolve } from 'path'
import { parseShellCommand, isAssignment, type Assignment, type SimpleCommand } from './parser'
import { isGitReadOnly } from './tools/git'
import { isContainerForbidden } from './tools/container'
import { isKubectlForbidden, isHelmForbidden } from './tools/kubernetes'
import { isCloudCliForbidden } from './tools/cloud-cli'
import { isIacForbidden } from './tools/iac'
import { isDatabaseForbidden, isDatabaseUtilityForbidden } from './tools/database'
import {
  SYSADMIN_ALWAYS_FORBIDDEN,
  SYSADMIN_BLOCKLIST,
  PACKAGE_MANAGERS,
  isSysadminForbidden,
  getSysadminAlwaysForbiddenReason,
  isPackageManagerForbidden,
} from './tools/sysadmin'
import { isLangPackageManagerForbidden } from './tools/package-managers'
import type { ClassificationResult, ShellSafetyTier } from './types'

/** Bound on nested unwrapping (wrappers, `sh -c`, eval, substitutions). */
const MAX_DEPTH = 16

export function classifyShellCommand(command: string): ClassificationResult {
  return classifyCommands(parseShellCommand(command), 0)
}

export function isGitAllowed(command: string): boolean {
  return gitAllowedAll(parseShellCommand(command), 0)
}

export function writesStayWithin(command: string, env: Record<string, string>, ...allowedRoots: string[]): boolean {
  const initialCwd = allowedRoots[0] ?? process.cwd()
  return writesStayWithinFrom(parseShellCommand(command), env, initialCwd, allowedRoots, 0)
}

function writesStayWithinFrom(
  commands: SimpleCommand[],
  env: Record<string, string>,
  initialCwd: string,
  allowedRoots: string[],
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) return false
  let effectiveCwd = initialCwd
  let previousCwd: string | null = null

  for (const cmd of commands) {
    // Command substitutions anywhere in the command run with the current cwd.
    for (const sub of commandSubstitutionsOf(cmd)) {
      if (!writesStayWithinFrom(parseShellCommand(sub), env, effectiveCwd, allowedRoots, depth + 1)) return false
    }
    if (hasUnbalancedSubstitution(cmd)) return false

    if (cmd.name) {
      const name = baseName(cmd.name)
      if (name === 'cd') {
        const oldCwd = effectiveCwd
        const target = cmd.args[0]

        let resolvedTarget: string
        if (!target) {
          const home = env.HOME ?? env.USERPROFILE
          if (!home) return false
          resolvedTarget = expandAndResolve(home, env, effectiveCwd)
        } else if (target === '-') {
          if (!previousCwd) return false
          resolvedTarget = previousCwd
        } else {
          if (hasSubstitutionSyntax(target)) return false
          if (hasUndefinedEnvVars(target, env)) return false
          if (target.startsWith('~') && !env.HOME && !env.USERPROFILE) return false
          resolvedTarget = expandAndResolve(target, env, effectiveCwd)
        }

        previousCwd = oldCwd
        effectiveCwd = resolvedTarget
        continue
      }
    }

    for (const redir of cmd.redirects) {
      const resolvedTarget = expandAndResolve(redir.target, env, effectiveCwd)
      if (!isPathWithin(resolvedTarget, env, ...allowedRoots)) return false
    }

    if (!cmd.name) continue

    // Nested commands: wrappers (sudo/env/xargs/...), `sh -c`, eval, find -exec.
    const nested = nestedCommands(cmd)
    if (nested.kind === 'command') {
      if (!writesStayWithinFrom([nested.cmd], env, effectiveCwd, allowedRoots, depth + 1)) return false
      continue
    }
    if (nested.kind === 'script') {
      if (!writesStayWithinFrom(parseShellCommand(nested.script), env, effectiveCwd, allowedRoots, depth + 1)) return false
      continue
    }
    for (const inner of findExecCommands(cmd)) {
      if (!writesStayWithinFrom([inner], env, effectiveCwd, allowedRoots, depth + 1)) return false
    }

    for (const target of writeTargets(baseName(cmd.name), cmd.args, effectiveCwd)) {
      const resolvedArg = expandAndResolve(target, env, effectiveCwd)
      if (!isPathWithin(resolvedArg, env, ...allowedRoots)) return false
    }
  }

  return true
}

// ─── Classification ─────────────────────────────────────────

const TIER_ORDER: Record<ShellSafetyTier, number> = {
  readonly: 0,
  normal: 1,
  'mass-destructive': 2,
  forbidden: 3
}

function worstTier(a: ShellSafetyTier, b: ShellSafetyTier): ShellSafetyTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b
}

function mergeResults(a: ClassificationResult, b: ClassificationResult): ClassificationResult {
  const tier = worstTier(a.tier, b.tier)
  const reason = tier === 'forbidden' ? (b.reason ?? a.reason) : null
  return { tier, reason }
}

const READONLY: ClassificationResult = { tier: 'readonly', reason: null }
const NORMAL: ClassificationResult = { tier: 'normal', reason: null }

function classifyCommands(commands: SimpleCommand[], depth: number): ClassificationResult {
  let result: ClassificationResult = READONLY
  for (let i = 0; i < commands.length; i++) {
    result = mergeResults(result, classifyCommand(commands[i], depth, commands[i - 1]))
    if (result.tier === 'forbidden') return result
  }
  return result
}

function classifyScript(script: string, depth: number): ClassificationResult {
  return classifyCommands(parseShellCommand(script), depth + 1)
}

function classifyCommand(cmd: SimpleCommand, depth: number, producer?: SimpleCommand): ClassificationResult {
  if (depth > MAX_DEPTH) return NORMAL

  let result = classifyCommandCore(cmd, depth, producer)

  // Command substitutions in any word ($(...) or `...`) execute too.
  for (const sub of commandSubstitutionsOf(cmd)) {
    result = mergeResults(result, classifyScript(sub, depth))
    if (result.tier === 'forbidden') return result
  }
  if (hasUnbalancedSubstitution(cmd)) result = mergeResults(result, NORMAL)

  return result
}

function classifyCommandCore(cmd: SimpleCommand, depth: number, producer?: SimpleCommand): ClassificationResult {
  if (!cmd.name) return READONLY

  if (cmd.assignments.length > 0) {
    const inner: SimpleCommand = { ...cmd, assignments: [] }
    const reason = dangerousGitEnvReason(cmd.assignments, inner)
    if (reason) return { tier: 'forbidden', reason }
    return mergeResults(NORMAL, classifyCommandCore(inner, depth, producer))
  }

  const hasRedirects = cmd.redirects.length > 0
  const name = baseName(cmd.name)
  const args = cmd.args

  // `git\ push` etc: a command name containing whitespace is re-read as a script (fail closed).
  if (/\s/.test(name)) return classifyScript([cmd.name, ...args].join(' '), depth)

  // Dynamic command names ($var, $(...), `...`) can be anything.
  if (isDynamicWord(cmd.name)) return NORMAL

  if (SHELLS.has(name)) return classifyShellInvocation(cmd, depth, producer)

  if (name === 'eval') return mergeResults(NORMAL, classifyScript(args.join(' '), depth))

  if (name === 'command' && args.some(a => a === '-v' || a === '-V')) return hasRedirects ? NORMAL : READONLY

  if (WRAPPERS.has(name)) {
    const unwrapped = unwrapWrapper(name, args)
    if (!unwrapped) return NORMAL
    const floor = WRAPPER_PASSTHROUGH.has(name) && !hasRedirects ? READONLY : NORMAL
    if (unwrapped.kind === 'script') return mergeResults(floor, classifyScript(unwrapped.script, depth))
    const innerCmd: SimpleCommand = { ...unwrapped.cmd, redirects: cmd.redirects, stdinPiped: cmd.stdinPiped }
    return mergeResults(floor, classifyCommandCore(innerCmd, depth + 1, producer))
  }

  let result: ClassificationResult
  const forbiddenReason = isForbidden(name, args)
  if (forbiddenReason) result = { tier: 'forbidden', reason: forbiddenReason }
  else if (isMassDestructive(name, args)) result = { tier: 'mass-destructive', reason: null }
  else if (isReadOnly(name, args)) result = hasRedirects ? NORMAL : READONLY
  else result = NORMAL

  if (name === 'find') {
    for (const inner of findExecCommands(cmd)) {
      result = mergeResults(result, classifyCommand(inner, depth + 1))
    }
  }

  return result
}

// ─── Shell invocations (bash -c, piped shells) ──────────────

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash'])

interface ShellInvocation {
  /** The -c script, '' when -c was given without a script (fail closed). */
  script: string | null
  /** Shell reads commands from stdin (pipe, redirect, herestring, -s). */
  stdinFed: boolean
  /** Commands known to arrive on stdin (herestring `<<< "..."`). */
  stdinScript: string | null
}

function parseShellInvocation(cmd: SimpleCommand): ShellInvocation {
  const args = cmd.args
  let script: string | null = null
  let stdinFed = cmd.stdinPiped === true || args.some(a => a.startsWith('<'))
  let sawPositional = false
  const hereIdx = args.indexOf('<<<')
  const stdinScript = hereIdx >= 0 ? (args[hereIdx + 1] ?? '') : null

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') continue
    if (a === '-o' || a === '+o') { i++; continue }
    if (a === '--command' || a.startsWith('--command=')) {
      script = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[i + 1] ?? '')
      break
    }
    if ((a.startsWith('-') || a.startsWith('+')) && a.length > 1 && !a.startsWith('--')) {
      const cluster = a.slice(1)
      const cIdx = cluster.indexOf('c')
      if (cIdx >= 0) {
        const attached = cluster.slice(cIdx + 1)
        // `-c'rm -rf /'` attaches the script; `-cx` is just more option letters.
        script = attached && !/^[a-zA-Z]+$/.test(attached) ? attached : (args[i + 1] ?? '')
        break
      }
      if (cluster.includes('s')) stdinFed = true
      continue
    }
    if (a.startsWith('<')) continue
    sawPositional = true
    break
  }

  // No script, no script file: the shell reads from stdin.
  if (script === null && !sawPositional) stdinFed = true
  return { script, stdinFed, stdinScript }
}

/**
 * Text piped into a shell by an adjacent `echo`/`printf` producer
 * (`echo "rm -rf /" | sh`); classified as a script.
 */
function pipedShellScript(producer: SimpleCommand | undefined, shell: SimpleCommand): string | null {
  if (!shell.stdinPiped || !producer?.name) return null
  const name = baseName(producer.name)
  if (name !== 'echo' && name !== 'printf') return null
  return producer.args.filter(a => !a.startsWith('-')).join(' ')
}

function classifyShellInvocation(cmd: SimpleCommand, depth: number, producer?: SimpleCommand): ClassificationResult {
  const { script, stdinFed, stdinScript } = parseShellInvocation(cmd)
  let result: ClassificationResult = stdinFed || cmd.redirects.length > 0 || script === '' ? NORMAL : READONLY
  if (script) result = mergeResults(result, classifyScript(script, depth))
  else if (script === null) result = NORMAL
  if (stdinScript) result = mergeResults(result, classifyScript(stdinScript, depth))
  const piped = pipedShellScript(producer, cmd)
  if (piped) result = mergeResults(result, classifyScript(piped, depth))
  return result
}

// ─── Wrapper commands (env, sudo, xargs, ...) ───────────────

// Options that consume a following value, per wrapper.
const WRAPPERS = new Map<string, Set<string>>([
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['command', new Set()],
  ['exec', new Set(['-a'])],
  ['nohup', new Set()],
  ['time', new Set(['-o', '-f', '--output', '--format'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['xargs', new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--replace', '--max-lines', '--max-chars', '--eof', '--arg-file', '--process-slot-var'])],
  ['doas', new Set(['-u', '-C'])],
  ['sudo', new Set(['-u', '-g', '-p', '-C', '-D', '-h', '-r', '-t', '-U', '-T', '--user', '--group', '--prompt', '--close-from', '--chdir', '--host', '--role', '--type', '--other-user', '--command-timeout'])],
  ['busybox', new Set()],
])
/** Wrappers whose result inherits the inner command's tier (others floor at normal). */
const WRAPPER_PASSTHROUGH = new Set(['env', 'command'])
const WRAPPER_ACCEPTS_ASSIGNMENTS = new Set(['env', 'sudo'])
const WRAPPER_POSITIONALS = new Map<string, number>([['timeout', 1]])

type Unwrapped = { kind: 'command'; cmd: SimpleCommand } | { kind: 'script'; script: string }

function unwrapWrapper(name: string, args: string[]): Unwrapped | null {
  const valueOpts = WRAPPERS.get(name) ?? new Set<string>()
  const assignments: Assignment[] = []
  let positionals = WRAPPER_POSITIONALS.get(name) ?? 0
  let i = 0

  while (i < args.length) {
    const a = args[i]
    if (a === '--') { i++; break }

    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const flag = eq >= 0 ? a.slice(0, eq) : a
      if (name === 'env' && flag === '--split-string') {
        const value = eq >= 0 ? a.slice(eq + 1) : (args[i + 1] ?? '')
        const rest = args.slice(eq >= 0 ? i + 1 : i + 2)
        return { kind: 'script', script: [value, ...rest].join(' ') }
      }
      i += eq < 0 && valueOpts.has(flag) ? 2 : 1
      continue
    }

    if (a.startsWith('-') && a.length > 1) {
      const cluster = a.slice(1)
      let consumedNext = false
      for (let k = 0; k < cluster.length; k++) {
        const opt = `-${cluster[k]}`
        if (!valueOpts.has(opt)) continue
        const attached = cluster.slice(k + 1)
        if (name === 'env' && opt === '-S') {
          const value = attached || (args[i + 1] ?? '')
          const rest = args.slice(attached ? i + 1 : i + 2)
          return { kind: 'script', script: [value, ...rest].join(' ') }
        }
        if (!attached) consumedNext = true
        break
      }
      i += consumedNext ? 2 : 1
      continue
    }

    if (WRAPPER_ACCEPTS_ASSIGNMENTS.has(name) && isAssignment(a)) {
      const eq = a.indexOf('=')
      assignments.push({ name: a.slice(0, eq), value: a.slice(eq + 1) })
      i++
      continue
    }

    if (positionals > 0) { positionals--; i++; continue }
    break
  }

  if (i >= args.length) return null
  return { kind: 'command', cmd: { assignments, name: args[i], args: args.slice(i + 1), redirects: [] } }
}

/** Resolve one level of nesting: wrapper → inner command, `sh -c`/eval/env -S → script. */
function nestedCommands(cmd: SimpleCommand): Unwrapped | { kind: 'none' } {
  if (!cmd.name) return { kind: 'none' }
  const name = baseName(cmd.name)
  const args = cmd.args
  if (/\s/.test(name)) return { kind: 'script', script: [cmd.name, ...args].join(' ') }
  if (name === 'eval') return { kind: 'script', script: args.join(' ') }
  if (SHELLS.has(name)) {
    const { script } = parseShellInvocation(cmd)
    return script ? { kind: 'script', script } : { kind: 'none' }
  }
  if (WRAPPERS.has(name)) {
    const unwrapped = unwrapWrapper(name, args)
    if (!unwrapped) return { kind: 'none' }
    if (unwrapped.kind === 'command') return { kind: 'command', cmd: { ...unwrapped.cmd, redirects: cmd.redirects, stdinPiped: cmd.stdinPiped } }
    return unwrapped
  }
  return { kind: 'none' }
}

/** Commands run by `find -exec/-execdir/-ok/-okdir ... ;|+`. */
function findExecCommands(cmd: SimpleCommand): SimpleCommand[] {
  if (!cmd.name || baseName(cmd.name) !== 'find') return []
  const EXEC_OPTS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
  const args = cmd.args
  const result: SimpleCommand[] = []
  for (let i = 0; i < args.length; i++) {
    if (!EXEC_OPTS.has(args[i])) continue
    const words: string[] = []
    let j = i + 1
    while (j < args.length && args[j] !== ';' && args[j] !== '+') words.push(args[j++])
    if (words.length > 0) result.push({ assignments: [], name: words[0], args: words.slice(1), redirects: [] })
    i = j
  }
  return result
}

// ─── Dangerous environment for git ──────────────────────────

const DANGEROUS_GIT_ENV = new Set([
  'PAGER', 'GIT_PAGER', 'GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'GIT_CONFIG_PARAMETERS', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'PATH',
])

const DANGEROUS_GIT_ENV_REASON =
  'Overriding pager/editor/SSH/loader environment for git can execute arbitrary programs. Run git without environment overrides.'

/** Does this command (after unwrapping wrappers) ultimately invoke git? */
function invokesGit(cmd: SimpleCommand, depth = 0): boolean {
  if (!cmd.name || depth > MAX_DEPTH) return false
  const name = baseName(cmd.name)
  if (name === 'git') return true
  const nested = nestedCommands(cmd)
  if (nested.kind === 'command') return invokesGit(nested.cmd, depth + 1)
  if (nested.kind === 'script') return parseShellCommand(nested.script).some(c => invokesGit(c, depth + 1))
  return false
}

function hasDangerousGitEnv(assignments: Assignment[]): boolean {
  return assignments.some(a => DANGEROUS_GIT_ENV.has(a.name))
}

function dangerousGitEnvReason(assignments: Assignment[], inner: SimpleCommand): string | null {
  if (!hasDangerousGitEnv(assignments)) return null
  return invokesGit(inner) ? DANGEROUS_GIT_ENV_REASON : null
}

// ─── Command substitution ───────────────────────────────────

function hasSubstitutionSyntax(word: string): boolean {
  return word.includes('$(') || word.includes('`')
}

function isDynamicWord(word: string): boolean {
  return word.includes('$') || word.includes('`')
}

function wordsOf(cmd: SimpleCommand): string[] {
  return [
    ...cmd.assignments.map(a => a.value),
    ...(cmd.name ? [cmd.name] : []),
    ...cmd.args,
    ...cmd.redirects.map(r => r.target),
  ]
}

function commandSubstitutionsOf(cmd: SimpleCommand): string[] {
  return wordsOf(cmd).flatMap(extractCommandSubstitutions)
}

/** A word contains substitution syntax that could not be extracted (unbalanced). */
function hasUnbalancedSubstitution(cmd: SimpleCommand): boolean {
  return wordsOf(cmd).some(w => hasSubstitutionSyntax(w) && extractCommandSubstitutions(w).length === 0)
}

function extractCommandSubstitutions(value: string): string[] {
  const results: string[] = []
  let i = 0

  while (i < value.length) {
    if (value[i] === '$' && value[i + 1] === '(') {
      let depth = 1
      const start = i + 2
      let j = start
      while (j < value.length && depth > 0) {
        if (value[j] === '(') depth++
        else if (value[j] === ')') depth--
        if (depth > 0) j++
      }
      if (depth === 0) results.push(value.slice(start, j))
      i = j + 1
    } else if (value[i] === '`') {
      const end = value.indexOf('`', i + 1)
      if (end === -1) break
      results.push(value.slice(i + 1, end))
      i = end + 1
    } else {
      i++
    }
  }

  return results
}

// ─── isGitAllowed ───────────────────────────────────────────

function gitAllowedAll(commands: SimpleCommand[], depth: number): boolean {
  if (depth > MAX_DEPTH) return false
  return commands.every(cmd => gitAllowedCommand(cmd, depth))
}

function gitAllowedScript(script: string, depth: number): boolean {
  return gitAllowedAll(parseShellCommand(script), depth + 1)
}

function gitAllowedCommand(cmd: SimpleCommand, depth: number): boolean {
  if (hasUnbalancedSubstitution(cmd)) return false

  if (!cmd.name) {
    return commandSubstitutionsOf(cmd).every(sub => gitAllowedScript(sub, depth))
  }

  const name = baseName(cmd.name)

  // Dynamic or whitespace-containing command names could resolve to git.
  if (isDynamicWord(cmd.name) || /\s/.test(name)) return false

  if (name === 'git') {
    // Any substitution or dangerous env override on a git command: fail closed.
    if (wordsOf(cmd).some(hasSubstitutionSyntax)) return false
    if (hasDangerousGitEnv(cmd.assignments)) return false
    return isGitReadOnly(cmd.args)
  }

  if (name === 'eval') return gitAllowedScript(cmd.args.join(' '), depth)

  if (SHELLS.has(name)) {
    const { script, stdinFed } = parseShellInvocation(cmd)
    if (stdinFed) return false
    if (script === '') return false
    if (script !== null && !gitAllowedScript(script, depth)) return false
  }

  if (WRAPPERS.has(name)) {
    if (name === 'command' && cmd.args.some(a => a === '-v' || a === '-V')) return true
    const unwrapped = unwrapWrapper(name, cmd.args)
    if (unwrapped?.kind === 'script') return gitAllowedScript(unwrapped.script, depth)
    if (unwrapped?.kind === 'command') {
      const inner: SimpleCommand = { ...unwrapped.cmd, assignments: [...cmd.assignments, ...unwrapped.cmd.assignments], stdinPiped: cmd.stdinPiped }
      if (!gitAllowedCommand(inner, depth + 1)) return false
    }
  }

  for (const inner of findExecCommands(cmd)) {
    if (!gitAllowedCommand(inner, depth + 1)) return false
  }

  // Substitutions in any word run their own commands.
  return commandSubstitutionsOf(cmd).every(sub => gitAllowedScript(sub, depth))
}

const READONLY_COMMANDS = new Set([
  'cat', 'cd', 'cut', 'echo', 'expr', 'false', 'grep', 'head', 'id', 'ls',
  'nl', 'paste', 'pwd', 'rev', 'seq', 'stat', 'tail', 'tr', 'true', 'uname',
  'uniq', 'wc', 'which', 'whoami', 'tac', 'numfmt', 'file',
  'du', 'df', 'printenv', 'date', 'hostname', 'sort', 'dirname',
  'basename', 'realpath', 'readlink', 'test', '[', 'type',
  'jq',
  'column', 'fmt', 'fold', 'comm', 'diff', 'strings', 'od', 'hexdump', 'tree',
])


function isMassDestructive(cmd: string, args: string[]): boolean {
  if (cmd === 'rm') return hasRecursiveRmFlag(args)
  if (cmd === 'find') return isFindMassDestructive(args)
  if (cmd === 'rsync') return isRsyncMassDestructive(args)
  return false
}

function hasRecursiveRmFlag(args: string[]): boolean {
  let optionsEnded = false
  for (const arg of args) {
    if (optionsEnded) continue
    if (arg === '--') {
      optionsEnded = true
      continue
    }
    if (arg === '--recursive') return true
    if (!arg.startsWith('-') || arg === '-') continue
    if (arg.startsWith('--')) continue
    const flags = arg.slice(1)
    if (flags.includes('r') || flags.includes('R')) return true
  }
  return false
}

function isFindMassDestructive(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-delete') return true
    if (arg !== '-exec' && arg !== '-execdir') continue

    const command = args[i + 1]
    if (!command) continue
    if (baseName(command) === 'rm') return true
  }
  return false
}

function isRsyncMassDestructive(args: string[]): boolean {
  return args.some(arg =>
    arg === '--delete' ||
    arg === '--delete-before' ||
    arg === '--delete-during' ||
    arg === '--delete-delay' ||
    arg === '--delete-after'
  )
}

function isReadOnly(cmd: string, args: string[]): boolean {
  if (READONLY_COMMANDS.has(cmd)) return true

  if (cmd === 'find') return isFindSafe(args)
  if (cmd === 'git') return isGitReadOnly(args)
  if (cmd === 'rg') return isRipgrepSafe(args)
  if (cmd === 'sed') return isSedSafe(args)
  if (cmd === 'base64') return isBase64Safe(args)
  if (cmd === 'yq') return isYqSafe(args)
  if (cmd === 'fd' || cmd === 'fdfind') return isFdSafe(args)
  if (cmd === 'ag') return true

  return false
}

function isFindSafe(args: string[]): boolean {
  const unsafeOptions = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf'])
  return !args.some(arg => unsafeOptions.has(arg))
}

function isRipgrepSafe(args: string[]): boolean {
  const unsafeNoArg = new Set(['--search-zip', '-z'])
  const unsafeWithArg = ['--pre', '--hostname-bin']

  return !args.some(arg =>
    unsafeNoArg.has(arg) ||
    unsafeWithArg.some(opt => arg === opt || arg.startsWith(`${opt}=`))
  )
}

function isSedSafe(args: string[]): boolean {
  for (const arg of args) {
    if (!arg.startsWith('-')) continue
    if (arg === '--in-place' || arg.startsWith('--in-place=')) return false
    if (arg === '--file' || arg.startsWith('--file=')) return false
    if (arg.startsWith('--')) continue
    const flags = arg.slice(1)
    if (containsUnsafeSedFlag(flags)) return false
  }
  return true
}

function containsUnsafeSedFlag(flags: string): boolean {
  for (let i = 0; i < flags.length; i++) {
    const ch = flags[i]
    if (ch === 'i') return true
    if (ch === 'f') return true
    if (ch === 'e') return false
  }
  return false
}

function isBase64Safe(args: string[]): boolean {
  return !args.some(arg =>
    arg === '-o' || arg === '--output' ||
    arg.startsWith('--output=') ||
    (arg.startsWith('-o') && arg !== '-o')
  )
}

function isYqSafe(args: string[]): boolean {
  return !args.some(arg => arg === '-i' || arg === '--inplace' || arg.startsWith('--inplace='))
}

function isFdSafe(args: string[]): boolean {
  const unsafeOptions = new Set(['-x', '--exec', '-X', '--exec-batch'])
  return !args.some(arg => unsafeOptions.has(arg))
}

const SYSTEM_DIRS = new Set(['/etc', '/usr', '/System', '/bin', '/sbin', '/boot', '/var', '/lib', '/dev', '/proc', '/sys'])

const CONTAINER_TOOLS = new Set(['docker', 'podman', 'nerdctl'])
const CLOUD_CLIS = new Set(['aws', 'gcloud', 'az'])
const IAC_TOOLS = new Set(['terraform', 'terragrunt', 'pulumi', 'sst', 'cdk'])
const DB_SHELLS_FORBIDDEN = new Set(['psql', 'mysql', 'mariadb', 'mongosh', 'mongo', 'redis-cli', 'sqlcmd'])
const DB_UTILITY_TOOLS = new Set(['pg_dump', 'mysqldump', 'createdb', 'createuser', 'dropdb', 'dropuser', 'pg_restore'])
const LANG_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'twine', 'poetry', 'uv', 'cargo', 'gem', 'mvn', 'gradle', 'gradlew', 'dotnet', 'mix', 'swift'])

function isForbidden(cmd: string, args: string[]): string | null {
  if (cmd === ':') return 'This command is blocked as a shell-control sentinel, not a useful task action. Use a read-only check like `pwd` or `ls` instead.'
  if (cmd === 'mkfs' || cmd.startsWith('mkfs.') || cmd === 'wipefs') {
    return 'Formatting filesystems can irreversibly erase disk data. Use read-only disk inspection like `lsblk` or `diskutil list` instead.'
  }
  if (cmd === 'dd' && args.some(a => a.startsWith('if=') || a.startsWith('of=/dev'))) {
    return 'Raw device copy/write can destroy entire disks quickly. Use file-level copy commands on workspace files only.'
  }
  if (cmd === 'shred' && args.some(a => a.startsWith('/dev/'))) {
    return 'Raw device copy/write can destroy entire disks quickly. Use file-level copy commands on workspace files only.'
  }

  if (cmd === 'rm') {
    const hasForce = args.some(a => a === '-rf' || a === '-fr' || a === '-f')
    const targetsSystem = args.some(a => {
      if (a.startsWith('-')) return false
      return a === '/' || SYSTEM_DIRS.has(a) || Array.from(SYSTEM_DIRS).some(d => a.startsWith(d + '/'))
    })
    if (hasForce && targetsSystem) {
      return 'Force-deleting system paths can break the host environment irrecoverably. Delete only explicit project-local paths after listing them first.'
    }
  }

  if (cmd === 'git' && !isGitReadOnly(args)) {
    return 'Mutating git actions can permanently discard or rewrite history. Use read-only git commands like `git status`, `git log`, or `git diff`.'
  }

  return isForbiddenByToolPolicy(cmd, args)
}

function isForbiddenByToolPolicy(base: string, args: readonly string[]): string | null {
  if (CONTAINER_TOOLS.has(base)) return isContainerForbidden(base, args)
  if (base === 'kubectl') return isKubectlForbidden(args)
  if (base === 'helm') return isHelmForbidden(args)
  if (CLOUD_CLIS.has(base)) return isCloudCliForbidden(base, args)
  if (IAC_TOOLS.has(base)) return isIacForbidden(base, args)
  if (DB_SHELLS_FORBIDDEN.has(base)) return isDatabaseForbidden(base, args)
  if (DB_UTILITY_TOOLS.has(base)) return isDatabaseUtilityForbidden(base, args)
  if (SYSADMIN_ALWAYS_FORBIDDEN.has(base)) return getSysadminAlwaysForbiddenReason(base)
  if (SYSADMIN_BLOCKLIST.has(base)) return isSysadminForbidden(base, args)
  if (LANG_PACKAGE_MANAGERS.has(base)) {
    const result = isLangPackageManagerForbidden(base, args)
    if (result) return result
  }
  if (PACKAGE_MANAGERS.has(base)) return isPackageManagerForbidden(base, args)
  return null
}

// ─── Write-path tracking ────────────────────────────────────

const WRITE_PATH_COMMANDS = new Set(['rm', 'cp', 'mv', 'tee', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'install', 'rsync'])

/**
 * Paths a command writes to. Returns `cwd` itself for commands that write
 * into the working directory (tar -x / unzip without a target dir).
 */
function writeTargets(name: string, args: string[], cwd: string): string[] {
  if (WRITE_PATH_COMMANDS.has(name)) return args.filter(a => !a.startsWith('-'))
  if (name === 'dd') return args.filter(a => a.startsWith('of=')).map(a => a.slice(3))
  if (name === 'curl') return optionValues(args, ['-o', '--output'])
  if (name === 'wget') return optionValues(args, ['-O', '--output-document', '-P', '--directory-prefix'])
  if (name === 'find') return optionValues(args, ['-fprint', '-fprint0', '-fprintf', '-fls'])
  if (name === 'sed') return sedInPlaceTargets(args)
  if (name === 'tar') return tarTargets(args, cwd)
  if (name === 'unzip') {
    const dirs = optionValues(args, ['-d'])
    return dirs.length > 0 ? dirs : [cwd]
  }
  return []
}

/** Values of options given as `-o path`, `-opath`, `--opt path` or `--opt=path`. */
function optionValues(args: string[], opts: string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    for (const opt of opts) {
      if (a === opt) {
        values.push(args[i + 1] ?? '')
        i++
        break
      }
      if (opt.startsWith('--') && a.startsWith(`${opt}=`)) { values.push(a.slice(opt.length + 1)); break }
      // Attached value only for single-letter options (`-o/tmp/x`, `-Cdir`).
      if (opt.length === 2 && a.startsWith(opt) && a.length > 2) { values.push(a.slice(2)); break }
    }
  }
  return values
}

function sedInPlaceTargets(args: string[]): string[] {
  const inPlace = args.some(a => a === '--in-place' || a.startsWith('--in-place=') ||
    (a.startsWith('-') && !a.startsWith('--') && containsUnsafeSedFlag(a.slice(1))))
  if (!inPlace) return []
  const scriptGiven = args.some(a => a === '-e' || a === '--expression' || a.startsWith('--expression=') ||
    a === '-f' || a === '--file' || a.startsWith('--file='))
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-e' || a === '--expression' || a === '-f' || a === '--file') { i++; continue }
    if (a.startsWith('-')) continue
    positionals.push(a)
  }
  return scriptGiven ? positionals : positionals.slice(1)
}

function tarTargets(args: string[], cwd: string): string[] {
  const targets = optionValues(args, ['-C', '--directory'])
  const first = args[0] ?? ''
  // Mode letters: `-czf`, or old-style `czf` without the dash.
  const flags = first.startsWith('--') ? '' : first.startsWith('-') ? first.slice(1) : first
  const extracting = args.includes('--extract') || args.includes('--get') || args.includes('-x') || flags.includes('x')
  const creating = args.some(a => a === '--create' || a === '--append' || a === '--update' || a === '--concatenate') ||
    /[cruA]/.test(flags)
  if (creating) {
    targets.push(...optionValues(args, ['--file']))
    const fIdx = flags.indexOf('f')
    if (fIdx >= 0) {
      const attached = flags.slice(fIdx + 1)
      targets.push(attached || (args[1] ?? ''))
    } else {
      targets.push(...optionValues(args, ['-f']))
    }
  }
  if (extracting && targets.length === 0) targets.push(cwd)
  return targets
}

function baseName(cmd: string): string {
  const i = cmd.lastIndexOf('/')
  return i === -1 ? cmd : cmd.slice(i + 1)
}

const ALLOWED_OUTSIDE_PREFIXES = ['/tmp/']
const ALLOWED_OUTSIDE_EXACT = new Set(['/tmp', '/dev/null'])

function hasUndefinedEnvVars(str: string, env: Record<string, string>): boolean {
  const refs = str.matchAll(/\$\{(\w+)\}|\$(\w+)/g)
  for (const match of refs) {
    const key = match[1] ?? match[2]
    if (!(key in env)) return true
  }
  return false
}

function expandEnvVars(p: string, env: Record<string, string>): string {
  return p.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced, bare) => {
    const key = braced ?? bare
    return env[key] ?? ''
  })
}

function expandAndResolve(path: string, env: Record<string, string>, baseCwd: string): string {
  const expanded = expandEnvVars(path, env)
  if (expanded.startsWith('~')) {
    const home = env.HOME ?? env.USERPROFILE ?? ''
    return resolve(home || '/', expanded.slice(expanded.startsWith('~/') ? 2 : 1))
  }

  // resolve() normalizes trailing slashes; an empty base would fall back to process.cwd().
  return resolve(baseCwd || '/', expanded)
}

function isWithinRoot(resolved: string, root: string): boolean {
  const normalizedRoot = resolve(root || '/')
  if (resolved === normalizedRoot) return true
  return resolved.startsWith(normalizedRoot === '/' ? '/' : `${normalizedRoot}/`)
}

export function isPathWithin(path: string, env: Record<string, string>, ...allowedRoots: string[]): boolean {
  if (!path || path.startsWith('-')) return true

  const [primaryRoot, ...additionalRoots] = allowedRoots
  const cwd = primaryRoot ?? process.cwd()

  const resolved = expandAndResolve(path, env, cwd)

  if ([cwd, ...additionalRoots].some(root => isWithinRoot(resolved, root))) return true

  if (ALLOWED_OUTSIDE_EXACT.has(resolved)) return true
  if (ALLOWED_OUTSIDE_PREFIXES.some(p => resolved.startsWith(p))) return true

  return false
}
