import type { ModelProperties, PreparedChatInfo } from "./execution.js"
import type { InferenceObservation, InferenceCompletion } from "./inference/output.js"
import type { ResolvedInferenceRequest } from "./inference/request.js"

export * from "./bootstrap/index.js"
export * from "./execution.js"
export * from "./inventory.js"
export * from "./output.js"
export * from "./models/index.js"

export * as inference from "./inference/index.js"

export interface CompletionBackend {
  modelId(): string
  properties?(): ModelProperties | import("./execution.js").InferenceError
  applyTemplate?(request: ResolvedInferenceRequest): PreparedChatInfo | import("./execution.js").InferenceError
  countTokens?(request: ResolvedInferenceRequest): number | import("./execution.js").InferenceError
  complete(
    request: ResolvedInferenceRequest,
    onAdmitted: (position: number) => void | import("./execution.js").InferenceError,
    onEvent: (observation: InferenceObservation) => void | import("./execution.js").InferenceError
  ): InferenceCompletion | import("./execution.js").InferenceError
}
