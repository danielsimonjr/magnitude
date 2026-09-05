import type { Subprocess } from "bun"
import { platform } from "node:os"

export interface ManagedWorker {
  readonly pid: number
  readonly role: "inference" | "planning"
  tryWait(): number | null
  terminate(code: string, reason: string): void
  shutdown(): Promise<void>
}

export interface WorkerLaunchSpec {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly role: "inference" | "planning"
  readonly env?: Readonly<Record<string, string>>
}

const terminateUnixProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // fall back to direct pid
  }
  try {
    process.kill(pid, signal)
  } catch {
    // already exited
  }
}

const terminateWindowsProcessTree = (_pid: number, _signal: NodeJS.Signals): void => {
  // TODO(wave-5): use @magnitudedev/acn-protocol/coordination job-object semantics via taskkill /T.
}

export const terminateProcessTree = (pid: number, signal: NodeJS.Signals): void => {
  if (platform() === "win32") {
    terminateWindowsProcessTree(pid, signal)
    return
  }
  terminateUnixProcessGroup(pid, signal)
}

export class WorkerSupervisor {
  private workers = new Map<number, Subprocess>()

  spawn(spec: WorkerLaunchSpec): ManagedWorker {
    const child = Bun.spawn([spec.executable, ...spec.args], {
      env: {
        ...process.env,
        MAGNITUDE_OTEL: "0",
        RUST_LOG: "error",
        ...spec.env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: platform() !== "win32",
    })
    if (child.pid === undefined) {
      throw new Error("failed to spawn worker process")
    }
    this.workers.set(child.pid, child)

    return {
      pid: child.pid,
      role: spec.role,
      tryWait: () => {
        const exitCode = child.exitCode
        if (exitCode !== null) {
          this.workers.delete(child.pid!)
          return exitCode
        }
        return null
      },
      terminate: (_code, _reason) => {
        terminateProcessTree(child.pid!, "SIGTERM")
      },
      shutdown: async () => {
        terminateProcessTree(child.pid!, "SIGTERM")
        const exited = await Promise.race([
          child.exited,
          Bun.sleep(500).then(() => null),
        ])
        if (exited === null && child.exitCode === null) {
          terminateProcessTree(child.pid!, "SIGKILL")
          await child.exited.catch(() => undefined)
        }
        this.workers.delete(child.pid!)
      },
    }
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.workers.values()].map(async (child) => {
      if (child.pid !== undefined) {
        terminateProcessTree(child.pid, "SIGTERM")
      }
      await child.exited.catch(() => undefined)
    }))
    this.workers.clear()
  }
}

export const workerCommand = (
  executable: string,
  role: "inference" | "planning",
  installation?: string,
): ReadonlyArray<string> => {
  const subcommand = role === "inference" ? "inference-worker" : "planning-worker"
  if (installation !== undefined) {
    return [subcommand, "--installation", installation]
  }
  return [subcommand, "--development-runtime"]
}
