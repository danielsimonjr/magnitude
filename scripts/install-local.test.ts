import { describe, expect, test } from "bun:test"
import { delimiter, resolve } from "node:path"
import {
  cliReleaseTag,
  defaultBinDir,
  formatMissingReleaseGuidance,
  pathContains,
  pickLatestCliReleaseTag,
  releaseManifestUrl,
  windowsWrapperContents,
  WINDOWS_WRAPPER_MARKER,
} from "./install-local"

describe("install-local helpers", () => {
  test("builds the release manifest URL for a version", () => {
    expect(releaseManifestUrl("0.0.11", "https://example.test/releases/download/")).toBe(
      "https://example.test/releases/download/@magnitudedev/cli@0.0.11/magnitude-release.json",
    )
    expect(cliReleaseTag("0.0.11")).toBe("@magnitudedev/cli@0.0.11")
  })

  test("picks the newest @magnitudedev/cli tag", () => {
    expect(
      pickLatestCliReleaseTag([
        "@magnitudedev/cli@0.0.9",
        "unrelated",
        "@magnitudedev/cli@0.0.11",
        "@magnitudedev/cli@0.0.10",
      ]),
    ).toBe("@magnitudedev/cli@0.0.11")
    expect(pickLatestCliReleaseTag(["v1.0.0"])).toBeUndefined()
  })

  test("chooses a platform-appropriate default bin directory", () => {
    expect(defaultBinDir({ BUN_INSTALL: "/opt/bun" }, "/home/dev", false)).toBe(
      resolve("/opt/bun", "bin"),
    )
    expect(defaultBinDir({}, "/home/dev", false)).toBe(resolve("/home/dev", ".local", "bin"))
    expect(defaultBinDir({ LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" }, "C:\\Users\\dev", true)).toBe(
      resolve("C:\\Users\\dev\\AppData\\Local", "Magnitude", "bin"),
    )
  })

  test("detects whether a directory is already on PATH", () => {
    const directory = resolve("/home/dev/.local/bin")
    expect(pathContains(directory, `/usr/bin${delimiter}${directory}`)).toBe(true)
    expect(pathContains(directory, "/usr/bin")).toBe(false)
  })

  test("writes a marked Windows wrapper that forwards to the shim", () => {
    const contents = windowsWrapperContents("C:\\src\\cli\\bin\\magnitude.cmd")
    expect(contents).toContain(WINDOWS_WRAPPER_MARKER)
    expect(contents).toContain('call "C:\\src\\cli\\bin\\magnitude.cmd" %*')
    expect(contents.startsWith("@echo off\r\n")).toBe(true)
  })

  test("guides the user to a concrete release tag when one is known", () => {
    const message = formatMissingReleaseGuidance({
      version: "0.0.12",
      status: 404,
      manifestUrl: "https://example.test/magnitude-release.json",
      latestTag: "@magnitudedev/cli@0.0.11",
    })
    expect(message).toContain("checked-out version 0.0.12")
    expect(message).toContain("git checkout @magnitudedev/cli@0.0.11")
    expect(message).toContain("bun run install:local --build-inference")
    expect(message).toContain("--allow-unreleased")
  })
})
