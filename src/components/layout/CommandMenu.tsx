'use client';

import { useEffect } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from '@/components/ui/command';
import {
  FileCode2, TestTube2, Settings2, FileText,
  Zap, Play, Square, Sun, Moon,
  Download, Upload, FilePlus2, Cpu,
  FileCode, Waves, LayoutGrid, Trash2, BookOpen, FolderPlus, Highlighter,
} from 'lucide-react';
import type { ProjectFile } from '@/lib/store';

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: ProjectFile[];
  activeView: 'editor' | 'board' | 'waveform';
  isSimulating: boolean;
  isSynthesizing: boolean;
  onOpenFile: (id: string) => void;
  onSetView: (view: 'editor' | 'board' | 'waveform') => void;
  onSynthesize: () => void;
  onRunSimulation: () => void;
  onStopSimulation: () => void;
  onNewFile: () => void;
  onNewProject: () => void;
  onLoadExample: () => void;
  onExportProject: () => void;
  onImportProject: () => void;
  onClearConsole: () => void;
}

const FILE_ICONS: Record<string, React.ReactNode> = {
  verilog: <FileCode2 className="h-4 w-4 text-blue-500" />,
  testbench: <TestTube2 className="h-4 w-4 text-green-500" />,
  constraints: <Settings2 className="h-4 w-4 text-yellow-500" />,
  memory: <Cpu className="h-4 w-4 text-purple-500" />,
  other: <FileText className="h-4 w-4 text-muted-foreground" />,
};

export default function CommandMenu({
  open,
  onOpenChange,
  files,
  activeView,
  isSimulating,
  isSynthesizing,
  onOpenFile,
  onSetView,
  onSynthesize,
  onRunSimulation,
  onStopSimulation,
  onNewFile,
  onNewProject,
  onLoadExample,
  onExportProject,
  onImportProject,
  onClearConsole,
}: CommandMenuProps) {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [open, onOpenChange]);

  const runAndClose = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };

  const toggleTheme = () => {
    const current = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('fpga-theme', next);
    document.documentElement.classList.toggle('dark', next === 'dark');
  };

  const currentTheme = typeof document !== 'undefined'
    ? (document.documentElement.classList.contains('dark') ? 'dark' : 'light')
    : 'dark';

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Files */}
        <CommandGroup heading="Files">
          {files.map((file) => (
            <CommandItem
              key={file.id}
              onSelect={() => runAndClose(() => onOpenFile(file.id))}
            >
              {FILE_ICONS[file.type]}
              <span>{file.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* Actions */}
        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => runAndClose(onNewFile)}
          >
            <FilePlus2 className="h-4 w-4" />
            <span>New File</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runAndClose(onSynthesize)}
            disabled={isSynthesizing}
          >
            <Zap className="h-4 w-4 text-yellow-500" />
            <span>{isSynthesizing ? 'Synthesizing...' : 'Run Synthesis'}</span>
          </CommandItem>
          {isSimulating ? (
            <CommandItem
              onSelect={() => runAndClose(onStopSimulation)}
            >
              <Square className="h-4 w-4" />
              <span>Stop Simulation</span>
            </CommandItem>
          ) : (
            <CommandItem
              onSelect={() => runAndClose(onRunSimulation)}
            >
              <Play className="h-4 w-4 text-green-500" />
              <span>Run Test</span>
            </CommandItem>
          )}
          <CommandItem
            onSelect={() => runAndClose(onClearConsole)}
          >
            <Trash2 className="h-4 w-4" />
            <span>Clear Console</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runAndClose(() => {
              const editor = window.__fpgaActiveEditor;
              if (!editor) return;
              requestAnimationFrame(() => {
                editor.focus();
                editor.trigger('commandMenu', 'editor.action.selectHighlights', null);
              });
            })}
          >
            <Highlighter className="h-4 w-4" />
            <span>Select All Occurrences</span>
            <CommandShortcut>Shift+Cmd+L</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Views */}
        <CommandGroup heading="View">
          <CommandItem
            onSelect={() => runAndClose(() => onSetView('editor'))}
          >
            <FileCode className="h-4 w-4" />
            <span>Editor</span>
            {activeView === 'editor' && <CommandShortcut>Active</CommandShortcut>}
          </CommandItem>
          <CommandItem
            onSelect={() => runAndClose(() => onSetView('waveform'))}
          >
            <Waves className="h-4 w-4" />
            <span>Waveform Viewer</span>
            {activeView === 'waveform' && <CommandShortcut>Active</CommandShortcut>}
          </CommandItem>
          <CommandItem
            onSelect={() => runAndClose(() => onSetView('board'))}
          >
            <LayoutGrid className="h-4 w-4" />
            <span>Board View</span>
            {activeView === 'board' && <CommandShortcut>Active</CommandShortcut>}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Theme */}
        <CommandGroup heading="Appearance">
          <CommandItem
            onSelect={() => runAndClose(toggleTheme)}
          >
            {currentTheme === 'dark' ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
            <span>{currentTheme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Project */}
        <CommandGroup heading="Project">
          <CommandItem
            onSelect={() => runAndClose(onNewProject)}
          >
            <FolderPlus className="h-4 w-4" />
            <span>New Project</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runAndClose(onLoadExample)}
          >
            <BookOpen className="h-4 w-4" />
            <span>Load Example</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runAndClose(onImportProject)}
          >
            <Upload className="h-4 w-4" />
            <span>Import Project</span>
          </CommandItem>
          <CommandItem
            onSelect={() => runAndClose(onExportProject)}
          >
            <Download className="h-4 w-4" />
            <span>Export Project</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
