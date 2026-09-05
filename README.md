<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/icon-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/icon-light.svg">
    <img alt="Magnitude icon" src="assets/brand/icon-light.svg" width="120">
  </picture>
</p>

<h1 align="center">Magnitude</h1>

<p align="center"><strong>Run your agent on local models. Free, private, and offline.</strong></p>

<p align="center">
  <a href="https://docs.magnitude.dev"><img src="https://img.shields.io/badge/%F0%9F%93%95-Docs-0369a1?style=flat-square&labelColor=0369a1&color=gray" alt="Documentation"></a>
  <a href="https://discord.gg/EHt48pPWdC"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=flat-square&logo=discord&logoColor=white&labelColor=5865F2&color=gray" alt="Discord"></a>
  <a href="https://x.com/usemagnitude"><img src="https://img.shields.io/badge/Twitter-Follow-000000?style=flat-square&logo=x&logoColor=white&labelColor=000000&color=gray" alt="Follow Magnitude on Twitter"></a>
  <a href="https://github.com/magnitudedev/magnitude/stargazers"><img src="https://img.shields.io/github/stars/magnitudedev/magnitude" alt="GitHub Repo stars"></a>
  <a href="https://www.npmjs.com/package/@magnitudedev/cli"><img src="https://img.shields.io/npm/v/%40magnitudedev%2Fcli" alt="npm version"></a>
</p>

Magnitude is an open source inference server that runs the best local models for your hardware, plugged into the agent you already use. It profiles your machine, recommends the models that fit, then downloads, tunes, and runs them. Works with Pi, OpenCode, Hermes, OpenClaw, Codex, Claude Code, Oh My Pi, and Cline, or use the built-in harness.

⭐ Help us reach more developers and grow the Magnitude community. Star this repo!

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/ecosystem-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/ecosystem-light.png">
  <img alt="Pi, OpenCode, Hermes, Codex, Claude Code, and OpenClaw connected to Magnitude, which runs local models for your hardware." src="assets/readme/ecosystem-light.png">
</picture>

## Get started

**Send this to your agent to walk through models and setup:**

```text
Set up local models for me with the Magnitude CLI. Install it with `npm i -g @magnitudedev/cli` (or my package manager), then run `magnitude docs onboarding` and follow the instructions.
```

Your agent will profile your hardware, walk you through the best local models for it, download the ones you pick, and switch itself over to them.

Magnitude supports macOS, Linux, and Windows 10 or later (x64). On Windows the agent shell needs a POSIX shell: install [Git for Windows](https://gitforwindows.org), which provides Git Bash. WSL also works.

<details>
<summary>Want to browse the models directly?</summary>

```sh
npm i -g @magnitudedev/cli
magnitude setup
```

The interactive setup lets you browse the recommended models and choose one yourself.

</details>

<details>
<summary>Run from a source checkout</summary>

You can run the CLI straight from a clone without installing the npm package. You need
[Bun](https://bun.sh) and Git; macOS, Linux, and Windows 10 or later are supported (on Windows the
installer writes a `magnitude.cmd` wrapper instead of a symlink).

```sh
git clone https://github.com/magnitudedev/magnitude.git
cd magnitude
bun run install:local
magnitude setup
```

`install:local` installs dependencies, generates the version file, and symlinks `magnitude` into
`$BUN_INSTALL/bin` (or `~/.local/bin`; pass `--bin-dir <dir>` to choose). In this mode the
background service runs from the checkout, and the prebuilt inference engine matching the
checked-out version is downloaded from GitHub releases on first use. The installer checks that such a
release exists and, if not, tells you to check out a release tag (`git checkout @magnitudedev/cli@<version>`)
or build the engine yourself.

To compile the inference engine locally instead (requires a Rust toolchain, CMake, and a C++
compiler), run `bun run install:local --build-inference`. Remove the link with
`bun run install:local --uninstall`.

</details>

## Why Magnitude?

- **Free to run:** no token costs, API keys, or rate limits for local models
- **Private and offline inference:** models, prompts, and files stay on your machine
- **Agent-first setup:** one prompt and your agent walks you through the rest
- **Knows your hardware:** profiles your chip, memory, and bandwidth
- **Recommends what fits:** the best models for your machine, with estimated tok/s
- **Tuned end to end:** speculative decoding, concurrency, all set for your machine
- **Models on demand:** loaded on request, unloaded when idle or memory fills
- **Open source:** Apache 2.0, yours to modify

## FAQ

### What is Magnitude?

An open source inference server that runs the best local models for your hardware, plugged into the agent you already use. It profiles your machine, recommends the models that fit, then downloads, tunes, and runs them.

### What hardware do I need?

There's no fixed minimum. Magnitude profiles your hardware and recommends the best models for your machine. More memory lets you run larger models.

### Why not just have my agent set up Ollama?

Your agent would be guessing. It doesn't know your hardware, which quant fits, or how fast it'll run. Magnitude gives it a catalog with recommendations computed for your machine, an onboarding flow that writes your harness config, and inference built for agent workloads. Models load just in time and unload when idle or memory gets tight.

### Which harnesses work with it?

Pi, OpenCode, Hermes, OpenClaw, Codex, Claude Code, Oh My Pi, and Cline. During setup, your agent connects your harness to the model you pick. Or use Magnitude's built-in harness.

### Do I need to manage Magnitude after setup?

No. It runs in the background, loads models when your agent needs them, and unloads them when idle or memory gets tight. Your agent can install or switch models through the Magnitude CLI anytime.

### Does my data go to the cloud?

No. Local inference never leaves your machine: prompts, files, and models stay local, and the
inference server listens only on loopback.

Two optional features do use the network, and only if you turn them on:

- **Magnitude cloud models** in the built-in harness, enabled by setting `MAGNITUDE_API_KEY`.
  Requests to those models go to `app.magnitude.dev` along with your OS family and shell name.
- **Web search** in the built-in harness, enabled by setting `EXA_API_KEY`. Search queries go to
  Exa.

Neither is configured by default, and neither affects local models.

### Can it run completely offline?

Yes, for inference. Once Magnitude and a model are downloaded, no internet connection is needed to
run models or serve your agent.

Some CLI conveniences reach out when a connection is available and stay quiet when it is not:

| What | When | Where |
|---|---|---|
| Downloading the Magnitude runtime and models | First run, `magnitude update`, `magnitude catalog pull` | GitHub releases, Hugging Face |
| Checking for a newer CLI version | Starting the interactive `magnitude` command | npm registry |

The update check only reads the published version list. If it fails or you are offline, the CLI
starts normally without an update prompt. Model downloads are verified against pinned digests
before they are used.

### Can I use models outside the catalog?

Yes. You can [download compatible GGUF models from Hugging Face](https://docs.magnitude.dev/models#download-a-model-outside-the-catalog) and use them in Magnitude.

## Learn more

- [Documentation](https://docs.magnitude.dev)
- [CLI reference](https://docs.magnitude.dev/reference)
- [Discord](https://discord.gg/EHt48pPWdC)
- [Report an issue](https://github.com/magnitudedev/magnitude/issues)

## License

Magnitude is licensed under the [Apache License 2.0](https://github.com/magnitudedev/magnitude/blob/main/LICENSE).
