'use client';

import { useState, useCallback } from 'react';
import {
  FileText, FilePlus2, Trash2, Pencil, Copy,
  FileCode2, TestTube2, Settings2, MoreHorizontal, Cpu,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { ProjectFile, createFile } from '@/lib/store';

interface FileExplorerProps {
  files: ProjectFile[];
  activeFileId: string | null;
  topModule: string | null;
  onOpenFile: (id: string) => void;
  onAddFile: (file: ProjectFile) => void;
  onDeleteFile: (id: string) => void;
  onRenameFile: (id: string, name: string) => void;
  onSetTopModule: (name: string) => void;
}

const FILE_ICONS: Record<string, React.ReactNode> = {
  verilog: <FileCode2 className="h-4 w-4 text-blue-500" />,
  testbench: <TestTube2 className="h-4 w-4 text-green-500" />,
  constraints: <Settings2 className="h-4 w-4 text-yellow-500" />,
  memory: <Cpu className="h-4 w-4 text-purple-500" />,
  other: <FileText className="h-4 w-4 text-muted-foreground" />,
};

function detectFileType(name: string): ProjectFile['type'] {
  if (name.endsWith('.xdc')) return 'constraints';
  if (name.match(/_tb\.v$|_tb\.sv$|_test\.v$/)) return 'testbench';
  if (name.endsWith('.v') || name.endsWith('.sv') || name.endsWith('.vh')) return 'verilog';
  if (name.endsWith('.mem') || name.endsWith('.hex')) return 'memory';
  return 'other';
}

export default function FileExplorer({
  files, activeFileId, topModule, onOpenFile, onAddFile, onDeleteFile, onRenameFile, onSetTopModule,
}: FileExplorerProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ProjectFile | null>(null);

  const handleCreate = useCallback(() => {
    if (!newFileName.trim()) {
      setIsCreating(false);
      return;
    }
    const type = detectFileType(newFileName);
    let template = '';
    if (type === 'verilog') {
      const modName = newFileName.replace(/\.(v|sv|vh)$/, '');
      template = `module ${modName}(\n    \n);\n\n    \n\nendmodule\n`;
    } else if (type === 'testbench') {
      const modName = newFileName.replace(/\.(v|sv)$/, '');
      template = `\`timescale 1ns / 1ps\n\nmodule ${modName};\n\n    initial begin\n        \n        $finish;\n    end\n\nendmodule\n`;
    } else if (type === 'constraints') {
      template = `## Constraints file\n## Target: Basys 3 (xc7a35tcpg236-1)\n\n`;
    }

    const file = createFile(newFileName, template, type);
    onAddFile(file);
    setNewFileName('');
    setIsCreating(false);
  }, [newFileName, onAddFile]);

  const handleRename = useCallback((id: string) => {
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    onRenameFile(id, renameValue);
    setRenamingId(null);
  }, [renameValue, onRenameFile]);

  const handleDuplicate = useCallback((file: ProjectFile) => {
    const ext = file.name.lastIndexOf('.');
    const base = ext > 0 ? file.name.slice(0, ext) : file.name;
    const extension = ext > 0 ? file.name.slice(ext) : '';
    const newName = `${base}_copy${extension}`;
    const newFile = createFile(newName, file.content, file.type);
    onAddFile(newFile);
  }, [onAddFile]);

  // Group files by type
  const grouped = {
    verilog: files.filter(f => f.type === 'verilog'),
    testbench: files.filter(f => f.type === 'testbench'),
    constraints: files.filter(f => f.type === 'constraints'),
    other: files.filter(f => f.type === 'memory' || f.type === 'other'),
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sources</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                <FilePlus2 className="h-3.5 w-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem onClick={() => { setNewFileName('new_module.v'); setIsCreating(true); }}>
              <FileCode2 className="h-4 w-4 mr-2 text-blue-500" /> Design Source (.v)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setNewFileName('new_tb.v'); setIsCreating(true); }}>
              <TestTube2 className="h-4 w-4 mr-2 text-green-500" /> Testbench (.v)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setNewFileName('constraints.xdc'); setIsCreating(true); }}>
              <Settings2 className="h-4 w-4 mr-2 text-yellow-500" /> Constraints (.xdc)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { setNewFileName(''); setIsCreating(true); }}>
              <FileText className="h-4 w-4 mr-2" /> Other File
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* New file input */}
      {isCreating && (
        <div className="px-3 py-2 border-b border-border">
          <Input
            value={newFileName}
            onChange={e => setNewFileName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') setIsCreating(false);
            }}
            onBlur={handleCreate}
            placeholder="filename.v"
            className="h-7 text-xs"
            autoFocus
          />
        </div>
      )}

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {Object.entries(grouped).map(([group, groupFiles]) => {
          if (groupFiles.length === 0) return null;
          const groupLabels: Record<string, string> = {
            verilog: 'Design Sources',
            testbench: 'Simulation Sources',
            constraints: 'Constraints',
            other: 'Other',
          };
          return (
            <div key={group} className="mb-1">
              <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                {groupLabels[group]}
              </div>
              <div className="px-2 space-y-0.5">
                {groupFiles.map(file => (
                  <ContextMenu key={file.id}>
                    <ContextMenuTrigger>
                      <button
                        className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded-md border transition-colors ${
                          activeFileId === file.id
                            ? 'bg-accent text-accent-foreground border-border'
                            : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50'
                        }`}
                        onClick={() => onOpenFile(file.id)}
                        onDoubleClick={() => {
                          setRenamingId(file.id);
                          setRenameValue(file.name);
                        }}
                      >
                        {FILE_ICONS[file.type]}
                        {renamingId === file.id ? (
                          <Input
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleRename(file.id);
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                            onBlur={() => handleRename(file.id)}
                            className="h-5 text-xs py-0 px-1"
                            autoFocus
                            onClick={e => e.stopPropagation()}
                          />
                        ) : (
                          <span className="truncate flex-1 text-xs">{file.name}</span>
                        )}
                        {topModule && file.type === 'verilog' && file.content.includes(`module ${topModule}`) && (
                          <Badge variant="outline" className="h-4 text-[9px] px-1 border-blue-500/50 text-blue-500">
                            TOP
                          </Badge>
                        )}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => onOpenFile(file.id)}>
                        Open
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => {
                        setRenamingId(file.id);
                        setRenameValue(file.name);
                      }}>
                        <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleDuplicate(file)}>
                        <Copy className="h-3.5 w-3.5 mr-2" /> Duplicate
                      </ContextMenuItem>
                      {file.type === 'verilog' && (
                        <ContextMenuItem onClick={() => {
                          const match = file.content.match(/module\s+(\w+)/);
                          if (match) onSetTopModule(match[1]);
                        }}>
                          <Cpu className="h-3.5 w-3.5 mr-2" /> Set as Top Module
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className="text-destructive"
                        onClick={() => setDeleteTarget(file)}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom info */}
      <div className="px-3 py-2 border-t border-border text-[10px] text-muted-foreground">
        {files.length} source{files.length !== 1 ? 's' : ''} · Basys 3
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete file</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  onDeleteFile(deleteTarget.id);
                  setDeleteTarget(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
