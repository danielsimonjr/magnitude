import { useMemo } from 'react'
import { logprobToColor, logprobToPercent } from '../logprobColors'
import './components.css'

export interface TokenWithLogprob {
  readonly token: string
  readonly logprob: number
  readonly topLogprobs: readonly { readonly token: string; readonly logprob: number }[]
}

interface Props {
  token: TokenWithLogprob
  x: number
  y: number
}

function barWidth(lp: number) {
  return Math.max(2, Math.exp(lp) * 100)
}

export function LogprobTooltip({ token, x, y }: Props) {
  const sorted = useMemo(
    () => [...(token.topLogprobs || [])].sort((a, b) => b.logprob - a.logprob).slice(0, 8),
    [token],
  )

  return (
    <div className="logprob-tooltip" style={{ left: `${x}px`, top: `${y}px` }}>
      <div className="header">
        <span className="token-text">"{token.token}"</span>
        <span className="prob">{logprobToPercent(token.logprob)}</span>
      </div>
      <div className="alternatives">
        {sorted.map((alt, i) => (
          <div key={i} className={`alt-row${alt.token === token.token ? ' current' : ''}`}>
            <span className="alt-token">{JSON.stringify(alt.token)}</span>
            <div className="bar-wrap">
              <div className="bar" style={{ width: `${barWidth(alt.logprob)}%`, background: logprobToColor(alt.logprob) }}></div>
            </div>
            <span className="alt-prob">{logprobToPercent(alt.logprob)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
