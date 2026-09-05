/**
 * Phase-5 scaffold: compile the TypeScript ICN (`packages/icn-server`) with Bun.
 *
 * The shipped release still builds the Rust ICN via `inference/scripts/compile`.
 * Call this helper only when selecting the TypeScript engine for development or
 * once wave-4 exit criteria are met and cutover begins. Do not wire it into
 * `buildHostArtifacts` until a stable TypeScript ICN has shipped.
 */
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { getTargetInfo } from "../../../../scripts/release-target"
import { run } from "./common"

const PROJECT_ROOT = resolve(import.meta.dir, "../../../..")

export const buildTypescriptIcnBinary = async (target: string): Promise<string> => {
  const info = getTargetInfo(target)
  const nativePlatform = info.platform === "windows" ? "win32" : info.platform
  const binary = resolve(
    PROJECT_ROOT,
    "bin",
    `magnitude-inference-ts${info.executableExt}`,
  )
  await mkdir(resolve(PROJECT_ROOT, "bin"), { recursive: true })
  await run(
    [
      "bun",
      "build",
      resolve(PROJECT_ROOT, "packages/icn-server/src/main.ts"),
      "--compile",
      `--target=${target}`,
      `--outfile=${binary}`,
      "--define",
      `process.platform=${JSON.stringify(nativePlatform)}`,
      "--define",
      `process.arch=${JSON.stringify(info.arch)}`,
    ],
    { cwd: PROJECT_ROOT },
  )
  if (info.platform === "darwin") {
    await run(["codesign", "--force", "--deep", "--sign", "-", binary])
  }
  return binary
}
