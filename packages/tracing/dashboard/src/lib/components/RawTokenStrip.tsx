import { useState } from 'react'
import type { RawInputToken } from '../types'
import './components.css'

interface Props {
  tokens: readonly RawInputToken[]
}

function visibleText(text: string): string {
  if (text === '\n') return '⏎'
  if (text === '\r\n') return '⏎'
  if (text === ' ') return '·'
  if (text === '\t') return '⇥'
  if (/^\s+$/.test(text) && text.length > 1) return '␣'
  return text
}

function isWhitespace(text: string): boolean {
  return /^\s+$/.test(text)
}

export function RawTokenStrip({ tokens }: Props) {
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [tooltipX, setTooltipX] = useState(0)
  const [tooltipY, setTooltipY] = useState(0)

  return (
    <>
      <span className="token-strip">
        {tokens.map((token, i) => (
          <span
            key={i}
            className={`token${isWhitespace(token.text) ? ' whitespace' : ''}${i % 2 === 1 ? ' odd' : ''}`}
            onMouseEnter={(e) => {
              setHoveredId(token.id)
              setTooltipX(e.clientX + 12)
              setTooltipY(e.clientY + 12)
            }}
            onMouseLeave={() => setHoveredId(null)}
            role="button"
            tabIndex={0}
          >{visibleText(token.text)}</span>
        ))}
      </span>

      {hoveredId !== null && (
        <div className="raw-token-tooltip" style={{ left: `${tooltipX}px`, top: `${tooltipY}px` }}>
          <span className="id">ID: {hoveredId}</span>
        </div>
      )}
    </>
  )
}
