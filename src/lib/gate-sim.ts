// Gate-level simulator for Yosys JSON netlists
// Optimized with typed arrays, pre-compiled operations, and counter
// fast-forward for realistic clock divider support.

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
  bits: (number | string)[];
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

// ─── Unified DFF config ───

interface DFFConfig {
  posEdge: boolean;
  hasAsyncReset: boolean;
  asyncResetActiveHigh: boolean;
  asyncResetValue: number;
  hasSyncReset: boolean;
  syncResetActiveHigh: boolean;
  syncResetValue: number;
  syncResetPriority: boolean;
  hasEnable: boolean;
  enableActiveHigh: boolean;
  clkPin: string;
  dataPin: string;
  outputPin: string;
  resetPin: string;
  enablePin: string;
}

// ─── DFF parsers ───

function parseGateLevelDFF(type: string): DFFConfig | null {
  const m = type.match(/^\$_(S?DFF(?:C?E)?)_([PN01]+)_$/);
  if (!m) return null;
  const base = m[1], suffix = m[2];
  const cfg: DFFConfig = {
    posEdge: true,
    hasAsyncReset: false, asyncResetActiveHigh: true, asyncResetValue: 0,
    hasSyncReset: false, syncResetActiveHigh: true, syncResetValue: 0, syncResetPriority: false,
    hasEnable: false, enableActiveHigh: true,
    clkPin: 'C', dataPin: 'D', outputPin: 'Q', resetPin: 'R', enablePin: 'E',
  };
  let i = 0;
  cfg.posEdge = suffix[i++] === 'P';
  if (base === 'DFF' && suffix.length === 1) return cfg;
  if (base === 'DFF' && suffix.length === 3) {
    cfg.hasAsyncReset = true;
    cfg.asyncResetActiveHigh = suffix[i++] === 'P';
    cfg.asyncResetValue = parseInt(suffix[i++]);
    return cfg;
  }
  if (base === 'DFFE' && suffix.length === 2) {
    cfg.hasEnable = true; cfg.enableActiveHigh = suffix[i++] === 'P'; return cfg;
  }
  if (base === 'DFFE' && suffix.length === 4) {
    cfg.hasAsyncReset = true;
    cfg.asyncResetActiveHigh = suffix[i++] === 'P';
    cfg.asyncResetValue = parseInt(suffix[i++]);
    cfg.hasEnable = true; cfg.enableActiveHigh = suffix[i++] === 'P'; return cfg;
  }
  if (base === 'SDFF' && suffix.length === 3) {
    cfg.hasSyncReset = true;
    cfg.syncResetActiveHigh = suffix[i++] === 'P';
    cfg.syncResetValue = parseInt(suffix[i++]);
    return cfg;
  }
  if (base === 'SDFFE' && suffix.length === 4) {
    cfg.hasSyncReset = true;
    cfg.syncResetActiveHigh = suffix[i++] === 'P';
    cfg.syncResetValue = parseInt(suffix[i++]);
    cfg.hasEnable = true; cfg.enableActiveHigh = suffix[i++] === 'P'; return cfg;
  }
  if (base === 'SDFFCE' && suffix.length === 4) {
    cfg.hasSyncReset = true; cfg.syncResetPriority = true;
    cfg.syncResetActiveHigh = suffix[i++] === 'P';
    cfg.syncResetValue = parseInt(suffix[i++]);
    cfg.hasEnable = true; cfg.enableActiveHigh = suffix[i++] === 'P'; return cfg;
  }
  return null;
}

function parseHighLevelDFF(cell: YosysCell): DFFConfig | null {
  const type = cell.type, p = cell.parameters;
  const cfg: DFFConfig = {
    posEdge: true,
    hasAsyncReset: false, asyncResetActiveHigh: true, asyncResetValue: 0,
    hasSyncReset: false, syncResetActiveHigh: true, syncResetValue: 0, syncResetPriority: false,
    hasEnable: false, enableActiveHigh: true,
    clkPin: 'CLK', dataPin: 'D', outputPin: 'Q', resetPin: '', enablePin: 'EN',
  };
  cfg.posEdge = paramBool(p['CLK_POLARITY']);
  if (type === '$dff') return cfg;
  if (type === '$dffe') { cfg.hasEnable = true; cfg.enableActiveHigh = paramBool(p['EN_POLARITY']); return cfg; }
  if (type === '$adff' || type === '$adffe') {
    cfg.hasAsyncReset = true; cfg.resetPin = 'ARST';
    cfg.asyncResetActiveHigh = paramBool(p['ARST_POLARITY']);
    cfg.asyncResetValue = paramInt(p['ARST_VALUE']);
    if (type === '$adffe') { cfg.hasEnable = true; cfg.enableActiveHigh = paramBool(p['EN_POLARITY']); }
    return cfg;
  }
  if (type === '$sdff' || type === '$sdffe' || type === '$sdffce') {
    cfg.hasSyncReset = true; cfg.resetPin = 'SRST';
    cfg.syncResetActiveHigh = paramBool(p['SRST_POLARITY']);
    cfg.syncResetValue = paramInt(p['SRST_VALUE']);
    if (type === '$sdffce') cfg.syncResetPriority = true;
    if (type === '$sdffe' || type === '$sdffce') { cfg.hasEnable = true; cfg.enableActiveHigh = paramBool(p['EN_POLARITY']); }
    return cfg;
  }
  return null;
}

function paramBool(v: unknown): boolean {
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '0' && v !== '';
  return true;
}
function paramInt(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseInt(v, 2) || 0;
  return 0;
}

const HIGH_LEVEL_DFF_TYPES = new Set([
  '$dff', '$dffe', '$adff', '$sdff', '$adffe', '$sdffe', '$sdffce',
]);

function isDFF(type: string): boolean {
  return type.startsWith('$_DFF') || type.startsWith('$_SDFF') || HIGH_LEVEL_DFF_TYPES.has(type);
}

// ─── Pre-compiled operation codes ───
const OP_BUF = 0, OP_NOT = 1, OP_AND = 2, OP_OR = 3, OP_XOR = 4;
const OP_NAND = 5, OP_NOR = 6, OP_XNOR = 7, OP_MUX = 8;

// Convert Yosys bit to net index. Constants: "0"→0, "1"→1. Net IDs ≥ 2.
function bx(bit: number | string): number {
  return typeof bit === 'number' ? bit : (bit === '1' ? 1 : 0);
}

// ─── GateLevelSimulator ───

export class GateLevelSimulator {
  // Net storage — Uint8Array indexed by net ID (0=const0, 1=const1)
  private nets: Uint8Array;

  // Pre-compiled combinational ops (flat typed arrays for tight inner loop)
  private cOp: Uint8Array;
  private cA: Uint32Array;
  private cB: Uint32Array;
  private cS: Uint32Array;
  private cY: Uint32Array;
  private cLen = 0;

  // LUT ops (variable-width, stored separately)
  private luts: { ins: number[]; out: number; init: number }[] = [];

  // DFF arrays
  private dLen = 0;
  private dState: number[];
  private dCfg: DFFConfig[];
  private dQ: number[][];   // Q net indices per DFF
  private dD: number[][];   // D net indices per DFF
  private dR: number[];     // reset net (-1 = none)
  private dE: number[];     // enable net (-1 = none)

  // Port mappings
  private inPorts: { name: string; nets: number[] }[] = [];
  private outPorts: { name: string; nets: number[] }[] = [];

  // Clock
  private prevClk = 0;
  private hasPosEdge = false;
  private hasNegEdge = false;
  private hasAsyncRst = false;
  private clockPortName: string | null = null;

  // Counter fast-forward
  private ctrDFFs: number[] | null = null; // DFF indices, bit 0 first
  private ctrPeriod = 0;
  private ctrVal = 0;
  private ctrRstNet = -1;
  private ctrRstHigh = true;

  // Watched output port name (for FSM early-break detection)
  private _watchedPortName = '';

  // Public: true when counter fast-forward is active
  get hasCounterFastForward(): boolean { return this.ctrDFFs !== null; }

  constructor(netlist: YosysNetlist, topModule: string) {
    const mod = netlist.modules[topModule];
    if (!mod) {
      throw new Error(`Module "${topModule}" not found in netlist. Available: [${Object.keys(netlist.modules)}]`);
    }

    // ── Parse ports & find max net ID ──
    let maxNet = 1;
    const trackMax = (b: number | string) => { const idx = bx(b); if (idx > maxNet) maxNet = idx; };

    for (const [name, port] of Object.entries(mod.ports)) {
      const nets = port.bits.map(b => { trackMax(b); return bx(b); });
      (port.direction === 'input' ? this.inPorts : this.outPorts).push({ name, nets });
    }
    for (const cell of Object.values(mod.cells)) {
      for (const bits of Object.values(cell.connections)) {
        for (const b of bits) trackMax(b);
      }
    }

    this.nets = new Uint8Array(maxNet + 1);

    // ── Topological sort ──
    const cells = Object.entries(mod.cells).map(([name, cell]) => ({ name, cell }));
    const n = cells.length;
    const netProd = new Map<number, number>();

    for (let i = 0; i < n; i++) {
      const c = cells[i].cell;
      const pins = isDFF(c.type) ? ['Q'] : ['Y'];
      for (const pin of pins) {
        const bits = c.connections[pin];
        if (bits) for (const b of bits) { const idx = bx(b); if (idx >= 2) netProd.set(idx, i); }
      }
    }

    const adj: number[][] = Array.from({ length: n }, () => []);
    const deg = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c = cells[i].cell;
      for (const pin of getInputPins(c.type)) {
        const bits = c.connections[pin];
        if (!bits) continue;
        for (const b of bits) {
          const idx = bx(b);
          if (idx >= 2) {
            const p = netProd.get(idx);
            if (p !== undefined && p !== i && !isDFF(cells[p].cell.type)) {
              adj[p].push(i); deg[i]++;
            }
          }
        }
      }
    }

    const q: number[] = [];
    for (let i = 0; i < n; i++) if (deg[i] === 0) q.push(i);
    const sorted: number[] = [];
    while (q.length > 0) {
      const u = q.shift()!;
      sorted.push(u);
      for (const v of adj[u]) if (--deg[v] === 0) q.push(v);
    }
    if (sorted.length < n) {
      const s = new Set(sorted);
      for (let i = 0; i < n; i++) if (!s.has(i)) sorted.push(i);
    }

    // ── Pre-compile cells ──
    const ops: number[] = [], as: number[] = [], bs: number[] = [], ss: number[] = [], ys: number[] = [];
    const dffIndices: number[] = [];
    const clockNets = new Set<number>();

    for (const idx of sorted) {
      const { cell } = cells[idx];
      const type = cell.type, conn = cell.connections;

      if (isDFF(type)) { dffIndices.push(idx); continue; }

      const yBit = conn['Y']?.[0];
      if (yBit === undefined) continue; // skip $scopeinfo etc
      const y = bx(yBit);

      switch (type) {
        case '$_BUF_':  ops.push(OP_BUF);  as.push(bx(conn['A'][0])); bs.push(0); ss.push(0); ys.push(y); break;
        case '$_NOT_':  ops.push(OP_NOT);  as.push(bx(conn['A'][0])); bs.push(0); ss.push(0); ys.push(y); break;
        case '$_AND_':  ops.push(OP_AND);  as.push(bx(conn['A'][0])); bs.push(bx(conn['B'][0])); ss.push(0); ys.push(y); break;
        case '$_OR_':   ops.push(OP_OR);   as.push(bx(conn['A'][0])); bs.push(bx(conn['B'][0])); ss.push(0); ys.push(y); break;
        case '$_XOR_':  ops.push(OP_XOR);  as.push(bx(conn['A'][0])); bs.push(bx(conn['B'][0])); ss.push(0); ys.push(y); break;
        case '$_NAND_': ops.push(OP_NAND); as.push(bx(conn['A'][0])); bs.push(bx(conn['B'][0])); ss.push(0); ys.push(y); break;
        case '$_NOR_':  ops.push(OP_NOR);  as.push(bx(conn['A'][0])); bs.push(bx(conn['B'][0])); ss.push(0); ys.push(y); break;
        case '$_XNOR_': ops.push(OP_XNOR); as.push(bx(conn['A'][0])); bs.push(bx(conn['B'][0])); ss.push(0); ys.push(y); break;
        case '$_MUX_':  ops.push(OP_MUX);  as.push(bx(conn['A'][0])); bs.push(bx(conn['B'][0])); ss.push(bx(conn['S'][0])); ys.push(y); break;
        case '$lut': {
          const ins = conn['A'].map(b => bx(b));
          const raw = cell.parameters['LUT'];
          const init = typeof raw === 'number' ? raw : parseInt(raw as string, 2);
          this.luts.push({ ins, out: y, init });
          break;
        }
      }
    }

    this.cLen = ops.length;
    this.cOp = new Uint8Array(ops);
    this.cA = new Uint32Array(as);
    this.cB = new Uint32Array(bs);
    this.cS = new Uint32Array(ss);
    this.cY = new Uint32Array(ys);

    // ── Initialize DFFs ──
    this.dLen = dffIndices.length;
    this.dState = new Array(this.dLen);
    this.dCfg = new Array(this.dLen);
    this.dQ = new Array(this.dLen);
    this.dD = new Array(this.dLen);
    this.dR = new Array(this.dLen).fill(-1);
    this.dE = new Array(this.dLen).fill(-1);

    for (let di = 0; di < this.dLen; di++) {
      const { cell } = cells[dffIndices[di]];
      const cfg = HIGH_LEVEL_DFF_TYPES.has(cell.type)
        ? parseHighLevelDFF(cell)!
        : parseGateLevelDFF(cell.type)!;

      // Fallback for unrecognized DFF
      if (!cfg) {
        const fb: DFFConfig = {
          posEdge: true, hasAsyncReset: false, asyncResetActiveHigh: true, asyncResetValue: 0,
          hasSyncReset: false, syncResetActiveHigh: true, syncResetValue: 0, syncResetPriority: false,
          hasEnable: false, enableActiveHigh: true,
          clkPin: 'C', dataPin: 'D', outputPin: 'Q', resetPin: 'R', enablePin: 'E',
        };
        this.dCfg[di] = fb;
        this.dState[di] = 0;
        this.dQ[di] = (cell.connections['Q'] || []).map(b => bx(b));
        this.dD[di] = (cell.connections['D'] || []).map(b => bx(b));
        this.hasPosEdge = true;
        continue;
      }

      this.dCfg[di] = cfg;
      this.dState[di] = cfg.hasAsyncReset ? cfg.asyncResetValue : 0;
      this.dQ[di] = (cell.connections[cfg.outputPin] || []).map(b => bx(b));
      this.dD[di] = (cell.connections[cfg.dataPin] || []).map(b => bx(b));
      if (cfg.hasAsyncReset || cfg.hasSyncReset) {
        const rb = cell.connections[cfg.resetPin];
        if (rb) this.dR[di] = bx(rb[0]);
      }
      if (cfg.hasEnable) {
        const eb = cell.connections[cfg.enablePin];
        if (eb) this.dE[di] = bx(eb[0]);
      }
      if (cfg.posEdge) this.hasPosEdge = true; else this.hasNegEdge = true;
      if (cfg.hasAsyncReset) this.hasAsyncRst = true;

      const cb = cell.connections[cfg.clkPin];
      if (cb) for (const b of cb) { const idx = bx(b); if (idx >= 2) clockNets.add(idx); }
    }

    // ── Auto-detect clock port ──
    for (const port of this.inPorts) {
      for (const net of port.nets) {
        if (net >= 2 && clockNets.has(net)) { this.clockPortName = port.name; break; }
      }
      if (this.clockPortName) break;
    }

    // ── Detect counters for fast-forward ──
    this.detectCounter();

    // ── Pre-compute watched output port for change detection ──
    for (const port of this.outPorts) {
      if (port.name.includes('led') || port.name.includes('light') || port.name.includes('out')) {
        this._watchedPortName = port.name; break;
      }
    }
    if (!this._watchedPortName && this.outPorts.length > 0) {
      this._watchedPortName = this.outPorts[0].name;
    }
  }

  // ─── Counter detection ───
  // Finds sync-reset DFF groups that form binary counters.
  // Determines actual bit ordering empirically (Yosys net IDs don't
  // correspond to bit positions) by setting counter to 2^k-1 and
  // simulating one cycle to identify which DFF becomes bit k.
  private detectCounter() {
    // Group 1-bit sync-reset DFFs (no enable, no async reset) by reset net
    const groups = new Map<number, number[]>();
    for (let i = 0; i < this.dLen; i++) {
      const cfg = this.dCfg[i];
      if (cfg.hasSyncReset && !cfg.hasAsyncReset && !cfg.hasEnable && this.dQ[i].length === 1) {
        const rn = this.dR[i];
        if (rn >= 0) {
          if (!groups.has(rn)) groups.set(rn, []);
          groups.get(rn)!.push(i);
        }
      }
    }

    for (const [rNet, dffs] of groups) {
      if (dffs.length < 3) continue; // skip tiny counters

      const savedStates = this.dState.slice();
      const savedClk = this.prevClk;
      const n = dffs.length;

      const zeroIn: Record<string, number> = {};
      for (const p of this.inPorts) zeroIn[p.name] = 0;

      // Helper: simulate one rising+falling edge
      const tickOnce = () => {
        this.prevClk = 0;
        zeroIn[this.clockPortName ?? 'clk'] = 1;
        this.evaluateInternal(zeroIn);
        zeroIn[this.clockPortName ?? 'clk'] = 0;
        this.evaluateInternal(zeroIn);
      };

      // Step 1: Find bit 0 — set all DFFs to 0, simulate 1 cycle
      for (const i of dffs) this.dState[i] = 0;
      tickOnce();

      const bitOrder: number[] = new Array(n);
      const assigned = new Set<number>();
      let valid = true;
      let count1 = 0;

      for (const i of dffs) {
        if (this.dState[i] === 1) { bitOrder[0] = i; assigned.add(i); count1++; }
      }
      if (count1 !== 1) valid = false;

      // Step 2: For each bit k=1..n-1, set counter to (2^k)-1 and simulate 1 cycle.
      // The carry ripples through bits 0..k-1, producing 2^k (only bit k set).
      if (valid) {
        for (let k = 1; k < n; k++) {
          for (const i of dffs) this.dState[i] = 0;
          for (let b = 0; b < k; b++) this.dState[bitOrder[b]] = 1;
          tickOnce();

          // Find the single newly-set DFF — that's bit k
          let bitK = -1;
          for (const i of dffs) {
            if (this.dState[i] === 1 && !assigned.has(i)) {
              if (bitK !== -1) { valid = false; break; } // multiple new bits set
              bitK = i;
            } else if (this.dState[i] === 1 && assigned.has(i)) {
              valid = false; break; // a lower bit didn't clear — not a binary counter
            }
          }
          if (!valid || bitK === -1) { valid = false; break; }
          bitOrder[k] = bitK;
          assigned.add(bitK);
        }
      }

      // Step 3: Verify with 4 cycles using the discovered bit ordering
      if (valid && assigned.size === n) {
        for (const i of dffs) this.dState[i] = 0;
        const vals: number[] = [0];
        for (let cyc = 0; cyc < 4; cyc++) {
          tickOnce();
          let v = 0;
          for (let b = 0; b < n; b++) v |= (this.dState[bitOrder[b]] << b);
          vals.push(v);
        }
        valid = vals[1] === 1 && vals[2] === 2 && vals[3] === 3 && vals[4] === 4;
      }

      // Restore state
      for (let i = 0; i < this.dState.length; i++) this.dState[i] = savedStates[i];
      this.prevClk = savedClk;

      if (valid) {
        this.ctrDFFs = bitOrder;
        this.ctrPeriod = 1 << n;
        this.ctrRstNet = rNet;
        this.ctrRstHigh = this.dCfg[dffs[0]].syncResetActiveHigh;
        this.ctrVal = 0;
        for (let b = 0; b < n; b++) this.ctrVal |= (this.dState[bitOrder[b]] << b);
        break;
      }
    }
  }

  // ─── Internal evaluate (no counter tracking) ───
  private evaluateInternal(inputs: Record<string, number>): void {
    const N = this.nets;
    N.fill(0); N[1] = 1;

    // Set inputs
    for (const { name, nets } of this.inPorts) {
      const val = inputs[name] ?? 0;
      for (let i = 0; i < nets.length; i++) {
        const idx = nets[i];
        if (idx >= 2) N[idx] = (val >> i) & 1;
      }
    }

    const clkVal = inputs[this.clockPortName ?? 'clk'] ?? 0;
    const posEdge = clkVal === 1 && this.prevClk === 0;
    const negEdge = clkVal === 0 && this.prevClk === 1;
    this.prevClk = clkVal;

    const edge = (posEdge && this.hasPosEdge) || (negEdge && this.hasNegEdge);

    if (edge) {
      this.outputDFFQ(); this.evalComb();

      // Capture DFF inputs
      const caps = new Int32Array(this.dLen);
      const capFlag = new Uint8Array(this.dLen); // 1 = captured

      for (let di = 0; di < this.dLen; di++) {
        const cfg = this.dCfg[di];
        // Async reset (highest priority, level-sensitive)
        if (cfg.hasAsyncReset) {
          const r = N[this.dR[di]];
          if (cfg.asyncResetActiveHigh ? r === 1 : r === 0) {
            caps[di] = cfg.asyncResetValue; capFlag[di] = 1; continue;
          }
        }
        if (!(cfg.posEdge ? posEdge : negEdge)) continue;
        // Enable
        if (cfg.hasEnable) {
          const e = N[this.dE[di]];
          const enActive = cfg.enableActiveHigh ? e === 1 : e === 0;
          if (cfg.syncResetPriority && cfg.hasSyncReset) {
            const sr = N[this.dR[di]];
            if (cfg.syncResetActiveHigh ? sr === 1 : sr === 0) {
              caps[di] = cfg.syncResetValue; capFlag[di] = 1; continue;
            }
          }
          if (!enActive) continue;
        }
        // Sync reset
        if (cfg.hasSyncReset && !cfg.syncResetPriority) {
          const sr = N[this.dR[di]];
          if (cfg.syncResetActiveHigh ? sr === 1 : sr === 0) {
            caps[di] = cfg.syncResetValue; capFlag[di] = 1; continue;
          }
        }
        // Normal capture
        let val = 0;
        const dNets = this.dD[di];
        for (let i = 0; i < dNets.length; i++) val |= (N[dNets[i]] << i);
        caps[di] = val; capFlag[di] = 1;
      }

      for (let di = 0; di < this.dLen; di++) {
        if (capFlag[di]) this.dState[di] = caps[di];
      }
      this.outputDFFQ(); this.evalComb();
    } else {
      this.outputDFFQ(); this.evalComb();
      // Async reset check (level-sensitive)
      if (this.hasAsyncRst) {
        let changed = false;
        for (let di = 0; di < this.dLen; di++) {
          const cfg = this.dCfg[di];
          if (!cfg.hasAsyncReset) continue;
          const r = N[this.dR[di]];
          const active = cfg.asyncResetActiveHigh ? r === 1 : r === 0;
          if (active && this.dState[di] !== cfg.asyncResetValue) {
            this.dState[di] = cfg.asyncResetValue; changed = true;
          }
        }
        if (changed) { this.outputDFFQ(); this.evalComb(); }
      }
    }
  }

  // ─── Output DFF Q values to nets ───
  private outputDFFQ() {
    const N = this.nets;
    for (let di = 0; di < this.dLen; di++) {
      const qNets = this.dQ[di], state = this.dState[di];
      for (let i = 0; i < qNets.length; i++) {
        const idx = qNets[i];
        if (idx >= 2) N[idx] = (state >> i) & 1;
      }
    }
  }

  // ─── Evaluate all combinational cells ───
  private evalComb() {
    const N = this.nets;
    const op = this.cOp, a = this.cA, b = this.cB, s = this.cS, y = this.cY;
    for (let i = 0; i < this.cLen; i++) {
      switch (op[i]) {
        case OP_BUF:  N[y[i]] = N[a[i]]; break;
        case OP_NOT:  N[y[i]] = N[a[i]] ^ 1; break;
        case OP_AND:  N[y[i]] = N[a[i]] & N[b[i]]; break;
        case OP_OR:   N[y[i]] = N[a[i]] | N[b[i]]; break;
        case OP_XOR:  N[y[i]] = N[a[i]] ^ N[b[i]]; break;
        case OP_NAND: N[y[i]] = (N[a[i]] & N[b[i]]) ^ 1; break;
        case OP_NOR:  N[y[i]] = (N[a[i]] | N[b[i]]) ^ 1; break;
        case OP_XNOR: N[y[i]] = (N[a[i]] ^ N[b[i]]) ^ 1; break;
        case OP_MUX:  N[y[i]] = N[s[i]] ? N[b[i]] : N[a[i]]; break;
      }
    }
    // LUTs (rare with abc -g, but supported)
    for (const lut of this.luts) {
      let addr = 0;
      for (let i = 0; i < lut.ins.length; i++) addr |= (N[lut.ins[i]] << i);
      N[lut.out] = (lut.init >> addr) & 1;
    }
  }

  // ─── Pack outputs from nets ───
  private packOutputs(): Record<string, number> {
    const N = this.nets;
    const result: Record<string, number> = {};
    for (const { name, nets } of this.outPorts) {
      let val = 0;
      for (let i = 0; i < nets.length; i++) val |= (N[nets[i]] << i);
      result[name] = val;
    }
    return result;
  }

  // ─── Public API: evaluate one half-cycle ───
  evaluate(inputs: Record<string, number>): Record<string, number> {
    this.evaluateInternal(inputs);
    return this.packOutputs();
  }

  // ─── Public API: run N full clock cycles ───
  // Simulates a sample batch first (for PWM duty-cycle measurement),
  // then uses counter fast-forward to skip idle counter increments.
  // Auto-detects PWM vs FSM outputs: PWM designs run full batch,
  // FSM designs use early-break on stable output changes.
  runCycles(
    count: number,
    risingInputs: Record<string, number>,
    fallingInputs: Record<string, number>,
    onMidCycle?: (result: Record<string, number>) => void,
  ): Record<string, number> {
    let remaining = count;

    // Fast-forward helper: analytically skip counter increments
    const ctrDFFs = this.ctrDFFs;
    const rstActive = ctrDFFs && this.ctrRstNet >= 0 && this.isResetActive(risingInputs);
    const doFastForward = ctrDFFs && !rstActive;

    // When counter reset is held, outputs are stable (counter stuck at 0,
    // no transitions possible). Simulate a small batch and return early
    // to avoid freezing the UI with millions of unskippable cycles.
    if (rstActive) {
      const batch = Math.min(remaining, 32);
      for (let i = 0; i < batch; i++) {
        this.evaluateInternal(risingInputs);
        if (onMidCycle) onMidCycle(this.packOutputs());
        this.evaluateInternal(fallingInputs);
      }
      return this.packOutputs();
    }

    const fastForward = doFastForward ? () => {
      if (remaining <= 1) return;
      this.ctrVal = 0;
      for (let b = 0; b < ctrDFFs.length; b++)
        this.ctrVal |= (this.dState[ctrDFFs[b]] << b);
      const mask = this.ctrPeriod - 1;
      const toOvf = (mask - this.ctrVal) & mask;
      if (toOvf > 1 && toOvf <= remaining) {
        const skip = toOvf - 1;
        const nv = (this.ctrVal + skip) & mask;
        for (let b = 0; b < ctrDFFs.length; b++)
          this.dState[ctrDFFs[b]] = (nv >> b) & 1;
        this.ctrVal = nv;
        remaining -= skip;
      } else if (toOvf > remaining) {
        const nv = (this.ctrVal + remaining) & mask;
        for (let b = 0; b < ctrDFFs.length; b++)
          this.dState[ctrDFFs[b]] = (nv >> b) & 1;
        this.ctrVal = nv;
        remaining = 0;
      }
    } : null;

    // Phase 1: Simulate a sample batch before fast-forward.
    // This gives PWM outputs enough cycles for meaningful duty-cycle
    // measurement, and lets us detect whether outputs toggle rapidly.
    const wp = this._watchedPortName;
    const sampleSize = Math.min(remaining, 32);
    let toggleCount = 0;
    let prevWatched = -1;
    let snapshot = -1;

    for (let i = 0; i < sampleSize && remaining > 0; i++) {
      this.evaluateInternal(risingInputs);
      const out = this.packOutputs();
      if (onMidCycle) onMidCycle(out);

      const w = wp ? (out[wp] ?? -1) : -1;
      if (i === 0) snapshot = w;
      if (prevWatched >= 0 && w !== prevWatched) toggleCount++;
      prevWatched = w;

      this.evaluateInternal(fallingInputs);
      remaining--;
    }

    // Phase 2: Fast-forward + remaining cycles
    if (fastForward) fastForward();

    if (toggleCount >= 4) {
      // PWM detected: outputs toggle rapidly — run full batch, no early-break
      while (remaining > 0) {
        this.evaluateInternal(risingInputs);
        if (onMidCycle) onMidCycle(this.packOutputs());
        this.evaluateInternal(fallingInputs);
        remaining--;
        if (fastForward) fastForward();
      }
    } else {
      // FSM mode: early-break when output changes and stays stable
      let stableCount = 0;

      while (remaining > 0) {
        this.evaluateInternal(risingInputs);
        const out = this.packOutputs();
        if (onMidCycle) onMidCycle(out);

        const cur = wp ? (out[wp] ?? -1) : -1;
        if (cur !== snapshot && snapshot >= 0) {
          stableCount++;
          if (stableCount >= 4) {
            this.evaluateInternal(fallingInputs);
            break;
          }
        } else {
          stableCount = 0;
        }

        this.evaluateInternal(fallingInputs);
        remaining--;
        if (fastForward) fastForward();
      }
    }

    return this.packOutputs();
  }

  private isResetActive(inputs: Record<string, number>): boolean {
    if (!this.ctrDFFs || this.ctrRstNet < 0) return false;
    // Check if reset net is driven by an input that's currently active
    // Simple check: evaluate with current inputs and read the reset net
    const N = this.nets;
    N.fill(0); N[1] = 1;
    for (const { name, nets } of this.inPorts) {
      const val = inputs[name] ?? 0;
      for (let i = 0; i < nets.length; i++) {
        const idx = nets[i];
        if (idx >= 2) N[idx] = (val >> i) & 1;
      }
    }
    this.outputDFFQ(); this.evalComb();
    const r = N[this.ctrRstNet];
    return this.ctrRstHigh ? r === 1 : r === 0;
  }
}

// ─── Helper: get input pin names for topo sort ───
function getInputPins(type: string): string[] {
  if (HIGH_LEVEL_DFF_TYPES.has(type)) {
    const pins = ['D'];
    if (type === '$adff' || type === '$adffe') pins.push('ARST');
    if (type === '$sdff' || type === '$sdffe' || type === '$sdffce') pins.push('SRST');
    if (type.endsWith('e') && type !== '$adff') pins.push('EN');
    return pins;
  }
  if (isDFF(type)) {
    const pins = ['D'];
    const cfg = parseGateLevelDFF(type);
    if (cfg) {
      if (cfg.hasAsyncReset || cfg.hasSyncReset) pins.push('R');
      if (cfg.hasEnable) pins.push('E');
    }
    return pins;
  }
  switch (type) {
    case '$_BUF_': case '$_NOT_': return ['A'];
    case '$_AND_': case '$_OR_': case '$_XOR_':
    case '$_NAND_': case '$_NOR_': case '$_XNOR_': return ['A', 'B'];
    case '$_MUX_': return ['A', 'B', 'S'];
    case '$lut': return ['A'];
    default: return ['A', 'B', 'S'];
  }
}
