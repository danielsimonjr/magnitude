import { ParseResult, Schema } from "effect"

export type InferenceRequestError =
  | { readonly _tag: "Empty"; readonly field: string }
  | { readonly _tag: "OutOfRange"; readonly field: string; readonly minimum: number; readonly maximum: number }
  | { readonly _tag: "DuplicateToolName"; readonly name: string }
  | { readonly _tag: "UnknownToolName"; readonly name: string }
  | { readonly _tag: "EmptyAllowedTools" }
  | { readonly _tag: "DuplicateAllowedToolName"; readonly name: string }
  | { readonly _tag: "RequiredToolsWithoutDefinitions" }

const inferenceRequestErrorTags = new Set([
  "Empty",
  "OutOfRange",
  "DuplicateToolName",
  "UnknownToolName",
  "EmptyAllowedTools",
  "DuplicateAllowedToolName",
  "RequiredToolsWithoutDefinitions",
])

export const isInferenceRequestError = (value: unknown): value is InferenceRequestError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  inferenceRequestErrorTags.has(String((value as InferenceRequestError)._tag))

export class NonEmptyText {
  constructor(private readonly value: string) {}

  static tryNew(value: string, field: string): NonEmptyText | InferenceRequestError {
    if (value.length === 0) return { _tag: "Empty", field }
    return new NonEmptyText(value)
  }

  asStr(): string {
    return this.value
  }

  intoInner(): string {
    return this.value
  }
}

export const NonEmptyTextSchema = Schema.transformOrFail(Schema.String, Schema.typeSchema(Schema.Any), {
  strict: true,
  decode: (value, _, ast) => {
    const parsed = NonEmptyText.tryNew(value, "text")
      if (isInferenceRequestError(parsed) && parsed._tag === "Empty") {
        return ParseResult.fail(new ParseResult.Type(ast, value, `${parsed.field} must not be empty`))
      }
    return ParseResult.succeed(parsed)
  },
  encode: (value) => value.asStr(),
})

export class NonEmptyVec<T> {
  constructor(private readonly values: readonly T[]) {}

  static tryNew<T>(values: readonly T[], field: string): NonEmptyVec<T> | InferenceRequestError {
    if (values.length === 0) return { _tag: "Empty", field }
    return new NonEmptyVec(values)
  }

  asSlice(): readonly T[] {
    return this.values
  }

  intoVec(): T[] {
    return [...this.values]
  }

  len(): number {
    return this.values.length
  }
}

export const nonEmptyVecSchema = <A, I>(item: Schema.Schema<A, I, never>) =>
  Schema.transformOrFail(Schema.Array(item), Schema.typeSchema(Schema.Any), {
    strict: true,
    decode: (values, _, ast) => {
      const parsed = NonEmptyVec.tryNew(values, "collection")
      if (isInferenceRequestError(parsed) && parsed._tag === "Empty") {
        return ParseResult.fail(new ParseResult.Type(ast, values, `${parsed.field} must not be empty`))
      }
      return ParseResult.succeed(parsed)
    },
    encode: (value) => value.intoVec(),
  })
