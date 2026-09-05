import { describe, expect, it } from "vitest"
import {
  backendArchive,
  backendPacks,
  hostById,
  releaseHosts,
} from "./targets"

describe("release targets", () => {
  it("ships one host per supported platform with unique identifiers", () => {
    const ids = releaseHosts.map((host) => host.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64-gnu",
      "linux-x64-gnu",
      "windows-x64-msvc",
    ])
  })

  it("describes the native Windows host", () => {
    expect(hostById("windows-x64-msvc")).toEqual({
      id: "windows-x64-msvc",
      runner: "windows-2022",
      bunTarget: "bun-windows-x64",
      rustTarget: "x86_64-pc-windows-msvc",
      executableExtension: ".exe",
      cargoFeatures: ["mtmd", "dynamic-backends"],
    })
    for (const host of releaseHosts) {
      expect(host.executableExtension).toBe(
        host.id.startsWith("windows-") ? ".exe" : "",
      )
    }
  })

  it("targets a known host from every backend pack with unique identifiers", () => {
    const ids = backendPacks.map((pack) => pack.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const pack of backendPacks) {
      const host = hostById(pack.host)
      expect(pack.id.endsWith(`-${host.id}`)).toBe(true)
      expect(backendArchive(pack)).toBe(`magnitude-icn-${pack.id}.tar.gz`)
    }
  })

  it("names Windows backend modules and runtime libraries as PE DLLs", () => {
    const windowsPacks = backendPacks.filter((pack) => pack.host === "windows-x64-msvc")
    expect(windowsPacks.map((pack) => pack.id)).toEqual([
      "cuda-12.9-windows-x64-msvc",
      "vulkan1-windows-x64-msvc",
    ])
    for (const pack of windowsPacks) {
      expect(pack.runner).toBe("windows-2022")
      expect(pack.module).toMatch(/^ggml-[a-z]+\.dll$/)
      for (const library of pack.runtimeLibraries) expect(library).toMatch(/\.dll$/)
    }
    const cuda = windowsPacks.find((pack) => pack.backend === "cuda")
    expect(cuda).toMatchObject({
      module: "ggml-cuda.dll",
      cargoFeatures: ["dynamic-backends", "cuda-no-vmm"],
      runtimeLibraries: ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"],
      cuda: {
        toolkitVersion: "12.9",
        architectures: ["80-virtual", "90-virtual", "120-virtual"],
      },
    })
    expect(windowsPacks.find((pack) => pack.backend === "vulkan")).toMatchObject({
      module: "ggml-vulkan.dll",
      compatibility: { kind: "vulkan", minimumApi: "1.1.0" },
    })
  })

  it("keeps Linux CUDA packs on shared-object names for both toolkits", () => {
    const linux = backendPacks.filter((pack) =>
      pack.backend === "cuda" && pack.host.startsWith("linux-")
    )
    expect(linux.map((pack) => pack.id).sort()).toEqual([
      "cuda-11.8-linux-arm64-gnu",
      "cuda-11.8-linux-x64-gnu",
      "cuda-12.9-linux-arm64-gnu",
      "cuda-12.9-linux-x64-gnu",
    ])
    for (const pack of linux) {
      expect(pack.module).toBe("libggml-cuda.so")
      if (pack.backend !== "cuda") throw new Error("unreachable")
      const suffix = pack.cuda.toolkitVersion === "11.8" ? "11" : "12"
      expect(pack.runtimeLibraries).toEqual([
        pack.cuda.toolkitVersion === "11.8" ? "libcudart.so.11.0" : "libcudart.so.12",
        `libcublas.so.${suffix}`,
        `libcublasLt.so.${suffix}`,
      ])
    }
  })

  it("never uses a lib prefix or Unix extension on Windows and never a DLL elsewhere", () => {
    for (const pack of backendPacks) {
      const windows = pack.host.startsWith("windows-")
      for (const name of [pack.module, ...pack.runtimeLibraries]) {
        expect(name.endsWith(".dll")).toBe(windows)
        if (windows) expect(name.startsWith("lib")).toBe(false)
      }
    }
  })
})
