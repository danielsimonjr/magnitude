/**
 * SHA-256 digests of the ripgrep prebuilt release assets this package downloads.
 *
 * Every asset is pinned so a compromised or substituted release artifact is rejected
 * before extraction. When bumping RIPGREP_VERSION / MULTI_ARCH_LINUX_VERSION in
 * `platform.ts`, regenerate these values from the official release assets, e.g.
 *
 *   curl -sSL https://github.com/microsoft/ripgrep-prebuilt/releases/download/<tag>/<asset> | sha256sum
 */
export const ASSET_SHA256: Readonly<Record<string, string>> = {
  'ripgrep-v15.0.0-aarch64-apple-darwin.tar.gz':
    '16ded8d87db15333e8c06188ea2635dcde7f9869412f843e463a290f9d7493f3',
  'ripgrep-v15.0.0-x86_64-apple-darwin.tar.gz':
    '9787387f2d01ee3382e5984c39beb457f445585d81f928a5b1a089706ffb6c8f',
  'ripgrep-v15.0.0-x86_64-pc-windows-msvc.zip':
    '5b7f6a3020739ac4bdf2c32300f14388456361bea054d35270a18a3c9949b932',
  'ripgrep-v15.0.0-aarch64-pc-windows-msvc.zip':
    '77757a3a8fc99705062e2594d4bbf48aafaee0faca65816455edb0d671bd534e',
  'ripgrep-v15.0.0-i686-pc-windows-msvc.zip':
    '4f98e8fcdfc2206b831cb8032f8a1befbb99119a57033c08f244874d52345416',
  'ripgrep-v15.0.0-x86_64-unknown-linux-musl.tar.gz':
    '9dd9306a2c44cdda31e2f4f3cf36f4d7148260d9371683e965d3c8992c205349',
  'ripgrep-v15.0.0-aarch64-unknown-linux-musl.tar.gz':
    '47c6ea56f4d18bc26778eaca9b9c3f6e201b7c7d78d5ebc528dfda47e0e8f1ba',
  'ripgrep-v15.0.0-i686-unknown-linux-musl.tar.gz':
    '67a3b5933e2e470dd4090342f934a7c2ff37c46b170465760ba89c1aea29399f',
  'ripgrep-v15.0.0-riscv64gc-unknown-linux-gnu.tar.gz':
    '49d7a681e4d22ffc523185682719332763ae182256e7360b9f621dc3268e7d08',
  'ripgrep-v13.0.0-4-arm-unknown-linux-gnueabihf.tar.gz':
    '14934deb7be2682325afa78b3ed1ffc3ce52ad8f490e437bba7871e5a09bc33c',
  'ripgrep-v13.0.0-4-powerpc64le-unknown-linux-gnu.tar.gz':
    '3ddd7c0797c14cefd3ee61f13f15ac219bfecee8e6f6e27fd15c102ef229653a',
  'ripgrep-v13.0.0-4-s390x-unknown-linux-gnu.tar.gz':
    '61fa877688b721897cee33d572b64d8217ef16fe2cecf5f6f899f5ce55870e28',
}

export function expectedSha256(assetName: string): string {
  const digest = ASSET_SHA256[assetName]
  if (!digest) {
    throw new Error(`[ripgrep] No pinned SHA-256 digest for ${assetName}; refusing to download unverified binary`)
  }
  return digest
}

export function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bytes)
  return hasher.digest('hex')
}
