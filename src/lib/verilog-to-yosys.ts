// Convert a parsed VerilogModule into a Yosys-compatible JSON netlist
// that can be rendered by netlistsvg.

import type { VerilogModule } from './verilog-parser';

interface YosysPort {
  direction: 'input' | 'output';
  bits: (number | string)[];
}

interface YosysCell {
  type: string;
  port_directions: Record<string, 'input' | 'output'>;
  connections: Record<string, (number | string)[]>;
}

interface YosysModule {
  ports: Record<string, YosysPort>;
  cells: Record<string, YosysCell>;
}

export interface YosysNetlistJson {
  modules: Record<string, YosysModule>;
}

const GATE_TYPE_MAP: Record<string, string> = {
  and: '$_AND_',
  or: '$_OR_',
  not: '$_NOT_',
  buf: '$_BUF_',
  nand: '$_NAND_',
  nor: '$_NOR_',
  xor: '$_XOR_',
  xnor: '$_XNOR_',
};

export function verilogModuleToYosysJson(mod: VerilogModule, allModules?: VerilogModule[]): YosysNetlistJson {
  const moduleMap = new Map<string, VerilogModule>();
  if (allModules) for (const m of allModules) moduleMap.set(m.name, m);
  // Bit index 0 = constant 0, 1 = constant 1 (Yosys convention)
  let bitIdx = 2;
  const signalBits = new Map<string, number[]>();

  function allocBits(name: string, width: number) {
    if (signalBits.has(name)) return;
    const bits: number[] = [];
    for (let i = 0; i < width; i++) bits.push(bitIdx++);
    signalBits.set(name, bits);
  }

  // Allocate bit indices for all signals
  for (const port of mod.ports) allocBits(port.name, port.width);
  for (const wire of mod.wires) allocBits(wire.name, wire.width);
  for (const reg of mod.regs) allocBits(reg.name, reg.width);

  function getBits(signalRef: string): (number | string)[] {
    const trimmed = signalRef.trim();
    // Numeric literal: 0 or 1
    if (trimmed === '0' || trimmed === "1'b0") return [0];
    if (trimmed === '1' || trimmed === "1'b1") return [1];
    // Bit-select: signal[N]
    const bitSel = trimmed.match(/^(\w+)\[(\d+)\]$/);
    if (bitSel) {
      const bits = signalBits.get(bitSel[1]);
      const idx = parseInt(bitSel[2]);
      if (bits && idx < bits.length) return [bits[idx]];
    }
    // Range select: signal[M:N]
    const rangeSel = trimmed.match(/^(\w+)\[(\d+):(\d+)\]$/);
    if (rangeSel) {
      const bits = signalBits.get(rangeSel[1]);
      const msb = parseInt(rangeSel[2]);
      const lsb = parseInt(rangeSel[3]);
      if (bits) return bits.slice(lsb, msb + 1);
    }
    // Simple signal name
    const bits = signalBits.get(trimmed);
    if (bits) return bits;
    // Unknown signal — allocate a fresh bit
    const fresh = bitIdx++;
    return [fresh];
  }

  // Build ports
  const ports: Record<string, YosysPort> = {};
  for (const port of mod.ports) {
    ports[port.name] = {
      direction: port.direction === 'inout' ? 'input' : port.direction,
      bits: signalBits.get(port.name) || [],
    };
  }

  // Build cells
  const cells: Record<string, YosysCell> = {};

  // Gate primitives
  for (let gi = 0; gi < mod.gatePrimitives.length; gi++) {
    const gate = mod.gatePrimitives[gi];
    const cellType = GATE_TYPE_MAP[gate.gate] || gate.gate;
    const baseName = gate.instanceName || `${gate.gate}_${gi}`;

    if (gate.gate === 'not' || gate.gate === 'buf') {
      cells[baseName] = {
        type: cellType,
        port_directions: { A: 'input', Y: 'output' },
        connections: { A: getBits(gate.inputs[0]), Y: getBits(gate.output) },
      };
    } else if (gate.inputs.length <= 2) {
      const conn: Record<string, (number | string)[]> = {
        A: getBits(gate.inputs[0]),
        Y: getBits(gate.output),
      };
      const dirs: Record<string, 'input' | 'output'> = { A: 'input', Y: 'output' };
      if (gate.inputs.length === 2) {
        conn.B = getBits(gate.inputs[1]);
        dirs.B = 'input';
      }
      cells[baseName] = { type: cellType, port_directions: dirs, connections: conn };
    } else {
      // Chain >2 inputs as pairs of 2-input gates
      let prevBits = getBits(gate.inputs[0]);
      for (let i = 1; i < gate.inputs.length; i++) {
        const isLast = i === gate.inputs.length - 1;
        const outBits = isLast ? getBits(gate.output) : [bitIdx++];
        cells[`${baseName}_${i}`] = {
          type: cellType,
          port_directions: { A: 'input', B: 'input', Y: 'output' },
          connections: { A: prevBits, B: getBits(gate.inputs[i]), Y: outBits },
        };
        prevBits = outBits;
      }
    }
  }

  // Module instances
  for (const inst of mod.instances) {
    const portDirs: Record<string, 'input' | 'output'> = {};
    const conns: Record<string, (number | string)[]> = {};
    const childMod = moduleMap.get(inst.moduleName);

    if (Object.keys(inst.connections).length > 0) {
      for (const [portName, wire] of Object.entries(inst.connections)) {
        conns[portName] = getBits(wire);
        const childPort = childMod?.ports.find(p => p.name === portName);
        if (childPort) {
          portDirs[portName] = childPort.direction === 'inout' ? 'input' : childPort.direction;
        } else {
          portDirs[portName] = /^(out|o|q|y|result|data_out)/i.test(portName) ? 'output' : 'input';
        }
      }
    } else if (inst.positionalArgs) {
      inst.positionalArgs.forEach((arg, i) => {
        if (childMod && i < childMod.ports.length) {
          const cp = childMod.ports[i];
          conns[cp.name] = getBits(arg);
          portDirs[cp.name] = cp.direction === 'inout' ? 'input' : cp.direction;
        } else {
          const name = `p${i}`;
          conns[name] = getBits(arg);
          portDirs[name] = i === 0 ? 'output' : 'input';
        }
      });
    }

    cells[inst.instanceName] = {
      type: inst.moduleName,
      port_directions: portDirs,
      connections: conns,
    };
  }

  // Continuous assigns — represent as buffer cells for simple cases
  for (let ai = 0; ai < mod.assigns.length; ai++) {
    const assign = mod.assigns[ai];
    const expr = assign.expression.trim();
    // Only handle simple signal-to-signal assigns
    if (/^[a-zA-Z_]\w*(\[\d+(:\d+)?\])?$/.test(expr)) {
      cells[`assign_${assign.target}`] = {
        type: '$_BUF_',
        port_directions: { A: 'input', Y: 'output' },
        connections: { A: getBits(expr), Y: getBits(assign.target) },
      };
    }
  }

  return {
    modules: {
      [mod.name]: { ports, cells },
    },
  };
}
