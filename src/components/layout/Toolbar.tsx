'use client';

import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  Play, Square, Download, Upload, Cpu,
  FileCode2, Zap, LayoutGrid, Waves,
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
  topModule: string | null;
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
}

export default function Toolbar({
  projectName, topModule, isSimulating, isSynthesizing, activeView,
  onRunSimulation, onStopSimulation, onSynthesize,
  onSetView, onExportProject, onImportProject, onNewProject,
}: ToolbarProps) {
  return (
    <TooltipProvider>
      <div className="flex items-center h-11 px-2 border-b border-border bg-background gap-1">
        {/* App name */}
        <span className="text-sm font-bold text-foreground tracking-tight mr-2">FPGA Studio</span>

        {/* Menubar: File + Flow */}
        <Menubar className="h-7 border-none p-0 gap-0">
          <MenubarMenu>
            <MenubarTrigger className="text-xs h-7 px-2">File</MenubarTrigger>
            <MenubarContent className="min-w-48">
              <MenubarItem onClick={onNewProject}>New Project</MenubarItem>
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
            <MenubarTrigger className="text-xs h-7 px-2">Flow</MenubarTrigger>
            <MenubarContent className="min-w-48">
              <MenubarItem onClick={onSynthesize}>
                <Zap className="h-4 w-4 mr-2" /> Run Synthesis
              </MenubarItem>
              <MenubarItem onClick={onRunSimulation}>
                <Play className="h-4 w-4 mr-2" /> Run Simulation
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={() => onSetView('board')}>
                <LayoutGrid className="h-4 w-4 mr-2" /> Open Board View
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>

        <div className="w-px h-5 bg-border mx-1" />

        {/* Action buttons */}
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
                <Play className="h-3.5 w-3.5 text-green-500" /> Simulate
              </>
            )}
          </TooltipTrigger>
          <TooltipContent>
            {isSimulating ? 'Stop simulation' : 'Run behavioral simulation'}
          </TooltipContent>
        </Tooltip>

        <div className="w-px h-5 bg-border mx-1" />

        {/* View toggle group */}
        <ToggleGroup
          value={[activeView]}
          onValueChange={(newValue) => {
            if (newValue.length > 0) onSetView(newValue[newValue.length - 1] as 'editor' | 'board' | 'waveform');
          }}
          size="sm"
        >
          <Tooltip>
            <TooltipTrigger render={<ToggleGroupItem value="editor" className="h-6 w-6 p-0" />}>
              <FileCode2 className="h-3.5 w-3.5" />
            </TooltipTrigger>
            <TooltipContent>Editor</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<ToggleGroupItem value="waveform" className="h-6 w-6 p-0" />}>
              <Waves className="h-3.5 w-3.5" />
            </TooltipTrigger>
            <TooltipContent>Waveform Viewer</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<ToggleGroupItem value="board" className="h-6 w-6 p-0" />}>
              <Cpu className="h-3.5 w-3.5" />
            </TooltipTrigger>
            <TooltipContent>FPGA Board</TooltipContent>
          </Tooltip>
        </ToggleGroup>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status + Theme Toggle */}
        <div className="flex items-center gap-2">
          {(isSynthesizing || isSimulating) ? (
            <Badge variant="secondary" className="h-5 text-[10px]">
              {isSynthesizing ? 'Synthesizing' : 'Simulating'}
              <Spinner data-icon="inline-end" className="h-3 w-3" />
            </Badge>
          ) : topModule ? (
            <Badge variant="outline" className="h-5 text-[10px] border-blue-500/30 text-blue-500">
              <Cpu className="h-3 w-3 mr-1" /> {topModule}
            </Badge>
          ) : null}
          <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">
            Basys 3 · XC7A35T
          </Badge>
          <ThemeToggle />
        </div>
      </div>
    </TooltipProvider>
  );
}
