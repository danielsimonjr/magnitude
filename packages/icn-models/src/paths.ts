import { join } from "node:path"

export const hfRepoDir = (repository: string): string =>
  `models--${repository.replaceAll("/", "--")}`

export const repositoryLockPath = (root: string, repository: string): string =>
  join(root, "locks", `repo--${repository.replaceAll("/", "--")}.lock`)
