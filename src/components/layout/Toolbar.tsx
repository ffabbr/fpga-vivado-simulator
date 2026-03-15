'use client';

import {
  Play, Square, Download, Upload, Cpu, FilePlus2,
  FileCode2, Zap, LayoutGrid, Waves,
  Undo2, Redo2, Scissors, Copy, ClipboardPaste, Search,
  FolderPlus, BookOpen,
} from 'lucide-react';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Menubar, MenubarMenu, MenubarTrigger, MenubarContent,
  MenubarItem, MenubarSeparator,
} from '@/components/ui/menubar';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Button } from '@/components/ui/button';
import ThemeToggle from './ThemeToggle';

interface ToolbarProps {
  projectName: string;
  isSimulating: boolean;
  isSynthesizing?: boolean;
  activeView: 'editor' | 'board' | 'waveform';
  onRunSimulation: () => void;
  onStopSimulation: () => void;
  onSynthesize: () => void;
  onSetView: (view: 'editor' | 'board' | 'waveform') => void;
  onExportProject: () => void;
  onImportProject: () => void;
  onNewProject: () => void;
  onNewFile: () => void;
  onLoadExample: () => void;
  onOpenCommandMenu: () => void;
}

export default function Toolbar({
  projectName, isSimulating, isSynthesizing, activeView,
  onRunSimulation, onStopSimulation, onSynthesize,
  onSetView, onExportProject, onImportProject, onNewProject, onNewFile, onLoadExample, onOpenCommandMenu,
}: ToolbarProps) {
  const runEditorCommand = (commandId: string) => {
    const editor = window.__fpgaActiveEditor;
    if (!editor) return;
    // Defer until the menu has fully closed so its focus management
    // doesn't steal focus back from the editor after we focus it.
    requestAnimationFrame(() => {
      editor.focus();
      editor.trigger('toolbar', commandId, null);
    });
  };

  const doUndo = () => {
    runEditorCommand('undo');
  };

  const doRedo = () => {
    runEditorCommand('redo');
  };

  const doCut = () => {
    runEditorCommand('editor.action.clipboardCutAction');
  };

  const doCopy = () => {
    runEditorCommand('editor.action.clipboardCopyAction');
  };

  const doPaste = () => {
    runEditorCommand('editor.action.clipboardPasteAction');
  };

  const doSelectAll = () => {
    runEditorCommand('editor.action.selectAll');
  };

  const doFind = () => {
    runEditorCommand('actions.find');
  };

  const doMoveLineUp = () => {
    runEditorCommand('editor.action.moveLinesUpAction');
  };

  const doMoveLineDown = () => {
    runEditorCommand('editor.action.moveLinesDownAction');
  };

  const doAddCursorAbove = () => {
    runEditorCommand('editor.action.insertCursorAbove');
  };

  const doAddCursorBelow = () => {
    runEditorCommand('editor.action.insertCursorBelow');
  };

  const doSelectAllOccurrences = () => {
    runEditorCommand('editor.action.selectHighlights');
  };

  return (
    <TooltipProvider>
      <div className="flex items-center h-11 px-2 border-b border-border bg-background gap-1 relative">
        {/* App name */}
        <span className="text-sm font-bold text-foreground tracking-tight mr-2">FPGA Studio</span>

        {/* Menubar: File + Edit + Flow */}
        <Menubar className="h-7 border-none p-0 gap-0">
          <MenubarMenu>
            <MenubarTrigger className="text-xs h-7 px-2">File</MenubarTrigger>
            <MenubarContent className="min-w-48">
              <MenubarItem onClick={onNewFile}>
                <FilePlus2 className="h-4 w-4 mr-2" /> New File
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={onNewProject}>
                <FolderPlus className="h-4 w-4 mr-2" /> New Project
              </MenubarItem>
              <MenubarItem onClick={onLoadExample}>
                <BookOpen className="h-4 w-4 mr-2" /> Load Example
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={onImportProject}>
                <Upload className="h-4 w-4 mr-2" /> Import Project
              </MenubarItem>
              <MenubarItem onClick={onExportProject}>
                <Download className="h-4 w-4 mr-2" /> Export Project
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger className="text-xs h-7 px-2">Edit</MenubarTrigger>
            <MenubarContent className="min-w-56">
              <MenubarItem onClick={doUndo}>
                <Undo2 className="h-4 w-4 mr-2" /> Undo
                <span className="ml-auto text-[10px] text-muted-foreground">Cmd/Ctrl+Z</span>
              </MenubarItem>
              <MenubarItem onClick={doRedo}>
                <Redo2 className="h-4 w-4 mr-2" /> Redo
                <span className="ml-auto text-[10px] text-muted-foreground">Shift+Cmd/Ctrl+Z</span>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={doCut}>
                <Scissors className="h-4 w-4 mr-2" /> Cut
                <span className="ml-auto text-[10px] text-muted-foreground">Cmd/Ctrl+X</span>
              </MenubarItem>
              <MenubarItem onClick={doCopy}>
                <Copy className="h-4 w-4 mr-2" /> Copy
                <span className="ml-auto text-[10px] text-muted-foreground">Cmd/Ctrl+C</span>
              </MenubarItem>
              <MenubarItem onClick={doPaste}>
                <ClipboardPaste className="h-4 w-4 mr-2" /> Paste
                <span className="ml-auto text-[10px] text-muted-foreground">Cmd/Ctrl+V</span>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={doSelectAll}>
                Select All
                <span className="ml-auto text-[10px] text-muted-foreground">Cmd/Ctrl+A</span>
              </MenubarItem>
              <MenubarItem onClick={doFind}>
                <Search className="h-4 w-4 mr-2" /> Find
                <span className="ml-auto text-[10px] text-muted-foreground">Cmd/Ctrl+F</span>
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger className="text-xs h-7 px-2">Select</MenubarTrigger>
            <MenubarContent className="min-w-64">
              <MenubarItem onClick={doSelectAll}>
                Select All
                <span className="ml-auto text-[10px] text-muted-foreground">Cmd/Ctrl+A</span>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={doMoveLineUp}>
                Move Line Up
                <span className="ml-auto text-[10px] text-muted-foreground">Alt+Up</span>
              </MenubarItem>
              <MenubarItem onClick={doMoveLineDown}>
                Move Line Down
                <span className="ml-auto text-[10px] text-muted-foreground">Alt+Down</span>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={doAddCursorAbove}>
                Add Cursor Above
                <span className="ml-auto text-[10px] text-muted-foreground">Cmd/Ctrl+Alt+Up</span>
              </MenubarItem>
              <MenubarItem onClick={doAddCursorBelow}>
                Add Cursor Below
                <span className="ml-auto text-[10px] text-muted-foreground">Cmd/Ctrl+Alt+Down</span>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={doSelectAllOccurrences}>
                Select All Occurrences
                <span className="ml-auto text-[10px] text-muted-foreground">Shift+Cmd/Ctrl+L</span>
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger className="text-xs h-7 px-2">Flow</MenubarTrigger>
            <MenubarContent className="min-w-48">
              <MenubarItem onClick={onSynthesize}>
                <Zap className="h-4 w-4 mr-2" /> Run Synthesis
              </MenubarItem>
              <MenubarItem onClick={onRunSimulation}>
                <Play className="h-4 w-4 mr-2" /> Run Test
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={() => onSetView('board')}>
                <LayoutGrid className="h-4 w-4 mr-2" /> Open Board View
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger className="text-xs h-7 px-2" onClick={onOpenCommandMenu}>Search</MenubarTrigger>
          </MenubarMenu>
        </Menubar>

        {/* View toggle group - centered */}
        <div className="absolute left-1/2 -translate-x-1/2">
          <ToggleGroup
            value={[activeView]}
            onValueChange={(newValue) => {
              if (newValue.length > 0) onSetView(newValue[newValue.length - 1] as 'editor' | 'board' | 'waveform');
            }}
            size="sm"
            className="border border-border p-0 data-[size=sm]:!rounded-[11px]"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value="editor"
                    className={`h-6 px-2 gap-1.5 text-muted-foreground hover:text-foreground ${
                      activeView === 'editor'
                        ? 'data-[state=on]:!bg-black data-[state=on]:!text-white aria-pressed:!bg-black aria-pressed:!text-white dark:data-[state=on]:!bg-white dark:data-[state=on]:!text-black dark:aria-pressed:!bg-white dark:aria-pressed:!text-black shadow-sm'
                        : ''
                    }`}
                  />
                }
              >
                <FileCode2 className="h-3.5 w-3.5" />
                <span className="text-[11px]">Editor</span>
              </TooltipTrigger>
              <TooltipContent>Editor</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value="waveform"
                    className={`h-6 px-2 gap-1.5 text-muted-foreground hover:text-foreground ${
                      activeView === 'waveform'
                        ? 'data-[state=on]:!bg-black data-[state=on]:!text-white aria-pressed:!bg-black aria-pressed:!text-white dark:data-[state=on]:!bg-white dark:data-[state=on]:!text-black dark:aria-pressed:!bg-white dark:aria-pressed:!text-black shadow-sm'
                        : ''
                    }`}
                  />
                }
              >
                <Waves className="h-3.5 w-3.5" />
                <span className="text-[11px]">Wave</span>
              </TooltipTrigger>
              <TooltipContent>Waveform Viewer</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value="board"
                    className={`h-6 px-2 gap-1.5 text-muted-foreground hover:text-foreground ${
                      activeView === 'board'
                        ? 'data-[state=on]:!bg-black data-[state=on]:!text-white aria-pressed:!bg-black aria-pressed:!text-white dark:data-[state=on]:!bg-white dark:data-[state=on]:!text-black dark:aria-pressed:!bg-white dark:aria-pressed:!text-black shadow-sm'
                        : ''
                    }`}
                  />
                }
              >
                <Cpu className="h-3.5 w-3.5" />
                <span className="text-[11px]">Board</span>
              </TooltipTrigger>
              <TooltipContent>FPGA Board</TooltipContent>
            </Tooltip>
          </ToggleGroup>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Action buttons + Theme Toggle */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={onSynthesize}
                  disabled={isSynthesizing}
                />
              }
            >
              {isSynthesizing ? (
                <>
                  <Zap className="h-3.5 w-3.5 text-yellow-500 animate-pulse" />
                  Synthesizing...
                </>
              ) : (
                <>
                  <Zap className="h-3.5 w-3.5 text-yellow-500" />
                  Synthesize
                </>
              )}
            </TooltipTrigger>
            <TooltipContent>
              {isSynthesizing ? 'Synthesis in progress...' : 'Run Yosys synthesis on top module'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={isSimulating ? 'destructive' : 'ghost'}
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={isSimulating ? onStopSimulation : onRunSimulation}
                />
              }
            >
              {isSimulating ? (
                <>
                  <Square className="h-3.5 w-3.5" /> Stop
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5 text-green-500" /> Test
                </>
              )}
            </TooltipTrigger>
            <TooltipContent>
              {isSimulating ? 'Stop simulation' : 'Run behavioral simulation'}
            </TooltipContent>
          </Tooltip>

          <div className="w-px h-5 bg-border mx-1" />
          <ThemeToggle />
        </div>
      </div>
    </TooltipProvider>
  );
}
