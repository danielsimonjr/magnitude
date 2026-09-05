import { ParseResult, Schema } from "effect"

export const JsonValue: Schema.Schema<any, any, never> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(JsonValue),
    Schema.Record({ key: Schema.String, value: JsonValue })
  )
)

export const JsonObject = Schema.Record({ key: Schema.String, value: JsonValue })

export type JsonObject = typeof JsonObject.Type

export const PositiveInt = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))

export const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

export const U32 = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

export const Path = Schema.String

export const optional = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.optionalWith(schema, { as: "Option", exact: true })

export const transparentStringId = <Brand extends string>(brand: Brand) =>
  Schema.String.pipe(Schema.brand(brand))

export const isNfcNormalized = (value: string): boolean => value === value.normalize("NFC")

export const decodeJson = (schema: Schema.Schema<any, any, never>, value: unknown): any =>
  Schema.decodeUnknownSync(schema)(value)

export const encodeJson = (schema: Schema.Schema<any, any, never>, value: unknown): any =>
  Schema.encodeSync(schema)(value)
