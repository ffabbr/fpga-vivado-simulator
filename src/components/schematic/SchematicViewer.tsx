'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  addEdge as rfAddEdge,
  type Node,
  type Edge,
  type NodeTypes,
  type Connection,
  Handle,
  Position,
  MarkerType,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK, { type ElkNode, type ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import type { VerilogModule, ParseResult } from '@/lib/verilog-parser';
import type { SchematicEdgeInfo, AddedNodeInfo, DeletedNodeInfo, RenamedSignal, RenamedGate } from '@/lib/verilog-codegen';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuGroup,
  ContextMenuLabel,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ZoomIn, ZoomOut, Maximize, Lock, Unlock, ChevronDown, Spline, Plus, Eye, Pencil, Trash2, Type, FileImage } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { verilogModuleToYosysJson } from '@/lib/verilog-to-yosys';
import { toast } from 'sonner';

// Lazy-loaded netlistsvg module + skin cache
let netlistSvgModule: { render(skin: string, netlist: object): Promise<string> } | null = null;
let skinCache: string | null = null;

async function getNetlistSvg() {
  if (!netlistSvgModule) {
    const mod = await import('netlistsvg');
    netlistSvgModule = mod.default ?? mod;
  }
  if (!skinCache) {
    const resp = await fetch('/netlistsvg-skin.svg');
    skinCache = await resp.text();
  }
  return { render: netlistSvgModule!.render.bind(netlistSvgModule), skin: skinCache! };
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SchematicEdgeDiff {
  added: SchematicEdgeInfo[];
  removed: SchematicEdgeInfo[];
  addedNodes: AddedNodeInfo[];
  deletedNodes: DeletedNodeInfo[];
  renamedSignals: RenamedSignal[];
  renamedGates: RenamedGate[];
}

interface SchematicViewerProps {
  parseResults: ParseResult[];
  topModuleName: string | null;
  contentKey?: string; // changes when verilog source changes → resets cached positions
  requestedModuleName?: string | null; // external module selection (e.g. sidebar file click)
  resetKey?: number; // increment to force re-build from source (e.g. after reject)
  onNavigateToModule?: (moduleName: string) => void;
  onEdgeDiffChange?: (diff: SchematicEdgeDiff, moduleName: string) => void;
  onConsoleMessage?: (type: 'info' | 'error' | 'success' | 'warning', message: string, source?: string) => void;
}

// ── Position Cache ───────────────────────────────────────────────────────────
// Module-level cache so positions survive unmount/remount (view switching).
// Keyed by `${contentKey}::${moduleName}`.  Cleared when contentKey changes.

const positionCache = new Map<string, Map<string, { x: number; y: number }>>();
let cachedContentKey: string | undefined;

function getCacheKey(contentKey: string | undefined, moduleName: string) {
  return `${contentKey ?? ''}::${moduleName}`;
}

function savePositions(contentKey: string | undefined, moduleName: string, nodes: Node[]) {
  const key = getCacheKey(contentKey, moduleName);
  const map = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    map.set(n.id, { x: n.position.x, y: n.position.y });
  }
  positionCache.set(key, map);
}

function loadPositions(contentKey: string | undefined, moduleName: string): Map<string, { x: number; y: number }> | null {
  // If the content key changed, flush the entire cache
  if (contentKey !== cachedContentKey) {
    positionCache.clear();
    cachedContentKey = contentKey;
    return null;
  }
  return positionCache.get(getCacheKey(contentKey, moduleName)) ?? null;
}

type PortNodeData = {
  label: string;
  direction: 'input' | 'output' | 'inout';
  width: number;
};

type InstanceNodeData = {
  label: string;
  moduleName: string;
  ports: { name: string; direction: 'input' | 'output' | 'inout' }[];
  canDrillDown: boolean;
};

type GateNodeData = {
  label: string;
  gateType: string;
  inputs: string[];
  output: string;
  instanceName?: string; // original Verilog instance name (if any)
};

type AssignNodeData = {
  label: string;
  expression: string;
  target: string;
};

type AlwaysNodeData = {
  label: string;
  sensitivity: string;
  blockType: 'combinational' | 'sequential';
};

// ── Custom Node Components ───────────────────────────────────────────────────

function PortNode({ data }: { data: PortNodeData }) {
  const isInput = data.direction === 'input';
  const isOutput = data.direction === 'output';

  const widthLabel = data.width > 1 ? `[${data.width - 1}:0]` : '';
  const dirLabel = isInput ? 'IN' : isOutput ? 'OUT' : 'IO';

  // Input ports: [IN [3:0]]---name--->
  // Output ports:      <---name---[OUT [3:0]]
  return (
    <div className="relative flex items-center" style={{ height: 20 }}>
      {isInput ? (
        <>
          {/* Direction + width info on the left */}
          <span className="text-[9px] font-mono text-muted-foreground mr-1.5 whitespace-nowrap">
            {dirLabel}{widthLabel && ` ${widthLabel}`}
          </span>
          {/* Signal name + line stub */}
          <span className="text-xs font-mono font-medium text-foreground mr-0.5">{data.label}</span>
          <svg width={16} height={20} className="text-foreground shrink-0">
            <line x1={0} y1={10} x2={16} y2={10} stroke="currentColor" strokeWidth={1.8} />
          </svg>
          <Handle
            type="source"
            position={Position.Right}
            className="!w-2 !h-2 !bg-foreground !border-0"
            style={{ right: -1 }}
          />
        </>
      ) : isOutput ? (
        <>
          <Handle
            type="target"
            position={Position.Left}
            className="!w-2 !h-2 !bg-foreground !border-0"
            style={{ left: -1 }}
          />
          <svg width={16} height={20} className="text-foreground shrink-0">
            <line x1={0} y1={10} x2={16} y2={10} stroke="currentColor" strokeWidth={1.8} />
          </svg>
          {/* Signal name + direction/width info on the right */}
          <span className="text-xs font-mono font-medium text-foreground ml-0.5">{data.label}</span>
          <span className="text-[9px] font-mono text-muted-foreground ml-1.5 whitespace-nowrap">
            {dirLabel}{widthLabel && ` ${widthLabel}`}
          </span>
        </>
      ) : (
        /* inout: handles on both sides */
        <>
          <Handle
            type="target"
            position={Position.Left}
            className="!w-2 !h-2 !bg-foreground !border-0"
            style={{ left: -1 }}
          />
          <svg width={10} height={20} className="text-foreground shrink-0">
            <line x1={0} y1={10} x2={10} y2={10} stroke="currentColor" strokeWidth={1.8} />
          </svg>
          <span className="text-[9px] font-mono text-muted-foreground mr-1 whitespace-nowrap">{dirLabel}{widthLabel && ` ${widthLabel}`}</span>
          <span className="text-xs font-mono font-medium text-foreground mx-0.5">{data.label}</span>
          <svg width={10} height={20} className="text-foreground shrink-0">
            <line x1={0} y1={10} x2={10} y2={10} stroke="currentColor" strokeWidth={1.8} />
          </svg>
          <Handle
            type="source"
            position={Position.Right}
            className="!w-2 !h-2 !bg-foreground !border-0"
            style={{ right: -1 }}
          />
        </>
      )}
    </div>
  );
}

function InstanceNode({ data }: { data: InstanceNodeData }) {
  const inputPorts = data.ports.filter(p => p.direction === 'input' || p.direction === 'inout');
  const outputPorts = data.ports.filter(p => p.direction === 'output');
  const portRows = Math.max(inputPorts.length, outputPorts.length, 1);
  const bodyHeight = Math.max(portRows * 18 + 16, 50);

  // Compute Y positions for port handles, evenly spaced within the body
  const inputYs = inputPorts.map((_, i) =>
    inputPorts.length === 1 ? bodyHeight / 2 : 12 + (i * (bodyHeight - 24)) / (inputPorts.length - 1),
  );
  const outputYs = outputPorts.map((_, i) =>
    outputPorts.length === 1 ? bodyHeight / 2 : 12 + (i * (bodyHeight - 24)) / (outputPorts.length - 1),
  );

  // Compute width based on module name, instance label, and port name lengths
  const charWidth = 6; // approx width per monospace char at font-size 8-10px
  const centerLabelWidth = Math.max(data.moduleName.length, data.label !== data.moduleName ? data.label.length : 0) * (charWidth + 0.5);
  const maxInputPortLen = inputPorts.reduce((max, p) => Math.max(max, p.name.length), 0);
  const maxOutputPortLen = outputPorts.reduce((max, p) => Math.max(max, p.name.length), 0);
  const portLabelsWidth = (maxInputPortLen + maxOutputPortLen) * charWidth + 24; // 24px for ticks + padding
  const boxWidth = Math.max(90, centerLabelWidth + 30, portLabelsWidth);

  return (
    <div
      className={`relative ${data.canDrillDown ? 'cursor-pointer' : ''}`}
      style={{ width: boxWidth, height: bodyHeight }}
    >
      {/* Square box outline */}
      <svg viewBox={`0 0 ${boxWidth} ${bodyHeight}`} width={boxWidth} height={bodyHeight} className="text-foreground">
        <rect
          x={1} y={1} width={boxWidth - 2} height={bodyHeight - 2}
          rx={0} ry={0}
          stroke="currentColor" strokeWidth={1.8} fill="var(--background)"
        />
        {/* Input port ticks and labels */}
        {inputPorts.map((p, i) => (
          <g key={`in-${p.name}`}>
            <line x1={0} y1={inputYs[i]} x2={6} y2={inputYs[i]} stroke="currentColor" strokeWidth={1.8} />
            <text x={9} y={inputYs[i] + 3.5} fontSize={8} fontFamily="monospace" fill="currentColor" opacity={0.6}>
              {p.name}
            </text>
          </g>
        ))}
        {/* Output port ticks and labels */}
        {outputPorts.map((p, i) => (
          <g key={`out-${p.name}`}>
            <line x1={boxWidth - 6} y1={outputYs[i]} x2={boxWidth} y2={outputYs[i]} stroke="currentColor" strokeWidth={1.8} />
            <text x={boxWidth - 9} y={outputYs[i] + 3.5} fontSize={8} fontFamily="monospace" fill="currentColor" opacity={0.6} textAnchor="end">
              {p.name}
            </text>
          </g>
        ))}
      </svg>

      {/* Center label */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-[10px] font-mono font-semibold text-foreground leading-tight">{data.moduleName}</span>
        {data.label !== data.moduleName && (
          <span className="text-[8px] font-mono text-muted-foreground leading-tight">{data.label}</span>
        )}
      </div>

      {/* Handles */}
      {inputPorts.map((p, i) => (
        <Handle
          key={`in-${p.name}`}
          type="target"
          position={Position.Left}
          id={p.name}
          className="!w-2 !h-2 !bg-foreground !border-0"
          style={{ top: inputYs[i], left: -1 }}
        />
      ))}
      {outputPorts.map((p, i) => (
        <Handle
          key={`out-${p.name}`}
          type="source"
          position={Position.Right}
          id={p.name}
          className="!w-2 !h-2 !bg-foreground !border-0"
          style={{ top: outputYs[i], right: -1 }}
        />
      ))}
    </div>
  );
}

// ── SVG Gate Shape Paths ─────────────────────────────────────────────────────
// All gates are drawn in a 80×60 viewBox. Inputs on left, output on right.
// Inverting gates (NOT, NAND, NOR, XNOR) get a bubble on the output.

function GateSvgShape({ gateType, inputCount }: { gateType: string; inputCount: number }) {
  const stroke = 'currentColor';
  const fill = 'var(--background)';
  const sw = 1.8; // strokeWidth

  // Compute input Y positions evenly spaced within the gate body
  const inputYs = Array.from({ length: inputCount }, (_, i) =>
    inputCount === 1 ? 30 : 10 + (i * 40) / (inputCount - 1),
  );

  const isInverting = ['not', 'nand', 'nor', 'xnor'].includes(gateType);
  const bubbleX = isInverting ? 68 : -1;
  const outputX = isInverting ? 76 : 70;
  const bodyType = gateType.replace(/^n/, '').replace(/^x/, ''); // and, or, xor → base shape

  return (
    <svg viewBox="0 0 84 60" width={84} height={60} className="text-foreground">
      {/* Input lines */}
      {inputYs.map((y, i) => (
        <line key={i} x1={0} y1={y} x2={14} y2={y} stroke={stroke} strokeWidth={sw} />
      ))}

      {/* Output line */}
      <line x1={outputX} y1={30} x2={84} y2={30} stroke={stroke} strokeWidth={sw} />

      {/* Gate body */}
      {(gateType === 'and' || gateType === 'nand') && (
        <path
          d="M14,5 L40,5 A28,25 0 0,1 40,55 L14,55 Z"
          stroke={stroke} strokeWidth={sw} fill={fill}
        />
      )}

      {(gateType === 'or' || gateType === 'nor') && (
        <path
          d="M14,5 Q28,30 14,55 Q45,55 65,30 Q45,5 14,5 Z"
          stroke={stroke} strokeWidth={sw} fill={fill}
        />
      )}

      {(gateType === 'xor' || gateType === 'xnor') && (
        <>
          {/* Extra curved line for XOR */}
          <path
            d="M10,5 Q24,30 10,55"
            stroke={stroke} strokeWidth={sw} fill={fill}
          />
          <path
            d="M14,5 Q28,30 14,55 Q45,55 65,30 Q45,5 14,5 Z"
            stroke={stroke} strokeWidth={sw} fill={fill}
          />
        </>
      )}

      {(gateType === 'not' || gateType === 'buf') && (
        <path
          d="M14,5 L64,30 L14,55 Z"
          stroke={stroke} strokeWidth={sw} fill={fill}
        />
      )}

      {/* Inversion bubble */}
      {isInverting && (
        <circle cx={bubbleX - 4} cy={30} r={4} stroke={stroke} strokeWidth={sw} fill={fill} />
      )}
    </svg>
  );
}

/** Minimal gate icon for the palette — just the body shape, no wires/handles */
function GateIconMini({ gateType }: { gateType: string }) {
  const stroke = 'currentColor';
  const fill = 'none';
  const sw = 1.5;
  const isInverting = ['not', 'nand', 'nor', 'xnor'].includes(gateType);

  return (
    <svg viewBox="6 0 72 60" width={28} height={20} className="text-muted-foreground">
      {(gateType === 'and' || gateType === 'nand') && (
        <path d="M14,5 L40,5 A28,25 0 0,1 40,55 L14,55 Z" stroke={stroke} strokeWidth={sw} fill={fill} />
      )}
      {(gateType === 'or' || gateType === 'nor') && (
        <path d="M14,5 Q28,30 14,55 Q45,55 65,30 Q45,5 14,5 Z" stroke={stroke} strokeWidth={sw} fill={fill} />
      )}
      {(gateType === 'xor' || gateType === 'xnor') && (
        <>
          <path d="M10,5 Q24,30 10,55" stroke={stroke} strokeWidth={sw} fill="none" />
          <path d="M14,5 Q28,30 14,55 Q45,55 65,30 Q45,5 14,5 Z" stroke={stroke} strokeWidth={sw} fill={fill} />
        </>
      )}
      {(gateType === 'not' || gateType === 'buf') && (
        <path d="M14,5 L64,30 L14,55 Z" stroke={stroke} strokeWidth={sw} fill={fill} />
      )}
      {isInverting && (
        <circle cx={64} cy={30} r={4} stroke={stroke} strokeWidth={sw} fill={fill} />
      )}
    </svg>
  );
}

function GateNode({ data }: { data: GateNodeData }) {
  const inputCount = data.inputs.length;
  // Compute input Y positions matching the SVG (in a 60px-tall viewbox)
  const inputYs = Array.from({ length: inputCount }, (_, i) =>
    inputCount === 1 ? 30 : 10 + (i * 40) / (inputCount - 1),
  );

  return (
    <div className="relative" style={{ width: 84, height: 60 }}>
      {/* Input handles positioned to match SVG input lines */}
      {inputYs.map((y, i) => (
        <Handle
          key={`in-${i}`}
          type="target"
          position={Position.Left}
          id={`in-${i}`}
          className="!w-2 !h-2 !bg-foreground !border-0"
          style={{ top: y, left: -1 }}
        />
      ))}

      {/* Output handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="!w-2 !h-2 !bg-foreground !border-0"
        style={{ top: 30, right: -1 }}
      />

      {/* Gate SVG shape */}
      <GateSvgShape gateType={data.gateType} inputCount={inputCount} />

      {/* Gate type label inside the shape */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ paddingLeft: 14, paddingRight: 14 }}>
        <span className="text-[9px] font-mono font-semibold text-foreground/70 uppercase">{data.gateType}</span>
      </div>
    </div>
  );
}

function AssignNode({ data }: { data: AssignNodeData }) {
  return (
    <div className="rounded border-2 bg-cyan-500/10 border-cyan-500/50 px-3 py-1.5 min-w-[80px]">
      <Handle type="target" position={Position.Left} className="!w-1.5 !h-1.5 !bg-cyan-400 !border-0" />
      <div className="text-[10px] text-cyan-500/60 font-mono">assign</div>
      <div className="text-xs font-mono text-cyan-700 dark:text-cyan-200 max-w-[200px] truncate">
        {data.target} = {data.expression}
      </div>
      <Handle type="source" position={Position.Right} className="!w-1.5 !h-1.5 !bg-cyan-400 !border-0" />
    </div>
  );
}

function AlwaysNode({ data }: { data: AlwaysNodeData }) {
  const isSeq = data.blockType === 'sequential';
  const colorClass = isSeq
    ? 'bg-rose-500/10 border-rose-500/50'
    : 'bg-violet-500/10 border-violet-500/50';
  const textColor = isSeq
    ? 'text-rose-700 dark:text-rose-200'
    : 'text-violet-700 dark:text-violet-200';
  const subColor = isSeq
    ? 'text-rose-500/60'
    : 'text-violet-500/60';
  const handleColor = isSeq ? '!bg-rose-400' : '!bg-violet-400';

  return (
    <div className={`rounded border-2 ${colorClass} px-3 py-1.5 min-w-[100px]`}>
      <Handle type="target" position={Position.Left} className={`!w-1.5 !h-1.5 ${handleColor} !border-0`} />
      <div className={`text-[10px] ${subColor} font-mono`}>
        always @({data.sensitivity.length > 30 ? data.sensitivity.slice(0, 30) + '...' : data.sensitivity})
      </div>
      <div className={`text-xs font-mono font-medium ${textColor}`}>
        {isSeq ? 'Sequential Logic' : 'Combinational Logic'}
      </div>
      <Handle type="source" position={Position.Right} className={`!w-1.5 !h-1.5 ${handleColor} !border-0`} />
    </div>
  );
}

// ── Node Types Registry ──────────────────────────────────────────────────────

const nodeTypes: NodeTypes = {
  port: PortNode,
  instance: InstanceNode,
  gate: GateNode,
  assign: AssignNode,
  always: AlwaysNode,
};

// ── ELK Layout ───────────────────────────────────────────────────────────────

const elk = new ELK();

async function layoutGraph(
  nodes: Node[],
  edges: Edge[],
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  // Build ELK nodes with layer constraints for ports:
  // - Input ports pinned to the first (leftmost) layer
  // - Output ports pinned to the last (rightmost) layer
  const elkNodes: ElkNode['children'] = nodes.map((n) => {
    const w = n.measured?.width ?? estimateWidth(n);
    const h = n.measured?.height ?? estimateHeight(n);
    const layoutOptions: Record<string, string> = {};

    if (n.type === 'port') {
      const dir = (n.data as PortNodeData).direction;
      if (dir === 'input') {
        layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST';
      } else if (dir === 'output') {
        layoutOptions['elk.layered.layering.layerConstraint'] = 'LAST';
      }
    }

    // Inflate height of gates/instances for ELK so they get more vertical space
    const elkH = (n.type === 'port') ? h : h + 200;
    return { id: n.id, width: w, height: elkH, layoutOptions };
  });

  const elkEdges: ElkExtendedEdge[] = edges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      // Spacing — generous to avoid overlaps
      'elk.spacing.nodeNode': '120',
      'elk.layered.spacing.nodeNodeBetweenLayers': '150',
      'elk.layered.spacing.edgeNodeBetweenLayers': '60',
      'elk.spacing.edgeEdge': '40',
      'elk.spacing.edgeNode': '60',
      'elk.spacing.componentComponent': '200',
      'elk.layered.compaction.postCompaction.strategy': 'NONE',
      'elk.padding': '[top=60,left=60,bottom=60,right=60]',
      // Edge routing
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.mergeEdges': 'false',
      // Crossing minimization
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
      // Node placement
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      // Consider model order to keep ports visually ordered
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // Thoroughness
      'elk.layered.thoroughness': '20',
    },
    children: elkNodes,
    edges: elkEdges,
  };

  const laid = await elk.layout(graph);

  // Build a fast lookup map instead of O(n^2) find
  const posMap = new Map<string, { x: number; y: number }>();
  for (const c of laid.children || []) {
    posMap.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  }

  const laidNodes = nodes.map((n) => {
    const pos = posMap.get(n.id);
    return {
      ...n,
      position: pos ?? { x: 0, y: 0 },
    };
  });

  return { nodes: laidNodes, edges };
}

function estimateWidth(node: Node): number {
  switch (node.type) {
    case 'port': {
      const d = node.data as PortNodeData;
      const nameLen = d.label.length * 7;
      const metaLen = (d.width > 1 ? `[${d.width - 1}:0]`.length : 0) * 5 + 20;
      return nameLen + metaLen + 30;
    }
    case 'instance': return 90;
    case 'gate': return 84;
    case 'assign': return 180;
    case 'always': return 180;
    default: return 120;
  }
}

function estimateHeight(node: Node): number {
  if (node.type === 'instance') {
    const data = node.data as InstanceNodeData;
    const portRows = Math.max(
      data.ports.filter(p => p.direction === 'input' || p.direction === 'inout').length,
      data.ports.filter(p => p.direction === 'output').length,
      1,
    );
    return Math.max(portRows * 18 + 16, 50);
  }
  if (node.type === 'gate') {
    return 72; // 60px shape + 12px label below
  }
  if (node.type === 'port') {
    return 20;
  }
  return 45;
}

// ── Graph Builder ────────────────────────────────────────────────────────────

function buildGraph(
  targetModule: VerilogModule,
  allModules: VerilogModule[],
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const moduleMap = new Map(allModules.map(m => [m.name, m]));

  // Track which signals are produced/consumed so we can draw edges.
  // A signal can be a plain name ("clk") or a bus name ("a") that also
  // covers bit-selects like "a[0]". We normalise to the base bus name.
  const signalProducers = new Map<string, { nodeId: string; handleId?: string }>();
  const signalConsumers = new Map<string, { nodeId: string; handleId?: string }[]>();

  // All known signal base-names in this module (ports + wires + regs)
  const knownSignals = new Set([
    ...targetModule.ports.map(p => p.name),
    ...targetModule.wires.map(w => w.name),
    ...targetModule.regs.map(r => r.name),
  ]);

  /** Return the base signal name (strip bit-select). */
  function baseSignal(sig: string): string {
    return sig.replace(/\[.*\]$/, '');
  }

  /** Normalise a raw signal reference, preserving bit-selects. Returns null for literals. */
  function cleanSignal(raw: string): string | null {
    const trimmed = raw.replace(/\s/g, '');
    // Extract base name (before any [index])
    const base = baseSignal(trimmed);
    // Skip numeric literals, empty strings, tick-literals like 1'b0
    if (!base || /^\d/.test(base) || /^'/.test(base)) return null;
    // Only return if it's a known signal in this module
    if (knownSignals.has(base)) return trimmed; // preserve bit-select
    return null;
  }

  function addConsumer(signal: string, nodeId: string, handleId?: string) {
    const list = signalConsumers.get(signal) || [];
    list.push({ nodeId, handleId });
    signalConsumers.set(signal, list);
  }

  // 1) Input ports (signal producers)
  for (const port of targetModule.ports) {
    if (port.direction === 'input' || port.direction === 'inout') {
      const id = `port-in-${port.name}`;
      nodes.push({
        id,
        type: 'port',
        position: { x: 0, y: 0 },
        data: { label: port.name, direction: port.direction, width: port.width } satisfies PortNodeData,
      });
      signalProducers.set(port.name, { nodeId: id });
    }
  }

  // 2) Output ports (signal consumers)
  for (const port of targetModule.ports) {
    if (port.direction === 'output' || port.direction === 'inout') {
      const id = `port-out-${port.name}`;
      nodes.push({
        id,
        type: 'port',
        position: { x: 0, y: 0 },
        data: { label: port.name, direction: port.direction, width: port.width } satisfies PortNodeData,
      });
      addConsumer(port.name, id);
    }
  }

  // 3) Module instances
  for (const inst of targetModule.instances) {
    const childModule = moduleMap.get(inst.moduleName);
    const instId = `inst-${inst.instanceName}`;

    // Determine port info from child module definition when available,
    // so positional args get proper directions.
    let ports: InstanceNodeData['ports'] = [];
    if (childModule) {
      ports = childModule.ports.map(p => ({ name: p.name, direction: p.direction }));
    } else if (Object.keys(inst.connections).length > 0) {
      ports = Object.keys(inst.connections).map(k => ({ name: k, direction: 'input' as const }));
    } else if (inst.positionalArgs) {
      // No child module known — guess all inputs
      ports = inst.positionalArgs.map((_, i) => ({ name: `p${i}`, direction: 'input' as const }));
    }

    nodes.push({
      id: instId,
      type: 'instance',
      position: { x: 0, y: 0 },
      data: {
        label: inst.instanceName,
        moduleName: inst.moduleName,
        ports,
        canDrillDown: !!childModule,
      } satisfies InstanceNodeData,
    });

    // Connect wires to instance ports
    if (Object.keys(inst.connections).length > 0) {
      for (const [portName, wire] of Object.entries(inst.connections)) {
        const sig = cleanSignal(wire);
        if (!sig) continue;
        const portInfo = ports.find(p => p.name === portName);
        const dir = portInfo?.direction || 'input';

        if (dir === 'input' || dir === 'inout') {
          addConsumer(sig, instId, portName);
        }
        if (dir === 'output' || dir === 'inout') {
          signalProducers.set(sig, { nodeId: instId, handleId: portName });
        }
      }
    } else if (inst.positionalArgs) {
      inst.positionalArgs.forEach((arg, i) => {
        const sig = cleanSignal(arg);
        if (!sig) return;
        const pName = ports[i]?.name || `p${i}`;
        const dir = ports[i]?.direction || 'input';
        if (dir === 'input' || dir === 'inout') {
          addConsumer(sig, instId, pName);
        }
        if (dir === 'output' || dir === 'inout') {
          signalProducers.set(sig, { nodeId: instId, handleId: pName });
        }
      });
    }
  }

  // 4) Gate primitives
  for (let gi = 0; gi < targetModule.gatePrimitives.length; gi++) {
    const gate = targetModule.gatePrimitives[gi];
    const gateId = `gate-${gate.instanceName || gi}`;
    nodes.push({
      id: gateId,
      type: 'gate',
      position: { x: 0, y: 0 },
      data: {
        label: gate.instanceName || gate.gate.toUpperCase(),
        gateType: gate.gate,
        inputs: gate.inputs,
        output: gate.output,
        instanceName: gate.instanceName,
      } satisfies GateNodeData,
    });

    signalProducers.set(gate.output, { nodeId: gateId, handleId: 'out' });
    gate.inputs.forEach((inp, i) => {
      addConsumer(inp, gateId, `in-${i}`);
    });
  }

  // 5) Continuous assignments
  for (let ai = 0; ai < targetModule.assigns.length; ai++) {
    const assign = targetModule.assigns[ai];
    const assignId = `assign-${ai}`;
    nodes.push({
      id: assignId,
      type: 'assign',
      position: { x: 0, y: 0 },
      data: {
        label: `assign ${assign.target}`,
        expression: assign.expression,
        target: assign.target,
      } satisfies AssignNodeData,
    });

    signalProducers.set(assign.target, { nodeId: assignId });

    // Parse expression to find referenced signals
    const exprSignals = extractSignals(assign.expression, targetModule);
    for (const sig of exprSignals) {
      addConsumer(sig, assignId);
    }
  }

  // 6) Always blocks
  for (let bi = 0; bi < targetModule.alwaysBlocks.length; bi++) {
    const block = targetModule.alwaysBlocks[bi];
    const blockId = `always-${bi}`;
    nodes.push({
      id: blockId,
      type: 'always',
      position: { x: 0, y: 0 },
      data: {
        label: `always @(${block.sensitivity})`,
        sensitivity: block.sensitivity,
        blockType: block.type,
      } satisfies AlwaysNodeData,
    });

    // Extract signals from sensitivity list and body for connections
    const sensSignals = extractSignals(block.sensitivity, targetModule);
    for (const sig of sensSignals) {
      addConsumer(sig, blockId);
    }

    // Extract output signals (targets of assignments in the body)
    const assignTargets = extractAssignTargets(block.body);
    for (const target of assignTargets) {
      signalProducers.set(target, { nodeId: blockId });
    }

    // Extract input signals from body
    const bodySignals = extractSignals(block.body, targetModule);
    for (const sig of bodySignals) {
      if (!assignTargets.has(sig)) {
        addConsumer(sig, blockId);
      }
    }
  }

  // Build edges from producer→consumer relationships, deduplicating.
  // Use two-pass matching to handle bit-selects correctly:
  //   Forward: for each consumer signal, find its producer (exact match, then base name fallback)
  //   Reverse: for each bit-selected producer, connect to base-name consumers (e.g. s[0] → output port s)
  const seenEdges = new Set<string>();
  let edgeIdx = 0;

  function findProducer(signal: string) {
    return signalProducers.get(signal) ?? signalProducers.get(baseSignal(signal));
  }

  function addEdge(producer: { nodeId: string; handleId?: string }, consumer: { nodeId: string; handleId?: string }, label: string) {
    if (producer.nodeId === consumer.nodeId) return;
    const key = `${producer.nodeId}:${producer.handleId || ''}->${consumer.nodeId}:${consumer.handleId || ''}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({
      id: `e-${edgeIdx++}`,
      source: producer.nodeId,
      sourceHandle: producer.handleId || undefined,
      target: consumer.nodeId,
      targetHandle: consumer.handleId || undefined,
      label,
      type: 'default',
      animated: false,
      style: { strokeWidth: 1.5 },
      labelStyle: { fontSize: 9, fill: '#888' },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
    });
  }

  // Forward pass: for each consumer signal, find its producer
  for (const [signal, consumers] of signalConsumers) {
    const producer = findProducer(signal);
    if (!producer) continue;
    for (const consumer of consumers) {
      addEdge(producer, consumer, signal);
    }
  }

  // Reverse pass: for producers with bit-selects (e.g. s[0]), connect to
  // base-name consumers (e.g. output port registered under "s")
  for (const [signal, producer] of signalProducers) {
    const base = baseSignal(signal);
    if (base === signal) continue; // no bit-select, already handled above
    const consumers = signalConsumers.get(base);
    if (!consumers) continue;
    for (const consumer of consumers) {
      addEdge(producer, consumer, signal);
    }
  }

  // Post-process: add junction dots on edges that fan out from the same source handle.
  // Count edges per source+sourceHandle.
  const sourceFanOut = new Map<string, number>();
  for (const e of edges) {
    const sk = `${e.source}:${e.sourceHandle || ''}`;
    sourceFanOut.set(sk, (sourceFanOut.get(sk) || 0) + 1);
  }
  for (const e of edges) {
    const sk = `${e.source}:${e.sourceHandle || ''}`;
    if ((sourceFanOut.get(sk) || 0) > 1) {
      (e as Edge & { markerStart?: string }).markerStart = 'schematic-junction-dot';
    }
  }

  return { nodes, edges };
}

function extractSignals(expr: string, mod: VerilogModule): Set<string> {
  const signals = new Set<string>();
  const allSignalNames = new Set([
    ...mod.ports.map(p => p.name),
    ...mod.wires.map(w => w.name),
    ...mod.regs.map(r => r.name),
  ]);
  const identifiers = expr.match(/\b[a-zA-Z_]\w*\b/g) || [];
  for (const id of identifiers) {
    if (allSignalNames.has(id)) {
      signals.add(id);
    }
  }
  return signals;
}

function extractAssignTargets(body: string): Set<string> {
  const targets = new Set<string>();
  const regex = /(\w+)\s*(?:\[\d+(?::\d+)?\])?\s*(?:<=|=)\s*/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const name = match[1];
    if (!['if', 'else', 'case', 'for', 'while', 'begin', 'end', 'reg', 'wire', 'integer'].includes(name)) {
      targets.add(name);
    }
  }
  return targets;
}

// ── Main Component ───────────────────────────────────────────────────────────

// ── Inner component (needs ReactFlow context) ───────────────────────────────

function SchematicViewerInner({
  parseResults,
  topModuleName,
  contentKey,
  requestedModuleName,
  resetKey,
  onNavigateToModule,
  onEdgeDiffChange,
  onConsoleMessage,
}: SchematicViewerProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [currentModule, setCurrentModule] = useState<string | null>(topModuleName);
  const [moduleStack, setModuleStack] = useState<string[]>([]);
  const [isLayouting, setIsLayouting] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [fluidEdges, setFluidEdges] = useState(true);
  const contextMenuPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const [contextMenuNode, setContextMenuNode] = useState<Node | null>(null);
  const [contextMenuEdge, setContextMenuEdge] = useState<Edge | null>(null);
  const nodeContextMenuFiredRef = useRef(false);
  const edgeContextMenuFiredRef = useRef(false);
  const [renameEdge, setRenameEdge] = useState<Edge | null>(null);
  const [renameGateNode, setRenameGateNode] = useState<Node | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [netlistSvg, setNetlistSvg] = useState<string | null>(null);
  const [isRenderingNetlist, setIsRenderingNetlist] = useState(false);
  const [showNetlistSvg, setShowNetlistSvg] = useState(true);
  const netlistSvgModuleRef = useRef<string | null>(null);
  const [svgTransform, setSvgTransform] = useState({ x: 0, y: 0, scale: 1 });
  const svgTransformRef = useRef(svgTransform);
  svgTransformRef.current = svgTransform;
  const svgDragRef = useRef<{ dragging: boolean; startX: number; startY: number; startTx: number; startTy: number } | null>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const svgNaturalSize = useRef<{ w: number; h: number } | null>(null);
  const reactFlowInstance = useReactFlow();
  const baselineEdgesRef = useRef<Edge[]>([]);
  const baselineNodesRef = useRef<Node[]>([]);

  const allModules = useMemo(() => {
    const modules: VerilogModule[] = [];
    for (const pr of parseResults) {
      modules.push(...pr.modules);
    }
    return modules;
  }, [parseResults]);

  // React to external module selection (e.g. sidebar file click)
  useEffect(() => {
    if (requestedModuleName && allModules.some(m => m.name === requestedModuleName)) {
      setCurrentModule(requestedModuleName);
      setModuleStack([]);
    }
  }, [requestedModuleName, allModules]);

  const effectiveModule = currentModule || topModuleName;
  const targetModule = useMemo(
    () => allModules.find(m => m.name === effectiveModule),
    [allModules, effectiveModule],
  );

  // Save positions whenever nodes are dragged
  const handleNodesChange: typeof onNodesChange = useCallback((changes) => {
    onNodesChange(changes);
    // After a drag ends, persist positions
    const hasDragStop = changes.some((c) => c.type === 'position' && !('dragging' in c && c.dragging));
    if (hasDragStop && effectiveModule) {
      // Use setTimeout so the state has settled
      setTimeout(() => {
        setNodes((current) => {
          savePositions(contentKey, effectiveModule, current);
          return current;
        });
      }, 0);
    }
  }, [onNodesChange, contentKey, effectiveModule, setNodes]);

  // Build and layout the graph whenever the target module changes
  useEffect(() => {
    if (!targetModule) return;

    const { nodes: rawNodes, edges: rawEdges } = buildGraph(targetModule, allModules);
    baselineEdgesRef.current = rawEdges;
    baselineNodesRef.current = rawNodes;

    if (rawNodes.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }

    // Check if we have cached positions for this content+module
    const cached = loadPositions(contentKey, effectiveModule || '');
    if (cached && rawNodes.every(n => cached.has(n.id))) {
      // Restore cached positions
      const restored = rawNodes.map(n => ({
        ...n,
        position: cached.get(n.id)!,
      }));
      setNodes(restored);
      setEdges(rawEdges);
      return;
    }

    setIsLayouting(true);
    layoutGraph(rawNodes, rawEdges).then(({ nodes: laid, edges: laidEdges }) => {
      setNodes(laid);
      setEdges(laidEdges);
      setIsLayouting(false);
      // Cache the initial layout positions
      if (effectiveModule) {
        savePositions(contentKey, effectiveModule, laid);
      }
    });
  }, [targetModule, allModules, contentKey, effectiveModule, setNodes, setEdges, resetKey]);

  // Handle new connection creation
  const handleConnect = useCallback((connection: Connection) => {
    setEdges((eds) => rfAddEdge({
      ...connection,
      id: `user-e-${Date.now()}`,
      type: fluidEdges ? 'default' : 'step',
      style: { strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
    }, eds));
  }, [setEdges, fluidEdges]);

  // Compute and report edge + node diff whenever edges or nodes change
  useEffect(() => {
    if (!onEdgeDiffChange || !effectiveModule) return;
    const baseline = baselineEdgesRef.current;
    const edgeKey = (e: Edge) => `${e.source}:${e.sourceHandle || ''}->${e.target}:${e.targetHandle || ''}`;
    const baseSet = new Set(baseline.map(edgeKey));
    const currSet = new Set(edges.map(edgeKey));

    const added: SchematicEdgeInfo[] = [];
    const removed: SchematicEdgeInfo[] = [];

    for (const e of edges) {
      if (!baseSet.has(edgeKey(e))) {
        added.push({ source: e.source, sourceHandle: e.sourceHandle || undefined, target: e.target, targetHandle: e.targetHandle || undefined, label: typeof e.label === 'string' ? e.label : undefined });
      }
    }
    for (const e of baseline) {
      if (!currSet.has(edgeKey(e))) {
        removed.push({ source: e.source, sourceHandle: e.sourceHandle || undefined, target: e.target, targetHandle: e.targetHandle || undefined, label: typeof e.label === 'string' ? e.label : undefined });
      }
    }

    // Detect signal renames (edge label changes for edges that exist in both baseline and current)
    const baseEdgeLabelMap = new Map<string, string>();
    for (const e of baseline) {
      const lbl = typeof e.label === 'string' ? e.label : '';
      if (lbl) baseEdgeLabelMap.set(edgeKey(e), lbl);
    }
    const renamedSignals: RenamedSignal[] = [];
    const seenRenames = new Set<string>();
    for (const e of edges) {
      const key = edgeKey(e);
      const baseLabel = baseEdgeLabelMap.get(key);
      const currLabel = typeof e.label === 'string' ? e.label : '';
      if (baseLabel && currLabel && baseLabel !== currLabel && !seenRenames.has(baseLabel)) {
        renamedSignals.push({ oldName: baseLabel, newName: currLabel });
        seenRenames.add(baseLabel);
      }
    }

    // Detect added and deleted nodes
    const baselineNodes = baselineNodesRef.current;
    const baseNodeIds = new Set(baselineNodes.map(n => n.id));
    const currNodeIds = new Set(nodes.map(n => n.id));

    const addedNodes: AddedNodeInfo[] = [];
    for (const n of nodes) {
      if (!baseNodeIds.has(n.id)) {
        if (n.type === 'gate') {
          const data = n.data as GateNodeData;
          addedNodes.push({ nodeId: n.id, type: 'gate', gateType: data.gateType, inputCount: data.inputs.length });
        } else if (n.type === 'instance') {
          const data = n.data as InstanceNodeData;
          addedNodes.push({ nodeId: n.id, type: 'instance', moduleName: data.moduleName, portNames: data.ports.map(p => p.name) });
        }
      }
    }

    const deletedNodes: DeletedNodeInfo[] = [];
    for (const n of baselineNodes) {
      if (!currNodeIds.has(n.id)) {
        if (n.type === 'gate') {
          const data = n.data as GateNodeData;
          deletedNodes.push({ nodeId: n.id, type: 'gate', gateType: data.gateType });
        } else if (n.type === 'instance') {
          const data = n.data as InstanceNodeData;
          deletedNodes.push({ nodeId: n.id, type: 'instance', instanceName: data.label, moduleName: data.moduleName });
        } else if (n.type === 'port') {
          const data = n.data as PortNodeData;
          deletedNodes.push({ nodeId: n.id, type: 'port', portName: data.label, portDirection: data.direction });
        }
      }
    }

    // Detect gate instance name renames
    const baseNodeMap = new Map(baselineNodes.map(n => [n.id, n]));
    const renamedGates: RenamedGate[] = [];
    for (const n of nodes) {
      if (n.type === 'gate' && baseNodeMap.has(n.id)) {
        const baseNode = baseNodeMap.get(n.id)!;
        const baseData = baseNode.data as GateNodeData;
        const currData = n.data as GateNodeData;
        if (currData.label !== baseData.label) {
          renamedGates.push({
            nodeId: n.id,
            gateType: currData.gateType,
            oldInstanceName: baseData.instanceName || '',
            newInstanceName: currData.label,
          });
        }
      }
    }

    onEdgeDiffChange({ added, removed, addedNodes, deletedNodes, renamedSignals, renamedGates }, effectiveModule);
  }, [edges, nodes, onEdgeDiffChange, effectiveModule]);

  const handleNodeClick = useCallback((_: React.MouseEvent, _node: Node) => {
    // No auto-drill-down on click; use right-click → "View Module" instead
  }, []);

  // Right-click on a node: record it so the context menu shows node-specific items
  const handleNodeContextMenu = useCallback((_event: React.MouseEvent, node: Node) => {
    nodeContextMenuFiredRef.current = true;
    setContextMenuNode(node);
    setContextMenuEdge(null);
  }, []);

  // Right-click on an edge: record it so the context menu shows edge-specific items
  const handleEdgeContextMenu = useCallback((_event: React.MouseEvent, edge: Edge) => {
    edgeContextMenuFiredRef.current = true;
    setContextMenuEdge(edge);
    setContextMenuNode(null);
  }, []);

  // Drill into a module from the context menu
  const handleViewModule = useCallback(() => {
    if (!contextMenuNode || contextMenuNode.type !== 'instance') return;
    const data = contextMenuNode.data as InstanceNodeData;
    if (data.canDrillDown) {
      setModuleStack(prev => [...prev, effectiveModule || '']);
      setCurrentModule(data.moduleName);
      onNavigateToModule?.(data.moduleName);
    }
    setContextMenuNode(null);
  }, [contextMenuNode, effectiveModule, onNavigateToModule]);

  // Delete a node from the canvas
  const handleDeleteNode = useCallback(() => {
    if (!contextMenuNode) return;
    const nodeId = contextMenuNode.id;
    setNodes(nds => nds.filter(n => n.id !== nodeId));
    setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId));
    setContextMenuNode(null);
  }, [contextMenuNode, setNodes, setEdges]);

  // Open rename dialog for a connection
  const handleRenameEdgeOpen = useCallback(() => {
    if (!contextMenuEdge) return;
    const currentLabel = typeof contextMenuEdge.label === 'string' ? contextMenuEdge.label : '';
    setRenameValue(currentLabel);
    setRenameEdge(contextMenuEdge);
    setContextMenuEdge(null);
  }, [contextMenuEdge]);

  // Apply edge rename
  const handleRenameEdgeConfirm = useCallback(() => {
    if (!renameEdge) return;
    setEdges(eds => eds.map(e =>
      e.id === renameEdge.id ? { ...e, label: renameValue || undefined } : e
    ));
    setRenameEdge(null);
    setRenameValue('');
  }, [renameEdge, renameValue, setEdges]);

  // Delete a connection from the canvas
  const handleDeleteEdge = useCallback(() => {
    if (!contextMenuEdge) return;
    setEdges(eds => eds.filter(e => e.id !== contextMenuEdge.id));
    setContextMenuEdge(null);
  }, [contextMenuEdge, setEdges]);

  // Open rename dialog for a gate
  const handleRenameGateOpen = useCallback(() => {
    if (!contextMenuNode || contextMenuNode.type !== 'gate') return;
    const data = contextMenuNode.data as GateNodeData;
    setRenameValue(data.label);
    setRenameGateNode(contextMenuNode);
    setContextMenuNode(null);
  }, [contextMenuNode]);

  // Apply gate rename
  const handleRenameGateConfirm = useCallback(() => {
    if (!renameGateNode || !renameValue.trim()) return;
    setNodes(nds => nds.map(n =>
      n.id === renameGateNode.id
        ? { ...n, data: { ...n.data, label: renameValue.trim() } }
        : n
    ));
    setRenameGateNode(null);
    setRenameValue('');
  }, [renameGateNode, renameValue, setNodes]);

  const handleZoomIn = useCallback(() => { reactFlowInstance.zoomIn({ duration: 200 }); }, [reactFlowInstance]);
  const handleZoomOut = useCallback(() => { reactFlowInstance.zoomOut({ duration: 200 }); }, [reactFlowInstance]);
  const handleFitView = useCallback(() => { reactFlowInstance.fitView({ padding: 0.2, duration: 300 }); }, [reactFlowInstance]);
  const handleToggleLock = useCallback(() => { setIsLocked(l => !l); }, []);
  const handleToggleFluid = useCallback(() => {
    setFluidEdges(prev => {
      const next = !prev;
      setEdges(eds => eds.map(e => ({ ...e, type: next ? 'default' : 'step' })));
      return next;
    });
  }, [setEdges]);

  // Render netlist SVG for a given module
  const renderNetlistSvg = useCallback(async (mod: VerilogModule) => {
    setIsRenderingNetlist(true);
    const log = (type: 'info' | 'error' | 'success' | 'warning', msg: string) => {
      onConsoleMessage?.(type, msg, 'NetlistSVG');
    };
    try {
      log('info', 'Loading netlistsvg module...');
      const { render, skin } = await getNetlistSvg();
      log('info', 'Converting Verilog AST to Yosys JSON...');
      const yosysJson = verilogModuleToYosysJson(mod, allModules);
      log('info', 'Rendering SVG layout...');
      let svg = await render(skin, yosysJson);
      // Pre-process SVG: extract dimensions and add viewBox so the inline ref
      // doesn't need to modify the DOM on every re-render (which resets zoom/pan).
      const widthMatch = svg.match(/<svg[^>]*\bwidth="([^"]+)"/);
      const heightMatch = svg.match(/<svg[^>]*\bheight="([^"]+)"/);
      if (widthMatch && heightMatch && !/<svg[^>]*\bviewBox\b/.test(svg)) {
        const pw = parseFloat(widthMatch[1]);
        const ph = parseFloat(heightMatch[1]);
        svg = svg.replace(
          /<svg([^>]*)>/,
          (_, attrs) => {
            let cleaned = attrs.replace(/\bwidth="[^"]*"/, '').replace(/\bheight="[^"]*"/, '');
            return `<svg${cleaned} viewBox="0 0 ${pw} ${ph}" style="width:${pw}px;height:${ph}px">`;
          }
        );
        svgNaturalSize.current = { w: pw, h: ph };
      }
      log('success', `SVG rendered (${svg.length} chars)`);
      setNetlistSvg(svg);
      netlistSvgModuleRef.current = mod.name;
    } catch (err) {
      log('error', `Render failed: ${(err as Error).message}`);
      console.error('[NetlistSVG] Render failed:', err);
    } finally {
      setIsRenderingNetlist(false);
    }
  }, [onConsoleMessage, allModules]);

  // SVG pan/zoom handlers — use native wheel listener to allow preventDefault on non-passive event
  const handleSvgWheelRef = useRef<(e: WheelEvent) => void>(null);
  handleSvgWheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.95 : 1.05;
    setSvgTransform(prev => {
      const rect = svgContainerRef.current?.getBoundingClientRect();
      if (!rect) return { ...prev, scale: Math.max(0.1, Math.min(10, prev.scale * delta)) };
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const newScale = Math.max(0.1, Math.min(10, prev.scale * delta));
      const ratio = newScale / prev.scale;
      return { x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio, scale: newScale };
    });
  };

  useEffect(() => {
    const el = svgContainerRef.current;
    if (!el || !showNetlistSvg) return;
    const handler = (e: WheelEvent) => handleSvgWheelRef.current?.(e);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [showNetlistSvg, netlistSvg]);

  const handleSvgPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const t = svgTransformRef.current;
    svgDragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, startTx: t.x, startTy: t.y };
    svgContainerRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const handleSvgPointerMove = useCallback((e: React.PointerEvent) => {
    const d = svgDragRef.current;
    if (!d || !d.dragging) return;
    setSvgTransform(prev => ({ ...prev, x: d.startTx + (e.clientX - d.startX), y: d.startTy + (e.clientY - d.startY) }));
  }, []);

  const handleSvgPointerUp = useCallback(() => {
    svgDragRef.current = null;
  }, []);

  const handleSvgPointerCancel = useCallback(() => {
    svgDragRef.current = null;
  }, []);

  const handleSvgFitView = useCallback(() => {
    const container = svgContainerRef.current;
    const sz = svgNaturalSize.current;
    if (!container || !sz) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const padding = 60;
    const availW = rect.width - padding * 2;
    const availH = rect.height - padding * 2;
    if (availW <= 0 || availH <= 0) return;
    const scale = Math.min(availW / sz.w, availH / sz.h, 1);
    const x = (rect.width - sz.w * scale) / 2;
    const y = (rect.height - sz.h * scale) / 2;
    setSvgTransform({ x, y, scale });
  }, []);

  const handleSvgZoomIn = useCallback(() => {
    setSvgTransform(prev => {
      const container = svgContainerRef.current;
      if (!container) return { ...prev, scale: Math.min(10, prev.scale * 1.3) };
      const rect = container.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const newScale = Math.min(10, prev.scale * 1.3);
      const ratio = newScale / prev.scale;
      return { x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio, scale: newScale };
    });
  }, []);

  const handleSvgZoomOut = useCallback(() => {
    setSvgTransform(prev => {
      const container = svgContainerRef.current;
      if (!container) return { ...prev, scale: Math.max(0.1, prev.scale / 1.3) };
      const rect = container.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const newScale = Math.max(0.1, prev.scale / 1.3);
      const ratio = newScale / prev.scale;
      return { x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio, scale: newScale };
    });
  }, []);

  // Auto fit-view when SVG is first rendered
  useEffect(() => {
    if (showNetlistSvg && netlistSvg && svgNaturalSize.current) {
      // Small delay to ensure container is measured
      requestAnimationFrame(() => handleSvgFitView());
    }
  }, [netlistSvg, showNetlistSvg, handleSvgFitView]);

  // Toggle netlist SVG view
  const handleToggleNetlistSvg = useCallback(async () => {
    if (showNetlistSvg) {
      setShowNetlistSvg(false);
      toast.warning('Experimental Feature', {
        description: 'Schematic editing is experimental and may not work as expected.',
      });
      return;
    }
    if (!targetModule) return;
    setShowNetlistSvg(true);
    renderNetlistSvg(targetModule);
  }, [showNetlistSvg, targetModule, renderNetlistSvg]);

  // Re-render SVG when module changes while in SVG mode
  useEffect(() => {
    if (showNetlistSvg && targetModule && targetModule.name !== netlistSvgModuleRef.current) {
      renderNetlistSvg(targetModule);
    }
  }, [showNetlistSvg, targetModule, renderNetlistSvg]);

  // Right-click position capture (screen → flow coords)
  const handlePaneContextMenu = useCallback((event: React.MouseEvent) => {
    // If onNodeContextMenu or onEdgeContextMenu already fired this cycle, keep that state
    if (nodeContextMenuFiredRef.current) {
      nodeContextMenuFiredRef.current = false;
    } else {
      setContextMenuNode(null);
    }
    if (edgeContextMenuFiredRef.current) {
      edgeContextMenuFiredRef.current = false;
    } else {
      setContextMenuEdge(null);
    }
    const flowPos = reactFlowInstance.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    contextMenuPosRef.current = flowPos;
  }, [reactFlowInstance]);

  // Standard gate primitives available for adding
  const STANDARD_GATES = ['and', 'or', 'xor', 'not', 'nand', 'nor', 'xnor', 'buf'] as const;

  // Custom modules (user-defined, excluding the current module being viewed)
  const customModules = useMemo(
    () => allModules.filter(m => m.name !== effectiveModule),
    [allModules, effectiveModule],
  );

  // Add a new gate primitive to the canvas
  const handleAddGate = useCallback((gateType: string) => {
    const pos = contextMenuPosRef.current;
    const inputCount = gateType === 'not' || gateType === 'buf' ? 1 : 2;
    const inputs = Array.from({ length: inputCount }, (_, i) => `in${i}`);
    const newNode: Node = {
      id: `gate-new-${Date.now()}`,
      type: 'gate',
      position: { x: pos.x, y: pos.y },
      data: {
        label: gateType.toUpperCase(),
        gateType,
        inputs,
        output: 'out',
      } satisfies GateNodeData,
    };
    setNodes(nds => [...nds, newNode]);
  }, [setNodes]);

  // Add a new module instance to the canvas
  const handleAddInstance = useCallback((moduleName: string) => {
    const pos = contextMenuPosRef.current;
    const childModule = allModules.find(m => m.name === moduleName);
    const ports: InstanceNodeData['ports'] = childModule
      ? childModule.ports.map(p => ({ name: p.name, direction: p.direction }))
      : [{ name: 'in', direction: 'input' }, { name: 'out', direction: 'output' }];
    const instanceName = `${moduleName}_${Date.now()}`;
    const newNode: Node = {
      id: `inst-${instanceName}`,
      type: 'instance',
      position: { x: pos.x, y: pos.y },
      data: {
        label: instanceName,
        moduleName,
        ports,
        canDrillDown: !!childModule,
      } satisfies InstanceNodeData,
    };
    setNodes(nds => [...nds, newNode]);
  }, [setNodes, allModules]);

  // Drag-and-drop from gate palette
  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const gateType = event.dataTransfer.getData('application/schematic-gate');
    if (!gateType) return;
    const pos = reactFlowInstance.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    const inputCount = gateType === 'not' || gateType === 'buf' ? 1 : 2;
    const inputs = Array.from({ length: inputCount }, (_, i) => `in${i}`);
    const newNode: Node = {
      id: `gate-new-${Date.now()}`,
      type: 'gate',
      position: pos,
      data: {
        label: gateType.toUpperCase(),
        gateType,
        inputs,
        output: 'out',
      } satisfies GateNodeData,
    };
    setNodes(nds => [...nds, newNode]);
  }, [reactFlowInstance, setNodes]);

  // Inject junction-dot marker into React Flow's own marker SVG so url(#id) resolves
  useEffect(() => {
    const el = containerRef.current?.querySelector('.react-flow__marker defs');
    if (!el || el.querySelector('#schematic-junction-dot')) return;
    const ns = 'http://www.w3.org/2000/svg';
    const marker = document.createElementNS(ns, 'marker');
    marker.id = 'schematic-junction-dot';
    marker.setAttribute('viewBox', '-4 -4 8 8');
    marker.setAttribute('refX', '0');
    marker.setAttribute('refY', '0');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('markerUnits', 'strokeWidth');
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '0');
    circle.setAttribute('cy', '0');
    circle.setAttribute('r', '2.5');
    circle.setAttribute('fill', 'currentColor');
    circle.setAttribute('opacity', '0.5');
    marker.appendChild(circle);
    el.appendChild(marker);
  }, [nodes, edges]);

  // Auto-select another module when the current one is deleted
  useEffect(() => {
    if (!targetModule && allModules.length > 0) {
      setCurrentModule(allModules[0].name);
      setModuleStack([]);
    }
  }, [targetModule, allModules]);

  if (allModules.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <p className="text-lg">No Schematic Available</p>
          <p className="text-xs">Write or open a Verilog design to view its schematic diagram.</p>
        </div>
      </div>
    );
  }

  if (!targetModule) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <p className="text-lg">Module Not Found</p>
          <p className="text-xs">Module &quot;{effectiveModule}&quot; was not found in the design files.</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full w-full relative">
      {/* Breadcrumb navigation */}
      <div className="absolute top-2 left-2 z-20 flex items-center gap-1 bg-background/80 backdrop-blur border border-border rounded-md px-2 py-1 text-xs font-mono">
        {moduleStack.map((m, i) => (
          <span key={i} className="text-muted-foreground">
            <button
              onClick={() => {
                setModuleStack(s => s.slice(0, i));
                setCurrentModule(m);
              }}
              className="hover:text-foreground"
            >
              {m}
            </button>
            <span className="mx-1 opacity-40">/</span>
          </span>
        ))}
        <span className="text-foreground font-medium">{effectiveModule}</span>
      </div>

      {/* Module selector - shadcn DropdownMenu */}
      {allModules.length > 1 && (
        <div className="absolute top-2 right-2 z-20">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm" className="h-7 text-xs font-mono bg-background/80 backdrop-blur">
                  {effectiveModule}
                  <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-70" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {allModules.map(m => (
                <DropdownMenuItem
                  key={m.name}
                  onClick={() => {
                    setCurrentModule(m.name);
                    setModuleStack([]);
                  }}
                  className="font-mono text-xs"
                >
                  {m.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {isLayouting && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/50">
          <span className="text-sm text-muted-foreground animate-pulse">Laying out schematic...</span>
        </div>
      )}

      {showNetlistSvg && !netlistSvg && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background">
          <span className="text-sm text-muted-foreground animate-pulse">Rendering netlist SVG...</span>
        </div>
      )}

      {showNetlistSvg && netlistSvg && (
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                ref={svgContainerRef}
                className="absolute inset-0 z-10 h-full w-full overflow-hidden bg-background cursor-grab active:cursor-grabbing select-none"
                style={{ backgroundImage: 'radial-gradient(circle, color-mix(in srgb, currentColor 15%, transparent) 1px, transparent 1px)', backgroundSize: '16px 16px', touchAction: 'none' }}
                onPointerDown={handleSvgPointerDown}
                onPointerMove={handleSvgPointerMove}
                onPointerUp={handleSvgPointerUp}
                onPointerLeave={handleSvgPointerUp}
                onPointerCancel={handleSvgPointerCancel}
              />
            }
          >
            <div
              style={{
                transform: `translate(${svgTransform.x}px, ${svgTransform.y}px) scale(${svgTransform.scale})`,
                transformOrigin: '0 0',
                width: svgNaturalSize.current ? `${svgNaturalSize.current.w}px` : undefined,
                height: svgNaturalSize.current ? `${svgNaturalSize.current.h}px` : undefined,
                willChange: 'transform',
              }}
              dangerouslySetInnerHTML={{ __html: netlistSvg }}
            />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={handleSvgZoomIn}>
              <ZoomIn className="h-4 w-4" />
              <span>Zoom In</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={handleSvgZoomOut}>
              <ZoomOut className="h-4 w-4" />
              <span>Zoom Out</span>
            </ContextMenuItem>
            <ContextMenuItem onClick={handleSvgFitView}>
              <Maximize className="h-4 w-4" />
              <span>Fit to View</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={handleToggleNetlistSvg}>
              <Pencil className="h-4 w-4" />
              <span>Edit</span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      {/* Controls toolbar — always visible above overlay */}
      <div className="absolute bottom-2 left-2 z-30">
        <TooltipProvider>
          <div className="flex flex-col gap-1.5 items-start">
            {!showNetlistSvg && (
              <div className="flex flex-col gap-0.5 rounded-md border border-border bg-muted/80 backdrop-blur p-0.5 shadow-sm">
                {STANDARD_GATES.map(gate => (
                  <Tooltip key={gate}>
                    <TooltipTrigger
                      render={
                        <div
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/schematic-gate', gate);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          className="flex items-center justify-center h-7 w-7 rounded cursor-grab hover:bg-accent active:cursor-grabbing transition-colors select-none text-muted-foreground hover:text-foreground"
                        />
                      }
                    >
                      <GateIconMini gateType={gate} />
                    </TooltipTrigger>
                    <TooltipContent side="right">{gate.toUpperCase()}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-0.5 rounded-md border border-border bg-muted/80 backdrop-blur p-0.5 shadow-sm">
              <Tooltip>
                <TooltipTrigger render={<button onClick={showNetlistSvg ? handleSvgZoomIn : handleZoomIn} className="flex items-center justify-center h-7 w-7 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" />}>
                  <ZoomIn className="h-3.5 w-3.5" />
                </TooltipTrigger>
                <TooltipContent side="right">Zoom In</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<button onClick={showNetlistSvg ? handleSvgZoomOut : handleZoomOut} className="flex items-center justify-center h-7 w-7 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" />}>
                  <ZoomOut className="h-3.5 w-3.5" />
                </TooltipTrigger>
                <TooltipContent side="right">Zoom Out</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<button onClick={showNetlistSvg ? handleSvgFitView : handleFitView} className="flex items-center justify-center h-7 w-7 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" />}>
                  <Maximize className="h-3.5 w-3.5" />
                </TooltipTrigger>
                <TooltipContent side="right">Fit View</TooltipContent>
              </Tooltip>
              {!showNetlistSvg && (
                <>
                  <div className="h-px bg-border mx-0.5" />
                  <Tooltip>
                    <TooltipTrigger render={<button onClick={handleToggleLock} className={`flex items-center justify-center h-7 w-7 rounded hover:bg-accent transition-colors ${isLocked ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`} />}>
                      {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                    </TooltipTrigger>
                    <TooltipContent side="right">{isLocked ? 'Unlock Canvas' : 'Lock Canvas'}</TooltipContent>
                  </Tooltip>
                  <div className="h-px bg-border mx-0.5" />
                  <Tooltip>
                    <TooltipTrigger render={<button onClick={handleToggleFluid} className={`flex items-center justify-center h-7 w-7 rounded hover:bg-accent transition-colors ${fluidEdges ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`} />}>
                      <Spline className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent side="right">{fluidEdges ? 'Orthogonal Edges' : 'Fluid Curves'}</TooltipContent>
                  </Tooltip>
                </>
              )}
              <div className="h-px bg-border mx-0.5" />
              <Tooltip>
                <TooltipTrigger render={<button onClick={handleToggleNetlistSvg} disabled={isRenderingNetlist} className="flex items-center justify-center h-7 w-7 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" />}>
                  {showNetlistSvg ? <Pencil className="h-3.5 w-3.5" /> : <FileImage className="h-3.5 w-3.5" />}
                </TooltipTrigger>
                <TooltipContent side="right">{showNetlistSvg ? 'Edit' : 'Netlist SVG'}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </TooltipProvider>
      </div>

      <ContextMenu>
        <ContextMenuTrigger className="h-full w-full" onContextMenu={handlePaneContextMenu}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onNodeClick={handleNodeClick}
            onNodeContextMenu={handleNodeContextMenu}
            onEdgeContextMenu={handleEdgeContextMenu}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            nodeTypes={nodeTypes}
            nodesDraggable={!isLocked}
            nodesConnectable={!isLocked}
            elementsSelectable={!isLocked}
            fitView
            minZoom={0.1}
            maxZoom={4}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
              type: fluidEdges ? 'default' : 'step',
              style: { strokeWidth: 1.5 },
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="!bg-background" />
            {/* Gate palette and controls are rendered outside ReactFlow as an overlay (z-30) */}
            <MiniMap
              className="!rounded-md !border !border-border !bg-muted/80 !shadow-sm !w-[120px] !h-[80px]"
              nodeStrokeWidth={1}
              nodeBorderRadius={1}
              style={{
                '--xy-minimap-mask-background-color-props': 'rgba(0,0,0,0.04)',
                '--xy-minimap-mask-stroke-color-props': 'rgba(0,0,0,0.15)',
                '--xy-minimap-mask-stroke-width-props': '1',
                '--xy-minimap-node-background-color-props': 'currentColor',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                overflow: 'hidden',
              } as React.CSSProperties}
              maskColor="rgba(0,0,0,0.04)"
              nodeColor={(n) => {
                switch (n.type) {
                  case 'port': return '#10b981';
                  case 'instance': return '#3b82f6';
                  case 'gate': return '#f59e0b';
                  case 'assign': return '#06b6d4';
                  case 'always': return '#f43f5e';
                  default: return '#888';
                }
              }}
            />
          </ReactFlow>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {contextMenuNode ? (
            <>
              {/* Node-specific context menu */}
              {contextMenuNode.type === 'instance' && (contextMenuNode.data as InstanceNodeData).canDrillDown && (
                <>
                  <ContextMenuItem onClick={handleViewModule}>
                    <Eye className="h-4 w-4" />
                    <span>View Module</span>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              {contextMenuNode.type === 'gate' && (
                <>
                  <ContextMenuItem onClick={handleRenameGateOpen}>
                    <Pencil className="h-4 w-4" />
                    <span>Rename</span>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onClick={handleDeleteNode} variant="destructive">
                <Trash2 className="h-4 w-4" />
                <span>Delete</span>
              </ContextMenuItem>
            </>
          ) : contextMenuEdge ? (
            <>
              {/* Edge-specific context menu */}
              <ContextMenuItem onClick={handleRenameEdgeOpen}>
                <Pencil className="h-4 w-4" />
                <span>Rename Connection</span>
              </ContextMenuItem>
              <ContextMenuItem onClick={handleDeleteEdge} variant="destructive">
                <Trash2 className="h-4 w-4" />
                <span>Delete Connection</span>
              </ContextMenuItem>
            </>
          ) : (
            <>
              {/* Pane context menu */}
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Plus className="h-4 w-4" />
                  <span>Add</span>
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuGroup>
                    <ContextMenuLabel>Standard Gates</ContextMenuLabel>
                    {STANDARD_GATES.map(gate => (
                      <ContextMenuItem key={gate} onClick={() => handleAddGate(gate)}>
                        <span className="font-mono text-xs uppercase">{gate}</span>
                      </ContextMenuItem>
                    ))}
                  </ContextMenuGroup>
                  {customModules.length > 0 && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuGroup>
                        <ContextMenuLabel>Modules</ContextMenuLabel>
                        {customModules.map(m => (
                          <ContextMenuItem key={m.name} onClick={() => handleAddInstance(m.name)}>
                            <span className="font-mono text-xs">{m.name}</span>
                          </ContextMenuItem>
                        ))}
                      </ContextMenuGroup>
                    </>
                  )}
                </ContextMenuSubContent>
              </ContextMenuSub>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={handleZoomIn}>
                <ZoomIn className="h-4 w-4" />
                <span>Zoom In</span>
              </ContextMenuItem>
              <ContextMenuItem onClick={handleZoomOut}>
                <ZoomOut className="h-4 w-4" />
                <span>Zoom Out</span>
              </ContextMenuItem>
              <ContextMenuItem onClick={handleFitView}>
                <Maximize className="h-4 w-4" />
                <span>Fit to View</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={handleToggleLock}>
                {isLocked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                <span>{isLocked ? 'Unlock Canvas' : 'Lock Canvas'}</span>
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Rename dialog (shared for connections and gates) */}
      <Dialog
        open={!!renameEdge || !!renameGateNode}
        onOpenChange={(open) => { if (!open) { setRenameEdge(null); setRenameGateNode(null); setRenameValue(''); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{renameEdge ? 'Rename Connection' : 'Rename Gate'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); renameEdge ? handleRenameEdgeConfirm() : handleRenameGateConfirm(); }}>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={renameEdge ? 'Connection name' : 'Instance name'}
              autoFocus
              className="font-mono text-sm"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => { setRenameEdge(null); setRenameGateNode(null); setRenameValue(''); }}>
                Cancel
              </Button>
              <Button type="submit">Rename</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Wrapper with ReactFlowProvider ───────────────────────────────────────────

export default function SchematicViewer(props: SchematicViewerProps) {
  return (
    <ReactFlowProvider>
      <SchematicViewerInner {...props} />
    </ReactFlowProvider>
  );
}
