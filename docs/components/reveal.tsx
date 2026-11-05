'use client'

import { useEffect, useRef, type ElementType, type ReactNode } from 'react'

/** Fades and lifts its content once as it enters the screen. Visible without script. */
export function Reveal({
  as: Tag = 'div',
  className = '',
  children,
  id,
}: {
  as?: ElementType
  className?: string
  children: ReactNode
  id?: string
}) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.classList.add('pre')
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.remove('pre')
            io.disconnect()
          }
        }
      },
      { threshold: 0.15 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <Tag ref={ref} id={id} className={`reveal ${className}`}>
      {children}
    </Tag>
  )
}
