// Verilog Code Generation — maps schematic edge/node changes back to Verilog source edits

import type { VerilogModule, VerilogGatePrimitive, VerilogInstance } from './verilog-parser';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SchematicEdgeInfo {
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  label?: string;
}

export interface AddedNodeInfo {
  nodeId: string;      // React Flow node ID
  type: 'gate' | 'instance';
  gateType?: string;   // for gates: 'and', 'or', etc.
  moduleName?: string; // for instances
  inputCount?: number; // for gates
  portNames?: string[]; // for instances: ordered port names from child module
}

export interface DeletedNodeInfo {
  nodeId: string;
  type: 'gate' | 'instance' | 'port';
  gateType?: string;
  instanceName?: string;
  moduleName?: string;
  portName?: string;
  portDirection?: 'input' | 'output' | 'inout';
}

export interface RenamedSignal {
  oldName: string;
  newName: string;
}

export interface RenamedGate {
  nodeId: string;
  gateType: string;
  oldInstanceName: string;
  newInstanceName: string;
}

export interface EdgeDiff {
  added: SchematicEdgeInfo[];
  removed: SchematicEdgeInfo[];
  addedNodes?: AddedNodeInfo[];
  deletedNodes?: DeletedNodeInfo[];
  renamedSignals?: RenamedSignal[];
  renamedGates?: RenamedGate[];
}

export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  line: string;
}

// ── Node ID helpers ─────────────────────────────────────────────────────────

type NodeKind = 'port-in' | 'port-out' | 'inst' | 'gate' | 'assign' | 'always' | 'unknown';

function parseNodeId(id: string): { kind: NodeKind; name: string; isNew: boolean } {
  if (id.startsWith('port-in-')) return { kind: 'port-in', name: id.slice(8), isNew: false };
  if (id.startsWith('port-out-')) return { kind: 'port-out', name: id.slice(9), isNew: false };
  if (id.startsWith('inst-')) return { kind: 'inst', name: id.slice(5), isNew: id.includes('-new-') || /\d{10,}/.test(id) };
  if (id.startsWith('gate-')) {
    const name = id.slice(5);
    const isNew = name.startsWith('new-');
    return { kind: 'gate', name, isNew };
  }
  if (id.startsWith('assign-')) return { kind: 'assign', name: id.slice(7), isNew: false };
  if (id.startsWith('always-')) return { kind: 'always', name: id.slice(7), isNew: false };
  return { kind: 'unknown', name: id, isNew: false };
}

// ── Lookup helpers ──────────────────────────────────────────────────────────

function findGate(nodeId: string, mod: VerilogModule): VerilogGatePrimitive | null {
  const { kind, name, isNew } = parseNodeId(nodeId);
  if (kind !== 'gate' || isNew) return null;
  const idx = parseInt(name);
  if (!isNaN(idx) && idx < mod.gatePrimitives.length) return mod.gatePrimitives[idx];
  return mod.gatePrimitives.find(g => g.instanceName === name) ?? null;
}

function findInstance(nodeId: string, mod: VerilogModule): VerilogInstance | null {
  const { kind, name, isNew } = parseNodeId(nodeId);
  if (kind !== 'inst' || isNew) return null;
  return mod.instances.find(i => i.instanceName === name) ?? null;
}

/** Resolve the signal name that a given node+handle represents in the original AST. */
function resolveSignal(
  nodeId: string,
  handle: string | undefined,
  mod: VerilogModule,
  allModules: VerilogModule[],
): string | null {
  const { kind, name, isNew } = parseNodeId(nodeId);
  if (isNew) return null; // new nodes have no AST entry

  if (kind === 'port-in' || kind === 'port-out') return name;

  if (kind === 'gate') {
    const gate = findGate(nodeId, mod);
    if (!gate) return null;
    if (handle === 'out') return gate.output;
    const m = handle?.match(/^in-(\d+)$/);
    if (m) return gate.inputs[parseInt(m[1])] ?? null;
    return null;
  }

  if (kind === 'inst') {
    const inst = findInstance(nodeId, mod);
    if (!inst || !handle) return null;
    if (Object.keys(inst.connections).length > 0) {
      return inst.connections[handle] ?? null;
    }
    if (inst.positionalArgs) {
      const moduleMap = new Map(allModules.map(m => [m.name, m]));
      const childMod = moduleMap.get(inst.moduleName);
      if (childMod) {
        const portIdx = childMod.ports.findIndex(p => p.name === handle);
        if (portIdx >= 0) return inst.positionalArgs[portIdx] ?? null;
      }
    }
    return null;
  }

  if (kind === 'assign') {
    const idx = parseInt(name);
    const assign = mod.assigns[idx];
    if (assign) return assign.target;
    return null;
  }

  return null;
}

// ── Compute proposed source from edge diff ──────────────────────────────────

export function computeProposedSource(
  originalSource: string,
  edgeDiff: EdgeDiff,
  targetModule: VerilogModule,
  allModules: VerilogModule[],
): string {
  let source = originalSource;
  const moduleMap = new Map(allModules.map(m => [m.name, m]));

  const deletedNodeIds = new Set((edgeDiff.deletedNodes ?? []).map(n => n.nodeId));
  const newNodeIds = new Set((edgeDiff.addedNodes ?? []).map(n => n.nodeId));
  const addedNodes = edgeDiff.addedNodes ?? [];

  const knownSignals = new Set([
    ...targetModule.ports.map(p => p.name),
    ...targetModule.wires.map(w => w.name),
    ...targetModule.regs.map(r => r.name),
  ]);

  // ── Shared helpers (used across multiple phases) ────────────────────────
  const newNodeSignals = new Map<string, Map<string, string>>();
  let autoWireCounter = 0;
  const touchedGateArgs = new Map<number, Set<string>>();
  const extraWires = new Set<string>();
  const gateDesired = new Map<number, { output: string; inputs: string[] }>();

  function getNewNodeSignalMap(nodeId: string): Map<string, string> {
    let map = newNodeSignals.get(nodeId);
    if (!map) { map = new Map(); newNodeSignals.set(nodeId, map); }
    return map;
  }

  function genWireName(): string {
    return `w_auto_${autoWireCounter++}`;
  }

  function markTouched(gi: number, handle: string) {
    let s = touchedGateArgs.get(gi);
    if (!s) { s = new Set(); touchedGateArgs.set(gi, s); }
    s.add(handle);
  }

  function getGateDesired(gi: number): { output: string; inputs: string[] } {
    let d = gateDesired.get(gi);
    if (!d) {
      const gate = targetModule.gatePrimitives[gi];
      d = { output: gate.output, inputs: [...gate.inputs] };
      gateDesired.set(gi, d);
    }
    return d;
  }

  function gateIndexFromNodeId(nodeId: string): number | null {
    const gate = findGate(nodeId, targetModule);
    if (!gate) return null;
    const idx = targetModule.gatePrimitives.indexOf(gate);
    return idx >= 0 ? idx : null;
  }

  // ── Phase 0: Build signal map for new nodes ────────────────────────────
  // Build a set of (source, sourceHandle) pairs involved in removals —
  // used to detect when an existing node's output is being disconnected from a port
  const removedSourceHandles = new Set<string>();
  for (const edge of edgeDiff.removed) {
    removedSourceHandles.add(`${edge.source}::${edge.sourceHandle || ''}`);
  }

  // First pass: resolve signals from existing nodes connected to new nodes
  for (const edge of edgeDiff.added) {
    const srcIsNew = newNodeIds.has(edge.source);
    const tgtIsNew = newNodeIds.has(edge.target);
    const srcDeleted = deletedNodeIds.has(edge.source);
    const tgtDeleted = deletedNodeIds.has(edge.target);
    if (srcDeleted || tgtDeleted) continue;

    if (!srcIsNew && tgtIsNew) {
      // Existing source → new target: resolve signal from existing source
      // BUT if this source handle also has a removal (e.g. gate was driving a port,
      // now rewired through a new node), use an auto-wire instead of the original signal
      const srcHandleKey = `${edge.source}::${edge.sourceHandle || ''}`;
      if (removedSourceHandles.has(srcHandleKey)) {
        // Source handle is being disconnected from something else → use auto-wire
        const wire = genWireName();
        if (edge.targetHandle) getNewNodeSignalMap(edge.target).set(edge.targetHandle, wire);
        // Also pre-set the gate's desired output to this wire
        const srcGi = gateIndexFromNodeId(edge.source);
        if (srcGi !== null && edge.sourceHandle === 'out') {
          getGateDesired(srcGi).output = wire;
          markTouched(srcGi, 'out');
        }
      } else {
        const sig = resolveSignal(edge.source, edge.sourceHandle, targetModule, allModules);
        if (sig && edge.targetHandle) {
          getNewNodeSignalMap(edge.target).set(edge.targetHandle, sig);
        }
      }
    }

    if (srcIsNew && tgtIsNew) {
      // Both new: generate a connecting wire
      const wireName = genWireName();
      if (edge.sourceHandle) getNewNodeSignalMap(edge.source).set(edge.sourceHandle, wireName);
      if (edge.targetHandle) getNewNodeSignalMap(edge.target).set(edge.targetHandle, wireName);
    }

    if (srcIsNew && !tgtIsNew) {
      // New source → existing target
      const tgtParsed = parseNodeId(edge.target);
      if ((tgtParsed.kind === 'port-out' || tgtParsed.kind === 'port-in') && edge.sourceHandle) {
        // New node connecting to a port — use the port signal name directly
        // so the new node drives the port without needing an assign statement
        getNewNodeSignalMap(edge.source).set(edge.sourceHandle, tgtParsed.name);
      } else if (edge.sourceHandle) {
        // New node → existing non-port: generate auto-wire
        const existingMapping = getNewNodeSignalMap(edge.source).get(edge.sourceHandle);
        if (!existingMapping) {
          getNewNodeSignalMap(edge.source).set(edge.sourceHandle, genWireName());
        }
      }
    }
  }

  // ── Phase 1: Process edge changes for existing gates/instances ──────────
  // Process edge REMOVALS for existing gates and instances
  for (const edge of edgeDiff.removed) {
    if (deletedNodeIds.has(edge.source) || deletedNodeIds.has(edge.target)) continue;

    // Target is an existing gate — disconnecting an input or output
    const tgtGi = gateIndexFromNodeId(edge.target);
    if (tgtGi !== null && edge.targetHandle) {
      if (edge.targetHandle === 'out') {
        getGateDesired(tgtGi).output = '';
        markTouched(tgtGi, 'out');
      } else {
        const m = edge.targetHandle.match(/^in-(\d+)$/);
        if (m) {
          const d = getGateDesired(tgtGi);
          const inputIdx = parseInt(m[1]);
          if (inputIdx < d.inputs.length) {
            d.inputs[inputIdx] = '';
            markTouched(tgtGi, edge.targetHandle);
          }
        }
      }
    }

    // Target is a port-out — the source gate/instance was driving this port directly.
    // The source needs to write to an intermediate wire instead.
    const tgtParsed = parseNodeId(edge.target);
    if (tgtParsed.kind === 'port-out') {
      const srcGi = gateIndexFromNodeId(edge.source);
      if (srcGi !== null && edge.sourceHandle === 'out') {
        const d = getGateDesired(srcGi);
        // Only mark if not already updated by Phase 0 (which handles the rewire case)
        if (d.output === targetModule.gatePrimitives[srcGi].output) {
          d.output = '';
          markTouched(srcGi, 'out');
        }
      }
    }

    // Source is a port-in — the target gate/instance was reading this port.
    // Already handled by target-is-gate above (the gate input gets cleared).
    // No extra handling needed.

    // Target is an existing instance
    const tgt = parseNodeId(edge.target);
    if (tgt.kind === 'inst' && !tgt.isNew && edge.targetHandle) {
      const inst = findInstance(edge.target, targetModule);
      if (inst) {
        if (Object.keys(inst.connections).length > 0) {
          const wire = inst.connections[edge.targetHandle];
          if (wire) source = replaceInstanceConnection(source, inst.instanceName, edge.targetHandle, wire, '');
        } else if (inst.positionalArgs) {
          const childMod = moduleMap.get(inst.moduleName);
          if (childMod) {
            const portIdx = childMod.ports.findIndex(p => p.name === edge.targetHandle);
            if (portIdx >= 0 && portIdx < inst.positionalArgs.length) {
              source = replacePositionalArg(source, inst.instanceName, inst.moduleName, portIdx, inst.positionalArgs[portIdx], '');
            }
          }
        }
      }
    }

    // Source is an existing instance
    const src = parseNodeId(edge.source);
    if (src.kind === 'inst' && !src.isNew && edge.sourceHandle) {
      const inst = findInstance(edge.source, targetModule);
      if (inst) {
        if (Object.keys(inst.connections).length > 0) {
          const wire = inst.connections[edge.sourceHandle];
          if (wire) source = replaceInstanceConnection(source, inst.instanceName, edge.sourceHandle, wire, '');
        } else if (inst.positionalArgs) {
          const childMod = moduleMap.get(inst.moduleName);
          if (childMod) {
            const portIdx = childMod.ports.findIndex(p => p.name === edge.sourceHandle);
            if (portIdx >= 0 && portIdx < inst.positionalArgs.length) {
              source = replacePositionalArg(source, inst.instanceName, inst.moduleName, portIdx, inst.positionalArgs[portIdx], '');
            }
          }
        }
      }
    }
  }

  // Process edge ADDITIONS — including edges touching new nodes
  for (const edge of edgeDiff.added) {
    if (deletedNodeIds.has(edge.source) || deletedNodeIds.has(edge.target)) continue;

    const srcIsNew = newNodeIds.has(edge.source);
    const tgtIsNew = newNodeIds.has(edge.target);

    // Resolve signal: either from existing AST or from new-node auto-wire
    let signal: string | null = null;
    if (!srcIsNew) {
      signal = resolveSignal(edge.source, edge.sourceHandle, targetModule, allModules);
    } else {
      // Source is a new node — use the auto-generated wire from Phase 0
      signal = getNewNodeSignalMap(edge.source).get(edge.sourceHandle ?? '') ?? null;
    }

    if (!signal) continue;

    // Skip if target is a new node (handled when generating new node code)
    if (tgtIsNew) continue;

    // Target is an existing gate
    const tgtGi = gateIndexFromNodeId(edge.target);
    if (tgtGi !== null && edge.targetHandle) {
      const d = getGateDesired(tgtGi);
      if (edge.targetHandle === 'out') {
        d.output = signal;
      } else {
        const m = edge.targetHandle.match(/^in-(\d+)$/);
        if (m) {
          const inputIdx = parseInt(m[1]);
          if (inputIdx < d.inputs.length) {
            d.inputs[inputIdx] = signal;
          }
        }
      }
    }

    // Target is an existing instance
    const tgt = parseNodeId(edge.target);
    if (tgt.kind === 'inst' && !tgt.isNew && edge.targetHandle) {
      const inst = findInstance(edge.target, targetModule);
      if (inst) {
        if (Object.keys(inst.connections).length > 0) {
          const oldWire = inst.connections[edge.targetHandle] ?? '';
          source = replaceInstanceConnection(source, inst.instanceName, edge.targetHandle, oldWire, signal);
        } else if (inst.positionalArgs) {
          const childMod = moduleMap.get(inst.moduleName);
          if (childMod) {
            const portIdx = childMod.ports.findIndex(p => p.name === edge.targetHandle);
            if (portIdx >= 0 && portIdx < inst.positionalArgs.length) {
              source = replacePositionalArg(source, inst.instanceName, inst.moduleName, portIdx, inst.positionalArgs[portIdx], signal);
            }
          }
        }
      }
    }

    // Target is an output port
    if (tgt.kind === 'port-out' && signal !== tgt.name) {
      // Only update if the signal driving the port is different from the port name
      // (when signal === port name, the source node already drives the port directly)
      const existingAssign = targetModule.assigns.find(a => a.target === tgt.name);
      if (existingAssign) {
        source = replaceAssignExpression(source, tgt.name, existingAssign.expression, signal);
      }
    }

    // Source is an existing instance (added edge FROM instance output)
    const src = parseNodeId(edge.source);
    if (src.kind === 'inst' && !src.isNew && edge.sourceHandle) {
      // Updating the instance's output port connection — only if the wire changed
      // (Instance output connections are typically driven by the instance, not the consumer)
    }
  }

  // ── Phase 2: Apply gate whole-line replacements ────────────────────────
  for (const [gi, desired] of gateDesired) {
    const original = targetModule.gatePrimitives[gi];
    const touched = touchedGateArgs.get(gi);

    // For untouched empty args, restore original values.
    // For touched empty args (explicitly disconnected), generate an auto-wire.
    if (!desired.output) {
      if (touched && touched.has('out')) {
        const wire = genWireName();
        desired.output = wire;
        extraWires.add(wire);
      } else {
        desired.output = original.output;
      }
    }
    for (let i = 0; i < desired.inputs.length; i++) {
      if (!desired.inputs[i]) {
        if (touched && touched.has(`in-${i}`)) {
          const wire = genWireName();
          desired.inputs[i] = wire;
          extraWires.add(wire);
        } else {
          desired.inputs[i] = original.inputs[i];
        }
      }
    }
    if (desired.output === original.output && desired.inputs.every((inp, i) => inp === original.inputs[i])) {
      continue;
    }
    source = replaceGateLine(source, original, desired.output, desired.inputs);
  }

  // ── Phase 3: Delete nodes ──────────────────────────────────────────────
  if (edgeDiff.deletedNodes) {
    for (const deleted of edgeDiff.deletedNodes) {
      if (deleted.type === 'gate') {
        const gate = findGate(deleted.nodeId, targetModule);
        if (gate) source = removeGateLine(source, gate);
      } else if (deleted.type === 'instance' && deleted.instanceName && deleted.moduleName) {
        source = removeInstanceLine(source, deleted.moduleName, deleted.instanceName);
      } else if (deleted.type === 'port' && deleted.portName) {
        source = removePort(source, deleted.portName, targetModule.name);
      }
    }
  }

  // ── Phase 4: Insert new nodes + wire declarations ───────────────────────
  {
    const lines: string[] = [];
    let gateCounter = targetModule.gatePrimitives.length;
    let instCounter = targetModule.instances.length;

    // Collect all new wire names that need declaration (from new nodes + disconnections)
    const newWires = new Set<string>(extraWires);

    for (const node of addedNodes) {
      const signals = newNodeSignals.get(node.nodeId);
      if (!signals || signals.size === 0) continue; // skip unconnected

      if (node.type === 'gate' && node.gateType) {
        const inputCount = node.inputCount ?? 2;
        const instName = `${node.gateType}_g${gateCounter++}`;
        const outSignal = signals.get('out') || `${instName}_out`;
        const inSignals: string[] = [];
        for (let i = 0; i < inputCount; i++) {
          inSignals.push(signals.get(`in-${i}`) || `${instName}_in${i}`);
        }

        // Track auto-generated wires
        for (const s of [outSignal, ...inSignals]) {
          const base = s.replace(/\[.*\]$/, '');
          if (!knownSignals.has(base)) newWires.add(s);
        }
        lines.push(`  ${node.gateType} ${instName}(${outSignal}, ${inSignals.join(', ')});`);

      } else if (node.type === 'instance' && node.moduleName) {
        const childMod = moduleMap.get(node.moduleName);
        const instName = `${node.moduleName}_i${instCounter++}`;
        const portList = childMod?.ports ?? [];
        const portNames = portList.length > 0
          ? portList.map(p => p.name)
          : (node.portNames ?? []);

        if (portNames.length > 0) {
          const portConns = portNames.map(pName => `.${pName}(${signals.get(pName) || ''})`);
          lines.push(`  ${node.moduleName} ${instName}(${portConns.join(', ')});`);
        } else {
          lines.push(`  ${node.moduleName} ${instName}();`);
        }
      }
    }

    // Add wire declarations before gate/instance lines
    const wireDecls = Array.from(newWires).map(w => `  wire ${w};`);
    const allNewLines = [...wireDecls, ...lines];

    if (allNewLines.length > 0) {
      // Find the module in the (possibly modified) source by its declaration,
      // then locate the next `endmodule` after it.
      const modDeclPattern = new RegExp(`\\bmodule\\s+${escapeRegex(targetModule.name)}\\b`);
      const modDeclMatch = modDeclPattern.exec(source);
      if (modDeclMatch && modDeclMatch.index !== undefined) {
        const endIdx = source.indexOf('endmodule', modDeclMatch.index);
        if (endIdx >= 0) {
          source = source.slice(0, endIdx) + allNewLines.join('\n') + '\n' + source.slice(endIdx);
        }
      }
    }
  }

  // ── Phase 5: Rename gate instances ─────────────────────────────────────
  if (edgeDiff.renamedGates && edgeDiff.renamedGates.length > 0) {
    for (const rename of edgeDiff.renamedGates) {
      const gate = findGate(rename.nodeId, targetModule);
      if (gate) {
        // Replace the gate line with updated instance name
        source = renameGateInstance(source, gate, rename.newInstanceName);
      } else if (!rename.oldInstanceName) {
        // Gate had no instance name — add one
        // Find the gate by type and args
        const parsed = parseNodeId(rename.nodeId);
        if (parsed.kind === 'gate' && !parsed.isNew) {
          const idx = parseInt(parsed.name);
          const gateObj = !isNaN(idx) && idx < targetModule.gatePrimitives.length
            ? targetModule.gatePrimitives[idx]
            : targetModule.gatePrimitives.find(g => g.instanceName === parsed.name);
          if (gateObj) {
            source = renameGateInstance(source, gateObj, rename.newInstanceName);
          }
        }
      }
    }
  }

  // ── Phase 6: Apply signal renames (must be last — other phases match original names) ─
  if (edgeDiff.renamedSignals && edgeDiff.renamedSignals.length > 0) {
    const modDeclPat = new RegExp(`\\bmodule\\s+${escapeRegex(targetModule.name)}\\b`);
    const modMatch = modDeclPat.exec(source);
    if (modMatch && modMatch.index !== undefined) {
      const modEndIdx = source.indexOf('endmodule', modMatch.index);
      if (modEndIdx >= 0) {
        const modEnd = modEndIdx + 'endmodule'.length;
        let moduleText = source.slice(modMatch.index, modEnd);
        for (const { oldName, newName } of edgeDiff.renamedSignals) {
          const pat = new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g');
          moduleText = moduleText.replace(pat, newName);
        }
        source = source.slice(0, modMatch.index) + moduleText + source.slice(modEnd);
      }
    }
  }

  return source;
}

// ── Source text manipulation helpers ─────────────────────────────────────────

function replaceInstanceConnection(
  source: string,
  instanceName: string,
  portName: string,
  oldWire: string,
  newWire: string,
): string {
  const pattern = new RegExp(
    `(\\.${escapeRegex(portName)}\\s*\\()${escapeRegex(oldWire)}(\\s*\\))`,
  );
  return source.replace(pattern, `$1${newWire}$2`);
}

function replacePositionalArg(
  source: string,
  instanceName: string,
  moduleName: string,
  argIndex: number,
  oldArg: string,
  newArg: string,
): string {
  const instPattern = new RegExp(
    `\\b${escapeRegex(moduleName)}\\s+${escapeRegex(instanceName)}\\s*\\(([^)]+)\\)`,
  );
  return source.replace(instPattern, (match, argsStr: string) => {
    const args = argsStr.split(',').map(s => s.trim());
    if (argIndex < args.length) {
      args[argIndex] = newArg;
    }
    return match.replace(argsStr, args.join(', '));
  });
}

function replaceAssignExpression(
  source: string,
  target: string,
  oldExpr: string,
  newExpr: string,
): string {
  const pattern = new RegExp(
    `(assign\\s+${escapeRegex(target)}\\s*=\\s*)${escapeRegex(oldExpr)}(\\s*;)`,
  );
  return source.replace(pattern, `$1${newExpr}$2`);
}

/**
 * Replace an entire gate primitive line with new arguments.
 * Matches the original gate line by its exact args, then rewrites it completely.
 */
function replaceGateLine(
  source: string,
  gate: VerilogGatePrimitive,
  newOutput: string,
  newInputs: string[],
): string {
  // Build a pattern that matches the original gate declaration
  const origArgs = [gate.output, ...gate.inputs];
  const argsPat = origArgs.map(a => `\\s*${escapeRegex(a)}\\s*`).join(',');
  const namePat = gate.instanceName ? `\\s+${escapeRegex(gate.instanceName)}` : '(?:\\s+\\w+)?';
  const pattern = new RegExp(
    `([ \\t]*)\\b${escapeRegex(gate.gate)}${namePat}\\s*\\(${argsPat}\\)\\s*;`,
  );

  const newArgs = [newOutput, ...newInputs];
  const nameStr = gate.instanceName ? ` ${gate.instanceName}` : '';

  return source.replace(pattern, (_, indent) => {
    return `${indent}${gate.gate}${nameStr}(${newArgs.join(', ')});`;
  });
}

/** Rename a gate's instance name (or add one if it didn't have one). */
function renameGateInstance(
  source: string,
  gate: VerilogGatePrimitive,
  newInstanceName: string,
): string {
  const origArgs = [gate.output, ...gate.inputs];
  const argsPat = origArgs.map(a => `\\s*${escapeRegex(a)}\\s*`).join(',');
  const namePat = gate.instanceName ? `\\s+${escapeRegex(gate.instanceName)}` : '(?:\\s+\\w+)?';
  const pattern = new RegExp(
    `([ \\t]*)\\b${escapeRegex(gate.gate)}${namePat}\\s*\\(${argsPat}\\)\\s*;`,
  );

  const args = origArgs.join(', ');
  return source.replace(pattern, (_, indent) => {
    return `${indent}${gate.gate} ${newInstanceName}(${args});`;
  });
}

/** Remove an entire gate primitive line from source */
function removeGateLine(
  source: string,
  gate: VerilogGatePrimitive,
): string {
  const origArgs = [gate.output, ...gate.inputs];
  const argsPat = origArgs.map(a => `\\s*${escapeRegex(a)}\\s*`).join(',');
  const namePat = gate.instanceName ? `\\s+${escapeRegex(gate.instanceName)}` : '(?:\\s+\\w+)?';
  const pattern = new RegExp(
    `[ \\t]*\\b${escapeRegex(gate.gate)}${namePat}\\s*\\(${argsPat}\\)\\s*;[ \\t]*\\n?`,
  );
  return source.replace(pattern, '');
}

/** Remove an entire instance line from source */
function removeInstanceLine(
  source: string,
  moduleName: string,
  instanceName: string,
): string {
  const pattern = new RegExp(
    `[ \\t]*\\b${escapeRegex(moduleName)}\\s+${escapeRegex(instanceName)}\\s*\\([^)]*\\)\\s*;[ \\t]*\\n?`,
  );
  return source.replace(pattern, '');
}

/** Remove a port from the module header and its direction declaration */
function removePort(source: string, portName: string, moduleName: string): string {
  const eName = escapeRegex(portName);
  const eMod = escapeRegex(moduleName);

  // Detect ANSI-style: direction keyword appears inside the module(...) port list
  const headerMatch = source.match(new RegExp(`module\\s+${eMod}\\s*\\(([^)]*)\\)`));
  const portList = headerMatch ? headerMatch[1] : '';
  const isAnsi = /\b(input|output|inout)\b/.test(portList);

  if (isAnsi) {
    // ANSI-style: remove the full "input/output [width] portName" entry + comma
    // e.g. "  input [7:0] a,\n" or "  output answer\n"
    // Remove entire line if it only contains this port declaration
    const ansiLineRe = new RegExp(
      `[ \\t]*(?:input|output|inout)\\s+(?:reg\\s+)?(?:\\[\\d+:\\d+\\]\\s+)?${eName}\\s*,?[ \\t]*\\n?`,
    );
    source = source.replace(ansiLineRe, '');
    // Fix trailing comma on the now-last port (if we removed the last entry, prev line may have dangling comma)
    source = source.replace(/,(\s*\))/, '$1');
  } else {
    // Non-ANSI: remove port name from header list + remove direction declaration line
    const headerRe = new RegExp(
      `(module\\s+${eMod}\\s*\\([^)]*)\\b${eName}\\b([^)]*\\))`,
    );
    source = source.replace(headerRe, (_match, before: string, after: string) => {
      let cleaned = before + after;
      cleaned = cleaned.replace(new RegExp(`\\b${eName}\\b\\s*,\\s*`), '');
      cleaned = cleaned.replace(new RegExp(`,\\s*\\b${eName}\\b`), '');
      cleaned = cleaned.replace(new RegExp(`\\b${eName}\\b`), '');
      return cleaned;
    });

    const declRe = new RegExp(
      `[ \\t]*(?:input|output|inout)\\s+(?:reg\\s+)?(?:\\[\\d+:\\d+\\]\\s+)?${eName}\\s*;[ \\t]*\\n?`,
    );
    source = source.replace(declRe, '');
  }

  return source;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Line diff ───────────────────────────────────────────────────────────────

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  let i = m, j = n;
  const result: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'unchanged', line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'added', line: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: 'removed', line: oldLines[i - 1] });
      i--;
    }
  }

  return result.reverse();
}
