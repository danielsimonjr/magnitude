import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import { Effect, Option, Schema } from "effect"
import { ReleaseAcquisitionError } from "./errors"

/**
 * The launcher's release pins, shipped inside its immutable npm tarball at
 * `bin/release-pins.json`. GitHub release assets are mutable, so the manifest
 * downloaded at install time is only trusted when its SHA-256 matches the
 * digest recorded here at publish time.
 */
export const RELEASE_PINS_FILENAME = "release-pins.json"

export const ReleasePinsSchema = Schema.Struct({
  version: Schema.String.pipe(Schema.minLength(1)),
  manifestSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
})
export type ReleasePins = typeof ReleasePinsSchema.Type

export const encodeReleasePins = (pins: ReleasePins): string =>
  `${JSON.stringify(Schema.encodeSync(ReleasePinsSchema)(pins), null, 2)}\n`

export const decodeReleasePins = Schema.decodeUnknown(
  Schema.parseJson(ReleasePinsSchema),
)

/** Location of the pins file inside an installed launcher package root. */
export const releasePinsPath = (path: Path.Path, packageRoot: string): string =>
  path.join(packageRoot, "bin", RELEASE_PINS_FILENAME)

/**
 * Reads the pinned manifest digest for the installed launcher version.
 *
 * A missing pins file yields no pin: locally built launchers (bootstrap tests,
 * the distribution simulation) run without one. A pins file that is present
 * but unreadable, malformed, or written for a different version is a broken
 * package and fails closed rather than silently disabling verification.
 */
export const readLauncherReleasePins = (
  packageRoot: string,
  version: string,
): Effect.Effect<
  Option.Option<string>,
  ReleaseAcquisitionError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = releasePinsPath(path, packageRoot)
    const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return Option.none<string>()
    const contents = yield* fs.readFileString(file).pipe(
      Effect.mapError(() => new ReleaseAcquisitionError({
        stage: "validate",
        message: `launcher release pins are unreadable at ${file}`,
        transient: false,
      })),
    )
    const pins = yield* decodeReleasePins(contents).pipe(
      Effect.mapError(() => new ReleaseAcquisitionError({
        stage: "validate",
        message: "launcher release pins are malformed",
        transient: false,
      })),
    )
    if (pins.version !== version) {
      return yield* new ReleaseAcquisitionError({
        stage: "validate",
        message:
          `launcher release pins are for ${pins.version}; installed launcher is ${version}`,
        transient: false,
      })
    }
    return Option.some(pins.manifestSha256)
  })
