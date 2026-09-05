/**
 * Phase-5 release cutover: compile the TypeScript ICN (`packages/icn-server`) with Bun
 * and package llama / shim / CPU backend shared libraries from the icn-native build.
 */
import { existsSync } from "node:fs"
import { access, chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { Schema } from "effect"
import { IcnBinaryIdentity } from "@magnitudedev/icn-protocol"
import { ICN_EXECUTABLE_NAME } from "../../src/executables"
import { MACOS_DEPLOYMENT_TARGET } from "../../src/targets"
import { getTargetInfo } from "../../../../scripts/release-target"
import { run } from "./common"

const PROJECT_ROOT = resolve(import.meta.dir, "../../../..")
const ICN_NATIVE_ROOT = resolve(PROJECT_ROOT, "packages/icn-native")
const LLAMA_SRC = resolve(
  PROJECT_ROOT,
  "inference/native/llama-cpp-rs/llama-cpp-sys-2/llama.cpp",
)

export interface TypescriptIcnBuild {
  readonly binary: string
  readonly identity: IcnBinaryIdentity
  readonly backendModules: readonly string[]
  readonly runtimeLibraries: readonly string[]
}

export interface BuildTypescriptIcnInput {
  readonly target: string
  readonly profile: string
  readonly features?: readonly string[]
  readonly buildEnvironment?: Readonly<Record<string, string>>
  /** When false, only collect native artifacts (backend packs). Default true. */
  readonly compileBinary?: boolean
}

const sharedLibName = (base: string, platform: string): string => {
  if (platform === "windows") return `${base}.dll`
  if (platform === "darwin") return `lib${base}.dylib`
  return `lib${base}.so`
}

const isRuntimeLibrary = (file: string): boolean => {
  const name = basename(file)
  return name.endsWith(".dylib") || name.endsWith(".dll") || name.includes(".so")
}

const isBackendModule = (file: string): boolean => {
  const name = basename(file).toLowerCase()
  return [
    "libggml-cpu",
    "libggml-metal",
    "libggml-cuda",
    "libggml-vulkan",
    "ggml-cpu",
    "ggml-metal",
    "ggml-cuda",
    "ggml-vulkan",
  ].some((prefix) => name.startsWith(prefix))
}

const filesIn = async (directory: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => resolve(directory, entry.name))
      .sort()
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return []
    throw cause
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const cmakeFeatureFlags = (
  features: readonly string[],
): readonly string[] => {
  const flags: string[] = ["-DGGML_BACKEND_DL=ON", "-DBUILD_SHARED_LIBS=ON"]
  const set = new Set(features)
  if (set.has("cuda-no-vmm") || set.has("cuda")) flags.push("-DGGML_CUDA=ON")
  if (set.has("metal")) flags.push("-DGGML_METAL=ON")
  if (set.has("vulkan")) flags.push("-DGGML_VULKAN=ON")
  return flags
}

/**
 * CMake only honors CMAKE_* values from the cache / -D flags. Putting them in the
 * process environment alone leaves variables like CMAKE_CUDA_ARCHITECTURES undefined,
 * so llama.cpp falls back to its default arch list (including Hopper/Blackwell), which
 * breaks CUDA 11.8 and Windows CUDA configure.
 */
export const cmakeDefinesFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] =>
  Object.entries(environment)
    .filter((entry): entry is [string, string] =>
      entry[0].startsWith("CMAKE_") && typeof entry[1] === "string" && entry[1].length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `-D${key}=${value}`)

/**
 * Windows CUDA native builds need MSVC `link.exe` and the Windows SDK `rc.exe`.
 * VS puts LLVM ahead of MSVC on PATH, and `bun install` puts npm's `rc` package
 * in `node_modules/.bin`, which CMake mistakes for the resource compiler.
 */
export const sanitizeWindowsNativeBuildEnv = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const pathKey =
    Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "Path"
  const pathValue = environment[pathKey] ?? environment.PATH ?? environment.Path ?? ""
  const sanitized: Record<string, string> = {
    [pathKey]: pathValue
      .split(";")
      .filter((entry) => {
        if (entry.length === 0) return false
        if (/[\\/]Llvm[\\/]/i.test(entry)) return false
        if (/[\\/]node_modules[\\/]\.bin$/i.test(entry)) return false
        return true
      })
      .join(";"),
  }

  const existingRc = environment.CMAKE_RC_COMPILER
  if (typeof existingRc === "string" && existingRc.length > 0) {
    sanitized.CMAKE_RC_COMPILER = existingRc
    return sanitized
  }

  const sdkDir = environment.WindowsSdkDir ?? environment.WINDOWSSDKDIR
  const sdkVer = (environment.WindowsSDKVersion ?? environment.WINDOWSSDKVERSION)
    ?.replace(/[\\/]+$/, "")
  if (sdkDir && sdkVer) {
    const candidate = join(sdkDir, "bin", sdkVer, "x64", "rc.exe")
    if (existsSync(candidate)) {
      sanitized.CMAKE_RC_COMPILER = candidate
    }
  }
  return sanitized
}

/** Bun `--compile --outfile=foo.exe` may write `foo.building.exe`, not `foo.exe.building`. */
export const stagingBinaryPath = (binary: string): string => {
  if (/\.exe$/i.test(binary)) {
    return binary.replace(/\.exe$/i, ".building.exe")
  }
  return `${binary}.building`
}

const nativeRpathEnvironment = (
  target: string,
): Readonly<Record<string, string>> => {
  const { platform } = getTargetInfo(target)
  if (platform === "linux") {
    return {
      CMAKE_BUILD_RPATH_USE_ORIGIN: "ON",
      CMAKE_INSTALL_RPATH: "$ORIGIN;$ORIGIN/../runtime",
    }
  }
  if (platform === "darwin") {
    return {
      CMAKE_INSTALL_RPATH: "@loader_path;@loader_path/../runtime",
    }
  }
  return {}
}

const loaderPathVariable = (): string => {
  if (process.platform === "darwin") return "DYLD_LIBRARY_PATH"
  if (process.platform !== "win32") return "LD_LIBRARY_PATH"
  return Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
}

const readIdentity = async (
  binary: string,
  runtimeDirectories: readonly string[],
): Promise<IcnBinaryIdentity> => {
  const loader = loaderPathVariable()
  const stdout = await run([binary, "version", "--json"], {
    env: {
      ...process.env,
      [loader]: [...runtimeDirectories, process.env[loader]]
        .filter(Boolean)
        .join(delimiter),
    },
  })
  const value = Schema.decodeUnknownSync(
    Schema.parseJson(IcnBinaryIdentity),
  )(stdout)
  if (value.api_version !== 1) {
    throw new Error("ICN identity probe returned an invalid contract")
  }
  return value
}

const rewriteLinuxRpath = async (
  file: string,
  rpath: string,
): Promise<void> => {
  const patchelf = Bun.which("patchelf")
  if (!patchelf) return
  await run([patchelf, "--set-rpath", rpath, file])
}

const rewriteDarwinRpath = async (
  file: string,
  rpaths: readonly string[],
): Promise<void> => {
  const otool = Bun.which("otool")
  const installNameTool = Bun.which("install_name_tool")
  if (!otool || !installNameTool) return
  const listing = await run([otool, "-l", file])
  const existing = [...listing.matchAll(
    /LC_RPATH[\s\S]*?\n\s*path ([^ ]+) \(offset/g,
  )].map((match) => match[1]!)
  for (const path of existing) {
    await run([installNameTool, "-delete_rpath", path, file])
  }
  for (const path of rpaths) {
    await run([installNameTool, "-add_rpath", path, file])
  }
}

const normalizeReleaseRpaths = async (
  platform: string,
  files: readonly string[],
): Promise<void> => {
  if (platform === "windows") return
  const libraryRpath = platform === "darwin"
    ? ["@loader_path", "@loader_path/../runtime"]
    : "$ORIGIN:$ORIGIN/../runtime"
  for (const file of files) {
    if (platform === "darwin") {
      await rewriteDarwinRpath(file, libraryRpath as readonly string[])
    } else {
      await rewriteLinuxRpath(file, libraryRpath as string)
    }
  }
}

const findLlamaLibDir = async (buildDir: string, platform: string): Promise<string> => {
  const name = sharedLibName("llama", platform)
  for (const candidate of [join(buildDir, "bin"), join(buildDir, "src"), buildDir]) {
    if (await exists(join(candidate, name))) return candidate
  }
  throw new Error(`could not find ${name} under ${buildDir}`)
}

const buildShim = async (
  platform: string,
  llamaLibDir: string,
  outputDir: string,
): Promise<string> => {
  const cc = process.env.CC ?? Bun.which("cc") ?? Bun.which("gcc") ?? Bun.which("clang")
  if (!cc) throw new Error("no C compiler found (set CC)")
  const out = join(outputDir, sharedLibName("icn_shim", platform))
  const args = [
    cc,
    "-shared",
    "-fPIC",
    "-O2",
    "-fvisibility=hidden",
    "-std=c11",
    "-Wall",
    "-Wextra",
    `-I${join(LLAMA_SRC, "include")}`,
    `-I${join(LLAMA_SRC, "ggml/include")}`,
    join(ICN_NATIVE_ROOT, "native", "shim.c"),
    "-o",
    out,
    `-L${llamaLibDir}`,
    "-lllama",
    "-lggml",
    "-lggml-base",
  ]
  const env: Record<string, string | undefined> = { ...process.env }
  if (platform === "darwin") {
    args.push(
      `-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`,
      "-Wl,-rpath,@loader_path",
      "-Wl,-rpath,@loader_path/../runtime",
    )
    env.MACOSX_DEPLOYMENT_TARGET = MACOS_DEPLOYMENT_TARGET
  } else if (platform !== "windows") {
    args.push("-Wl,-rpath,$ORIGIN", "-Wl,-rpath,$ORIGIN/../runtime", "-Wl,--no-undefined")
  }
  await run(args, { cwd: PROJECT_ROOT, env })
  return out
}

/**
 * Builds llama.cpp shared libraries (+ CPU/GPU backend modules) and the icn shim
 * for release packaging. Outputs are staged under `inference/target/release-<profile>/native`.
 */
export const buildIcnNativeArtifacts = async (input: {
  readonly target: string
  readonly profile: string
  readonly features?: readonly string[]
  readonly buildEnvironment?: Readonly<Record<string, string>>
}): Promise<{
  readonly backendModules: readonly string[]
  readonly runtimeLibraries: readonly string[]
  readonly llamaLibDir: string
}> => {
  const info = getTargetInfo(input.target)
  const platform = info.platform
  const cmake = Bun.which("cmake")
  if (!cmake) throw new Error("cmake not found on PATH")
  if (!(await exists(join(LLAMA_SRC, "CMakeLists.txt")))) {
    throw new Error(`llama.cpp source missing at ${LLAMA_SRC}`)
  }

  const stageRoot = resolve(
    PROJECT_ROOT,
    "inference/target",
    `release-${input.profile}`,
    "native",
  )
  const buildDir = join(stageRoot, "cmake")
  const packageDir = join(stageRoot, "package")
  await rm(stageRoot, { recursive: true, force: true })
  await mkdir(packageDir, { recursive: true, mode: 0o700 })

  const features = input.features ?? ["dynamic-backends"]
  const featureFlags = cmakeFeatureFlags(features)
  // On Windows CUDA builds: drop LLVM (MSVC link.exe) and node_modules/.bin
  // (npm `rc`), and pin CMAKE_RC_COMPILER to the Windows SDK resource compiler.
  const windowsNativeEnv =
    process.platform === "win32" && features.some((feature) => feature.includes("cuda"))
      ? sanitizeWindowsNativeBuildEnv({
          ...process.env,
          ...input.buildEnvironment,
        })
      : {}
  const buildEnvironment = {
    ...input.buildEnvironment,
    ...nativeRpathEnvironment(input.target),
    ...(windowsNativeEnv.CMAKE_RC_COMPILER
      ? { CMAKE_RC_COMPILER: windowsNativeEnv.CMAKE_RC_COMPILER }
      : {}),
  }
  const processEnvironment = {
    ...process.env,
    ...buildEnvironment,
    ...windowsNativeEnv,
  }
  const cmakeDefines = cmakeDefinesFromEnvironment(buildEnvironment)
  await run([
    cmake,
    "-S",
    LLAMA_SRC,
    "-B",
    buildDir,
    ...featureFlags,
    ...cmakeDefines,
    "-DGGML_NATIVE=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_SERVER=OFF",
    "-DLLAMA_BUILD_TOOLS=OFF",
    "-DLLAMA_CURL=OFF",
    "-DCMAKE_BUILD_TYPE=Release",
  ], {
    cwd: PROJECT_ROOT,
    env: processEnvironment,
  })
  await run([
    cmake,
    "--build",
    buildDir,
    "--target",
    "llama",
    "--config",
    "Release",
  ], {
    cwd: PROJECT_ROOT,
    env: processEnvironment,
  })

  const llamaLibDir = await findLlamaLibDir(buildDir, platform)
  const backendsDir = join(buildDir, "bin")
  const collectedLibs = [
    ...await filesIn(llamaLibDir),
    ...await filesIn(backendsDir),
    ...await filesIn(join(buildDir, "ggml", "src")),
  ]
  const uniqueByName = new Map<string, string>()
  for (const file of collectedLibs) {
    if (!isRuntimeLibrary(file)) continue
    uniqueByName.set(basename(file), file)
  }

  const backendModules: string[] = []
  const runtimeLibraries: string[] = []
  for (const [name, source] of uniqueByName) {
    const destination = join(packageDir, name)
    await run(["cp", "-a", source, destination])
    if (isBackendModule(destination)) {
      backendModules.push(destination)
    } else if (
      name.toLowerCase().includes("llama") ||
      name.toLowerCase().includes("ggml")
    ) {
      runtimeLibraries.push(destination)
    }
  }

  const shim = await buildShim(platform, packageDir, packageDir)
  runtimeLibraries.push(shim)

  if (backendModules.length === 0) {
    // CPU-only builds without GGML_BACKEND_DL may fold ggml-cpu into libggml.
    // Prefer an explicit CPU module when present; otherwise fail clearly for release.
    const cpuName = sharedLibName("ggml-cpu", platform)
    if (await exists(join(packageDir, cpuName))) {
      backendModules.push(join(packageDir, cpuName))
    }
  }
  if (backendModules.length === 0) {
    throw new Error(`${input.profile} native build emitted no backend modules`)
  }

  await normalizeReleaseRpaths(platform, [...runtimeLibraries, ...backendModules])
  await writeFile(
    join(packageDir, "build.json"),
    `${JSON.stringify({
      version: 1,
      platform: process.platform,
      arch: process.arch,
      llamaLibDir: packageDir,
      llamaLib: join(packageDir, sharedLibName("llama", platform)),
      shimLib: shim,
      builtAt: new Date().toISOString(),
    }, null, 2)}\n`,
  )

  return {
    backendModules: backendModules.sort(),
    runtimeLibraries: runtimeLibraries.sort(),
    llamaLibDir: packageDir,
  }
}

export const buildTypescriptIcnBinary = async (target: string): Promise<string> => {
  const info = getTargetInfo(target)
  const nativePlatform = info.platform === "windows" ? "win32" : info.platform
  const binary = resolve(
    PROJECT_ROOT,
    "bin",
    `${ICN_EXECUTABLE_NAME}${info.executableExt}`,
  )
  await mkdir(resolve(PROJECT_ROOT, "bin"), { recursive: true })
  // Stage through a temp name so a failed compile cannot leave a half-written release binary.
  const staging = stagingBinaryPath(binary)
  await run(
    [
      "bun",
      "build",
      resolve(PROJECT_ROOT, "packages/icn-server/src/main.ts"),
      "--compile",
      `--target=${target}`,
      `--outfile=${staging}`,
      "--define",
      `process.platform=${JSON.stringify(nativePlatform)}`,
      "--define",
      `process.arch=${JSON.stringify(info.arch)}`,
    ],
    { cwd: PROJECT_ROOT },
  )
  await rename(staging, binary)
  await chmod(binary, 0o755)
  if (info.platform === "darwin") {
    await run(["codesign", "--force", "--deep", "--sign", "-", binary])
  }
  return binary
}

export const buildTypescriptIcnBinaryBundle = async (
  input: BuildTypescriptIcnInput,
): Promise<TypescriptIcnBuild> => {
  const compileBinary = input.compileBinary !== false
  const native = await buildIcnNativeArtifacts({
    target: input.target,
    profile: input.profile,
    features: input.features,
    buildEnvironment: input.buildEnvironment,
  })
  const binary = compileBinary
    ? await buildTypescriptIcnBinary(input.target)
    : resolve(PROJECT_ROOT, "bin", `${ICN_EXECUTABLE_NAME}${getTargetInfo(input.target).executableExt}`)
  if (compileBinary) {
    // Point the compiled binary's FFI resolution at the staged native package when present.
    await writeFile(
      resolve(PROJECT_ROOT, "packages/icn-native/native/build.json"),
      `${JSON.stringify({
        version: 1,
        platform: process.platform,
        arch: process.arch,
        llamaLibDir: native.llamaLibDir,
        llamaLib: join(native.llamaLibDir, sharedLibName("llama", getTargetInfo(input.target).platform)),
        shimLib: join(native.llamaLibDir, sharedLibName("icn_shim", getTargetInfo(input.target).platform)),
        builtAt: new Date().toISOString(),
      }, null, 2)}\n`,
    )
  }
  const identity = compileBinary
    ? await readIdentity(binary, [native.llamaLibDir, ...native.runtimeLibraries.map(dirname)])
    : Schema.decodeUnknownSync(Schema.parseJson(IcnBinaryIdentity))(
      await run([
        "bun",
        resolve(PROJECT_ROOT, "packages/icn-server/src/main.ts"),
        "version",
        "--json",
      ], { cwd: PROJECT_ROOT }),
    )
  return {
    binary,
    identity,
    backendModules: native.backendModules,
    runtimeLibraries: native.runtimeLibraries,
  }
}
