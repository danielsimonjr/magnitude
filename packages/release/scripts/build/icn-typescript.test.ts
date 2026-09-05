import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  cmakeDefinesFromEnvironment,
  sanitizeWindowsNativeBuildEnv,
  stagingBinaryPath,
} from "./icn-typescript"

describe("cmakeDefinesFromEnvironment", () => {
  test("promotes CMAKE_* values to -D flags and ignores other keys", () => {
    expect(
      cmakeDefinesFromEnvironment({
        CMAKE_CUDA_ARCHITECTURES: "80-virtual;90-virtual",
        CMAKE_BUILD_TYPE: "Release",
        CUDA_PATH: "C:/CUDA",
        CMAKE_EMPTY: "",
        CMAKE_MISSING: undefined,
      }),
    ).toEqual([
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_CUDA_ARCHITECTURES=80-virtual;90-virtual",
    ])
  })
})

describe("sanitizeWindowsNativeBuildEnv", () => {
  test("removes LLVM and node_modules/.bin so MSVC link.exe and SDK rc.exe win", () => {
    expect(
      sanitizeWindowsNativeBuildEnv({
        Path: [
          "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64",
          "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\Llvm\\x64\\bin",
          "D:\\a\\magnitude\\magnitude\\node_modules\\.bin",
          "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.9\\bin",
        ].join(";"),
      }),
    ).toEqual({
      Path: [
        "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64",
        "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.9\\bin",
      ].join(";"),
    })
  })

  test("preserves an explicit CMAKE_RC_COMPILER", () => {
    expect(
      sanitizeWindowsNativeBuildEnv({
        Path: "C:\\tools\\node_modules\\.bin;C:\\Windows\\System32",
        CMAKE_RC_COMPILER: "C:\\Kits\\rc.exe",
      }),
    ).toEqual({
      Path: "C:\\Windows\\System32",
      CMAKE_RC_COMPILER: "C:\\Kits\\rc.exe",
    })
  })

  test("discovers Windows SDK rc.exe from WindowsSdkDir", () => {
    const sdkRoot = join(import.meta.dir, ".tmp-windows-sdk")
    const sdkVer = "10.0.26100.0"
    const rcPath = join(sdkRoot, "bin", sdkVer, "x64", "rc.exe")
    rmSync(sdkRoot, { recursive: true, force: true })
    mkdirSync(join(sdkRoot, "bin", sdkVer, "x64"), { recursive: true })
    writeFileSync(rcPath, "")
    try {
      expect(
        sanitizeWindowsNativeBuildEnv({
          Path: "C:\\Windows\\System32",
          WindowsSdkDir: sdkRoot,
          WindowsSDKVersion: `${sdkVer}\\`,
        }),
      ).toEqual({
        Path: "C:\\Windows\\System32",
        CMAKE_RC_COMPILER: rcPath,
      })
    } finally {
      rmSync(sdkRoot, { recursive: true, force: true })
    }
  })
})

describe("stagingBinaryPath", () => {
  test("uses .building.exe on Windows so Bun --compile outfile matches", () => {
    expect(stagingBinaryPath("D:\\a\\bin\\magnitude-inference.exe")).toBe(
      "D:\\a\\bin\\magnitude-inference.building.exe",
    )
  })

  test("appends .building on non-Windows binaries", () => {
    expect(stagingBinaryPath("/tmp/bin/magnitude-inference")).toBe(
      "/tmp/bin/magnitude-inference.building",
    )
  })
})
