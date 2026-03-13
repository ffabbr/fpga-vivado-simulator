// Verilog Simulator Engine
// Simulates synthesizable Verilog at the behavioral level

import { parseVerilog, VerilogModule, VerilogAlwaysBlock } from './verilog-parser';

export interface SignalValue {
  value: number;
  width: number;
}

export interface WaveformData {
  time: number;
  signals: Record<string, number>;
}

export interface SimulationResult {
  waveform: WaveformData[];
  signals: string[];
  signalWidths: Record<string, number>;
  errors: string[];
  logs: string[];
  duration: number;
}

type SignalMap = Record<string, SignalValue>;

class SimulationContext {
  signals: SignalMap = {};
  time: number = 0;
  waveform: WaveformData[] = [];
  logs: string[] = [];
  errors: string[] = [];
  modules: Map<string, VerilogModule> = new Map();
  maxTime: number = 10000;
  timeUnit: number = 1;

  constructor(modules: VerilogModule[]) {
    for (const mod of modules) {
      this.modules.set(mod.name, mod);
    }
  }

  setSignal(name: string, value: number, width: number = 1) {
    const mask = width >= 32 ? 0xFFFFFFFF : (1 << width) - 1;
    const maskedValue = value & mask;
    this.signals[name] = { value: maskedValue, width };
  }

  getSignal(name: string): number {
    return this.signals[name]?.value ?? 0;
  }

  getSignalWidth(name: string): number {
    return this.signals[name]?.width ?? 1;
  }

  recordState() {
    const snapshot: Record<string, number> = {};
    for (const [name, sv] of Object.entries(this.signals)) {
      snapshot[name] = sv.value;
    }
    this.waveform.push({ time: this.time, signals: snapshot });
  }
}

// Expression evaluator for Verilog expressions
function evaluateExpression(expr: string, ctx: SimulationContext): number {
  expr = expr.trim();

  // Number literals
  const numMatch = expr.match(/^(\d+)'([bhd])([0-9a-fA-F_]+)$/);
  if (numMatch) {
    const base = numMatch[2] === 'b' ? 2 : numMatch[2] === 'h' ? 16 : 10;
    return parseInt(numMatch[3].replace(/_/g, ''), base);
  }

  // Plain decimal
  if (/^\d+$/.test(expr)) {
    return parseInt(expr);
  }

  // Signal reference with bit select
  const bitSelectMatch = expr.match(/^(\w+)\[(\d+)\]$/);
  if (bitSelectMatch) {
    const val = ctx.getSignal(bitSelectMatch[1]);
    const bit = parseInt(bitSelectMatch[2]);
    return (val >> bit) & 1;
  }

  // Signal reference with range select
  const rangeSelectMatch = expr.match(/^(\w+)\[(\d+):(\d+)\]$/);
  if (rangeSelectMatch) {
    const val = ctx.getSignal(rangeSelectMatch[1]);
    const msb = parseInt(rangeSelectMatch[2]);
    const lsb = parseInt(rangeSelectMatch[3]);
    const width = msb - lsb + 1;
    const mask = (1 << width) - 1;
    return (val >> lsb) & mask;
  }

  // Simple signal reference
  if (/^\w+$/.test(expr)) {
    return ctx.getSignal(expr);
  }

  // Concatenation {a, b, c}
  const concatMatch = expr.match(/^\{(.+)\}$/);
  if (concatMatch) {
    const parts = splitTopLevel(concatMatch[1], ',');
    let result = 0;
    let totalBits = 0;
    for (const part of parts) {
      const trimmed = part.trim();
      // Check for replication {N{expr}}
      const repMatch = trimmed.match(/^(\d+)\{(.+)\}$/);
      if (repMatch) {
        const count = parseInt(repMatch[1]);
        const innerVal = evaluateExpression(repMatch[2], ctx);
        const innerWidth = guessWidth(repMatch[2], ctx);
        for (let i = 0; i < count; i++) {
          result = (result << innerWidth) | innerVal;
          totalBits += innerWidth;
        }
      } else {
        const val = evaluateExpression(trimmed, ctx);
        const w = guessWidth(trimmed, ctx);
        result = (result << w) | val;
        totalBits += w;
      }
    }
    return result;
  }

  // Unary operators
  if (expr.startsWith('~')) {
    const operand = evaluateExpression(expr.slice(1), ctx);
    return ~operand;
  }
  if (expr.startsWith('!')) {
    const operand = evaluateExpression(expr.slice(1), ctx);
    return operand === 0 ? 1 : 0;
  }
  if (expr.startsWith('&')) {
    // Reduction AND
    const operand = evaluateExpression(expr.slice(1), ctx);
    const w = guessWidth(expr.slice(1), ctx);
    const mask = (1 << w) - 1;
    return (operand & mask) === mask ? 1 : 0;
  }
  if (expr.startsWith('|')) {
    const operand = evaluateExpression(expr.slice(1), ctx);
    return operand !== 0 ? 1 : 0;
  }
  if (expr.startsWith('^')) {
    // Reduction XOR
    const operand = evaluateExpression(expr.slice(1), ctx);
    let result = 0;
    let val = operand;
    while (val) { result ^= val & 1; val >>= 1; }
    return result;
  }

  // Ternary operator
  const ternaryParts = splitTernary(expr);
  if (ternaryParts) {
    const cond = evaluateExpression(ternaryParts.condition, ctx);
    return cond ? evaluateExpression(ternaryParts.trueExpr, ctx) :
      evaluateExpression(ternaryParts.falseExpr, ctx);
  }

  // Binary operators (ordered by precedence, lowest first)
  const binaryOps: [string, (a: number, b: number) => number][] = [
    ['||', (a, b) => (a || b) ? 1 : 0],
    ['&&', (a, b) => (a && b) ? 1 : 0],
    ['|', (a, b) => a | b],
    ['^', (a, b) => a ^ b],
    ['&', (a, b) => a & b],
    ['==', (a, b) => a === b ? 1 : 0],
    ['!=', (a, b) => a !== b ? 1 : 0],
    ['>=', (a, b) => a >= b ? 1 : 0],
    ['<=', (a, b) => a <= b ? 1 : 0],
    ['>', (a, b) => a > b ? 1 : 0],
    ['<', (a, b) => a < b ? 1 : 0],
    ['<<', (a, b) => a << b],
    ['>>', (a, b) => a >>> b],
    ['+', (a, b) => a + b],
    ['-', (a, b) => a - b],
    ['*', (a, b) => a * b],
    ['/', (a, b) => b !== 0 ? Math.floor(a / b) : 0],
    ['%', (a, b) => b !== 0 ? a % b : 0],
  ];

  for (const [op, fn] of binaryOps) {
    const idx = findBinaryOp(expr, op);
    if (idx >= 0) {
      const left = evaluateExpression(expr.slice(0, idx), ctx);
      const right = evaluateExpression(expr.slice(idx + op.length), ctx);
      return fn(left, right);
    }
  }

  // Parenthesized expression
  if (expr.startsWith('(') && expr.endsWith(')')) {
    return evaluateExpression(expr.slice(1, -1), ctx);
  }

  return 0;
}

function guessWidth(expr: string, ctx: SimulationContext): number {
  expr = expr.trim();
  const numMatch = expr.match(/^(\d+)'[bhd]/);
  if (numMatch) return parseInt(numMatch[1]);
  if (/^\d+$/.test(expr)) return 32;
  const bitSelectMatch = expr.match(/^(\w+)\[(\d+)\]$/);
  if (bitSelectMatch) return 1;
  const rangeSelectMatch = expr.match(/^(\w+)\[(\d+):(\d+)\]$/);
  if (rangeSelectMatch) return parseInt(rangeSelectMatch[2]) - parseInt(rangeSelectMatch[3]) + 1;
  if (/^\w+$/.test(expr)) return ctx.getSignalWidth(expr);
  return 1;
}

function findBinaryOp(expr: string, op: string): number {
  let depth = 0;
  // Search from right to left for left-associative operators
  for (let i = expr.length - 1; i >= op.length; i--) {
    if (expr[i] === ')' || expr[i] === '}') depth++;
    if (expr[i] === '(' || expr[i] === '{') depth--;
    if (depth === 0) {
      const slice = expr.slice(i - op.length + 1, i + 1);
      if (slice === op) {
        // Make sure we're not matching a multi-char operator partially
        if (op === '|' && (expr[i - 1] === '|' || expr[i + 1] === '|')) continue;
        if (op === '&' && (expr[i - 1] === '&' || expr[i + 1] === '&')) continue;
        if (op === '>' && expr[i - 1] === '>') continue;
        if (op === '<' && expr[i - 1] === '<') continue;
        if (op === '=' && (expr[i - 1] === '=' || expr[i - 1] === '!' || expr[i - 1] === '>' || expr[i - 1] === '<')) continue;
        const leftPart = expr.slice(0, i - op.length + 1).trim();
        if (leftPart.length === 0) continue;
        return i - op.length + 1;
      }
    }
  }
  return -1;
}

function splitTopLevel(str: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of str) {
    if (ch === '(' || ch === '{') depth++;
    if (ch === ')' || ch === '}') depth--;
    if (ch === delimiter && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function splitTernary(expr: string): { condition: string; trueExpr: string; falseExpr: string } | null {
  let depth = 0;
  let questionIdx = -1;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(' || expr[i] === '{') depth++;
    if (expr[i] === ')' || expr[i] === '}') depth--;
    if (depth === 0 && expr[i] === '?') {
      questionIdx = i;
      break;
    }
  }
  if (questionIdx < 0) return null;

  depth = 0;
  for (let i = questionIdx + 1; i < expr.length; i++) {
    if (expr[i] === '(' || expr[i] === '{') depth++;
    if (expr[i] === ')' || expr[i] === '}') depth--;
    if (depth === 0 && expr[i] === ':') {
      return {
        condition: expr.slice(0, questionIdx).trim(),
        trueExpr: expr.slice(questionIdx + 1, i).trim(),
        falseExpr: expr.slice(i + 1).trim(),
      };
    }
  }
  return null;
}

// Execute a block of procedural Verilog statements
function executeBlock(code: string, ctx: SimulationContext): void {
  let body = code.trim();
  if (body.startsWith('begin')) body = body.slice(5);
  if (body.endsWith('end')) body = body.slice(0, -3);
  body = body.trim();

  const statements = parseStatements(body);
  for (const stmt of statements) {
    executeStatement(stmt.trim(), ctx);
  }
}

function parseStatements(body: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let inCase = 0;

  const lines = body.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Track begin/end depth for multi-line blocks
    const beginCount = (line.match(/\bbegin\b/g) || []).length;
    const endCount = (line.match(/\bend\b/g) || []).length;
    const caseCount = (line.match(/\bcase[zx]?\b/g) || []).length;
    const endcaseCount = (line.match(/\bendcase\b/g) || []).length;

    depth += beginCount - endCount;
    inCase += caseCount - endcaseCount;

    current += (current ? '\n' : '') + line;

    if (depth <= 0 && inCase <= 0) {
      if (line.endsWith(';') || line === 'end' || line === 'endcase') {
        statements.push(current);
        current = '';
        depth = 0;
        inCase = 0;
      }
    }
  }
  if (current.trim()) statements.push(current);
  return statements;
}

function executeStatement(stmt: string, ctx: SimulationContext): void {
  stmt = stmt.trim();
  if (!stmt || stmt === 'begin' || stmt === 'end') return;

  // $display / $monitor
  const displayMatch = stmt.match(/\$(display|monitor)\s*\(\s*"([^"]*)"(?:\s*,\s*(.+))?\)\s*;/);
  if (displayMatch) {
    let fmt = displayMatch[2];
    if (displayMatch[3]) {
      const args = splitTopLevel(displayMatch[3], ',');
      for (const arg of args) {
        const val = evaluateExpression(arg.trim(), ctx);
        fmt = fmt.replace(/%[bdh0-9]*/, val.toString());
      }
    }
    fmt = fmt.replace(/%t/, ctx.time.toString());
    ctx.logs.push(`[${ctx.time}] ${fmt}`);
    return;
  }

  // $finish
  if (stmt.match(/\$finish\s*;/)) {
    ctx.time = ctx.maxTime; // End simulation
    return;
  }

  // Time delay #N
  const delayMatch = stmt.match(/^#(\d+)\s*;?$/);
  if (delayMatch) {
    ctx.time += parseInt(delayMatch[1]) * ctx.timeUnit;
    ctx.recordState();
    return;
  }

  // Delay followed by statement: #N statement;
  const delayStmtMatch = stmt.match(/^#(\d+)\s+(.+)$/);
  if (delayStmtMatch) {
    ctx.time += parseInt(delayStmtMatch[1]) * ctx.timeUnit;
    ctx.recordState();
    executeStatement(delayStmtMatch[2], ctx);
    return;
  }

  // Non-blocking assignment: signal <= expr;
  const nbaMatch = stmt.match(/^(\w+)(\[\d+(?::\d+)?\])?\s*<=\s*(.+?)\s*;$/);
  if (nbaMatch) {
    const val = evaluateExpression(nbaMatch[3], ctx);
    const width = ctx.getSignalWidth(nbaMatch[1]) || guessWidth(nbaMatch[3], ctx);
    if (nbaMatch[2]) {
      handleBitAssign(nbaMatch[1], nbaMatch[2], val, ctx);
    } else {
      ctx.setSignal(nbaMatch[1], val, width);
    }
    return;
  }

  // Blocking assignment: signal = expr;
  const baMatch = stmt.match(/^(\w+)(\[\d+(?::\d+)?\])?\s*=\s*(.+?)\s*;$/);
  if (baMatch) {
    const val = evaluateExpression(baMatch[3], ctx);
    const width = ctx.getSignalWidth(baMatch[1]) || guessWidth(baMatch[3], ctx);
    if (baMatch[2]) {
      handleBitAssign(baMatch[1], baMatch[2], val, ctx);
    } else {
      ctx.setSignal(baMatch[1], val, width);
    }
    return;
  }

  // if-else
  const ifMatch = stmt.match(/^if\s*\((.+?)\)\s*(begin[\s\S]*?end|[^;]*;)(?:\s*else\s*(begin[\s\S]*?end|if[\s\S]*|[^;]*;))?/);
  if (ifMatch) {
    const cond = evaluateExpression(ifMatch[1], ctx);
    if (cond) {
      executeBlock(ifMatch[2], ctx);
    } else if (ifMatch[3]) {
      executeBlock(ifMatch[3], ctx);
    }
    return;
  }

  // case statement
  const caseMatch = stmt.match(/^case[zx]?\s*\((.+?)\)\s*([\s\S]*?)\s*endcase/);
  if (caseMatch) {
    const caseVal = evaluateExpression(caseMatch[1], ctx);
    const caseBody = caseMatch[2];
    const caseItems = caseBody.split(/\n/).reduce((acc: string[], line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return acc;
      if (acc.length > 0 && !trimmed.match(/^(\d+[']|default\s*:|\w+\s*:)/)) {
        acc[acc.length - 1] += '\n' + trimmed;
      } else {
        acc.push(trimmed);
      }
      return acc;
    }, []);

    let matched = false;
    for (const item of caseItems) {
      const itemMatch = item.match(/^(.+?)\s*:\s*([\s\S]+)$/);
      if (!itemMatch) continue;
      const label = itemMatch[1].trim();
      const action = itemMatch[2].trim();

      if (label === 'default') {
        if (!matched) executeBlock(action, ctx);
        break;
      }

      const labelVal = evaluateExpression(label, ctx);
      if (labelVal === caseVal && !matched) {
        matched = true;
        executeBlock(action, ctx);
      }
    }
    return;
  }

  // for loop
  const forMatch = stmt.match(/^for\s*\((.+?);(.+?);(.+?)\)\s*(begin[\s\S]*?end|[^;]*;)/);
  if (forMatch) {
    executeStatement(forMatch[1].trim() + ';', ctx);
    let iterations = 0;
    while (evaluateExpression(forMatch[2].trim(), ctx) && iterations < 10000) {
      executeBlock(forMatch[4], ctx);
      executeStatement(forMatch[3].trim() + ';', ctx);
      iterations++;
    }
    return;
  }

  // repeat
  const repeatMatch = stmt.match(/^repeat\s*\((.+?)\)\s*(begin[\s\S]*?end|[^;]*;)/);
  if (repeatMatch) {
    const count = evaluateExpression(repeatMatch[1], ctx);
    for (let i = 0; i < count && i < 100000; i++) {
      executeBlock(repeatMatch[2], ctx);
    }
    return;
  }

  // $dumpfile, $dumpvars - ignore
  if (stmt.startsWith('$dump')) return;
  // $monitor - ignore for now
  if (stmt.startsWith('$monitor')) return;
}

function handleBitAssign(name: string, selector: string, val: number, ctx: SimulationContext) {
  const current = ctx.getSignal(name);
  const width = ctx.getSignalWidth(name);
  const bitMatch = selector.match(/\[(\d+)(?::(\d+))?\]/);
  if (!bitMatch) return;

  if (bitMatch[2] !== undefined) {
    const msb = parseInt(bitMatch[1]);
    const lsb = parseInt(bitMatch[2]);
    const rangeWidth = msb - lsb + 1;
    const mask = ((1 << rangeWidth) - 1) << lsb;
    const newVal = (current & ~mask) | ((val << lsb) & mask);
    ctx.setSignal(name, newVal, width);
  } else {
    const bit = parseInt(bitMatch[1]);
    const mask = 1 << bit;
    const newVal = val ? (current | mask) : (current & ~mask);
    ctx.setSignal(name, newVal, width);
  }
}

// Evaluate continuous assignments for a module
function evaluateContinuousAssigns(mod: VerilogModule, ctx: SimulationContext) {
  for (const assign of mod.assigns) {
    const val = evaluateExpression(assign.expression, ctx);
    if (assign.targetBit !== undefined) {
      handleBitAssign(assign.target, `[${assign.targetBit}]`, val, ctx);
    } else if (assign.targetMsb !== undefined && assign.targetLsb !== undefined) {
      handleBitAssign(assign.target, `[${assign.targetMsb}:${assign.targetLsb}]`, val, ctx);
    } else {
      const port = mod.ports.find(p => p.name === assign.target);
      const wire = mod.wires.find(w => w.name === assign.target);
      const width = port?.width ?? wire?.width ?? 1;
      ctx.setSignal(assign.target, val, width);
    }
  }
}

// Evaluate combinational always blocks
function evaluateCombinational(mod: VerilogModule, ctx: SimulationContext) {
  for (const block of mod.alwaysBlocks) {
    if (block.type === 'combinational') {
      executeBlock(block.body, ctx);
    }
  }
}

export function simulate(
  sources: Record<string, string>,
  topModule: string,
  testbenchModule: string,
  maxTimeNs: number = 1000
): SimulationResult {
  const errors: string[] = [];
  const allModules: VerilogModule[] = [];

  // Parse all sources
  for (const [filename, source] of Object.entries(sources)) {
    const result = parseVerilog(source);
    if (result.errors.length > 0) {
      errors.push(...result.errors.map(e => `${filename}: ${e}`));
    }
    allModules.push(...result.modules);
  }

  if (errors.length > 0) {
    return { waveform: [], signals: [], signalWidths: {}, errors, logs: [], duration: 0 };
  }

  const designMod = allModules.find(m => m.name === topModule);
  const tbMod = allModules.find(m => m.name === testbenchModule);

  if (!tbMod) {
    errors.push(`Testbench module '${testbenchModule}' not found`);
    return { waveform: [], signals: [], signalWidths: {}, errors, logs: [], duration: 0 };
  }

  const ctx = new SimulationContext(allModules);
  ctx.maxTime = maxTimeNs;

  // Initialize testbench signals
  for (const reg of tbMod.regs) {
    ctx.setSignal(reg.name, 0, reg.width);
  }
  for (const wire of tbMod.wires) {
    ctx.setSignal(wire.name, 0, wire.width);
  }

  // Initialize design module signals
  if (designMod) {
    for (const port of designMod.ports) {
      ctx.setSignal(port.name, 0, port.width);
    }
    for (const wire of designMod.wires) {
      ctx.setSignal(wire.name, 0, wire.width);
    }
    for (const reg of designMod.regs) {
      ctx.setSignal(reg.name, 0, reg.width);
    }
  }

  ctx.recordState();

  // Execute initial blocks from testbench
  for (const initial of tbMod.initialBlocks) {
    executeBlock(initial.body, ctx);
    ctx.recordState();
  }

  // After initial blocks run, evaluate continuous assignments and combinational logic
  if (designMod) {
    // Map testbench connections to design module ports via instances
    for (const inst of tbMod.instances) {
      if (inst.moduleName === topModule && designMod) {
        // Copy connected signals
        for (const [portName, wireName] of Object.entries(inst.connections)) {
          const port = designMod.ports.find(p => p.name === portName);
          if (port && port.direction === 'input') {
            ctx.setSignal(portName, ctx.getSignal(wireName), port.width);
          }
        }
      }
    }

    evaluateContinuousAssigns(designMod, ctx);
    evaluateCombinational(designMod, ctx);

    // Copy outputs back
    for (const inst of tbMod.instances) {
      if (inst.moduleName === topModule) {
        for (const [portName, wireName] of Object.entries(inst.connections)) {
          const port = designMod.ports.find(p => p.name === portName);
          if (port && port.direction === 'output') {
            ctx.setSignal(wireName, ctx.getSignal(portName), port.width);
          }
        }
      }
    }
  }

  // Handle clock-based simulation
  const clockSignals: string[] = [];
  for (const block of tbMod.alwaysBlocks) {
    // Check for clock generation patterns: always #5 clk = ~clk;
    const clkMatch = block.body.match(/(\w+)\s*[<]?=\s*~\1/);
    if (clkMatch) clockSignals.push(clkMatch[1]);
  }

  // Check for always blocks with delay
  const alwaysDelayRegex = /always\s*#(\d+)\s+(.+)/g;
  const rawTb = tbMod.raw;
  let alwaysDelayMatch;
  const clockGenerators: { period: number; body: string }[] = [];
  while ((alwaysDelayMatch = alwaysDelayRegex.exec(rawTb)) !== null) {
    clockGenerators.push({
      period: parseInt(alwaysDelayMatch[1]),
      body: alwaysDelayMatch[2],
    });
  }

  // Run clock-based simulation if there are clocks
  if (clockGenerators.length > 0 && ctx.time < ctx.maxTime) {
    const minPeriod = Math.min(...clockGenerators.map(c => c.period));
    while (ctx.time < ctx.maxTime) {
      ctx.time += minPeriod;

      // Toggle clocks
      for (const gen of clockGenerators) {
        if (ctx.time % gen.period === 0) {
          executeStatement(gen.body.trim(), ctx);
        }
      }

      // Propagate through design
      if (designMod) {
        for (const inst of tbMod.instances) {
          if (inst.moduleName === topModule) {
            for (const [portName, wireName] of Object.entries(inst.connections)) {
              const port = designMod.ports.find(p => p.name === portName);
              if (port && port.direction === 'input') {
                ctx.setSignal(portName, ctx.getSignal(wireName), port.width);
              }
            }
          }
        }

        // Execute sequential always blocks on clock edges
        for (const block of designMod.alwaysBlocks) {
          if (block.type === 'sequential') {
            // Check if the relevant clock edge occurred
            executeBlock(block.body, ctx);
          }
        }

        evaluateContinuousAssigns(designMod, ctx);
        evaluateCombinational(designMod, ctx);

        for (const inst of tbMod.instances) {
          if (inst.moduleName === topModule) {
            for (const [portName, wireName] of Object.entries(inst.connections)) {
              const port = designMod.ports.find(p => p.name === portName);
              if (port && port.direction === 'output') {
                ctx.setSignal(wireName, ctx.getSignal(portName), port.width);
              }
            }
          }
        }
      }

      ctx.recordState();
    }
  }

  // Collect signal info
  const signalNames: string[] = [];
  const signalWidths: Record<string, number> = {};
  for (const [name, sv] of Object.entries(ctx.signals)) {
    signalNames.push(name);
    signalWidths[name] = sv.width;
  }

  return {
    waveform: ctx.waveform,
    signals: signalNames.sort(),
    signalWidths,
    errors: ctx.errors,
    logs: ctx.logs,
    duration: ctx.time,
  };
}

// ─── Helper: read a signal expression that may include bit/range selects ───

function readExpr(expr: string, ctx: SimulationContext): number {
  expr = expr.trim();
  // Numeric literal (e.g. 0, 1, 1'b0)
  if (/^\d+$/.test(expr)) return parseInt(expr, 10);
  const numMatch = expr.match(/^(\d+)'([bhd])([0-9a-fA-F_]+)$/);
  if (numMatch) {
    const base = numMatch[2] === 'b' ? 2 : numMatch[2] === 'h' ? 16 : 10;
    return parseInt(numMatch[3].replace(/_/g, ''), base);
  }
  // Bit select: name[N]
  const bitSel = expr.match(/^(\w+)\[(\d+)\]$/);
  if (bitSel) return (ctx.getSignal(bitSel[1]) >> parseInt(bitSel[2])) & 1;
  // Range select: name[M:L]
  const rangeSel = expr.match(/^(\w+)\[(\d+):(\d+)\]$/);
  if (rangeSel) {
    const msb = parseInt(rangeSel[2]), lsb = parseInt(rangeSel[3]);
    return (ctx.getSignal(rangeSel[1]) >> lsb) & ((1 << (msb - lsb + 1)) - 1);
  }
  // Simple signal
  if (/^\w+$/.test(expr)) return ctx.getSignal(expr);
  return 0;
}

function writeExpr(expr: string, val: number, width: number, ctx: SimulationContext) {
  expr = expr.trim();
  // Bit select: name[N]
  const bitSel = expr.match(/^(\w+)\[(\d+)\]$/);
  if (bitSel) {
    const name = bitSel[1];
    const bit = parseInt(bitSel[2]);
    const current = ctx.getSignal(name);
    const w = ctx.getSignalWidth(name) || (bit + 1);
    ctx.setSignal(name, (current & ~(1 << bit)) | ((val & 1) << bit), w);
    return;
  }
  // Range select: name[M:L]
  const rangeSel = expr.match(/^(\w+)\[(\d+):(\d+)\]$/);
  if (rangeSel) {
    const name = rangeSel[1];
    const msb = parseInt(rangeSel[2]), lsb = parseInt(rangeSel[3]);
    const rw = msb - lsb + 1;
    const mask = ((1 << rw) - 1) << lsb;
    const current = ctx.getSignal(name);
    const w = ctx.getSignalWidth(name) || (msb + 1);
    ctx.setSignal(name, (current & ~mask) | ((val & ((1 << rw) - 1)) << lsb), w);
    return;
  }
  // Simple signal
  ctx.setSignal(expr, val, width);
}

// ─── Evaluate a single module (non-recursive helper) ───

function evaluateModule(
  mod: VerilogModule,
  allModules: VerilogModule[],
  inputs: Record<string, number>,
  depth: number,
): Record<string, number> {
  if (depth > 20) return {}; // prevent runaway recursion

  const ctx = new SimulationContext(allModules);

  // Set up ports
  for (const port of mod.ports) {
    if (port.direction === 'input') {
      ctx.setSignal(port.name, inputs[port.name] ?? 0, port.width);
    } else {
      ctx.setSignal(port.name, 0, port.width);
    }
  }
  for (const wire of mod.wires) {
    ctx.setSignal(wire.name, 0, wire.width);
  }
  for (const reg of mod.regs) {
    ctx.setSignal(reg.name, 0, reg.width);
  }

  // Iterate for propagation
  for (let iter = 0; iter < 10; iter++) {
    evaluateContinuousAssigns(mod, ctx);
    evaluateCombinational(mod, ctx);

    // Gate primitives
    for (const g of mod.gatePrimitives) {
      const inputVals = g.inputs.map(name => readExpr(name, ctx) & 1);
      let outVal: number;
      switch (g.gate) {
        case 'and':  outVal = inputVals.reduce((a, b) => a & b, 1); break;
        case 'nand': outVal = inputVals.reduce((a, b) => a & b, 1) ^ 1; break;
        case 'or':   outVal = inputVals.reduce((a, b) => a | b, 0); break;
        case 'nor':  outVal = inputVals.reduce((a, b) => a | b, 0) ^ 1; break;
        case 'xor':  outVal = inputVals.reduce((a, b) => a ^ b, 0); break;
        case 'xnor': outVal = inputVals.reduce((a, b) => a ^ b, 0) ^ 1; break;
        case 'not':  outVal = inputVals[0] ^ 1; break;
        case 'buf':  outVal = inputVals[0]; break;
        default:     outVal = 0;
      }
      writeExpr(g.output, outVal, 1, ctx);
    }

    // Module instances (hierarchical)
    for (const inst of mod.instances) {
      const subMod = allModules.find(m => m.name === inst.moduleName);
      if (!subMod) continue;

      // Build sub-module inputs from connections
      const subInputs: Record<string, number> = {};
      for (const port of subMod.ports) {
        if (port.direction !== 'input') continue;

        let expr: string | undefined;
        if (inst.positionalArgs) {
          // Positional: map by port order index
          const idx = subMod.ports.indexOf(port);
          expr = idx >= 0 ? inst.positionalArgs[idx] : undefined;
        } else {
          expr = inst.connections[port.name];
        }
        if (expr !== undefined) {
          subInputs[port.name] = readExpr(expr, ctx);
        }
      }

      // Recursively evaluate the sub-module
      const subOutputs = evaluateModule(subMod, allModules, subInputs, depth + 1);

      // Write sub-module outputs back to parent signals
      for (const port of subMod.ports) {
        if (port.direction !== 'output') continue;

        let expr: string | undefined;
        if (inst.positionalArgs) {
          const idx = subMod.ports.indexOf(port);
          expr = idx >= 0 ? inst.positionalArgs[idx] : undefined;
        } else {
          expr = inst.connections[port.name];
        }
        if (expr !== undefined && subOutputs[port.name] !== undefined) {
          writeExpr(expr, subOutputs[port.name], port.width, ctx);
        }
      }
    }
  }

  const outputs: Record<string, number> = {};
  for (const port of mod.ports) {
    if (port.direction === 'output') {
      outputs[port.name] = ctx.getSignal(port.name);
    }
  }
  return outputs;
}

// Simple combinational-only evaluation for FPGA board simulation
export function evaluateDesign(
  source: string,
  moduleName: string,
  inputs: Record<string, number>
): Record<string, number> {
  const result = parseVerilog(source);
  if (result.errors.length > 0 || result.modules.length === 0) {
    return {};
  }

  const mod = result.modules.find(m => m.name === moduleName) || result.modules[0];
  return evaluateModule(mod, result.modules, inputs, 0);
}
