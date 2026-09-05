/** Thin Hugging Face URL and revision helpers ported from inference/crates/icn-models/src/hugging_face.rs */

export const DEFAULT_HF_ENDPOINT = "https://huggingface.co"
export const MAX_HUB_SEARCH_RESULTS = 50
export const MAX_HUB_SEARCH_QUERY_BYTES = 200

export const revisionMetadataUrl = (
  endpoint: string,
  repository: string,
  revision: string,
): string => {
  const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint
  const segments = ["api", "models", ...repository.split("/"), "revision", revision]
  return `${base}/${segments.join("/")}`
}

export const hubSearchUrl = (
  endpoint: string,
  query: string,
  limit: number,
): string => {
  const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint
  const params = new URLSearchParams()
  params.set("search", query)
  params.set("filter", "gguf")
  params.set("sort", "downloads")
  params.set("direction", "-1")
  params.set("limit", String(limit))
  for (const expand of ["sha", "lastModified", "downloads", "likes", "tags", "private", "gated"]) {
    params.append("expand", expand)
  }
  return `${base}/api/models?${params.toString()}`
}

export const requireRequestedRevision = (
  requested: string,
  resolved: string | undefined,
): void => {
  if (resolved === undefined) {
    throw new Error("Hugging Face metadata did not include a resolved revision")
  }
  if (resolved !== requested) {
    throw new Error(`Hugging Face resolved requested revision ${requested} as ${resolved}`)
  }
}
