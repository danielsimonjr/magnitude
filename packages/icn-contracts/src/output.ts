export interface StopOutput {
  readonly text: string
  readonly matched: string | null
}

export class Utf8Buffer {
  private pending: Uint8Array = new Uint8Array(0)

  push(bytes: Uint8Array | readonly number[]): string {
    const incoming = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
    const merged = new Uint8Array(this.pending.length + incoming.length)
    merged.set(this.pending)
    merged.set(incoming, this.pending.length)
    this.pending = merged
    return this.drain(false)
  }

  finish(): string {
    return this.drain(true)
  }

  hasPending(): boolean {
    return this.pending.length > 0
  }

  private drain(finalChunk: boolean): string {
    let output = ""
    while (this.pending.length > 0) {
      const decoded = this.decodePrefix(this.pending)
      if (decoded.kind === "complete") {
        output += decoded.text
        this.pending = this.pending.slice(decoded.consumed)
        continue
      }
      if (decoded.kind === "valid") {
        output += decoded.text
        this.pending = this.pending.slice(decoded.consumed)
        continue
      }
      if (decoded.kind === "invalid") {
        output += "\uFFFD"
        this.pending = this.pending.slice(decoded.invalidLength)
        continue
      }
      if (finalChunk) {
        output += "\uFFFD"
        this.pending = new Uint8Array(0)
      }
      break
    }
    return output
  }

  private decodePrefix(bytes: Uint8Array):
    | { kind: "complete"; text: string; consumed: number }
    | { kind: "valid"; text: string; consumed: number }
    | { kind: "invalid"; invalidLength: number }
    | { kind: "partial" } {
    const text = new TextDecoder("utf-8", { fatal: true })
    try {
      const decoded = text.decode(bytes)
      return { kind: "complete", text: decoded, consumed: bytes.length }
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error
      }
    }

    const nonFatal = new TextDecoder("utf-8", { fatal: false })
    let validUpTo = 0
    for (let index = 1; index <= bytes.length; index += 1) {
      const slice = bytes.slice(0, index)
      const decoded = nonFatal.decode(slice)
      if (!decoded.includes("\uFFFD")) {
        validUpTo = index
      }
    }

    if (validUpTo > 0) {
      const decoded = nonFatal.decode(bytes.slice(0, validUpTo))
      return { kind: "valid", text: decoded, consumed: validUpTo }
    }

    if (bytes.length >= 4) {
      return { kind: "invalid", invalidLength: 1 }
    }

    return { kind: "partial" }
  }
}

export class StopBuffer {
  private readonly stops: readonly string[]
  private pending = ""
  private stopped = false

  constructor(stops: Iterable<string>) {
    const unique = [...stops].filter((stop) => stop.length > 0).sort()
    this.stops = [...new Set(unique)]
  }

  push(text: string): StopOutput {
    if (this.stopped) {
      return { text: "", matched: null }
    }
    this.pending += text

    let earliest: { position: number; stop: string } | undefined
    for (const stop of this.stops) {
      const position = this.pending.indexOf(stop)
      if (position !== -1 && (earliest === undefined || position < earliest.position)) {
        earliest = { position, stop }
      }
    }

    if (earliest !== undefined) {
      const emitted = this.pending.slice(0, earliest.position)
      const matched = earliest.stop
      this.pending = ""
      this.stopped = true
      return { text: emitted, matched }
    }

    let heldBytes = 0
    for (let index = 0; index < this.pending.length; index += 1) {
      const suffix = this.pending.slice(index)
      if (this.stops.some((stop) => stop.startsWith(suffix))) {
        heldBytes = Math.max(heldBytes, suffix.length)
      }
    }

    const emitBytes = this.pending.length - heldBytes
    const emitted = this.pending.slice(0, emitBytes)
    this.pending = this.pending.slice(emitBytes)
    return { text: emitted, matched: null }
  }

  finish(): string {
    if (this.stopped) {
      return ""
    }
    const remaining = this.pending
    this.pending = ""
    return remaining
  }

  isStopped(): boolean {
    return this.stopped
  }
}
