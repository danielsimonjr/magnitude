import type {
  ModelAssessment,
  ModelCapabilities,
  ReasoningProfile,
  SpeculativeDecodingSelection,
  TemplateCapabilities,
} from "@magnitudedev/icn-contracts"

/** Models-internal assessment cache entry (see inference/crates/icn-models/src/cache.rs). */
export interface CachedModelAssessment {
  readonly capabilities: ModelCapabilities
  readonly templateCapabilities: TemplateCapabilities
  readonly reasoning: ReasoningProfile
  readonly templateFingerprint: string
  readonly speculative: SpeculativeDecodingSelection
  readonly profile: ModelAssessment
}
