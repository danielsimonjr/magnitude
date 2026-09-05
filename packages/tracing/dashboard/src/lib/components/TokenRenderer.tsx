import type { MouseEvent } from 'react'
import { logprobToBgColor } from '../logprobColors'
import './components.css'

export interface TokenWithLogprob {
  readonly token: string
  readonly logprob: number
  readonly topLogprobs: readonly { readonly token: string; readonly logprob: number }[]
}

interface Props {
  tokens: readonly TokenWithLogprob[]
  onHover?: (token: TokenWithLogprob, index: number, event: MouseEvent<HTMLSpanElement>) => void
  onLeave?: () => void
}

export function TokenRenderer({ tokens, onHover, onLeave }: Props) {
  return (
    <span className="token-renderer">
      {tokens.map((token, i) => (
        <span
          key={i}
          className="token"
          style={{ background: logprobToBgColor(token.logprob), color: '#000' }}
          onMouseEnter={(e) => onHover?.(token, i, e)}
          onMouseLeave={() => onLeave?.()}
          role="button"
          tabIndex={0}
        >{token.token}</span>
      ))}
    </span>
  )
}
