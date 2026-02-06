import * as React from "react"

import { cn } from "@/lib/utils"

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-7 min-w-0 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 font-mono text-[11px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent-blue)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer",
        className
      )}
      {...props}
    />
  )
}

export { Select }
