/**
 * End-to-end test against a real GGUF. Gated on MAGNITUDE_TEST_GGUF so the
 * suite passes on machines without a native build or model file.
 *
 *   MAGNITUDE_TEST_GGUF=/path/to/model.gguf bun test
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Context } from "./context";
import { Model } from "./model";
import { systemInfo } from "./system";

const GGUF = process.env.MAGNITUDE_TEST_GGUF?.trim();
const enabled = Boolean(GGUF && existsSync(GGUF));

describe.skipIf(!enabled)("icn-native integration", () => {
  let model: Model;
  let ctx: Context;

  beforeAll(() => {
    model = Model.load(GGUF!, { nGpuLayers: 0 });
    ctx = new Context(model, { nCtx: 256, nBatch: 64, nThreads: 2 });
  });

  afterAll(() => {
    ctx?.free();
    model?.free();
  });

  test("reports system info", () => {
    expect(systemInfo().length).toBeGreaterThan(0);
  });

  test("exposes model metadata", () => {
    expect(model.nVocab).toBeGreaterThan(0);
    expect(model.nParams).toBeGreaterThan(0n);
    expect(model.sizeBytes).toBeGreaterThan(0n);
    expect(ctx.nCtx).toBe(256);
  });

  test("tokenizes and detokenizes 'Hello' round-trip", () => {
    const tokens = model.tokenize("Hello");
    expect(tokens.length).toBeGreaterThan(0);
    if (model.addsBos) expect(tokens[0]).toBe(model.bosToken);
    const text = model.detokenize(tokens, { removeSpecial: true });
    expect(text.trim()).toBe("Hello");
    const pieces = Array.from(tokens).map((t) => model.tokenToPiece(t)).join("");
    expect(pieces.trim()).toBe("Hello");
  });

  test("generates 8 tokens greedily and detokenizes them", async () => {
    const generated: number[] = [];
    let text = "";
    for await (const piece of ctx.generate("Hello", 8)) {
      if (piece.token >= 0) generated.push(piece.token);
      text += piece.text;
    }
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.length).toBeLessThanOrEqual(8);
    for (const t of generated) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(model.nVocab);
    }
    expect(ctx.position).toBe(model.tokenize("Hello").length + generated.length);
    // Streamed text must match detokenizing the same ids (modulo the SPM
    // leading-space prefix, which detokenize strips, and any incomplete
    // trailing UTF-8 byte token).
    const detok = model.detokenize(generated);
    expect(text.replace(/\uFFFD/g, "").trim()).toBe(detok.replace(/\uFFFD/g, "").trim());
    console.log(`generated tokens: [${generated.join(", ")}]\ngenerated text: ${JSON.stringify(text)}`);
  });

  test("greedy decoding is deterministic after reset", async () => {
    ctx.reset();
    const a = await ctx.generateText("Hello", 8);
    ctx.reset();
    const b = await ctx.generateText("Hello", 8);
    expect(a).toBe(b);
    expect(ctx.logits().length).toBe(model.nVocab);
  });

  test("freed handles throw instead of crashing", () => {
    const m = Model.load(GGUF!, { vocabOnly: true });
    m.free();
    expect(m.isFreed).toBe(true);
    expect(() => m.nVocab).toThrow(/freed/);
    m.free(); // idempotent
  });
});
