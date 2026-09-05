import { loadNative } from "./ffi";

/** ggml_backend_dev_type values (see ggml-backend.h). */
export enum BackendDeviceType {
  Cpu = 0,
  Gpu = 1,
  IGpu = 2,
  Accel = 3,
  Meta = 4,
}

export interface BackendDevice {
  readonly index: number;
  readonly name: string;
  readonly description: string;
  readonly type: BackendDeviceType;
}

/**
 * Enumerate ggml backend devices registered after `icn_backend_init`.
 *
 * Safe to call before any model load; typically at least one CPU device is
 * present after the shim initializes the backend.
 */
export const listBackendDevices = (): BackendDevice[] => {
  const native = loadNative();
  const countRaw = native.shim.icn_backend_dev_count();
  const count = typeof countRaw === "bigint" ? Number(countRaw) : Number(countRaw);
  const devices: BackendDevice[] = [];
  for (let i = 0; i < count; i++) {
    const index = BigInt(i);
    const name = native.shim.icn_backend_dev_name(index)?.toString() ?? "";
    const description = native.shim.icn_backend_dev_description(index)?.toString() ?? "";
    const type = native.shim.icn_backend_dev_type(index);
    devices.push({
      index: i,
      name,
      description,
      type: type as BackendDeviceType,
    });
  }
  return devices;
};

export const backendDeviceCount = (): number => {
  const raw = loadNative().shim.icn_backend_dev_count();
  return typeof raw === "bigint" ? Number(raw) : Number(raw);
};
