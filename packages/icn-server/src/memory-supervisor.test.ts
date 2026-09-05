import { describe, expect, it } from "vitest"
import { MemorySupervisor, RECOVERY_STABLE_TIME_MS } from "./memory-supervisor.js"

describe("memory supervisor", () => {
  it("closes admission after pressure", () => {
    const supervisor = new MemorySupervisor()
    expect(supervisor.isAdmissionOpen()).toBe(true)
    supervisor.closeAdmissionAfterPressure(0)
    expect(supervisor.isAdmissionOpen()).toBe(false)
  })

  it("reopens admission after stable recovery observations", () => {
    const supervisor = new MemorySupervisor()
    supervisor.closeAdmissionAfterPressure(0)
    supervisor.updateRecovery(0)
    expect(supervisor.isAdmissionOpen()).toBe(false)
    supervisor.updateRecovery(RECOVERY_STABLE_TIME_MS)
    expect(supervisor.isAdmissionOpen()).toBe(true)
  })

  it("terminates after monitor loss deadline", () => {
    const supervisor = new MemorySupervisor()
    expect(supervisor.noteMonitorLoss(0)).toBe(false)
    expect(supervisor.noteMonitorLoss(999)).toBe(false)
    expect(supervisor.noteMonitorLoss(1000)).toBe(true)
  })
})
