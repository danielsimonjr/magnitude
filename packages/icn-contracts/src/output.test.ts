import { describe, expect, it } from "vitest"
import { StopBuffer, Utf8Buffer } from "./output.js"

describe("Utf8Buffer", () => {
  it("utf8 is invariant under every byte split", () => {
    const expected = "aλ🦀z"
    const bytes = new TextEncoder().encode(expected)
    for (let split = 0; split <= bytes.length; split += 1) {
      const decoder = new Utf8Buffer()
      let actual = decoder.push(bytes.slice(0, split))
      actual += decoder.push(bytes.slice(split))
      actual += decoder.finish()
      expect(actual).toBe(expected)
    }
  })

  it("invalid utf8 uses replacement character", () => {
    const decoder = new Utf8Buffer()
    expect(decoder.push(new Uint8Array([0x6f, 0x6b, 0xff, 0x64, 0x6f, 0x6e, 0x65]))).toBe("ok\uFFFDdone")
    expect(decoder.finish()).toBe("")
  })
})

describe("StopBuffer", () => {
  it("stop is never emitted across chunk boundaries", () => {
    const buffer = new StopBuffer(["<stop>"])
    expect(buffer.push("hello<st")).toEqual({ text: "hello", matched: null })
    expect(buffer.push("op>ignored")).toEqual({ text: "", matched: "<stop>" })
    expect(buffer.isStopped()).toBe(true)
  })

  it("unicode and overlapping stops choose the earliest match", () => {
    const buffer = new StopBuffer(["🦀x", "END"])
    expect(buffer.push("a🦀").text).toBe("a")
    const stopped = buffer.push("xEND")
    expect(stopped.text).toBe("")
    expect(stopped.matched).toBe("🦀x")
  })

  it("finish releases a partial prefix", () => {
    const buffer = new StopBuffer(["END"])
    expect(buffer.push("valueEN").text).toBe("value")
    expect(buffer.finish()).toBe("EN")
  })
})
