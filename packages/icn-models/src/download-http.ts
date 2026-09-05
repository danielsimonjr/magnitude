import { requireRequestedRevision, revisionMetadataUrl } from "./hugging-face"
import {
  DownloadError,
  missingUpstreamContent,
  type ResolvedRemoteMetadata,
  validateEquivalentFile,
} from "./download"
import type { ModelComponent } from "@magnitudedev/icn-contracts"

export interface HubApiLfs {
  sha256: string
  size: number
}

export interface HubApiSibling {
  rfilename: string
  size?: number
  lfs?: HubApiLfs
}

export interface HubApiModel {
  sha?: string
  siblings: HubApiSibling[]
}

export interface ModelDownloadHttpClient {
  fetchMetadata(repository: string, revision: string): Promise<HubApiModel>
  fetchFileRange(params: {
    repository: string
    commit: string
    path: string
    offset: number
    length: number
  }): Promise<Uint8Array>
}

export interface ModelDownloadHttpOptions {
  endpoint?: string
  fetch?: typeof globalThis.fetch
  token?: string
}

const defaultEndpoint = "https://huggingface.co"

export const createHuggingFaceDownloadClient = (
  options: ModelDownloadHttpOptions = {},
): ModelDownloadHttpClient => {
  const endpoint = options.endpoint ?? defaultEndpoint
  const fetchFn = options.fetch ?? globalThis.fetch
  const token = options.token ?? process.env.HF_TOKEN

  return {
    async fetchMetadata(repository, revision) {
      const url = revisionMetadataUrl(endpoint, repository, revision)
      const headers: Record<string, string> = { Accept: "application/json" }
      if (token !== undefined && token.length > 0) {
        headers.Authorization = `Bearer ${token}`
      }
      const response = await fetchFn(`${url}?blobs=true`, { headers })
      if (!response.ok) {
        throw mapHttpStatus(response.status)
      }
      return (await response.json()) as HubApiModel
    },

    async fetchFileRange({ repository, commit, path, offset, length }) {
      const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint
      const encodedPath = path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")
      const url = `${base}/${repository}/resolve/${commit}/${encodedPath}`
      const headers: Record<string, string> = {}
      if (length > 0) {
        headers.Range = `bytes=${offset}-${offset + length - 1}`
      }
      if (token !== undefined && token.length > 0) {
        headers.Authorization = `Bearer ${token}`
      }
      const response = await fetchFn(url, { headers })
      if (!response.ok) {
        throw mapHttpStatus(response.status)
      }
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

const mapHttpStatus = (status: number): DownloadError => {
  const retryable = status === 429 || status >= 500
  switch (status) {
    case 401:
    case 403:
      return new DownloadError("SourceAccessDenied", `Hugging Face returned HTTP ${status}`, false, false)
    case 404:
      return new DownloadError("MissingSource", `Hugging Face returned HTTP ${status}`, false, false)
    default:
      return new DownloadError(
        retryable ? "Network" : "InvalidRequest",
        `Hugging Face returned HTTP ${status}`,
        retryable,
        false,
      )
  }
}

export const isImmutableCommit = (value: string): boolean =>
  value.length >= 40 &&
  value.length <= 64 &&
  /^[0-9a-f]+$/.test(value)

export const resolveRemoteMetadata = (
  api: HubApiModel,
  commit: string,
  path: string,
): ResolvedRemoteMetadata => {
  const sibling = api.siblings.find((entry) => entry.rfilename === path)
  if (sibling === undefined) {
    throw new DownloadError("MissingSource", `Hugging Face repository has no ${path}`, false, false)
  }
  if (sibling.lfs !== undefined) {
    return { size: sibling.lfs.size, sha256: sibling.lfs.sha256.toLowerCase() }
  }
  return { size: sibling.size ?? 0, sha256: null }
}

export const resolveDownloadRevision = async (
  http: ModelDownloadHttpClient,
  repository: string,
  revision: string,
  components: readonly ModelComponent[],
  equivalentToRevision?: string,
): Promise<string> => {
  let api: HubApiModel
  try {
    api = await http.fetchMetadata(repository, revision)
  } catch (error) {
    if (equivalentToRevision !== undefined && error instanceof DownloadError && missingUpstreamContent(error)) {
      throw packageUnavailable(repository, equivalentToRevision, undefined, undefined, "current main is unavailable")
    }
    throw error
  }
  const commit = api.sha
  if (commit === undefined || commit.length === 0) {
    throw new DownloadError(
      "Network",
      "Hugging Face repository response did not include a commit",
      true,
      false,
    )
  }
  if (revision === "main") {
    if (!isImmutableCommit(commit)) {
      throw new DownloadError(
        "Network",
        "Hugging Face main did not resolve to an immutable commit",
        true,
        false,
      )
    }
  } else {
    try {
      requireRequestedRevision(revision, commit)
    } catch (message) {
      throw DownloadError.sourceUnavailable(String(message), false, false)
    }
  }

  for (const component of components) {
    let metadata: ResolvedRemoteMetadata
    try {
      metadata = resolveRemoteMetadata(api, commit, component.path)
    } catch (error) {
      if (
        equivalentToRevision !== undefined &&
        error instanceof DownloadError &&
        missingUpstreamContent(error)
      ) {
        throw packageUnavailable(
          repository,
          equivalentToRevision,
          commit,
          component.path,
          "required file is absent from current main",
        )
      }
      throw error
    }
    if (metadata.size === 0) {
      throw DownloadError.sourceUnavailable(
        `Hugging Face did not report a non-zero size for ${component.path}`,
        false,
        false,
      )
    }
    if (equivalentToRevision !== undefined) {
      const mismatch = validateEquivalentFile(
        repository,
        equivalentToRevision,
        commit,
        component,
        metadata,
      )
      if (mismatch !== undefined) {
        throw mismatch
      }
    }
  }
  return commit
}

const packageUnavailable = (
  repository: string,
  pinned: string,
  observed: string | undefined,
  path: string | undefined,
  reason: string,
): DownloadError => {
  const location = path ?? "unknown"
  return DownloadError.sourceUnavailable(
    path === undefined
      ? `the publisher no longer provides the catalog package: ${reason}`
      : `the publisher no longer provides the catalog package at ${location}: ${reason}`,
    true,
    false,
  )
}
