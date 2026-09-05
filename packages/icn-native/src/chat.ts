import { ptr } from "bun:ffi";
import { cstr, loadNative } from "./ffi";

export interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

export interface ApplyChatTemplateOptions {
  /**
   * Named or Jinja-like template text recognized by llama.cpp's built-in list.
   * When omitted, llama.cpp defaults to `"chatml"`.
   */
  readonly template?: string | null;
  /** Append the assistant-turn prefix. Default true. */
  readonly addAssistant?: boolean;
}

/**
 * Format chat messages with `llama_chat_apply_template` via the C shim.
 *
 * Only the predefined templates supported by llama.cpp are accepted; unknown
 * templates return a thrown error (native status -1).
 */
export const applyChatTemplate = (
  messages: readonly ChatMessage[],
  options: ApplyChatTemplateOptions = {}
): string => {
  const native = loadNative();
  const tmplBuf = options.template == null ? null : cstr(options.template);
  const roleBufs = messages.map((m) => cstr(m.role));
  const contentBufs = messages.map((m) => cstr(m.content));
  // Pointer array of `const char *` for roles and contents.
  const rolePtrs = BigUint64Array.from(roleBufs.map((b) => BigInt(ptr(b))));
  const contentPtrs = BigUint64Array.from(contentBufs.map((b) => BigInt(ptr(b))));

  const addAss = options.addAssistant ?? true;
  let buf = new Uint8Array(Math.max(64, estimateCapacity(messages) * 2));
  let n = native.shim.icn_chat_apply_template(
    tmplBuf == null ? null : ptr(tmplBuf),
    ptr(rolePtrs),
    ptr(contentPtrs),
    BigInt(messages.length),
    addAss,
    ptr(buf),
    buf.length
  );
  if (n < 0) {
    throw new Error(
      `icn-native: llama_chat_apply_template failed (${n}); template may be unsupported`
    );
  }
  if (n >= buf.length) {
    buf = new Uint8Array(n + 1);
    n = native.shim.icn_chat_apply_template(
      tmplBuf == null ? null : ptr(tmplBuf),
      ptr(rolePtrs),
      ptr(contentPtrs),
      BigInt(messages.length),
      addAss,
      ptr(buf),
      buf.length
    );
    if (n < 0) {
      throw new Error(`icn-native: llama_chat_apply_template failed on resize (${n})`);
    }
  }
  // Keep buffers alive through the native call(s).
  void roleBufs;
  void contentBufs;
  void tmplBuf;
  return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, n));
};

const estimateCapacity = (messages: readonly ChatMessage[]): number => {
  let n = 0;
  for (const m of messages) n += m.role.length + m.content.length + 16;
  return Math.max(n, 32);
};
