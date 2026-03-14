'use client';

import { X, FileCode2, TestTube2, Settings2, FileText, Cpu, Pencil, Copy, Trash2 } from 'lucide-react';
import { ProjectFile } from '@/lib/store';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu';

interface EditorTabsProps {
  files: ProjectFile[];
  openFileIds: string[];
  activeFileId: string | null;
  onSelectFile: (id: string) => void;
  onCloseFile: (id: string) => void;
  onRenameFile?: (id: string) => void;
  onDuplicateFile?: (id: string) => void;
  onDeleteFile?: (id: string) => void;
  onSetTopModule?: (id: string) => void;
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
  onRenameFile, onDuplicateFile, onDeleteFile, onSetTopModule,
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
        <ContextMenu key={file.id}>
          <ContextMenuTrigger
            className={`group flex items-center gap-1.5 h-full px-3 text-xs border-r border-border shrink-0 transition-colors cursor-default ${
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
          </ContextMenuTrigger>
          <ContextMenuContent>
            {onRenameFile && (
              <ContextMenuItem onClick={() => onRenameFile(file.id)}>
                <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
              </ContextMenuItem>
            )}
            {onDuplicateFile && (
              <ContextMenuItem onClick={() => onDuplicateFile(file.id)}>
                <Copy className="h-3.5 w-3.5 mr-2" /> Duplicate
              </ContextMenuItem>
            )}
            {onSetTopModule && file.type === 'verilog' && (
              <ContextMenuItem onClick={() => onSetTopModule(file.id)}>
                <Cpu className="h-3.5 w-3.5 mr-2" /> Set as Top Module
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => onCloseFile(file.id)}>
              <X className="h-3.5 w-3.5 mr-2" /> Close
            </ContextMenuItem>
            {onDeleteFile && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-destructive"
                  onClick={() => onDeleteFile(file.id)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}
