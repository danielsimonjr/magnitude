import { describe, expect, test } from "bun:test"
import {
  cmakeDefinesFromEnvironment,
  withoutWindowsLlvmPath,
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

describe("withoutWindowsLlvmPath", () => {
  test("removes LLVM directories so MSVC link.exe wins for CUDA", () => {
    expect(
      withoutWindowsLlvmPath({
        Path: [
          "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64",
          "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\Llvm\\x64\\bin",
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
})
