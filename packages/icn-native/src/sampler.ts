import { ptr, type Pointer } from "bun:ffi";
import { isNullPointer, loadNative, type NativeLibraries } from "./ffi";
import type { Context } from "./context";

/** llama.cpp `LLAMA_DEFAULT_SEED` — request a random seed from the sampler. */
export const LLAMA_DEFAULT_SEED = 0xffffffff;

export interface SamplerChainOptions {
  readonly nVocab: number;
  /** Top-k; <=0 disables. Default 0 (disabled). */
  readonly topK?: number;
  /** Nucleus top-p; 1.0 disables. Default 1.0. */
  readonly topP?: number;
  /**
   * Temperature. Non-positive values select greedy argmax via the chain.
   * Default 0 (greedy).
   */
  readonly temperature?: number;
  /** Last-n window for penalties; 0 disables. Default 0. */
  readonly penaltyLastN?: number;
  /** Repetition penalty; 1.0 disables. Default 1.0. */
  readonly penaltyRepeat?: number;
  /** Frequency penalty; 0.0 disables. Default 0.0. */
  readonly penaltyFreq?: number;
  /** Presence penalty; 0.0 disables. Default 0.0. */
  readonly penaltyPresent?: number;
  /** RNG seed for distribution sampling. Default `LLAMA_DEFAULT_SEED`. */
  readonly seed?: number;
}

const registry = new FinalizationRegistry<{ readonly ptr: Pointer; readonly native: NativeLibraries }>(
  ({ ptr: p, native }) => {
    native.llama.llama_sampler_free(p);
  }
);

/**
 * Owned `llama_sampler *` built as a temp / top-k / top-p / penalties chain.
 *
 * Prefer {@link Sampler.create} which builds the full chain inside the shim.
 * Call `free()` when done; FinalizationRegistry is a safety net only.
 */
export class Sampler {
  readonly #native: NativeLibraries;
  readonly #token: object = {};
  #ptr: Pointer | null;

  private constructor(native: NativeLibraries, samplerPtr: Pointer) {
    this.#native = native;
    this.#ptr = samplerPtr;
    registry.register(this, { ptr: samplerPtr, native }, this.#token);
  }

  static create(options: SamplerChainOptions): Sampler {
    const native = loadNative();
    const p = native.shim.icn_sampler_chain_build(
      options.nVocab,
      options.topK ?? 0,
      options.topP ?? 1.0,
      options.temperature ?? 0.0,
      options.penaltyLastN ?? 0,
      options.penaltyRepeat ?? 1.0,
      options.penaltyFreq ?? 0.0,
      options.penaltyPresent ?? 0.0,
      options.seed ?? LLAMA_DEFAULT_SEED
    );
    if (isNullPointer(p)) {
      throw new Error("icn-native: failed to build sampler chain");
    }
    return new Sampler(native, p);
  }

  /** Empty chain; callers add stages via the raw pointer APIs if needed. */
  static empty(noPerf = true): Sampler {
    const native = loadNative();
    const p = native.shim.icn_sampler_chain_init(noPerf);
    if (isNullPointer(p)) {
      throw new Error("icn-native: failed to init sampler chain");
    }
    return new Sampler(native, p);
  }

  get pointer(): Pointer {
    if (this.#ptr === null) throw new Error("icn-native: sampler has been freed");
    return this.#ptr;
  }

  get isFreed(): boolean {
    return this.#ptr === null;
  }

  get native(): NativeLibraries {
    return this.#native;
  }

  /** Sample (and accept) one token from context output row `idx` (default -1). */
  sample(ctx: Context, idx = -1): number {
    const token = this.#native.llama.llama_sampler_sample(this.pointer, ctx.pointer, idx);
    if (token < 0) {
      throw new Error("icn-native: llama_sampler_sample failed");
    }
    return token;
  }

  /** Feed an already-chosen token into sampler state (penalties / grammar). */
  accept(token: number): void {
    this.#native.llama.llama_sampler_accept(this.pointer, token);
  }

  reset(): void {
    this.#native.llama.llama_sampler_reset(this.pointer);
  }

  free(): void {
    if (this.#ptr === null) return;
    registry.unregister(this.#token);
    this.#native.llama.llama_sampler_free(this.#ptr);
    this.#ptr = null;
  }

  [Symbol.dispose](): void {
    this.free();
  }
}

/** True when the config requests non-greedy sampling that needs a chain. */
export const wantsStochasticSampling = (options: {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly penaltyLastN?: number;
  readonly penaltyRepeat?: number;
  readonly penaltyFreq?: number;
  readonly penaltyPresent?: number;
}): boolean => {
  const temperature = options.temperature ?? 0;
  if (temperature > 0) return true;
  if ((options.topK ?? 0) > 0) return true;
  if ((options.topP ?? 1) < 1) return true;
  if ((options.penaltyLastN ?? 0) !== 0) return true;
  if ((options.penaltyRepeat ?? 1) !== 1) return true;
  if ((options.penaltyFreq ?? 0) !== 0) return true;
  if ((options.penaltyPresent ?? 0) !== 0) return true;
  return false;
};

/** Keep typed arrays alive while their pointers are passed to C. */
export const keepAlive = (..._values: unknown[]): void => {
  // Intentionally empty — references in the caller's scope keep buffers alive.
  void _values;
};

export { ptr };
