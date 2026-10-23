/** Product mark: five petals around a centre, drawn for DBLoom (a database that blooms). */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="text-accent">
      <g fill="currentColor">
        {[0, 72, 144, 216, 288].map((angle) => (
          <ellipse
            key={angle}
            cx="12"
            cy="6.2"
            rx="3"
            ry="4.6"
            transform={`rotate(${angle} 12 12)`}
          />
        ))}
      </g>
      <circle cx="12" cy="12" r="2.6" fill="var(--surface)" />
    </svg>
  )
}

export function BrandName() {
  return (
    <span className="inline-flex items-center gap-2 text-[15px] font-semibold text-ink">
      <BrandMark />
      DBLoom
    </span>
  )
}
