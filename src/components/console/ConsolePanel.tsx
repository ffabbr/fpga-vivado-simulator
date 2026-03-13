'use client';

import { useRef, useEffect } from 'react';
import { ConsoleMessage } from '@/lib/store';
import { AlertCircle, Info, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ConsolePanelProps {
  messages: ConsoleMessage[];
}

const ICONS: Record<string, React.ReactNode> = {
  info: <Info className="h-3.5 w-3.5 text-blue-500 shrink-0" />,
  warning: <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />,
  error: <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />,
  success: <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />,
  log: <span className="text-muted-foreground text-xs shrink-0">$</span>,
};

const COLORS: Record<string, string> = {
  info: 'text-blue-600 dark:text-blue-300',
  warning: 'text-yellow-600 dark:text-yellow-300',
  error: 'text-red-600 dark:text-red-300',
  success: 'text-green-600 dark:text-green-300',
  log: 'text-foreground',
};

export default function ConsolePanel({ messages }: ConsolePanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="p-2 font-mono text-xs space-y-0.5">
          {messages.length === 0 && (
            <div className="text-muted-foreground italic py-4 text-center">
              Console output will appear here...
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} className="flex items-start gap-2 py-0.5 hover:bg-accent/50 px-1 rounded">
              {ICONS[msg.type]}
              <span className="text-muted-foreground text-[10px] shrink-0">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
              {msg.source && (
                <span className="text-muted-foreground/70 text-[10px] shrink-0">[{msg.source}]</span>
              )}
              <span className={`${COLORS[msg.type]} break-all`}>{msg.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
