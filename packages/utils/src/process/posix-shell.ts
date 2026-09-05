import { existsSync } from "node:fs"
import nodePath from "node:path"

/**
 * Locating a POSIX shell for the agent's shell tool.
 *
 * Magnitude's shell-safety classifier only understands POSIX shell syntax, so
 * the agent must run commands through `sh`/`bash` on every platform — never
 * through cmd.exe or PowerShell. On Windows that means finding a bash.exe,
 * preferring Git for Windows. WSL's `System32\bash.exe` is accepted only as a
 * last resort: it boots a Linux distro, so the working directory and
 * environment would not be the user's Windows ones.
 */

export const POSIX_SHELL_ARGS = ["-c"] as const

export interface PosixShell {
  readonly path: string
  readonly args: readonly ["-c"]
}

export type PosixShellResolution =
  | { readonly ok: true; readonly shell: PosixShell }
  | { readonly ok: false; readonly message: string }

export const POSIX_SHELL_NOT_FOUND_MESSAGE =
  "Magnitude's agent shell needs a POSIX shell. Install Git for Windows (https://gitforwindows.org) or set SHELL to a bash executable."

export interface ResolvePosixShellOptions {
  readonly env?: Record<string, string | undefined>
  readonly platform?: NodeJS.Platform
  readonly exists?: (path: string) => boolean
}

const looksLikeAbsolutePath = (value: string): boolean =>
  value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")

/** Ordered list of bash.exe candidates on Windows (excluding the WSL launcher). */
export function windowsBashCandidates(env: Record<string, string | undefined>): string[] {
  const { join } = nodePath.win32
  const candidates: string[] = []
  const gitRoots = [
    env.ProgramFiles ?? env.PROGRAMFILES,
    env["ProgramFiles(x86)"],
    env.ProgramW6432,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs") : undefined,
  ].filter((root): root is string => Boolean(root))
  for (const root of gitRoots) {
    candidates.push(join(root, "Git", "bin", "bash.exe"))
    candidates.push(join(root, "Git", "usr", "bin", "bash.exe"))
  }
  return candidates
}

const windowsSystem32 = (env: Record<string, string | undefined>): string => {
  const { join } = nodePath.win32
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? "C:\\Windows"
  return join(systemRoot, "System32").toLowerCase()
}

/**
 * Resolve the POSIX shell to run agent commands through.
 *
 * Order: `$SHELL` if set and it exists (absolute path, or found on PATH) →
 * Git for Windows install locations → `bash.exe` on PATH (skipping System32)
 * → WSL's System32 `bash.exe` → `/bin/sh` on non-Windows platforms.
 */
export function resolvePosixShell(options: ResolvePosixShellOptions = {}): PosixShellResolution {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const isWindows = platform === "win32"
  const { join } = isWindows ? nodePath.win32 : nodePath.posix

  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(isWindows ? ";" : ":")
    .filter((entry) => entry.length > 0)

  const findOnPath = (binary: string): string | undefined => {
    for (const dir of pathEntries) {
      const candidate = join(dir, binary)
      if (exists(candidate)) return candidate
    }
    return undefined
  }

  const ok = (path: string): PosixShellResolution => ({ ok: true, shell: { path, args: POSIX_SHELL_ARGS } })

  const fromEnv = env.SHELL?.trim()
  if (fromEnv) {
    if (looksLikeAbsolutePath(fromEnv)) {
      if (exists(fromEnv)) return ok(fromEnv)
    } else {
      const found = findOnPath(fromEnv) ?? (isWindows && !/\.exe$/i.test(fromEnv) ? findOnPath(`${fromEnv}.exe`) : undefined)
      if (found) return ok(found)
    }
  }

  if (!isWindows) {
    for (const candidate of ["/bin/sh", "/usr/bin/sh", "/bin/bash", "/usr/bin/bash"]) {
      if (exists(candidate)) return ok(candidate)
    }
    return { ok: false, message: POSIX_SHELL_NOT_FOUND_MESSAGE }
  }

  for (const candidate of windowsBashCandidates(env)) {
    if (exists(candidate)) return ok(candidate)
  }

  const system32 = windowsSystem32(env)
  let wslBash: string | undefined
  for (const dir of pathEntries) {
    const candidate = join(dir, "bash.exe")
    if (!exists(candidate)) continue
    if (dir.toLowerCase().replace(/[\\/]+$/, "") === system32) {
      wslBash ??= candidate
      continue
    }
    return ok(candidate)
  }
  if (wslBash) return ok(wslBash)

  return { ok: false, message: POSIX_SHELL_NOT_FOUND_MESSAGE }
}

/** Convenience wrapper that throws a descriptive Error instead of returning a failure. */
export function requirePosixShell(options: ResolvePosixShellOptions = {}): PosixShell {
  const resolved = resolvePosixShell(options)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.shell
}

/**
 * Basename of a shell path for display ("bash" from "/bin/bash",
 * "C:\Program Files\Git\bin\bash.exe", or "bash.exe"). Handles both
 * separators and strips a trailing `.exe`.
 */
export function shellDisplayName(shellPath: string | undefined, fallback = "bash"): string {
  const base = shellPath?.split(/[\\/]/).pop()?.replace(/\.exe$/i, "")
  return base || fallback
}
