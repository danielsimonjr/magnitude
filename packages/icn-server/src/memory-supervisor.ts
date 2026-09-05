import {
  type MemorySample,
  observeSystemMemory,
  permitsLoad,
  recovered,
  requiresEviction,
  RECOVERY_MARGIN_BYTES,
} from "@magnitudedev/icn-hardware"

export const POLL_INTERVAL_MS = 100
export const IDLE_POLL_INTERVAL_MS = 1_000
export const MONITOR_LOSS_DEADLINE_MS = 1_000
export const RECOVERY_STABLE_TIME_MS = 5_000

export class MemorySupervisor {
  private admissionOpen = true
  private lastSample: MemorySample | undefined
  private recoverySinceMs: number | undefined
  private monitorLostSinceMs: number | undefined

  sample(): MemorySample {
    const next = observeSystemMemory()
    this.lastSample = next
    if (this.monitorLostSinceMs !== undefined) {
      this.monitorLostSinceMs = undefined
    }
    return next
  }

  latestSample(): MemorySample | undefined {
    return this.lastSample
  }

  permitsLoad(requiredSystemMemoryBytes: number): boolean {
    if (!this.admissionOpen) return false
    const sample = this.sample()
    return permitsLoad(sample, requiredSystemMemoryBytes)
  }

  requiresEviction(): boolean {
    const sample = this.sample()
    return requiresEviction(sample)
  }

  noteMonitorLoss(nowMs = Date.now()): boolean {
    if (this.monitorLostSinceMs === undefined) {
      this.monitorLostSinceMs = nowMs
      return false
    }
    return nowMs - this.monitorLostSinceMs >= MONITOR_LOSS_DEADLINE_MS
  }

  closeAdmissionAfterPressure(nowMs = Date.now()): void {
    this.admissionOpen = false
    this.recoverySinceMs = undefined
    this.monitorLostSinceMs = nowMs
  }

  updateRecovery(nowMs = Date.now()): void {
    const sample = this.lastSample ?? this.sample()
    if (recovered(sample)) {
      if (this.recoverySinceMs === undefined) {
        this.recoverySinceMs = nowMs
      } else if (nowMs - this.recoverySinceMs >= RECOVERY_STABLE_TIME_MS) {
        this.admissionOpen = true
      }
    } else {
      this.recoverySinceMs = undefined
    }
  }

  isAdmissionOpen(): boolean {
    return this.admissionOpen
  }
}

export { RECOVERY_MARGIN_BYTES }
