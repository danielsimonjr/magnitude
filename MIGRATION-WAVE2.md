# Wave 2 agent brief — TypeScript-on-Bun inference migration

## Context

Phase 1 (`packages/icn-native`) is done. Wave 2 is **Contracts and store**.
Design: `design/inference/typescript-migration.md`. Status: `MIGRATION-STATUS.md`.

## Rules

- Effect-TS native. Serializable data → Effect Schema.
- Optional fields: `Schema.optionalWith(Schema.X, { as: "Option", exact: true })`.
- Branded string IDs via `Schema.brand`.
- No `bun:ffi` outside `packages/icn-native`.
- Port Rust `#[test]` / `#[tokio::test]` suites to vitest (`bunx --bun vitest run`).
- Match Rust serde JSON encoding (snake_case / tagged unions / camelCase as in source).
- Prefer reusing `@magnitudedev/icn-protocol/schemas` for pure wire shapes when identical;
  put validated / internal contracts in `@magnitudedev/icn-contracts`.
- Do not edit packages you do not own. Do not remove the Rust engine.

## Package ownership (wave 2)

| Package | Owns |
|---|---|
| `packages/icn-contracts` | Port of `inference/crates/icn-contracts` |
| `packages/icn-models` | Port of `inference/crates/icn-models` |

## Exit criterion

TypeScript store passes translated Rust store behavioral tests against the same fixtures.
Update `MIGRATION-STATUS.md` phase 2 when verified; record anything unverifiable.
