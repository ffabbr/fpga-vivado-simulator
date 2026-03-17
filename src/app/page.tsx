'use client';

import { useReducer, useCallback, useEffect, useState, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import {
  projectReducer, createDefaultProject, createEmptyProject, saveProject, loadProject,
  generateMsgId, createFile, type ProjectFile, type ConsoleMessage,
} from '@/lib/store';
import { simulate, type SimulationResult } from '@/lib/verilog-simulator';
import { parseVerilog } from '@/lib/verilog-parser';
import { YosysClient } from '@/lib/yosys-client';
import type { YosysNetlist } from '@/lib/gate-sim';
import JSZip from 'jszip';
import Toolbar from '@/components/layout/Toolbar';
import CommandMenu from '@/components/layout/CommandMenu';
import EditorTabs from '@/components/layout/EditorTabs';
import FileExplorer from '@/components/project/FileExplorer';
import WelcomeDialog from '@/components/layout/WelcomeDialog';
import ConsolePanel from '@/components/console/ConsolePanel';
import { Button } from '@/components/ui/button';
import { Trash2, Check, X } from 'lucide-react';
import WaveformViewer from '@/components/waveform/WaveformViewer';
import SchematicViewer, { type SchematicEdgeDiff } from '@/components/schematic/SchematicViewer';
import { computeAddedEdgePreviewLabels, computeProposedSource, computeLineDiff, type DiffLine } from '@/lib/verilog-codegen';
import CodeReviewPanel from '@/components/schematic/CodeReviewPanel';
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';

const CodeEditor = dynamic(() => import('@/components/editor/CodeEditor'), { ssr: false });
const Basys3Board = dynamic(() => import('@/components/board/Basys3Board'), { ssr: false });

function detectLikelyTopModule(verilogFiles: ProjectFile[]): string | null {
  const moduleNames: string[] = [];
  const instantiatedModuleNames = new Set<string>();

  for (const file of verilogFiles) {
    const result = parseVerilog(file.content);
    for (const mod of result.modules) {
      moduleNames.push(mod.name);
      for (const inst of mod.instances) {
        instantiatedModuleNames.add(inst.moduleName);
      }
    }
  }

  const uniqueModuleNames = Array.from(new Set(moduleNames));
  if (uniqueModuleNames.length === 0) return null;

  const rootCandidates = uniqueModuleNames.filter(name => !instantiatedModuleNames.has(name));

  // Prefer conventional top name first, then a unique root module.
  if (rootCandidates.includes('top')) return 'top';
  if (rootCandidates.length === 1) return rootCandidates[0];
  if (rootCandidates.length > 1) return rootCandidates[0];

  // Fallback if the design is fully recursive/unresolved.
  if (uniqueModuleNames.includes('top')) return 'top';
  return uniqueModuleNames[0];
}

export default function Home() {
  const [state, dispatch] = useReducer(projectReducer, null, () => {
    return createEmptyProject();
  });

  const [activeView, setActiveView] = useState<'editor' | 'board' | 'waveform' | 'schematic'>('editor');
  const [isSimulating, setIsSimulating] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [netlist, setNetlist] = useState<YosysNetlist | null>(null);
  const [bottomTab, setBottomTab] = useState<'console' | 'waveform' | 'codeReview'>('console');
  const [schematicRequestedModule, setSchematicRequestedModule] = useState<string | null>(null);
  const [schematicResetKey, setSchematicResetKey] = useState(0);
  const [pendingSchematicEdits, setPendingSchematicEdits] = useState<{
    diff: DiffLine[];
    targetFileId: string;
    targetFileName: string;
    newSource: string;
    changeCount: number;
    previewEdgeLabels: Record<string, string>;
  } | null>(null);
  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const yosysClientRef = useRef<YosysClient | null>(null);

  // Load from localStorage on mount + detect mobile by viewport width
  useEffect(() => {
    const saved = loadProject();
    if (saved) {
      dispatch({ type: 'LOAD_PROJECT', state: saved });
    }
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    setLoaded(true);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Save on change
  useEffect(() => {
    if (loaded) {
      saveProject(state);
    }
  }, [state, loaded]);

  // Clean up yosys worker on unmount
  useEffect(() => {
    return () => {
      yosysClientRef.current?.terminate();
    };
  }, []);

  // Clear netlist when design context changes (sources or chosen top module)
  const verilogContentKey = useMemo(() => {
    return state.files
      .filter(f => f.type === 'verilog')
      .map(f => f.content)
      .join('\0');
  }, [state.files]);

  useEffect(() => {
    setNetlist(null);
  }, [verilogContentKey, state.topModule]);

  const activeFile = state.files.find(f => f.id === state.activeFileId) || null;

  // Parsed Verilog results for the schematic viewer
  const schematicParseResults = useMemo(() => {
    return state.files
      .filter(f => f.type === 'verilog')
      .map(f => parseVerilog(f.content));
  }, [state.files]);

  const addConsoleMsg = useCallback((type: ConsoleMessage['type'], message: string, source?: string) => {
    dispatch({
      type: 'ADD_CONSOLE_MESSAGE',
      message: { id: generateMsgId(), type, message, timestamp: Date.now(), source },
    });
  }, []);

  // Get constraints source for pin mapping
  const constraintsSource = useMemo(() => {
    const xdcFiles = state.files.filter(f => f.type === 'constraints');
    if (xdcFiles.length === 0) return '';
    // Merge all XDC sources so custom constraint files are respected even when
    // multiple .xdc files exist in the project.
    return xdcFiles.map(f => f.content).join('\n\n');
  }, [state.files]);

  // Synthesize via Yosys WASM
  const handleSynthesize = useCallback(async () => {
    addConsoleMsg('info', 'Starting Yosys synthesis...', 'Synthesis');
    const verilogFiles = state.files.filter(f => f.type === 'verilog');

    if (verilogFiles.length === 0) {
      addConsoleMsg('error', 'No design source files found', 'Synthesis');
      return;
    }

    // Best-effort module discovery for auto-top fallback only.
    // Synthesis itself is performed by Yosys and should not be blocked by the
    // lightweight regex parser limits.
    const allModules: string[] = [];
    let parseIssueCount = 0;
    for (const file of verilogFiles) {
      const result = parseVerilog(file.content);
      if (result.errors.length > 0) {
        parseIssueCount += result.errors.length;
      } else {
        for (const mod of result.modules) {
          allModules.push(mod.name);
        }
      }
    }

    if (parseIssueCount > 0) {
      addConsoleMsg(
        'warning',
        `Pre-parse reported ${parseIssueCount} issue(s); continuing with Yosys synthesis anyway.`,
        'Synthesis'
      );
    }

    // Determine effective top module — auto-detect if current one is missing
    const uniqueModules = Array.from(new Set(allModules));
    let topMod = state.topModule || '';
    if (uniqueModules.length > 0 && (!topMod || !uniqueModules.includes(topMod))) {
      topMod = detectLikelyTopModule(verilogFiles) || '';
      dispatch({ type: 'SET_TOP_MODULE', name: topMod });
      addConsoleMsg('info', `Top module auto-detected: ${topMod}`, 'Synthesis');
    }
    if (!topMod) {
      addConsoleMsg('error', 'No top module selected. Set top module in file explorer and run synthesis again.', 'Synthesis');
      return;
    }

    // Collect .v files for Yosys
    const files: Record<string, string> = {};
    for (const file of verilogFiles) {
      files[file.name] = file.content;
    }

    setIsSynthesizing(true);
    try {
      if (!yosysClientRef.current) {
        yosysClientRef.current = new YosysClient();
      }
      addConsoleMsg('info', 'Running Yosys WASM (first run loads ~47MB, may take a moment)...', 'Synthesis');

      const result = await yosysClientRef.current.synthesize(files, topMod);

      // Log Yosys output to console
      if (result.log) {
        const lines = result.log.split('\n');
        for (const line of lines) {
          if (line.includes('ERROR') || line.includes('error')) {
            addConsoleMsg('error', line, 'Yosys');
          } else if (line.includes('Warning') || line.includes('warning')) {
            addConsoleMsg('warning', line, 'Yosys');
          }
        }
        console.log('[Yosys log]\n' + result.log);
      }

      setNetlist(result.netlist as YosysNetlist);
      addConsoleMsg('success', 'Synthesis complete. Gate-level netlist generated.', 'Synthesis');
      toast.success('Synthesis complete', { description: 'Gate-level netlist generated.' });

      // Check constraints
      const xdcFile = state.files.find(f => f.type === 'constraints');
      if (xdcFile) {
        addConsoleMsg('info', 'Constraints file found: ' + xdcFile.name, 'Synthesis');
      } else {
        addConsoleMsg('warning', 'No constraints file (.xdc) found', 'Synthesis');
      }
    } catch (err) {
      addConsoleMsg('error', `Synthesis failed: ${(err as Error).message}`, 'Synthesis');
      toast.error('Synthesis failed', { description: (err as Error).message });
      setNetlist(null);
    } finally {
      setIsSynthesizing(false);
    }
  }, [state.files, state.topModule, addConsoleMsg]);

  // Auto-switch to Code Review tab and show active file's module when entering schematic view
  useEffect(() => {
    if (activeView === 'schematic') {
      setBottomTab('codeReview');
      // Show the module from the file the user was viewing
      const file = state.files.find(f => f.id === state.activeFileId);
      if (file && (file.type === 'verilog' || file.type === 'testbench')) {
        const parsed = parseVerilog(file.content);
        if (parsed.modules.length > 0) {
          setSchematicRequestedModule(parsed.modules[0].name);
        }
      }
    }
  }, [activeView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-synthesize when entering board view without a netlist
  useEffect(() => {
    if (activeView === 'board' && !netlist && !isSynthesizing && loaded) {
      handleSynthesize();
    }
  }, [activeView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run simulation
  const handleRunSimulation = useCallback(() => {
    setIsSimulating(true);
    addConsoleMsg('info', 'Starting behavioral simulation...', 'Simulation');

    const tbFile = state.files.find(f => f.type === 'testbench');
    if (!tbFile) {
      addConsoleMsg('error', 'No testbench file found. Create a testbench to run simulation.', 'Simulation');
      toast.info('No simulation module detected', {
        description: 'Open FPGA Board view to inspect the synthesized design instead.',
        action: {
          label: 'Open Board View',
          onClick: () => setActiveView('board'),
        },
      });
      setIsSimulating(false);
      return;
    }

    // Find testbench module name
    const tbParse = parseVerilog(tbFile.content);
    if (tbParse.modules.length === 0) {
      addConsoleMsg('error', `No modules found in ${tbFile.name}`, 'Simulation');
      toast.info('No simulation module detected', {
        description: 'Open FPGA Board view to inspect the synthesized design instead.',
        action: {
          label: 'Open Board View',
          onClick: () => setActiveView('board'),
        },
      });
      setIsSimulating(false);
      return;
    }
    const tbModuleName = tbParse.modules[0].name;
    addConsoleMsg('info', `Testbench: ${tbModuleName}`, 'Simulation');

    // Gather all sources
    const sources: Record<string, string> = {};
    for (const file of state.files) {
      if (file.type === 'verilog' || file.type === 'testbench') {
        sources[file.name] = file.content;
      }
    }

    const verilogFiles = state.files.filter(f => f.type === 'verilog');
    const topMod = state.topModule || detectLikelyTopModule(verilogFiles) || 'top';
    if (!state.topModule && topMod) {
      dispatch({ type: 'SET_TOP_MODULE', name: topMod });
    }
    addConsoleMsg('info', `Top module: ${topMod}`, 'Simulation');

    // Use setTimeout to allow UI to update
    setTimeout(() => {
      try {
        const result = simulate(sources, topMod, tbModuleName, 1000);

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            addConsoleMsg('error', err, 'Simulation');
          }
        }

        for (const log of result.logs) {
          addConsoleMsg('log', log, 'Simulation');
        }

        setSimulationResult(result);
        addConsoleMsg('success',
          `Simulation complete: ${result.waveform.length} samples, ${result.signals.length} signals, ${result.duration}ns`,
          'Simulation'
        );
        toast.success('Simulation complete', { description: `${result.signals.length} signals, ${result.duration}ns` });

        // Switch to waveform view
        setBottomTab('waveform');

      } catch (err) {
        addConsoleMsg('error', `Simulation error: ${(err as Error).message}`, 'Simulation');
        toast.error('Simulation failed', { description: (err as Error).message });
      } finally {
        setIsSimulating(false);
      }
    }, 50);
  }, [state.files, state.topModule, addConsoleMsg]);

  const handleStopSimulation = useCallback(() => {
    setIsSimulating(false);
    addConsoleMsg('warning', 'Simulation stopped by user', 'Simulation');
  }, [addConsoleMsg]);

  // Export project
  const handleExport = useCallback(() => {
    const data = JSON.stringify(state, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.name.replace(/\s+/g, '_')}.fpgaproj`;
    a.click();
    URL.revokeObjectURL(url);
    addConsoleMsg('info', 'Project exported', 'System');
  }, [state, addConsoleMsg]);

  // Export project as ZIP
  const handleExportZip = useCallback(async () => {
    const zip = new JSZip();
    for (const file of state.files) {
      zip.file(file.name, file.content);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.name.replace(/\s+/g, '_')}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    addConsoleMsg('info', 'Project exported as ZIP', 'System');
  }, [state, addConsoleMsg]);

  // Import project
  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        dispatch({ type: 'LOAD_PROJECT', state: data });
        addConsoleMsg('success', `Project loaded: ${data.name}`, 'System');
      } catch {
        addConsoleMsg('error', 'Failed to import project file', 'System');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [addConsoleMsg]);

  const handleNewProject = useCallback(() => {
    const emptyState = createEmptyProject();
    dispatch({ type: 'LOAD_PROJECT', state: emptyState });
    setSimulationResult(null);
    addConsoleMsg('info', 'New project created', 'System');
  }, [addConsoleMsg]);

  const handleLoadExample = useCallback(() => {
    const exampleState = createDefaultProject();
    dispatch({ type: 'LOAD_PROJECT', state: exampleState });
    setSimulationResult(null);
    addConsoleMsg('info', 'Example project loaded', 'System');
  }, [addConsoleMsg]);

  // Schematic edge diff → code review
  const handleSchematicEdgeDiff = useCallback((diff: SchematicEdgeDiff, moduleName: string) => {
    if (diff.added.length === 0 && diff.removed.length === 0 && (!diff.addedNodes || diff.addedNodes.length === 0) && (!diff.deletedNodes || diff.deletedNodes.length === 0) && (!diff.renamedSignals || diff.renamedSignals.length === 0) && (!diff.renamedGates || diff.renamedGates.length === 0)) {
      setPendingSchematicEdits(null);
      return;
    }

    // Find the file containing this module
    const verilogFiles = state.files.filter(f => f.type === 'verilog');
    let targetFile: ProjectFile | null = null;
    for (const f of verilogFiles) {
      const pr = parseVerilog(f.content);
      if (pr.modules.some(m => m.name === moduleName)) {
        targetFile = f;
        break;
      }
    }
    if (!targetFile) return;

    // Get the target module and all modules
    const allModules = schematicParseResults.flatMap(pr => pr.modules);
    const targetModule = allModules.find(m => m.name === moduleName);
    if (!targetModule) return;

    const newSource = computeProposedSource(targetFile.content, diff, targetModule, allModules);
    if (newSource === targetFile.content) {
      setPendingSchematicEdits(null);
      return;
    }

    const lineDiff = computeLineDiff(targetFile.content, newSource);
    const changeCount = lineDiff.filter(d => d.type !== 'unchanged').length;
    const previewEdgeLabels = computeAddedEdgePreviewLabels(diff, targetModule, allModules);

    setPendingSchematicEdits({
      diff: lineDiff,
      targetFileId: targetFile.id,
      targetFileName: targetFile.name,
      newSource,
      changeCount,
      previewEdgeLabels,
    });
  }, [state.files, schematicParseResults]);

  const handleAcceptSchematicEdits = useCallback(() => {
    if (!pendingSchematicEdits) return;
    dispatch({ type: 'UPDATE_FILE', id: pendingSchematicEdits.targetFileId, content: pendingSchematicEdits.newSource });
    setPendingSchematicEdits(null);
    addConsoleMsg('success', `Schematic edits applied to ${pendingSchematicEdits.targetFileName}`, 'Schematic');
  }, [pendingSchematicEdits, addConsoleMsg]);

  const handleRejectSchematicEdits = useCallback(() => {
    setPendingSchematicEdits(null);
    setSchematicResetKey(k => k + 1);
  }, []);

  const handleNavigateSchematicModule = useCallback((moduleName: string) => {
    setSchematicRequestedModule(moduleName);

    const targetFile = state.files.find((file) => {
      if (file.type !== 'verilog' && file.type !== 'testbench') return false;
      const parsed = parseVerilog(file.content);
      return parsed.modules.some((mod) => mod.name === moduleName);
    });

    if (targetFile) {
      dispatch({ type: 'OPEN_FILE', id: targetFile.id });
    }
  }, [state.files]);

  const getEditorLanguage = (file: ProjectFile | null) => {
    if (!file) return 'verilog';
    if (file.name.endsWith('.xdc')) return 'xdc';
    return 'verilog';
  };

  if (!loaded) {
    return null;
  }

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 bg-background flex items-center justify-center p-6 text-center">
        <div className="max-w-sm space-y-3">
          <p className="text-lg font-semibold text-foreground">Mobile Not Supported Yet</p>
          <p className="text-sm text-muted-foreground">
            FPGA Studio currently supports desktop widths only. Please open this app on a larger screen.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      <input
        ref={fileInputRef}
        type="file"
        accept=".fpgaproj,.json"
        className="hidden"
        onChange={handleFileImport}
      />

      {/* Welcome Dialog (first visit only) */}
      <WelcomeDialog onLoadExample={handleLoadExample} />

      {/* Command Menu (Cmd+K) */}
      <CommandMenu
        open={commandMenuOpen}
        onOpenChange={setCommandMenuOpen}
        files={state.files}
        activeView={activeView}
        isSimulating={isSimulating}
        isSynthesizing={isSynthesizing}
        onOpenFile={(id) => {
          dispatch({ type: 'OPEN_FILE', id });
          if (activeView !== 'editor') setActiveView('editor');
        }}
        onSetView={setActiveView}
        onSynthesize={handleSynthesize}
        onRunSimulation={handleRunSimulation}
        onStopSimulation={handleStopSimulation}
        onNewFile={() => setNewFileDialogOpen(true)}
        onNewProject={handleNewProject}
        onLoadExample={handleLoadExample}
        onExportProject={handleExport}
        onExportZip={handleExportZip}
        onImportProject={handleImport}
        onClearConsole={() => dispatch({ type: 'CLEAR_CONSOLE' })}
      />

      {/* Toolbar */}
      <Toolbar
        projectName={state.name}
        isSimulating={isSimulating}
        isSynthesizing={isSynthesizing}
        activeView={activeView}
        onRunSimulation={handleRunSimulation}
        onStopSimulation={handleStopSimulation}
        onSynthesize={handleSynthesize}
        onSetView={setActiveView}
        onExportProject={handleExport}
        onExportZip={handleExportZip}
        onImportProject={handleImport}
        onNewProject={handleNewProject}
        onNewFile={() => setNewFileDialogOpen(true)}
        onLoadExample={handleLoadExample}
        onOpenCommandMenu={() => setCommandMenuOpen(true)}
      />

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          {/* Left sidebar - File explorer */}
          <ResizablePanel defaultSize="20" minSize="12" maxSize="30">
            <FileExplorer
              files={state.files}
              activeFileId={state.activeFileId}
              topModule={state.topModule}
              isSynthesizing={isSynthesizing}
              isSimulating={isSimulating}
              createDialogOpen={newFileDialogOpen}
              onCreateDialogOpenChange={setNewFileDialogOpen}
              onOpenFile={(id) => {
                dispatch({ type: 'OPEN_FILE', id });
                if (activeView === 'schematic') {
                  const file = state.files.find(f => f.id === id);
                  if (file && (file.type === 'verilog' || file.type === 'testbench')) {
                    const parsed = parseVerilog(file.content);
                    if (parsed.modules.length > 0) {
                      setSchematicRequestedModule(parsed.modules[0].name);
                    }
                  }
                } else if (activeView !== 'editor') {
                  setActiveView('editor');
                }
              }}
              onAddFile={(file) => dispatch({ type: 'ADD_FILE', file })}
              onDeleteFile={(id) => dispatch({ type: 'DELETE_FILE', id })}
              onRenameFile={(id, name) => dispatch({ type: 'RENAME_FILE', id, name })}
              onSetTopModule={(name) => {
                dispatch({ type: 'SET_TOP_MODULE', name });
                addConsoleMsg('info', `Top module set to: ${name}`, 'System');
              }}
            />
          </ResizablePanel>

          <ResizableHandle withHandle direction="horizontal" />

          {/* Center - Editor / Board / Waveform */}
          <ResizablePanel defaultSize="80">
            <ResizablePanelGroup direction="vertical">
              {/* Top - Editor or Board view */}
              <ResizablePanel defaultSize="75" minSize="25">
                {activeView === 'editor' && (
                  <div className="h-full flex flex-col">
                    <EditorTabs
                      files={state.files}
                      openFileIds={state.openFileIds}
                      activeFileId={state.activeFileId}
                      onSelectFile={(id) => dispatch({ type: 'SET_ACTIVE_FILE', id })}
                      onCloseFile={(id) => dispatch({ type: 'CLOSE_FILE', id })}
                      onRenameFile={(id) => {
                        const name = prompt('Rename file:', state.files.find(f => f.id === id)?.name);
                        if (name?.trim()) dispatch({ type: 'RENAME_FILE', id, name: name.trim() });
                      }}
                      onDuplicateFile={(id) => {
                        const file = state.files.find(f => f.id === id);
                        if (!file) return;
                        const ext = file.name.lastIndexOf('.');
                        const base = ext > 0 ? file.name.slice(0, ext) : file.name;
                        const extension = ext > 0 ? file.name.slice(ext) : '';
                        const newFile = createFile(`${base}_copy${extension}`, file.content, file.type);
                        dispatch({ type: 'ADD_FILE', file: newFile });
                      }}
                      onDeleteFile={(id) => dispatch({ type: 'DELETE_FILE', id })}
                      onSetTopModule={(id) => {
                        const file = state.files.find(f => f.id === id);
                        if (!file) return;
                        const match = file.content.match(/module\s+(\w+)/);
                        if (match) {
                          dispatch({ type: 'SET_TOP_MODULE', name: match[1] });
                          addConsoleMsg('info', `Top module set to: ${match[1]}`, 'System');
                        }
                      }}
                    />
                    <div className="flex-1">
                      {activeFile ? (
                        <CodeEditor
                          key={activeFile.id}
                          value={activeFile.content}
                          onChange={(content) =>
                            dispatch({ type: 'UPDATE_FILE', id: activeFile.id, content })
                          }
                          language={getEditorLanguage(activeFile)}
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                          <div className="text-center space-y-2">
                            <p className="text-lg">No file open</p>
                            <p className="text-xs">Select a file from the explorer or create a new one</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeView === 'board' && (
                  <ScrollArea className="h-full">
                    <div className="flex items-center justify-center min-h-full p-8">
                      <Basys3Board
                        moduleName={state.topModule || 'top'}
                        netlist={netlist}
                        constraintsSource={constraintsSource}
                        isSynthesizing={isSynthesizing}
                        onSynthesize={handleSynthesize}
                      />
                    </div>
                  </ScrollArea>
                )}

                {activeView === 'waveform' && (
                  <WaveformViewer simulation={simulationResult} />
                )}

                {activeView === 'schematic' && (
                  <SchematicViewer
                    parseResults={schematicParseResults}
                    topModuleName={state.topModule || detectLikelyTopModule(state.files.filter(f => f.type === 'verilog'))}
                    contentKey={verilogContentKey}
                    requestedModuleName={schematicRequestedModule}
                    resetKey={schematicResetKey}
                    previewEdgeLabels={pendingSchematicEdits?.previewEdgeLabels ?? null}
                    onNavigateToModule={handleNavigateSchematicModule}
                    onEdgeDiffChange={handleSchematicEdgeDiff}
                    onConsoleMessage={addConsoleMsg}
                  />
                )}
              </ResizablePanel>

              <ResizableHandle withHandle direction="vertical" />

              {/* Bottom panel - Console / Waveform */}
              <ResizablePanel defaultSize="25" minSize="15" maxSize="70">
                <Tabs value={bottomTab} onValueChange={(v) => setBottomTab(v as typeof bottomTab)} className="h-full flex flex-col">
                  <div className="flex items-center justify-between border-b border-border bg-muted/50 px-2 h-8">
                    <div className="flex items-center gap-2">
                      <TabsList className="h-8 w-fit rounded-none bg-transparent p-0">
                        <TabsTrigger value="console" className="text-xs h-6 data-[state=active]:bg-secondary">
                          Console
                        </TabsTrigger>
                        <TabsTrigger value="waveform" className="text-xs h-6 data-[state=active]:bg-secondary">
                          Waveform
                          {simulationResult && (
                            <span className="ml-1 text-[10px] text-green-400">
                              ({simulationResult.signals.length})
                            </span>
                          )}
                        </TabsTrigger>
                        <TabsTrigger value="codeReview" className="text-xs h-6 data-[state=active]:bg-secondary">
                          Code Review
                        </TabsTrigger>
                      </TabsList>
                      {bottomTab === 'console' && (
                        <>
                          {state.consoleMessages.filter(m => m.type === 'error').length > 0 && (
                            <span className="text-[10px] text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950 px-1.5 py-0.5 rounded">
                              {state.consoleMessages.filter(m => m.type === 'error').length} errors
                            </span>
                          )}
                          {state.consoleMessages.filter(m => m.type === 'warning').length > 0 && (
                            <span className="text-[10px] text-yellow-600 dark:text-yellow-400 bg-yellow-100 dark:bg-yellow-950 px-1.5 py-0.5 rounded">
                              {state.consoleMessages.filter(m => m.type === 'warning').length} warnings
                            </span>
                          )}
                        </>
                      )}
                      {bottomTab === 'codeReview' && pendingSchematicEdits && (
                        <span className="text-[10px] text-muted-foreground">
                          {pendingSchematicEdits.changeCount} {pendingSchematicEdits.changeCount === 1 ? 'change' : 'changes'}
                        </span>
                      )}
                    </div>
                    {bottomTab === 'console' && (
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => dispatch({ type: 'CLEAR_CONSOLE' })}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {bottomTab === 'codeReview' && pendingSchematicEdits && (
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" className="h-6 px-2 gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={handleRejectSchematicEdits}>
                          <X className="h-3 w-3" />
                          Decline
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 px-2 gap-1 text-xs text-green-500 hover:text-green-600 hover:bg-green-500/10" onClick={handleAcceptSchematicEdits}>
                          <Check className="h-3 w-3" />
                          Accept
                        </Button>
                      </div>
                    )}
                  </div>
                  <TabsContent value="console" className="flex-1 mt-0 overflow-hidden">
                    <ConsolePanel
                      messages={state.consoleMessages}
                    />
                  </TabsContent>
                  <TabsContent value="waveform" className="flex-1 mt-0 overflow-hidden">
                    <WaveformViewer simulation={simulationResult} />
                  </TabsContent>
                  <TabsContent value="codeReview" className="flex-1 mt-0 overflow-hidden">
                    {activeView === 'schematic' ? (
                      <CodeReviewPanel diff={pendingSchematicEdits?.diff ?? null} />
                    ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                        <p className="text-xs">Enter Schematic view to use Code Review.</p>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Status bar */}
      <div className="h-6 border-t border-border bg-muted/80 flex items-center justify-between px-3 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>FPGA Studio v1.0</span>
          <a href="https://github.com/ffabbr/fpga-vivado-simulator" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground underline underline-offset-2">Contribute</a>
          <span>|</span>
          <span>Target: Basys 3 (XC7A35T-1CPG236C)</span>
          {state.topModule && (
            <>
              <span>|</span>
              <span>Top: {state.topModule}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {activeFile && (
            <>
              <span>{activeFile.name}</span>
              <span>|</span>
              <span>{activeFile.content.split('\n').length} lines</span>
            </>
          )}
          {isSynthesizing && (
            <span className="text-yellow-400 animate-pulse">Synthesizing...</span>
          )}
          {isSimulating && (
            <span className="text-yellow-400 animate-pulse">Simulating...</span>
          )}
        </div>
      </div>
      </div>
    </>
  );
}
