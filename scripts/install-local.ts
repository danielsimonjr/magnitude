/**
 * Prepare a source checkout so `magnitude` can be run from it.
 *
 *   bun run install:local                      # install deps, generate version, link `magnitude`
 *   bun run install:local --build-inference    # also build the inference engine locally
 *   bun run install:local --bin-dir <dir>      # where to place the `magnitude` PATH entry
 *   bun run install:local --no-link            # prepare the checkout without touching PATH
 *   bun run install:local --allow-unreleased   # skip the check that a prebuilt engine exists for this version
 *   bun run install:local --uninstall          # remove the PATH entry
 *
 * Prefer a published release tag. Without --build-inference, the CLI downloads the
 * prebuilt inference engine that matches the checked-out version from GitHub releases
 * on first use. With --build-inference, the engine is compiled from this checkout and
 * runs as a development build (requires CMake, a C/C++ toolchain, and currently a
 * Rust toolchain for planner-input generation).
 */
import { existsSync, lstatSync, readlinkSync } from "node:fs"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const IS_WINDOWS = process.platform === "win32"
const SHIM = resolve(PROJECT_ROOT, "cli", "bin", IS_WINDOWS ? "magnitude.cmd" : "magnitude")
/** Marker embedded in the Windows wrapper so --uninstall only removes what we created. */
export const WINDOWS_WRAPPER_MARKER = "rem magnitude-install-local"
export const DEFAULT_RELEASE_BASE_URL =
  "https://github.com/magnitudedev/magnitude/releases/download"
export const DEFAULT_GITHUB_API_RELEASES_URL =
  "https://api.github.com/repos/magnitudedev/magnitude/releases"

const args = process.argv.slice(2)
const has = (flag: string) => args.includes(flag)
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

export const cliReleaseTag = (version: string): string => `@magnitudedev/cli@${version}`

export const releaseManifestUrl = (
  version: string,
  baseUrl: string = process.env.MAGNITUDE_RELEASE_BASE_URL ?? DEFAULT_RELEASE_BASE_URL,
): string => `${baseUrl.replace(/\/+$/, "")}/${cliReleaseTag(version)}/magnitude-release.json`

export const defaultBinDir = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  windows: boolean = IS_WINDOWS,
): string => {
  const bunInstall = env.BUN_INSTALL?.trim()
  if (bunInstall) return resolve(bunInstall, "bin")
  if (windows) {
    const localAppData = env.LOCALAPPDATA?.trim()
    return resolve(localAppData ?? resolve(home, "AppData", "Local"), "Magnitude", "bin")
  }
  return resolve(home, ".local", "bin")
}

export const pathContains = (directory: string, pathValue: string | undefined): boolean =>
  (pathValue ?? "").split(delimiter).some((entry) => entry && resolve(entry) === resolve(directory))

/**
 * Windows has no reliable symlinks for unprivileged users, so the PATH entry is a
 * tiny .cmd wrapper that forwards to the checkout's shim.
 */
export const windowsWrapperContents = (
  shimPath: string,
  marker: string = WINDOWS_WRAPPER_MARKER,
): string =>
  ["@echo off", marker, `call "${shimPath}" %*`, ""].join("\r\n")

export const pickLatestCliReleaseTag = (
  tags: readonly string[],
): string | undefined => {
  const matching = tags.filter((tag) => tag.startsWith("@magnitudedev/cli@"))
  if (matching.length === 0) return undefined
  return matching.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1)
}

export const formatMissingReleaseGuidance = (input: {
  readonly version: string
  readonly status: number
  readonly manifestUrl: string
  readonly latestTag?: string
}): string => {
  const tag = input.latestTag ?? cliReleaseTag("<version>")
  return [
    `No published Magnitude release exists for the checked-out version ${input.version} (HTTP ${input.status} for ${input.manifestUrl}).`,
    "Either check out a released tag and rerun:",
    "",
    "  git fetch --tags && git checkout " + tag,
    "  bun run install:local",
    "",
    "or build the inference engine from this checkout (requires CMake, a C/C++ toolchain,",
    "and currently a Rust toolchain for planner-input generation):",
    "",
    "  bun run install:local --build-inference",
    "",
    "Pass --allow-unreleased to continue anyway.",
  ].join("\n")
}

const binDir = resolve(valueOf("--bin-dir") ?? defaultBinDir())
const link = resolve(binDir, IS_WINDOWS ? "magnitude.cmd" : "magnitude")

const run = async (command: readonly string[], cwd = PROJECT_ROOT): Promise<void> => {
  console.log(`[install-local] ${command.join(" ")}`)
  const child = Bun.spawn([...command], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`)
}

const checkBunVersion = async (): Promise<void> => {
  const pkg = JSON.parse(await readFile(resolve(PROJECT_ROOT, "package.json"), "utf8")) as {
    packageManager?: string
  }
  const pinned = pkg.packageManager?.split("@")[1]
  if (pinned && Bun.version !== pinned) {
    console.warn(
      `[install-local] This checkout pins bun@${pinned}; you are running bun ${Bun.version}. ` +
        `It will usually work, but install the pinned version if something misbehaves.`,
    )
  }
}

const fetchLatestCliReleaseTag = async (): Promise<string | undefined> => {
  const apiUrl = (
    process.env.MAGNITUDE_GITHUB_API_RELEASES_URL ?? DEFAULT_GITHUB_API_RELEASES_URL
  ).replace(/\/+$/, "")
  try {
    const response = await fetch(`${apiUrl}?per_page=30`, {
      headers: { Accept: "application/vnd.github+json" },
      redirect: "follow",
    })
    if (!response.ok) return undefined
    const payload = (await response.json()) as Array<{ tag_name?: string }>
    return pickLatestCliReleaseTag(
      payload.map((release) => release.tag_name).filter((tag): tag is string => typeof tag === "string"),
    )
  } catch {
    return undefined
  }
}

/**
 * Without a local engine build, the CLI downloads the prebuilt inference
 * engine for the checked-out version on first use. Fail early, with guidance,
 * when that release does not exist (typically a checkout ahead of the latest
 * release).
 */
const ensurePrebuiltInferenceRelease = async (): Promise<void> => {
  const launcher = JSON.parse(
    await readFile(resolve(PROJECT_ROOT, "packages/launcher/package.json"), "utf8"),
  ) as { version: string }
  const version = launcher.version
  const manifestUrl = releaseManifestUrl(version)
  let status: number | undefined
  try {
    status = (await fetch(manifestUrl, { method: "HEAD", redirect: "follow" })).status
  } catch {
    console.warn(
      `[install-local] Could not reach the release origin to confirm a prebuilt inference engine for ${version}; continuing.`,
    )
    return
  }
  if (status === 200) return
  if (has("--allow-unreleased")) {
    console.warn(`[install-local] No published release for ${version}; the CLI will fail to start inference until one exists.`)
    return
  }
  const latestTag = await fetchLatestCliReleaseTag()
  throw new Error(formatMissingReleaseGuidance({ version, status, manifestUrl, latestTag }))
}

const isOurWindowsWrapper = async (path: string): Promise<boolean> => {
  try {
    return (await readFile(path, "utf8")).includes(WINDOWS_WRAPPER_MARKER)
  } catch {
    return false
  }
}

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

const uninstall = async (): Promise<void> => {
  if (!existsSync(link) && !isSymlink(link)) {
    console.log(`[install-local] Nothing to remove at ${link}`)
    return
  }
  if (IS_WINDOWS) {
    if (!(await isOurWindowsWrapper(link))) {
      throw new Error(`${link} was not created by install-local; refusing to remove it`)
    }
    await rm(link)
    console.log(`[install-local] Removed ${link}`)
    return
  }
  if (!isSymlink(link) || readlinkSync(link) !== SHIM) {
    throw new Error(`${link} was not created by install-local; refusing to remove it`)
  }
  await rm(link)
  console.log(`[install-local] Removed ${link}`)
}

const install = async (): Promise<void> => {
  await checkBunVersion()

  // Fail before dependency install when the checked-out version has no prebuilt engine.
  if (!has("--build-inference")) await ensurePrebuiltInferenceRelease()

  await run(["bun", "install", "--frozen-lockfile"])

  if (has("--build-inference")) {
    await run(["git", "submodule", "update", "--init", "--recursive"])
    await run(["bun", "run", "packages/version/scripts/generate-version.ts", "--dev"])
    await run(["bun", "run", "inference/scripts/build-local.ts"])
  } else {
    await run(["bun", "run", "packages/version/scripts/generate-version.ts"])
  }

  if (has("--no-link")) {
    console.log(`[install-local] Checkout prepared. Run the CLI with: ${SHIM}`)
    return
  }

  await mkdir(binDir, { recursive: true })
  if (IS_WINDOWS) {
    if (existsSync(link) && !(await isOurWindowsWrapper(link))) {
      throw new Error(`${link} exists and was not created by install-local; pass --bin-dir to choose another location`)
    }
    await writeFile(link, windowsWrapperContents(SHIM), "utf8")
    console.log(`[install-local] Wrote ${link} -> ${SHIM}`)
  } else if (isSymlink(link)) {
    if (readlinkSync(link) !== SHIM) {
      throw new Error(`${link} already points somewhere else; pass --bin-dir to choose another location`)
    }
  } else if (existsSync(link)) {
    throw new Error(`${link} exists and is not a symlink; pass --bin-dir to choose another location`)
  } else {
    await symlink(SHIM, link)
  }
  if (!IS_WINDOWS) console.log(`[install-local] Linked ${link} -> ${SHIM}`)

  if (!pathContains(binDir, process.env.PATH)) {
    const hint = IS_WINDOWS
      ? `  [Environment]::SetEnvironmentVariable("Path", "${binDir};" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")\n  (then open a new terminal)`
      : `  export PATH="${binDir}:$PATH"`
    console.log(`\n[install-local] ${binDir} is not on your PATH. Add it, for example:\n\n${hint}\n`)
  }
  console.log("\n[install-local] Done. Try:\n\n  magnitude --version\n  magnitude setup\n")
}

if (import.meta.main) {
  try {
    if (has("--uninstall")) await uninstall()
    else await install()
  } catch (error) {
    console.error(`[install-local] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
