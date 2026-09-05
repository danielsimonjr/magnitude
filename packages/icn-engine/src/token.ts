/** Native llama token identifier. */
export class LlamaToken {
  constructor(readonly id: number) {}

  static new(id: number): LlamaToken {
    return new LlamaToken(id)
  }

  equals(other: LlamaToken): boolean {
    return this.id === other.id
  }
}
