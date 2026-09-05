import { ptr, type Pointer } from "bun:ffi";
import { isNullPointer, type NativeLibraries } from "./ffi";
import { copyF32, type Model } from "./model";

export interface ContextOptions {
  /** Context length in tokens; 0 = take from the model. Default 2048. */
  readonly nCtx?: number;
  /** Max tokens per llama_decode call. Default 512. */
  readonly nBatch?: number;
  /** Generation threads; 0 = llama.cpp default. */
  readonly nThreads?: number;
  /** Prompt-processing threads; 0 = same as nThreads. */
  readonly nThreadsBatch?: number;
}

export interface GenerateOptions {
  readonly addSpecial?: boolean;
  readonly parseSpecial?: boolean;
  /** Stop when the model emits an end-of-generation token. Default true. */
  readonly stopAtEog?: boolean;
}

export interface GeneratedToken {
  readonly token: number;
  readonly text: string;
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/** Number of trailing bytes that form an incomplete UTF-8 sequence. */
const incompleteUtf8Tail = (bytes: Uint8Array): number => {
  const n = bytes.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = bytes[n - back]!;
    if ((b & 0xc0) !== 0x80) {
      // Lead byte: expected sequence length.
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      return need > back ? back : 0;
    }
  }
  return 0;
};

const registry = new FinalizationRegistry<{ readonly ptr: Pointer; readonly native: NativeLibraries }>(
  ({ ptr: p, native }) => {
    native.llama.llama_free(p);
  }
);

/**
 * An inference context (KV cache + compute buffers) over a Model. Owns a
 * `llama_context *`. Single sequence (seq_id 0); tracks the current position.
 */
export class Context {
  readonly #native: NativeLibraries;
  readonly #token: object = {};
  readonly model: Model;
  #ptr: Pointer | null;
  #pos = 0;

  constructor(model: Model, options: ContextOptions = {}) {
    this.model = model;
    this.#native = model.native;
    const p = this.#native.shim.icn_context_new(
      model.pointer,
      options.nCtx ?? 2048,
      options.nBatch ?? 512,
      options.nThreads ?? 0,
      options.nThreadsBatch ?? 0,
      false
    );
    if (isNullPointer(p)) {
      throw new Error("icn-native: failed to create llama context");
    }
    this.#ptr = p;
    registry.register(this, { ptr: p, native: this.#native }, this.#token);
  }

  get pointer(): Pointer {
    if (this.#ptr === null) throw new Error("icn-native: context has been freed");
    return this.#ptr;
  }

  get isFreed(): boolean {
    return this.#ptr === null;
  }

  /** Next position to be decoded (== number of tokens in the KV cache). */
  get position(): number {
    return this.#pos;
  }

  get nCtx(): number {
    return this.#native.llama.llama_n_ctx(this.pointer);
  }

  get nBatch(): number {
    return this.#native.llama.llama_n_batch(this.pointer);
  }

  free(): void {
    if (this.#ptr === null) return;
    registry.unregister(this.#token);
    this.#native.llama.llama_free(this.#ptr);
    this.#ptr = null;
  }

  [Symbol.dispose](): void {
    this.free();
  }

  /** Clear the KV cache and reset the position to 0. */
  reset(): void {
    this.#native.shim.icn_memory_clear(this.pointer, true);
    this.#pos = 0;
  }

  /**
   * Decode tokens appended at the current position, in chunks of nBatch.
   * Only the final token requests logits. Returns the new position.
   */
  decode(tokens: ArrayLike<number>): number {
    const toks = tokens instanceof Int32Array ? tokens : Int32Array.from(tokens);
    if (toks.length === 0) return this.#pos;
    const ctx = this.pointer;
    const nCtx = this.nCtx;
    if (this.#pos + toks.length > nCtx) {
      throw new Error(`icn-native: context overflow (${this.#pos} + ${toks.length} > n_ctx ${nCtx})`);
    }
    const batch = this.nBatch;
    for (let off = 0; off < toks.length; off += batch) {
      const chunk = toks.subarray(off, Math.min(off + batch, toks.length));
      const rc = this.#native.shim.icn_decode_tokens(ctx, ptr(chunk), chunk.length, this.#pos, 0, true);
      if (rc !== 0) {
        throw new Error(`icn-native: llama_decode failed with status ${rc}`);
      }
      this.#pos += chunk.length;
    }
    return this.#pos;
  }

  /** Copy of the logits for the last decoded token (n_vocab floats). */
  logits(): Float32Array {
    const p = this.#native.shim.icn_logits(this.pointer, -1);
    if (isNullPointer(p)) throw new Error("icn-native: no logits available (decode first)");
    return copyF32(p, this.model.nVocab);
  }

  /** Argmax over the last token's logits, computed natively. */
  sampleGreedy(): number {
    const t = this.#native.shim.icn_sample_greedy(this.pointer, -1, this.model.nVocab);
    if (t < 0) throw new Error("icn-native: greedy sampling failed (no logits)");
    return t;
  }

  /**
   * Greedy generation. Yields decoded text pieces as they become complete
   * UTF-8. Prompt is decoded from the current position (call reset() first
   * to start fresh).
   */
  async *generate(prompt: string, maxTokens: number, options: GenerateOptions = {}): AsyncGenerator<GeneratedToken, void> {
    const stopAtEog = options.stopAtEog ?? true;
    const promptTokens = this.model.tokenize(prompt, {
      addSpecial: options.addSpecial ?? this.#pos === 0,
      parseSpecial: options.parseSpecial ?? false,
    });
    this.decode(promptTokens);

    let pending = new Uint8Array(0);
    const next = new Int32Array(1);
    for (let i = 0; i < maxTokens; i++) {
      const token = this.sampleGreedy();
      if (stopAtEog && this.model.isEog(token)) break;

      const piece = this.model.tokenToPieceBytes(token);
      const merged = new Uint8Array(pending.length + piece.length);
      merged.set(pending);
      merged.set(piece, pending.length);
      const tail = incompleteUtf8Tail(merged);
      const complete = merged.subarray(0, merged.length - tail);
      pending = merged.slice(merged.length - tail);
      yield { token, text: TEXT_DECODER.decode(complete) };

      if (this.#pos >= this.nCtx) break;
      next[0] = token;
      this.decode(next);
      // Yield to the event loop between tokens so callers can cancel.
      await Promise.resolve();
    }
    if (pending.length > 0) {
      yield { token: -1, text: TEXT_DECODER.decode(pending) };
    }
  }

  /** Convenience: run generate() to completion and return the joined text. */
  async generateText(prompt: string, maxTokens: number, options: GenerateOptions = {}): Promise<string> {
    let out = "";
    for await (const piece of this.generate(prompt, maxTokens, options)) out += piece.text;
    return out;
  }
}
