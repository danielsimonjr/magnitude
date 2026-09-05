import { describe, expect, it } from "vitest"
import { Option } from "effect"
import {
  hubModelToSnapshot,
  hubSearchModelToContract,
  resolveHuggingFaceRepository,
  searchHuggingFaceModels,
  selectRepositorySnapshotComponents,
  validateSnapshotRevision,
  validHubRevision,
  validRepository,
} from "./preview"

describe("preview", () => {
  it("hub_search_results_require_immutable_commits", () => {
    const valid = hubSearchModelToContract({
      id: "owner/model-gguf",
      sha: "a".repeat(40),
      lastModified: "2026-07-20T00:00:00Z",
      downloads: 42,
      likes: 7,
      gated: false,
      private: false,
      tags: ["gguf"],
    })
    expect(valid?.repository).toBe("owner/model-gguf")
    expect(valid?.commit).toBe("a".repeat(40))
    expect(
      hubSearchModelToContract({
        id: "owner/model",
        sha: "main",
      }),
    ).toBeUndefined()
  })

  it("hub_coordinates_reject_path_traversal_but_allow_branch_names", () => {
    expect(validRepository("owner/model.gguf")).toBe(true)
    expect(validRepository("../model")).toBe(false)
    expect(validHubRevision("refs/pr/123")).toBe(true)
    expect(validHubRevision("../main")).toBe(false)
  })

  it("hub_snapshot_pins_symbolic_revisions_and_preserves_immutable_requests", () => {
    const commit = "a".repeat(40)
    expect(() => validateSnapshotRevision("main", commit)).not.toThrow()
    expect(() => validateSnapshotRevision(commit, commit)).not.toThrow()
    expect(() => validateSnapshotRevision("b".repeat(40), commit)).toThrow()
  })

  it("repository_snapshot_supplies_exact_preview_components_without_metadata_refetch", () => {
    const source = {
      repository: "owner/model-gguf",
      revision: "a".repeat(40),
      primary_gguf: "model-00001-of-00002.gguf",
      additional_components: [],
    }
    const files = [
      {
        path: "model-00001-of-00002.gguf",
        size_bytes: 10,
        content: { type: "sha256" as const, value: "b".repeat(64) },
      },
      {
        path: "model-00002-of-00002.gguf",
        size_bytes: 20,
        content: { type: "sha256" as const, value: "c".repeat(64) },
      },
    ]
    const selected = selectRepositorySnapshotComponents(files, source)
    expect(selected).toHaveLength(2)
    expect(selected[0]?.role).toBe("weights")
    expect(selected[0]?.shard_index).toBe(1)
    expect(selected[1]?.shard_index).toBe(2)
  })

  it("search_and_resolve_use_injectable_fetch", async () => {
    const commit = "a".repeat(40)
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes("/api/models?")) {
        return new Response(
          JSON.stringify([
            {
              id: "owner/model-gguf",
              sha: commit,
              downloads: 9,
              likes: 1,
              gated: false,
              private: false,
              tags: ["gguf"],
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/api/models/owner/model-gguf/revision/")) {
        return new Response(
          JSON.stringify({
            id: "owner/model-gguf",
            sha: commit,
            siblings: [
              {
                rfilename: "model.gguf",
                size: 42,
                lfs: { sha256: "b".repeat(64), size: 42 },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404 })
    }

    const search = await searchHuggingFaceModels({ query: "model", limit: 5 }, { fetch: fetchMock })
    expect(search.models).toHaveLength(1)
    expect(search.models[0]?.repository).toBe("owner/model-gguf")
    expect(Option.getOrNull(search.models[0]!.downloads)).toBe(9n)

    const resolved = await resolveHuggingFaceRepository(
      { repository: "owner/model-gguf", revision: "main" },
      { fetch: fetchMock },
    )
    expect(resolved.commit).toBe(commit)
    expect(resolved.gguf_files).toHaveLength(1)
  })
})

describe("preview hub snapshot parsing", () => {
  it("hub_snapshot_keeps_only_identified_gguf_files_and_live_metadata", () => {
    const snapshot = hubModelToSnapshot(
      {
        id: "owner/model-gguf",
        sha: "b".repeat(40),
        tags: ["gguf", "license:apache-2.0"],
        siblings: [
          {
            rfilename: "model-Q4_K_M.gguf",
            size: 123,
            lfs: { sha256: "d".repeat(64), size: 123 },
          },
          { rfilename: "README.md", size: 5 },
        ],
      },
      "owner/model-gguf",
      "b".repeat(40),
    )
    expect(snapshot.gguf_files).toHaveLength(1)
    expect(snapshot.gguf_files[0]?.size_bytes).toBe(123n)
  })
})
