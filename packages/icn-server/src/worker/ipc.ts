import type { WorkerFrame, WorkerHostMessage, WorkerReplyMessage } from "./protocol.js"
import { WORKER_MAX_FRAME_BYTES, WORKER_PROTOCOL_VERSION } from "./protocol.js"

const readExact = async (stream: ReadableStream<Uint8Array>, count: number): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < count) {
      const { done, value } = await reader.read()
      if (done || value === undefined) {
        throw new Error("IPC stream ended before frame completed")
      }
      chunks.push(value)
      total += value.length
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(count)
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.length, count - offset))
    output.set(slice, offset)
    offset += slice.length
    if (offset >= count) {
      break
    }
  }
  return output
}

export const readWorkerFrame = async <T>(
  stream: ReadableStream<Uint8Array>,
): Promise<WorkerFrame<T>> => {
  const lengthBytes = await readExact(stream, 4)
  const length = new DataView(lengthBytes.buffer).getUint32(0, false)
  if (length > WORKER_MAX_FRAME_BYTES) {
    throw new Error(`IPC frame exceeds maximum size (${length} > ${WORKER_MAX_FRAME_BYTES})`)
  }
  const payload = await readExact(stream, length)
  const frame = JSON.parse(new TextDecoder().decode(payload)) as WorkerFrame<T>
  if (frame.protocol_version !== WORKER_PROTOCOL_VERSION) {
    throw new Error(
      `IPC protocol version mismatch: got ${frame.protocol_version}, expected ${WORKER_PROTOCOL_VERSION}`,
    )
  }
  return frame
}

export const writeWorkerFrame = async (
  stream: WritableStream<Uint8Array>,
  generation: number,
  message: WorkerHostMessage | WorkerReplyMessage,
): Promise<void> => {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      protocol_version: WORKER_PROTOCOL_VERSION,
      generation,
      message,
    } satisfies WorkerFrame<typeof message>),
  )
  if (payload.length > WORKER_MAX_FRAME_BYTES) {
    throw new Error(`IPC frame exceeds maximum size (${payload.length} > ${WORKER_MAX_FRAME_BYTES})`)
  }
  const writer = stream.getWriter()
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, payload.length, false)
  try {
    await writer.write(header)
    await writer.write(payload)
  } finally {
    writer.releaseLock()
  }
}

export const bufferWorkerFrame = (
  generation: number,
  message: WorkerHostMessage | WorkerReplyMessage,
): Uint8Array => {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      protocol_version: WORKER_PROTOCOL_VERSION,
      generation,
      message,
    }),
  )
  const frame = new Uint8Array(4 + payload.length)
  new DataView(frame.buffer).setUint32(0, payload.length, false)
  frame.set(payload, 4)
  return frame
}

export const parseWorkerFrame = <T>(bytes: Uint8Array): WorkerFrame<T> => {
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false)
  const payload = bytes.subarray(4, 4 + length)
  const frame = JSON.parse(new TextDecoder().decode(payload)) as WorkerFrame<T>
  if (frame.protocol_version !== WORKER_PROTOCOL_VERSION) {
    throw new Error(
      `IPC protocol version mismatch: got ${frame.protocol_version}, expected ${WORKER_PROTOCOL_VERSION}`,
    )
  }
  return frame
}
