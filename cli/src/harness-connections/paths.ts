import { homedir } from "node:os"
import { join } from "node:path"

export type SkillInstallationTarget = "shared-agents" | "hermes-user" | "claude-user" | "cline-user"

export interface SkillInstallationPaths {
  readonly skillFile: string
}

export interface HarnessConnectionPaths {
  readonly manifest: string
  readonly piModels: string
  readonly piSettings: string
  readonly opencode: string
  readonly hermes: string
  readonly openclaw: string
  readonly codex: string
  readonly codexUser: string
  readonly codexModels: string
  readonly claude: string
  readonly ompModels: string
  readonly ompSettings: string
  readonly clineProviders: string
  readonly clineModels: string
  readonly skillInstallations: Readonly<Record<SkillInstallationTarget, SkillInstallationPaths>>
}

export const harnessConnectionPaths = (): HarnessConnectionPaths => {
  // Every harness below keeps a dot-directory under the user's home on all
  // platforms (homedir() is %USERPROFILE% on Windows); none use %APPDATA%.
  // Each root honours the harness's own override env var where one exists.
  const home = homedir()
  const clineRoot = join(home, ".cline", "data")
  const hermesRoot = process.env.HERMES_HOME ?? join(home, ".hermes")
  const openClawRoot = process.env.OPENCLAW_STATE_DIR ?? join(home, ".openclaw")
  const codexRoot = process.env.CODEX_HOME ?? join(home, ".codex")
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")
  const piRoot = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent")
  // OpenCode resolves its config dir via xdg-basedir: $XDG_CONFIG_HOME, else ~/.config.
  const opencodeRoot = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode")
  const skillInstallation = (root: string): SkillInstallationPaths => ({
    skillFile: join(root, "magnitude", "SKILL.md"),
  })
  return {
    manifest: join(home, ".magnitude", "harness-connections.json"),
    piModels: join(piRoot, "models.json"),
    piSettings: join(piRoot, "settings.json"),
    opencode: join(opencodeRoot, "opencode.json"),
    hermes: join(hermesRoot, "config.yaml"),
    openclaw: join(openClawRoot, "openclaw.json"),
    codex: join(codexRoot, "magnitude.config.toml"),
    codexUser: join(codexRoot, "config.toml"),
    codexModels: join(codexRoot, "magnitude.models.json"),
    claude: join(claudeRoot, "settings.json"),
    ompModels: join(home, ".omp", "agent", "models.yml"),
    ompSettings: join(home, ".omp", "agent", "config.yml"),
    clineProviders: join(clineRoot, "settings", "providers.json"),
    clineModels: join(clineRoot, "settings", "models.json"),
    skillInstallations: {
      "shared-agents": skillInstallation(join(home, ".agents", "skills")),
      "hermes-user": skillInstallation(join(hermesRoot, "skills")),
      "claude-user": skillInstallation(join(claudeRoot, "skills")),
      "cline-user": skillInstallation(join(clineRoot, "settings", "skills")),
    },
  }
}
