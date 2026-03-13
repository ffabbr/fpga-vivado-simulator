"use client"

import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  direction,
  ...props
}: Omit<ResizablePrimitive.GroupProps, 'orientation'> & { direction?: "horizontal" | "vertical" }) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      orientation={direction}
      className={cn(
        "flex h-full w-full",
        direction === "vertical" ? "flex-col" : "flex-row",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  direction = "horizontal",
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
  /** Direction of the parent group. "horizontal" group → vertical divider, "vertical" group → horizontal divider */
  direction?: "horizontal" | "vertical"
}) {
  const isVerticalDivider = direction === "horizontal";

  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex shrink-0 items-center justify-center",
        "bg-border",
        isVerticalDivider
          ? "w-px h-full cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-4 after:-translate-x-1/2 after:content-['']"
          : "h-px w-full cursor-row-resize after:absolute after:inset-x-0 after:top-1/2 after:h-4 after:-translate-y-1/2 after:content-['']",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className={cn(
          "z-20 shrink-0 rounded-full bg-muted-foreground/30",
          isVerticalDivider ? "h-8 w-1" : "h-1 w-8",
        )} />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
