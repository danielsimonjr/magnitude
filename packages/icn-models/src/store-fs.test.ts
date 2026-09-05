import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { acquireExclusiveLockSync, ensureStoreLayout } from "./store-fs"

describe("store-fs", () => {
  it("owned layout replaces invalid child nodes without touching their targets", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "icn-store-"))
    const root = join(temporary, "models")
    const outside = join(temporary, "outside")
    mkdirSync(root)
    writeFileSync(outside, "outside")
    if (process.platform !== "win32") {
      symlinkSync(outside, join(root, "hub"))
    } else {
      writeFileSync(join(root, "hub"), "invalid")
    }
    writeFileSync(join(root, "locks"), "invalid")

    await ensureStoreLayout(root)

    expect(require("node:fs").statSync(join(root, "hub")).isDirectory()).toBe(true)
    expect(require("node:fs").statSync(join(root, "locks")).isDirectory()).toBe(true)
    expect(readFileSync(outside, "utf8")).toBe("outside")
    rmSync(temporary, { recursive: true })
  })

  it("lock acquisition replaces a symlink without following it", () => {
    if (process.platform === "win32") return
    const temporary = mkdtempSync(join(tmpdir(), "icn-lock-"))
    const lockPath = join(temporary, "locks/model.lock")
    const outside = join(temporary, "outside")
    mkdirSync(join(temporary, "locks"), { recursive: true })
    writeFileSync(outside, "outside")
    symlinkSync(outside, lockPath)

    const lock = acquireExclusiveLockSync(lockPath)
    lock.release()

    expect(require("node:fs").lstatSync(lockPath).isFile()).toBe(true)
    expect(readFileSync(outside, "utf8")).toBe("outside")
    rmSync(temporary, { recursive: true })
  })
})
