import { describe, expect, it } from "vitest"
import { POSIX_SHELL_NOT_FOUND_MESSAGE, resolvePosixShell, shellDisplayName } from "./posix-shell"

const existsIn = (paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()))
  return (p: string) => set.has(p.toLowerCase())
}

describe("resolvePosixShell", () => {
  it("honors $SHELL when it exists", () => {
    const r = resolvePosixShell({ env: { SHELL: "/usr/local/bin/zsh" }, platform: "linux", exists: existsIn(["/usr/local/bin/zsh"]) })
    expect(r).toEqual({ ok: true, shell: { path: "/usr/local/bin/zsh", args: ["-c"] } })
  })

  it("falls back to /bin/sh on POSIX when $SHELL is missing or stale", () => {
    const r = resolvePosixShell({ env: { SHELL: "/nope/fish" }, platform: "darwin", exists: existsIn(["/bin/sh"]) })
    expect(r.ok && r.shell.path).toBe("/bin/sh")
  })

  it("prefers Git for Windows bash over PATH and WSL", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32;C:\\tools",
    }
    const exists = existsIn([
      "C:\\Windows\\System32\\bash.exe",
      "C:\\tools\\bash.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
    ])
    const r = resolvePosixShell({ env, platform: "win32", exists })
    expect(r.ok && r.shell.path.toLowerCase()).toBe("c:\\program files\\git\\bin\\bash.exe")
  })

  it("prefers bash.exe on PATH over the WSL launcher in System32", () => {
    const env = { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\tools\\bin" }
    const exists = existsIn(["C:\\Windows\\System32\\bash.exe", "C:\\tools\\bin\\bash.exe"])
    const r = resolvePosixShell({ env, platform: "win32", exists })
    expect(r.ok && r.shell.path.toLowerCase()).toBe("c:\\tools\\bin\\bash.exe")
  })

  it("uses WSL bash only as a last resort", () => {
    const env = { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" }
    const exists = existsIn(["C:\\Windows\\System32\\bash.exe"])
    const r = resolvePosixShell({ env, platform: "win32", exists })
    expect(r.ok && r.shell.path.toLowerCase()).toBe("c:\\windows\\system32\\bash.exe")
  })

  it("finds LOCALAPPDATA Git installs", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "" }
    const exists = existsIn(["C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"])
    const r = resolvePosixShell({ env, platform: "win32", exists })
    expect(r.ok).toBe(true)
  })

  it("resolves a bare $SHELL name on PATH (with .exe on Windows)", () => {
    const env = { SHELL: "bash", PATH: "C:\\Git\\bin" }
    const r = resolvePosixShell({ env, platform: "win32", exists: existsIn(["C:\\Git\\bin\\bash.exe"]) })
    expect(r.ok && r.shell.path).toBe("C:\\Git\\bin\\bash.exe")
  })

  it("returns a descriptive failure when nothing is found", () => {
    const r = resolvePosixShell({ env: { PATH: "C:\\tools" }, platform: "win32", exists: () => false })
    expect(r).toEqual({ ok: false, message: POSIX_SHELL_NOT_FOUND_MESSAGE })
  })
})

describe("shellDisplayName", () => {
  it("handles POSIX paths, Windows paths and .exe", () => {
    expect(shellDisplayName("/bin/zsh")).toBe("zsh")
    expect(shellDisplayName("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("bash")
    expect(shellDisplayName("bash.exe")).toBe("bash")
    expect(shellDisplayName(undefined)).toBe("bash")
    expect(shellDisplayName("")).toBe("bash")
  })
})
