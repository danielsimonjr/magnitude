const snakeToCamelKey = (key: string): string =>
  key === "_tag" ? key : key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())

const mergeAliasFields = (record: Record<string, unknown>): Record<string, unknown> => {
  const aliases: Array<[string, string]> = [
    ["quantization_name", "quantizationName"],
    ["maximum_context_length", "maximumContextLength"],
    ["size_bytes", "sizeBytes"],
    ["tensor_storage_bytes", "tensorStorageBytes"],
    ["context_length", "contextLength"],
    ["display_name", "displayName"],
    ["variant_label", "variantLabel"],
    ["release_date", "releaseDate"],
    ["source_urls", "sourceUrls"],
    ["fidelity_rank", "fidelityRank"],
    ["quantization_aware", "quantizationAware"],
    ["local_state", "localState"],
    ["update_state", "updateState"],
    ["required_download_bytes", "requiredDownloadBytes"],
    ["installed_bytes", "installedBytes"],
    ["primary_path", "primaryPath"],
    ["catalog_attribution", "catalogAttribution"],
    ["operation_id", "operationId"],
    ["model_id", "modelId"],
    ["bytes_per_second", "bytesPerSecond"],
    ["completed_bytes", "completedBytes"],
    ["total_bytes", "totalBytes"],
    ["reconciliation_complete", "reconciliationComplete"],
    ["intrinsic_model_id", "intrinsicModelId"],
    ["intrinsic_quality_id", "intrinsicQualityId"],
  ]

  for (const [snake, camel] of aliases) {
    if (record[snake] !== undefined && record[camel] === undefined) {
      record[camel] = record[snake]
    }
  }

  if (
    record.format !== undefined &&
    record.architecture !== undefined &&
    record.quantization !== undefined
  ) {
    if (record.quantizationName === undefined) {
      record.quantizationName =
        typeof record.quantization_name === "string"
          ? record.quantization_name
          : typeof record.quantization === "string"
            ? record.quantization
            : "unknown"
    }
    if (record.storageBytes === undefined || record.storageBytes === null) {
      record.storageBytes = 0
    }
  }

  if ("storageBytes" in record && record.storageBytes === null) {
    record.storageBytes = 0
  }

  return record
}

const primitiveWire = (value: unknown): unknown | undefined => {
  if (typeof value === "bigint") {
    return Number(value)
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    // Effect Option<"Some" | "None">
    if (record._tag === "Some" && "value" in record) {
      return toWireJson(record.value)
    }
    if (record._tag === "None") {
      return undefined
    }
    if ("value" in record && Object.keys(record).length === 1) {
      return toWireJson(record.value)
    }
    if (
      "asStr" in record &&
      typeof (record as { asStr: () => string }).asStr === "function"
    ) {
      return (record as { asStr: () => string }).asStr()
    }
  }
  return undefined
}

/** Projects icn-models snake_case records to OpenAPI camelCase wire JSON. */
export const toWireJson = (value: unknown): unknown => {
  const primitive = primitiveWire(value)
  if (primitive !== undefined) {
    return primitive
  }
  if (Array.isArray(value)) {
    return value.map(toWireJson)
  }
  if (value !== null && typeof value === "object") {
    if (Object.keys(value).length === 0) {
      return undefined
    }
    const normalized = mergeAliasFields(
      Object.fromEntries(
        Object.entries(value)
          .map(([key, nested]) => [snakeToCamelKey(key), toWireJson(nested)] as const)
          .filter(([, nested]) => nested !== undefined),
      ),
    )
    return normalized
  }
  return value
}
