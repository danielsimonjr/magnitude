import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { inspect } from "./gguf"

const pushString = (bytes: number[], value: string) => {
  const encoded = new TextEncoder().encode(value)
  const length = new Uint8Array(8)
  new DataView(length.buffer).setBigUint64(0, BigInt(encoded.length), true)
  bytes.push(...length, ...encoded)
}

describe("gguf", () => {
  it("rejects non gguf without panicking", () => {
    const path = join(tmpdir(), `icn-gguf-invalid-${process.pid}`)
    writeFileSync(path, "not a gguf")
    expect(() => inspect(path)).toThrow()
    rmSync(path)
  })

  it("extracts effective template variants and token strings", () => {
    const path = join(tmpdir(), `icn-gguf-template-${process.pid}`)
    const bytes: number[] = []
    bytes.push(...[0x47, 0x47, 0x55, 0x46])
    const view = new DataView(new ArrayBuffer(8))
    view.setUint32(0, 3, true)
    bytes.push(...new Uint8Array(view.buffer).slice(0, 4))
    view.setBigUint64(0, 0n, true)
    bytes.push(...new Uint8Array(view.buffer))
    view.setBigUint64(0, 5n, true)
    bytes.push(...new Uint8Array(view.buffer))

    pushString(bytes, "tokenizer.chat_template")
    bytes.push(...new Uint8Array([8, 0, 0, 0]))
    pushString(bytes, "default-template")
    pushString(bytes, "tokenizer.chat_template.tool_use")
    bytes.push(...new Uint8Array([8, 0, 0, 0]))
    pushString(bytes, "tool-template")
    pushString(bytes, "tokenizer.ggml.tokens")
    bytes.push(...new Uint8Array([9, 0, 0, 0]))
    bytes.push(...new Uint8Array([8, 0, 0, 0]))
    view.setBigUint64(0, 2n, true)
    bytes.push(...new Uint8Array(view.buffer))
    pushString(bytes, "<bos>")
    pushString(bytes, "<eos>")
    pushString(bytes, "tokenizer.ggml.bos_token_id")
    bytes.push(...new Uint8Array([4, 0, 0, 0]))
    view.setUint32(0, 0, true)
    bytes.push(...new Uint8Array(view.buffer).slice(0, 4))
    pushString(bytes, "tokenizer.ggml.eos_token_id")
    bytes.push(...new Uint8Array([4, 0, 0, 0]))
    view.setUint32(0, 1, true)
    bytes.push(...new Uint8Array(view.buffer).slice(0, 4))

    const aligned = Math.ceil(bytes.length / 32) * 32
    writeFileSync(path, new Uint8Array(aligned).map((_, index) => bytes[index] ?? 0))
    const result = inspect(path)
    rmSync(path)
    expect(result.chat_template).toBe("default-template")
    expect(result.tool_use_template).toBe("tool-template")
    expect(result.bos_token).toBe("<bos>")
    expect(result.eos_token).toBe("<eos>")
  })
})
