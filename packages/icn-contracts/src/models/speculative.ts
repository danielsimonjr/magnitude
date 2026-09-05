import { Schema } from "effect"

export const SpeculativeMethodMtp = Schema.Struct({ _tag: Schema.Literal("Mtp") })
export const SpeculativeMethodDFlash = Schema.Struct({ _tag: Schema.Literal("DFlash") })
export const SpeculativeMethodDSpark = Schema.Struct({ _tag: Schema.Literal("DSpark") })

export const SpeculativeMethod = Schema.Union(
  SpeculativeMethodMtp,
  SpeculativeMethodDFlash,
  SpeculativeMethodDSpark
)
export type SpeculativeMethod = typeof SpeculativeMethod.Type
