/**
 * Builds the native pieces `@magnitudedev/icn-native` binds through bun:ffi:
 *
 *   1. libllama (+ libggml*) as shared libraries from the vendored llama.cpp
 *      source under inference/native/llama-cpp-rs/llama-cpp-sys-2/llama.cpp.
 *   2. native/shim.c -> libicn_shim.so, a tiny C layer exposing pointer/scalar
 *      wrappers for the struct-by-value parts of the llama.cpp API.
 *
 * Output paths are recorded in native/build.json, which src/ffi.ts reads at
 * dlopen time (MAGNITUDE_LLAMA_LIB_DIR overrides it).
 *
 * Usage: bun run scripts/build-native.ts [--skip-llama] [--jobs N]
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const LLAMA_SRC = join(
  REPO_ROOT,
  "inference/native/llama-cpp-rs/llama-cpp-sys-2/llama.cpp"
);
const CMAKE_BUILD_DIR =
  process.env.MAGNITUDE_LLAMA_BUILD_DIR ??
  join(REPO_ROOT, "inference/target/llama-ffi");
const NATIVE_DIR = join(PACKAGE_ROOT, "native");
const BUILD_JSON = join(NATIVE_DIR, "build.json");

export interface NativeBuildManifest {
  readonly version: 1;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Directory holding libllama + libggml* shared libraries. */
  readonly llamaLibDir: string;
  /** Absolute path of the llama shared library. */
  readonly llamaLib: string;
  /** Absolute path of the compiled shim shared library. */
  readonly shimLib: string;
  readonly builtAt: string;
}

const sharedLibName = (base: string): string => {
  switch (process.platform) {
    case "darwin":
      return `lib${base}.dylib`;
    case "win32":
      return `${base}.dll`;
    default:
      return `lib${base}.so`;
  }
};

const run = async (cmd: readonly string[], cwd = REPO_ROOT): Promise<void> => {
  console.log(`$ ${cmd.join(" ")}`);
  const child = Bun.spawn([...cmd], { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
  }
};

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false
  );

const parseArgs = (argv: readonly string[]) => {
  let skipLlama = false;
  let jobs = Math.max(1, cpus().length);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-llama") skipLlama = true;
    else if (a === "--jobs") jobs = Number(argv[++i] ?? jobs);
    else throw new Error(`unknown argument: ${a}`);
  }
  return { skipLlama, jobs };
};

const buildLlama = async (jobs: number): Promise<string> => {
  const cmake = Bun.which("cmake");
  if (!cmake) throw new Error("cmake not found on PATH");
  await run([
    cmake,
    "-S",
    LLAMA_SRC,
    "-B",
    CMAKE_BUILD_DIR,
    "-DBUILD_SHARED_LIBS=ON",
    "-DGGML_NATIVE=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_SERVER=OFF",
    "-DLLAMA_BUILD_TOOLS=OFF",
    "-DLLAMA_BUILD_COMMON=OFF",
    "-DLLAMA_CURL=OFF",
    "-DCMAKE_BUILD_TYPE=Release",
  ]);
  await run([
    cmake,
    "--build",
    CMAKE_BUILD_DIR,
    "--target",
    "llama",
    "--config",
    "Release",
    `-j${jobs}`,
  ]);
  return CMAKE_BUILD_DIR;
};

const findLlamaLibDir = async (buildDir: string): Promise<string> => {
  const name = sharedLibName("llama");
  for (const candidate of [join(buildDir, "bin"), join(buildDir, "src"), buildDir]) {
    if (await exists(join(candidate, name))) return candidate;
  }
  throw new Error(`could not find ${name} under ${buildDir}`);
};

const buildShim = async (llamaLibDir: string): Promise<string> => {
  const cc = process.env.CC ?? Bun.which("cc") ?? Bun.which("gcc") ?? Bun.which("clang");
  if (!cc) throw new Error("no C compiler found (set CC)");
  const out = join(NATIVE_DIR, sharedLibName("icn_shim"));
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
    join(NATIVE_DIR, "shim.c"),
    "-o",
    out,
    `-L${llamaLibDir}`,
    "-lllama",
    "-lggml",
    "-lggml-base",
  ];
  if (process.platform === "darwin") {
    args.push(`-Wl,-rpath,${llamaLibDir}`);
  } else if (process.platform !== "win32") {
    args.push(`-Wl,-rpath,${llamaLibDir}`, "-Wl,--no-undefined");
  }
  await run(args);
  return out;
};

const main = async (): Promise<void> => {
  const { skipLlama, jobs } = parseArgs(process.argv.slice(2));
  await mkdir(NATIVE_DIR, { recursive: true });
  const buildDir = skipLlama ? CMAKE_BUILD_DIR : await buildLlama(jobs);
  const llamaLibDir = await findLlamaLibDir(buildDir);
  const shimLib = await buildShim(llamaLibDir);
  const manifest: NativeBuildManifest = {
    version: 1,
    platform: process.platform,
    arch: process.arch,
    llamaLibDir,
    llamaLib: join(llamaLibDir, sharedLibName("llama")),
    shimLib,
    builtAt: new Date().toISOString(),
  };
  await writeFile(BUILD_JSON, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${BUILD_JSON}`);
  console.log(JSON.stringify(manifest, null, 2));
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
