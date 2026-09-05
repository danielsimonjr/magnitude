import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { Schema } from "effect"
import { ReleaseManifestSchema } from "../src/contracts"
import {
  encodeReleasePins,
  RELEASE_PINS_FILENAME,
} from "../src/release-pins"
import { run } from "./build/common"

const PACKAGE_ROOT = resolve(import.meta.dir, "../../launcher")
const PINS_PATH = resolve(PACKAGE_ROOT, "bin", RELEASE_PINS_FILENAME)
const EXPECTED_FILES = [
  "package/README.md",
  "package/bin/magnitude.js",
  "package/package.json",
]

/**
 * The npm tarball is immutable once published; GitHub release assets are not.
 * Pinning the release manifest's digest into the tarball is what lets the
 * installed launcher reject a manifest (and therefore artifacts) rewritten
 * after publication.
 */
export type NpmCandidatePins =
  | { readonly _tag: "Pinned"; readonly manifest: string }
  | { readonly _tag: "Unpinned" }

export interface NpmCandidate {
  readonly tarball: string
  readonly integrity: string
  /** Digest of the pinned release manifest; absent for an unpinned candidate. */
  readonly manifestSha256?: string
}

const expectedFiles = (pins: NpmCandidatePins): readonly string[] =>
  [
    ...EXPECTED_FILES,
    ...(pins._tag === "Pinned" ? [`package/bin/${RELEASE_PINS_FILENAME}`] : []),
  ].sort()

export const validateNpmCandidate = async (
  tarball: string,
  pins: NpmCandidatePins = { _tag: "Unpinned" },
): Promise<void> => {
  const listing = (await run(["tar", "-tzf", tarball]))
    .split("\n")
    .filter(Boolean)
    .sort()
  if (JSON.stringify(listing) !== JSON.stringify(expectedFiles(pins))) {
    throw new Error(`npm candidate has unexpected files: ${listing.join(", ")}`)
  }
}

const readPackageVersion = async (): Promise<string> => {
  const packageJson = JSON.parse(
    await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as { readonly version?: string }
  if (!packageJson.version) throw new Error("launcher package has no version")
  return packageJson.version
}

/**
 * Writes `bin/release-pins.json` from the assembled manifest. The pins file is
 * derived from the manifest bytes exactly as served, so the digest the launcher
 * compares against is the digest of the file `publish.ts` uploads.
 */
const writeReleasePins = async (manifestPath: string): Promise<string> => {
  const manifestBytes = await readFile(manifestPath)
  const manifest = Schema.decodeUnknownSync(
    Schema.parseJson(ReleaseManifestSchema),
  )(manifestBytes.toString("utf8"))
  const version = await readPackageVersion()
  if (manifest.version !== version) {
    throw new Error(
      `release manifest is for ${manifest.version}; launcher package is ${version}`,
    )
  }
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex")
  await mkdir(resolve(PACKAGE_ROOT, "bin"), { recursive: true })
  await writeFile(
    PINS_PATH,
    encodeReleasePins({ version, manifestSha256 }),
    { mode: 0o644 },
  )
  return manifestSha256
}

export const prepareNpmCandidate = async (
  output: string,
  pins: NpmCandidatePins,
): Promise<NpmCandidate> => {
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true, mode: 0o700 })
  // Never let a stale pins file from an earlier run ride into the tarball.
  await rm(PINS_PATH, { force: true })
  const manifestSha256 = pins._tag === "Pinned"
    ? await writeReleasePins(resolve(pins.manifest))
    : undefined
  const packed = JSON.parse(await run([
    "npm",
    "pack",
    "--json",
    "--pack-destination",
    output,
  ], { cwd: PACKAGE_ROOT })) as readonly { readonly filename?: string }[]
  if (packed.length !== 1 || !packed[0]?.filename) {
    throw new Error("npm pack did not produce exactly one candidate")
  }
  const tarball = resolve(output, basename(packed[0].filename))
  await validateNpmCandidate(tarball, pins)
  const integrity =
    `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`
  return manifestSha256 === undefined
    ? { tarball, integrity }
    : { tarball, integrity, manifestSha256 }
}

const USAGE =
  "usage: prepare-npm.ts [output] (--manifest <magnitude-release.json> | --allow-unpinned)\n" +
  "  MAGNITUDE_RELEASE_MANIFEST may stand in for --manifest."

const parseArguments = (
  arguments_: readonly string[],
): { readonly output: string; readonly pins: NpmCandidatePins } => {
  let output: string | undefined
  let manifest = process.env.MAGNITUDE_RELEASE_MANIFEST?.trim() || undefined
  let allowUnpinned = false
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!
    if (argument === "--manifest") {
      manifest = arguments_[index + 1]
      if (!manifest) throw new Error(USAGE)
      index += 1
    } else if (argument === "--allow-unpinned") {
      allowUnpinned = true
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option ${argument}\n${USAGE}`)
    } else if (output === undefined) {
      output = argument
    } else {
      throw new Error(USAGE)
    }
  }
  if (manifest !== undefined && allowUnpinned) {
    throw new Error(`--allow-unpinned cannot be combined with a manifest\n${USAGE}`)
  }
  if (manifest === undefined && !allowUnpinned) {
    throw new Error(
      `a release manifest is required to pin the npm candidate; ` +
        `pass --allow-unpinned only for static checks whose tarball is never published\n${USAGE}`,
    )
  }
  return {
    output: resolve(output ?? "release/npm-candidate"),
    pins: manifest === undefined
      ? { _tag: "Unpinned" }
      : { _tag: "Pinned", manifest },
  }
}

if (import.meta.main) {
  const { output, pins } = parseArguments(process.argv.slice(2))
  const candidate = await prepareNpmCandidate(output, pins)
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, [
      `tarball=${candidate.tarball}`,
      `integrity=${candidate.integrity}`,
      ...(candidate.manifestSha256 === undefined
        ? []
        : [`manifest_sha256=${candidate.manifestSha256}`]),
      "",
    ].join("\n"))
  } else {
    console.log(JSON.stringify(candidate, null, 2))
  }
}
