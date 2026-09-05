import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { cstr, isNullPointer, loadNative, type NativeLibraries } from "./ffi";

/** llama_load_mode values (see llama.h). */
export enum LoadMode {
  Auto = -1,
  None = 0,
  Mmap = 1,
  Mlock = 2,
  MmapMlock = 3,
  DirectIo = 4,
}

export interface ModelLoadOptions {
  /** Layers to offload to GPU; 0 for CPU only (default), -1 for all. */
  readonly nGpuLayers?: number;
  readonly loadMode?: LoadMode;
  /** Load only the vocabulary (no weights); useful for tokenizer-only work. */
  readonly vocabOnly?: boolean;
}

export interface TokenizeOptions {
  /** Add BOS/EOS according to the model's vocab settings. Default true. */
  readonly addSpecial?: boolean;
  /** Parse special-token text (e.g. "<s>") into control tokens. Default false. */
  readonly parseSpecial?: boolean;
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

const registry = new FinalizationRegistry<{ readonly ptr: Pointer; readonly native: NativeLibraries }>(
  ({ ptr: p, native }) => {
    native.llama.llama_model_free(p);
  }
);

/**
 * A loaded GGUF model plus its vocabulary. Owns a `llama_model *`.
 *
 * Call `free()` when done; a FinalizationRegistry frees leaked models on GC as
 * a safety net, but model memory is large and GC timing is unpredictable.
 */
export class Model {
  readonly #native: NativeLibraries;
  readonly #token: object = {};
  #ptr: Pointer | null;
  readonly #vocab: Pointer;
  readonly path: string;

  private constructor(native: NativeLibraries, modelPtr: Pointer, path: string) {
    this.#native = native;
    this.#ptr = modelPtr;
    this.path = path;
    const vocab = native.llama.llama_model_get_vocab(modelPtr);
    if (isNullPointer(vocab)) {
      native.llama.llama_model_free(modelPtr);
      throw new Error("icn-native: model has no vocabulary");
    }
    this.#vocab = vocab;
    registry.register(this, { ptr: modelPtr, native }, this.#token);
  }

  static load(path: string, options: ModelLoadOptions = {}): Model {
    const native = loadNative();
    const pathBuf = cstr(path);
    const p = native.shim.icn_model_load(
      ptr(pathBuf),
      options.nGpuLayers ?? 0,
      options.loadMode ?? LoadMode.Auto,
      options.vocabOnly ?? false
    );
    if (isNullPointer(p)) {
      throw new Error(`icn-native: failed to load model from ${path}`);
    }
    return new Model(native, p, path);
  }

  /** Raw `llama_model *`. Throws if freed. */
  get pointer(): Pointer {
    if (this.#ptr === null) throw new Error("icn-native: model has been freed");
    return this.#ptr;
  }

  /** Raw `const llama_vocab *`. */
  get vocab(): Pointer {
    this.pointer; // freed check
    return this.#vocab;
  }

  get native(): NativeLibraries {
    return this.#native;
  }

  get isFreed(): boolean {
    return this.#ptr === null;
  }

  free(): void {
    if (this.#ptr === null) return;
    registry.unregister(this.#token);
    this.#native.llama.llama_model_free(this.#ptr);
    this.#ptr = null;
  }

  [Symbol.dispose](): void {
    this.free();
  }

  // -- metadata ------------------------------------------------------------

  get description(): string {
    const buf = new Uint8Array(512);
    const n = this.#native.llama.llama_model_desc(this.pointer, ptr(buf), BigInt(buf.byteLength));
    return n > 0 ? TEXT_DECODER.decode(buf.subarray(0, Math.min(n, buf.byteLength - 1))) : "";
  }

  get nParams(): bigint {
    return BigInt(this.#native.llama.llama_model_n_params(this.pointer));
  }

  get sizeBytes(): bigint {
    return BigInt(this.#native.llama.llama_model_size(this.pointer));
  }

  get nCtxTrain(): number {
    return this.#native.llama.llama_model_n_ctx_train(this.pointer);
  }

  get nEmbd(): number {
    return this.#native.llama.llama_model_n_embd(this.pointer);
  }

  // -- vocab ---------------------------------------------------------------

  get nVocab(): number {
    return this.#native.llama.llama_vocab_n_tokens(this.vocab);
  }

  get bosToken(): number {
    return this.#native.llama.llama_vocab_bos(this.vocab);
  }

  get eosToken(): number {
    return this.#native.llama.llama_vocab_eos(this.vocab);
  }

  get addsBos(): boolean {
    return this.#native.llama.llama_vocab_get_add_bos(this.vocab);
  }

  isEog(token: number): boolean {
    return this.#native.llama.llama_vocab_is_eog(this.vocab, token);
  }

  /** Tokenize `text` into token ids. */
  tokenize(text: string, options: TokenizeOptions = {}): Int32Array {
    const addSpecial = options.addSpecial ?? true;
    const parseSpecial = options.parseSpecial ?? false;
    const bytes = Buffer.from(text, "utf8");
    // llama_tokenize needs a pointer even for empty input.
    const textBuf = bytes.byteLength > 0 ? new Uint8Array(bytes) : new Uint8Array(1);
    let out = new Int32Array(Math.max(8, bytes.byteLength + 2));
    let n = this.#native.llama.llama_tokenize(
      this.vocab,
      ptr(textBuf),
      bytes.byteLength,
      ptr(out),
      out.length,
      addSpecial,
      parseSpecial
    );
    if (n < 0) {
      // Negative result = required capacity.
      out = new Int32Array(-n);
      n = this.#native.llama.llama_tokenize(
        this.vocab,
        ptr(textBuf),
        bytes.byteLength,
        ptr(out),
        out.length,
        addSpecial,
        parseSpecial
      );
      if (n < 0) throw new Error(`icn-native: llama_tokenize failed (${n})`);
    }
    return out.slice(0, n);
  }

  /**
   * Raw UTF-8 bytes of one token's piece. Pieces can end mid-codepoint, so
   * callers that stream text should accumulate bytes (see Context.generate).
   */
  tokenToPieceBytes(token: number, special = false): Uint8Array {
    let buf = new Uint8Array(64);
    let n = this.#native.llama.llama_token_to_piece(this.vocab, token, ptr(buf), buf.length, 0, special);
    if (n < 0) {
      buf = new Uint8Array(-n);
      n = this.#native.llama.llama_token_to_piece(this.vocab, token, ptr(buf), buf.length, 0, special);
      if (n < 0) throw new Error(`icn-native: llama_token_to_piece failed (${n})`);
    }
    return buf.slice(0, n);
  }

  tokenToPiece(token: number, special = false): string {
    return TEXT_DECODER.decode(this.tokenToPieceBytes(token, special));
  }

  /** Inverse of tokenize. */
  detokenize(tokens: ArrayLike<number>, options: { removeSpecial?: boolean; unparseSpecial?: boolean } = {}): string {
    const removeSpecial = options.removeSpecial ?? false;
    const unparseSpecial = options.unparseSpecial ?? false;
    const toks = tokens instanceof Int32Array ? tokens : Int32Array.from(tokens);
    if (toks.length === 0) return "";
    let buf = new Uint8Array(Math.max(16, toks.length * 8));
    let n = this.#native.llama.llama_detokenize(
      this.vocab,
      ptr(toks),
      toks.length,
      ptr(buf),
      buf.length,
      removeSpecial,
      unparseSpecial
    );
    if (n < 0) {
      buf = new Uint8Array(-n);
      n = this.#native.llama.llama_detokenize(
        this.vocab,
        ptr(toks),
        toks.length,
        ptr(buf),
        buf.length,
        removeSpecial,
        unparseSpecial
      );
      if (n < 0) throw new Error(`icn-native: llama_detokenize failed (${n})`);
    }
    return TEXT_DECODER.decode(buf.subarray(0, n));
  }
}

/** Read `count` f32 values from a native float pointer into a fresh Float32Array copy. */
export const copyF32 = (p: Pointer, count: number): Float32Array =>
  new Float32Array(toArrayBuffer(p, 0, count * 4).slice(0));
