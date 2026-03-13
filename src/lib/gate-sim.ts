// Gate-level simulator for Yosys JSON netlists

// ─── Yosys JSON netlist types ───

export interface YosysNetlist {
  modules: Record<string, YosysModule>;
}

interface YosysModule {
  ports: Record<string, YosysPort>;
  cells: Record<string, YosysCell>;
  netnames: Record<string, YosysNetname>;
}

interface YosysPort {
  direction: 'input' | 'output' | 'inout';
  bits: (number | string)[];  // net IDs or "0"/"1"
}

interface YosysCell {
  type: string;
  connections: Record<string, (number | string)[]>;
  parameters: Record<string, unknown>;
}

interface YosysNetname {
  bits: (number | string)[];
  hide_name?: number;
}

// ─── Topological ordering ───

interface CellInfo {
  name: string;
  cell: YosysCell;
}

// ─── GateLevelSimulator ───

export class GateLevelSimulator {
  private sortedCells: CellInfo[] = [];
  private nets: Map<number, number> = new Map(); // net ID → value (0 or 1)
  private dffState: Map<string, number> = new Map(); // cell name → stored Q bit
  private portBits: { inputs: Record<string, (number | string)[]>; outputs: Record<string, (number | string)[]> } = { inputs: {}, outputs: {} };
  private prevClk = 0;

  constructor(netlist: YosysNetlist, topModule: string) {
    const availableModules = Object.keys(netlist.modules || {});
    const mod = netlist.modules[topModule];
    if (!mod) {
      throw new Error(`Module "${topModule}" not found in netlist. Available: [${availableModules.join(', ')}]`);
    }
    this.buildFromModule(mod);
  }

  private buildFromModule(mod: YosysModule) {
    // Collect port bits
    for (const [name, port] of Object.entries(mod.ports)) {
      if (port.direction === 'input') {
        this.portBits.inputs[name] = port.bits;
      } else {
        this.portBits.outputs[name] = port.bits;
      }
    }

    // Topological sort: build dependency graph between cells
    const cells: CellInfo[] = [];
    const cellMap = new Map<string, number>(); // cell name → index
    // Map net ID → producing cell index
    const netProducer = new Map<number, number>();

    const entries = Object.entries(mod.cells);
    for (let i = 0; i < entries.length; i++) {
      const [name, cell] = entries[i];
      cells.push({ name, cell });
      cellMap.set(name, i);

      // Register output nets
      const outPins = this.getOutputPins(cell.type);
      for (const pin of outPins) {
        const bits = cell.connections[pin];
        if (bits) {
          for (const b of bits) {
            if (typeof b === 'number') {
              netProducer.set(b, i);
            }
          }
        }
      }
    }

    // Kahn's algorithm
    const n = cells.length;
    const adj: number[][] = Array.from({ length: n }, () => []);
    const inDeg = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      const cell = cells[i].cell;
      const inPins = this.getInputPins(cell.type);
      for (const pin of inPins) {
        const bits = cell.connections[pin];
        if (!bits) continue;
        for (const b of bits) {
          if (typeof b === 'number') {
            const producer = netProducer.get(b);
            if (producer !== undefined && producer !== i) {
              // Skip DFF feedback: don't add edge from DFF's own output
              if (this.isDFF(cells[producer].cell.type)) continue;
              adj[producer].push(i);
              inDeg[i]++;
            }
          }
        }
      }
    }

    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (inDeg[i] === 0) queue.push(i);
    }

    this.sortedCells = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      this.sortedCells.push(cells[u]);
      for (const v of adj[u]) {
        if (--inDeg[v] === 0) queue.push(v);
      }
    }

    // Add any remaining cells (cycles from DFF feedback)
    if (this.sortedCells.length < n) {
      const added = new Set(this.sortedCells.map(c => c.name));
      for (const c of cells) {
        if (!added.has(c.name)) this.sortedCells.push(c);
      }
    }

    // Initialize DFF states to 0
    for (const { name, cell } of this.sortedCells) {
      if (this.isDFF(cell.type)) {
        this.dffState.set(name, 0);
      }
    }
  }

  evaluate(inputs: Record<string, number>): Record<string, number> {
    // Reset all nets
    this.nets.clear();

    // Set input nets from multi-bit input values
    for (const [name, bits] of Object.entries(this.portBits.inputs)) {
      const val = inputs[name] ?? 0;
      for (let i = 0; i < bits.length; i++) {
        const b = bits[i];
        if (typeof b === 'number') {
          this.nets.set(b, (val >> i) & 1);
        }
      }
    }

    // Get clock value for edge detection
    const clkVal = inputs['clk'] ?? 0;
    const posEdge = clkVal === 1 && this.prevClk === 0;
    const negEdge = clkVal === 0 && this.prevClk === 1;
    this.prevClk = clkVal;

    // Walk cells in topo order
    for (const { name, cell } of this.sortedCells) {
      this.evaluateCell(name, cell, posEdge, negEdge);
    }

    // Pack multi-bit outputs
    const result: Record<string, number> = {};
    for (const [name, bits] of Object.entries(this.portBits.outputs)) {
      let val = 0;
      for (let i = 0; i < bits.length; i++) {
        const b = bits[i];
        let bitVal: number;
        if (typeof b === 'string') {
          bitVal = b === '1' ? 1 : 0;
        } else {
          bitVal = this.nets.get(b) ?? 0;
        }
        val |= (bitVal << i);
      }
      result[name] = val;
    }
    return result;
  }

  private getNet(bit: number | string): number {
    if (typeof bit === 'string') return bit === '1' ? 1 : 0;
    return this.nets.get(bit) ?? 0;
  }

  private setNet(bit: number | string, val: number) {
    if (typeof bit === 'number') {
      this.nets.set(bit, val & 1);
    }
  }

  private evaluateCell(name: string, cell: YosysCell, posEdge: boolean, negEdge: boolean) {
    const conn = cell.connections;
    const type = cell.type;

    switch (type) {
      case '$_BUF_': {
        const a = this.getNet(conn['A'][0]);
        this.setNet(conn['Y'][0], a);
        break;
      }
      case '$_NOT_': {
        const a = this.getNet(conn['A'][0]);
        this.setNet(conn['Y'][0], a ^ 1);
        break;
      }
      case '$_AND_': {
        const a = this.getNet(conn['A'][0]);
        const b = this.getNet(conn['B'][0]);
        this.setNet(conn['Y'][0], a & b);
        break;
      }
      case '$_OR_': {
        const a = this.getNet(conn['A'][0]);
        const b = this.getNet(conn['B'][0]);
        this.setNet(conn['Y'][0], a | b);
        break;
      }
      case '$_XOR_': {
        const a = this.getNet(conn['A'][0]);
        const b = this.getNet(conn['B'][0]);
        this.setNet(conn['Y'][0], a ^ b);
        break;
      }
      case '$_NAND_': {
        const a = this.getNet(conn['A'][0]);
        const b = this.getNet(conn['B'][0]);
        this.setNet(conn['Y'][0], (a & b) ^ 1);
        break;
      }
      case '$_NOR_': {
        const a = this.getNet(conn['A'][0]);
        const b = this.getNet(conn['B'][0]);
        this.setNet(conn['Y'][0], (a | b) ^ 1);
        break;
      }
      case '$_XNOR_': {
        const a = this.getNet(conn['A'][0]);
        const b = this.getNet(conn['B'][0]);
        this.setNet(conn['Y'][0], (a ^ b) ^ 1);
        break;
      }
      case '$_MUX_': {
        const a = this.getNet(conn['A'][0]);
        const b = this.getNet(conn['B'][0]);
        const s = this.getNet(conn['S'][0]);
        this.setNet(conn['Y'][0], s ? b : a);
        break;
      }
      case '$_DFF_P_': {
        // Positive-edge D flip-flop
        if (posEdge) {
          const d = this.getNet(conn['D'][0]);
          this.dffState.set(name, d);
        }
        this.setNet(conn['Q'][0], this.dffState.get(name) ?? 0);
        break;
      }
      case '$_DFF_N_': {
        // Negative-edge D flip-flop
        if (negEdge) {
          const d = this.getNet(conn['D'][0]);
          this.dffState.set(name, d);
        }
        this.setNet(conn['Q'][0], this.dffState.get(name) ?? 0);
        break;
      }
      case '$_DFFE_PP_': {
        // Positive-edge DFF with positive enable
        if (posEdge) {
          const e = this.getNet(conn['E'][0]);
          if (e) {
            const d = this.getNet(conn['D'][0]);
            this.dffState.set(name, d);
          }
        }
        this.setNet(conn['Q'][0], this.dffState.get(name) ?? 0);
        break;
      }
      case '$_SDFF_PP0_': {
        // Sync-reset positive-edge DFF (reset to 0)
        if (posEdge) {
          const r = this.getNet(conn['R'][0]);
          if (r) {
            this.dffState.set(name, 0);
          } else {
            const d = this.getNet(conn['D'][0]);
            this.dffState.set(name, d);
          }
        }
        this.setNet(conn['Q'][0], this.dffState.get(name) ?? 0);
        break;
      }
      case '$lut': {
        // LUT: Y = (INIT >> address) & 1
        const aBits = conn['A'];
        let addr = 0;
        for (let i = 0; i < aBits.length; i++) {
          addr |= (this.getNet(aBits[i]) << i);
        }
        const init = this.parseLutInit(cell.parameters['LUT'] as string | number);
        this.setNet(conn['Y'][0], (init >> addr) & 1);
        break;
      }
      default:
        // Unknown cell type — treat outputs as 0
        break;
    }
  }

  private parseLutInit(val: string | number): number {
    if (typeof val === 'number') return val;
    // Yosys may encode LUT INIT as a binary string (MSB first)
    return parseInt(val, 2);
  }

  private isDFF(type: string): boolean {
    return type.startsWith('$_DFF') || type.startsWith('$_SDFF');
  }

  private getOutputPins(type: string): string[] {
    if (this.isDFF(type)) return ['Q'];
    return ['Y'];
  }

  private getInputPins(type: string): string[] {
    switch (type) {
      case '$_BUF_':
      case '$_NOT_':
        return ['A'];
      case '$_AND_':
      case '$_OR_':
      case '$_XOR_':
      case '$_NAND_':
      case '$_NOR_':
      case '$_XNOR_':
        return ['A', 'B'];
      case '$_MUX_':
        return ['A', 'B', 'S'];
      case '$_DFF_P_':
      case '$_DFF_N_':
        return ['D', 'C'];
      case '$_DFFE_PP_':
        return ['D', 'C', 'E'];
      case '$_SDFF_PP0_':
        return ['D', 'C', 'R'];
      case '$lut':
        return ['A'];
      default:
        return ['A', 'B', 'S'];
    }
  }
}
