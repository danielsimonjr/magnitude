---
applies_to:
  - scripts/install-local.ts
  - cli/bin/magnitude
  - cli/bin/magnitude.cmd
  - cli/src/runtime/environment.ts
  - cli/src/server/service.ts
  - packages/acn/src/icn/layer.ts
---

# Source checkout installation

A git checkout can run Magnitude without installing the published npm package. This path is for
contributors and users who intentionally run from source. It is not a substitute for the
package-manager distribution.

## Entry

`bun run install:local` prepares the checkout and places a `magnitude` command on PATH that always
re-enters the repository through the source CLI entry. On Unix that PATH entry is a symlink to
`cli/bin/magnitude`. On Windows it is a small `.cmd` wrapper that forwards to
`cli/bin/magnitude.cmd`, because unprivileged Windows environments cannot rely on symlinks.

The prepared checkout must contain installed workspace dependencies and a generated version file.
Invoking the source entry without that preparation fails with instructions to run the installer.

## Runtime modes

Source entry is detected when the CLI is launched from TypeScript source. In that mode the
background service is started from the checkout rather than from a downloaded ACN release binary.

Inference has two mutually exclusive preparations:

| Mode | Version identity | Inference binary |
| --- | --- | --- |
| Default (`install:local`) | Published checkout version | Prebuilt release artifacts for that exact version |
| Development (`install:local --build-inference`) | Development identity (`+dev.…`) | Local development installation at the fixed development layout |

The default mode requires a published release for the checked-out version. A checkout whose version
is ahead of the latest release must either check out a release tag or build inference locally.
`--allow-unreleased` may continue preparation, but inference startup remains blocked until a
matching engine exists.

Development mode initializes native submodules, allocates a development version identity, and
builds the local development installation. It does not download release inference artifacts for
that identity.

## PATH and uninstall

The installer writes only into an explicit or default bin directory and refuses to overwrite a PATH
entry it did not create. `--uninstall` removes only an installer-owned entry. `--no-link` prepares
the checkout without modifying PATH.

## Required guarantees

- Source entry always launches the checkout's CLI and, when detected as source, the checkout's ACN.
- Default mode verifies that a release manifest exists for the checked-out version before dependency
  installation finishes preparation, unless explicitly overridden.
- When that verification fails, the installer names a concrete published release tag when one can be
  discovered.
- Development mode marks the checkout with a development identity and uses the local development
  installation layout for inference.
- Installer-owned PATH entries are distinguishable from unrelated `magnitude` commands and are the
  only entries `--uninstall` may remove.
- Windows and Unix expose the same user-facing command name after PATH setup.
