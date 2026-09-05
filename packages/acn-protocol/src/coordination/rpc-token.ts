import { randomBytes, timingSafeEqual } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs"
import { join } from "node:path"

/**
 * Shared secret that authenticates every ACN RPC and administrative request.
 *
 * The ACN listens on loopback, but loopback alone is not an authentication
 * boundary: any web page in the user's browser, or any other local user, can
 * reach the port. The daemon therefore requires a bearer token that lives only
 * in the owner-only Magnitude data directory. Same-user clients (CLI, desktop
 * main process, web dev server) read it from disk and pass it to the renderer
 * alongside the instance URL; nothing else can obtain it.
 */
export const ACN_RPC_TOKEN_FILE = "rpc-token"
const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

export const acnRpcTokenPath = (dataDirectory: string): string =>
  join(dataDirectory, "acn", ACN_RPC_TOKEN_FILE)

const readExistingToken = (path: string): string | undefined => {
  try {
    const token = readFileSync(path, "utf8").trim()
    return TOKEN_PATTERN.test(token) ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * Loads the data directory's RPC token, minting one atomically when absent.
 * Concurrent candidates race on an exclusive create; the loser reads the
 * winner's token so every process in the data directory agrees.
 */
export const loadOrCreateAcnRpcToken = (dataDirectory: string): string => {
  const path = acnRpcTokenPath(dataDirectory)
  const existing = readExistingToken(path)
  if (existing !== undefined) return existing

  mkdirSync(join(dataDirectory, "acn"), { recursive: true, mode: 0o700 })
  const minted = randomBytes(TOKEN_BYTES).toString("hex")
  try {
    const fd = openSync(path, "wx", 0o600)
    try {
      writeSync(fd, `${minted}\n`)
    } finally {
      closeSync(fd)
    }
    return minted
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const raced = readExistingToken(path)
    if (raced === undefined) {
      throw new Error(`ACN RPC token at ${path} exists but is unreadable or malformed`)
    }
    return raced
  }
}

export const acnRpcAuthorizationHeader = (token: string): { readonly authorization: string } => ({
  authorization: `Bearer ${token}`,
})

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export const acnRpcAuthorizationMatches = (
  header: string | undefined,
  token: string,
): boolean => {
  if (header === undefined) return false
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : ""
  const expected = Buffer.from(token, "utf8")
  const actual = Buffer.from(presented, "utf8")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
