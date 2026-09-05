/** Thin Hugging Face URL and revision helpers ported from inference/crates/icn-models/src/hugging_face.rs */

export const revisionMetadataUrl = (
  endpoint: string,
  repository: string,
  revision: string,
): string => {
  const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint
  const segments = ["api", "models", ...repository.split("/"), "revision", revision]
  return `${base}/${segments.join("/")}`
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
