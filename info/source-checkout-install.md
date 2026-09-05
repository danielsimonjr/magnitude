# Running Magnitude from a source checkout

Clone the repository when you want to run or change Magnitude without installing the published npm
package. Prefer a published release tag unless you are actively developing against `main`.

## Default path

1. Install [Bun](https://bun.sh) and Git.
2. Clone the repository and check out a release tag:
   `@magnitudedev/cli@$(npm view @magnitudedev/cli version)`.
3. Run `bun run install:local`.
4. Ensure the installer's bin directory is on your PATH, then run `magnitude`.

In this mode the CLI and background service run from the checkout. The inference engine is the
prebuilt release that matches the checked-out version and is downloaded on first use.

## Development path

`bun run install:local --build-inference` builds a local inference installation from the checkout
and marks it as a development build. Use this when you need engine changes that are not in a
published release. It requires native build tooling (CMake and a C/C++ toolchain) and currently
still needs a Rust toolchain to generate planner inputs.

## Windows notes

On Windows the installer writes a `magnitude.cmd` wrapper into the bin directory instead of a
symlink. Default location is under `%LOCALAPPDATA%\Magnitude\bin` unless `BUN_INSTALL` is set.

## Uninstall

`bun run install:local --uninstall` removes only the PATH entry created by the installer.
