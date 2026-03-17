'use client';

import type { DiffLine } from '@/lib/verilog-codegen';
import { ScrollArea } from '@/components/ui/scroll-area';

interface CodeReviewPanelProps {
  diff: DiffLine[] | null;
}

export default function CodeReviewPanel({ diff }: CodeReviewPanelProps) {
  if (!diff || diff.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <p className="text-xs">No pending changes. Edit connections in the schematic to generate code changes.</p>
      </div>
    );
  }

  // Only show changed lines (added/removed), with 1 line of context around each group
  const changedLines = getChangedLinesWithContext(diff, 1);

  return (
    <ScrollArea className="h-full">
      <div className="font-mono text-xs leading-5 py-1">
        {changedLines.map((d, i) => (
          d.type === 'separator' ? (
            <div key={i} className="text-muted-foreground/30 text-center text-[10px] py-0.5 select-none">···</div>
          ) : (
            <div
              key={i}
              className={`px-3 ${
                d.type === 'added'
                  ? 'bg-green-500/10 text-green-700 dark:text-green-300'
                  : d.type === 'removed'
                    ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                    : 'text-foreground/50'
              }`}
            >
              <span className="inline-block w-4 text-right text-muted-foreground/40 mr-2 select-none">
                {d.type === 'added' ? '+' : d.type === 'removed' ? '−' : ' '}
              </span>
              {d.line || ' '}
            </div>
          )
        ))}
      </div>
    </ScrollArea>
  );
}

type DisplayLine = DiffLine | { type: 'separator'; line: '' };

function getChangedLinesWithContext(diff: DiffLine[], context: number): DisplayLine[] {
  // Mark which lines to include (changed lines + N context lines around them)
  const include = new Array(diff.length).fill(false);
  for (let i = 0; i < diff.length; i++) {
    if (diff[i].type !== 'unchanged') {
      for (let j = Math.max(0, i - context); j <= Math.min(diff.length - 1, i + context); j++) {
        include[j] = true;
      }
    }
  }

  const result: DisplayLine[] = [];
  let lastIncluded = -1;
  for (let i = 0; i < diff.length; i++) {
    if (!include[i]) continue;
    if (lastIncluded >= 0 && i - lastIncluded > 1) {
      result.push({ type: 'separator', line: '' });
    }
    result.push(diff[i]);
    lastIncluded = i;
  }
  return result;
}
