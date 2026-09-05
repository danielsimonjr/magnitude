export const authorizeBearer = (
  expectedToken: string | undefined,
  authorizationHeader: string | null,
): boolean => {
  if (expectedToken === undefined) return true
  const expected = `Bearer ${expectedToken}`
  const supplied = authorizationHeader ?? ""
  if (supplied.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index)
  }
  return difference === 0
}

export const unauthorizedResponse = (): Response =>
  new Response(null, { status: 401 })
