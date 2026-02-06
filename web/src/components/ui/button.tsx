import * as React from "react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const variantStyles: Record<string, React.CSSProperties> = {
  default: { background: 'var(--bg-elevated)', color: 'var(--text-secondary)' },
  primary: { background: 'var(--accent-green)', color: 'white' },
  green: { background: 'var(--accent-green)', color: 'white' },
  blue: { background: 'var(--accent-blue)', color: 'white' },
  purple: { background: 'var(--accent-purple)', color: 'white' },
  orange: { background: 'var(--accent-orange)', color: 'black' },
  red: { background: 'var(--accent-red)', color: 'white' },
  cyan: { background: 'var(--accent-cyan)', color: 'black' },
  outline: { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' },
  ghost: { background: 'transparent', color: 'var(--text-secondary)' },
}

const sizeStyles: Record<string, React.CSSProperties> = {
  default: { padding: '3px 10px', fontSize: '11px' },
  sm: { padding: '3px 10px', fontSize: '10px' },
  xs: { padding: '2px 8px', fontSize: '10px' },
  lg: { padding: '6px 16px', fontSize: '13px' },
}

type ButtonVariant = keyof typeof variantStyles
type ButtonSize = keyof typeof sizeStyles

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  style,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant
  size?: ButtonSize
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "button"

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    whiteSpace: 'nowrap',
    borderRadius: '4px',
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    cursor: 'pointer',
    border: 'none',
    transition: 'filter 0.15s',
    ...variantStyles[variant] || variantStyles.default,
    ...sizeStyles[size] || sizeStyles.default,
    ...style,
  }

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn("hover:brightness-110 disabled:opacity-50 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3 shrink-0", className)}
      style={baseStyle}
      {...props}
    />
  )
}

export { Button }
export type { ButtonVariant, ButtonSize }
