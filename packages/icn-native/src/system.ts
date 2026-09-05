import { loadNative } from "./ffi";

/** llama_print_system_info() as a string. */
export const systemInfo = (): string => loadNative().llama.llama_print_system_info().toString();

export const supportsGpuOffload = (): boolean => loadNative().llama.llama_supports_gpu_offload();
