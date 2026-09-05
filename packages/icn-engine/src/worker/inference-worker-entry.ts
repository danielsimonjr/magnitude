import { bindSamplingContext, unbindSamplingContext } from "../sampling/context-binding.js"
import { loadNativeSession, releaseNativeSession, runCompletion } from "./session-core.js"
import type { NativeSessionState } from "./session-core.js"
import type { WorkerEvent, WorkerMainMessage } from "./types.js"

declare const self: Worker

let state: NativeSessionState | undefined
const active = new Map<string, AbortController>()

self.onmessage = (event: MessageEvent<WorkerMainMessage>) => {
  const message = event.data
  switch (message.type) {
    case "init": {
      state = loadNativeSession(message.executionIntent)
      bindSamplingContext(state.context)
      self.postMessage({ type: "loaded" } satisfies WorkerEvent)
      return
    }
    case "complete": {
      const eventsPort = event.ports[0]
      if (eventsPort === undefined || state === undefined) return
      const controller = new AbortController()
      active.set(message.requestId, controller)
      void (async () => {
        try {
          for await (const workerEvent of runCompletion(
            state!,
            message.requestId,
            message.payload,
            controller.signal
          )) {
            eventsPort.postMessage(workerEvent)
          }
        } finally {
          active.delete(message.requestId)
        }
      })()
      return
    }
    case "cancel": {
      active.get(message.requestId)?.abort()
      return
    }
    case "shutdown": {
      for (const controller of active.values()) controller.abort()
      active.clear()
      releaseNativeSession(state)
      state = undefined
      unbindSamplingContext()
      return
    }
  }
}
