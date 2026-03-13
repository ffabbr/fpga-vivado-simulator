'use client';

import { X, FileCode2, TestTube2, Settings2, FileText, Cpu } from 'lucide-react';
import { ProjectFile } from '@/lib/store';

interface EditorTabsProps {
  files: ProjectFile[];
  openFileIds: string[];
  activeFileId: string | null;
  onSelectFile: (id: string) => void;
  onCloseFile: (id: string) => void;
}

const TAB_ICONS: Record<string, React.ReactNode> = {
  verilog: <FileCode2 className="h-3 w-3 text-blue-500" />,
  testbench: <TestTube2 className="h-3 w-3 text-green-500" />,
  constraints: <Settings2 className="h-3 w-3 text-yellow-500" />,
  memory: <Cpu className="h-3 w-3 text-purple-500" />,
  other: <FileText className="h-3 w-3 text-muted-foreground" />,
};

export default function EditorTabs({
  files, openFileIds, activeFileId, onSelectFile, onCloseFile,
}: EditorTabsProps) {
  const openFiles = openFileIds.map(id => files.find(f => f.id === id)).filter(Boolean) as ProjectFile[];

  if (openFiles.length === 0) {
    return (
      <div className="h-9 border-b border-border bg-muted/50 flex items-center px-3 text-xs text-muted-foreground">
        No files open
      </div>
    );
  }

  return (
    <div className="flex items-center h-9 border-b border-border bg-muted/50 overflow-x-auto scrollbar-none">
      {openFiles.map(file => (
        <button
          key={file.id}
          className={`group flex items-center gap-1.5 h-full px-3 text-xs border-r border-border shrink-0 transition-colors ${
            activeFileId === file.id
              ? 'bg-background text-foreground border-b-2 border-b-blue-500'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
          }`}
          onClick={() => onSelectFile(file.id)}
        >
          {TAB_ICONS[file.type]}
          <span className="max-w-[120px] truncate">{file.name}</span>
          <span
            className="ml-1 hover:bg-accent rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              onCloseFile(file.id);
            }}
            role="button"
          >
            <X className="h-3 w-3" />
          </span>
        </button>
      ))}
    </div>
  );
}
