// Verilog Parser - Parses Verilog source into an AST

export interface VerilogPort {
  name: string;
  direction: 'input' | 'output' | 'inout';
  width: number; // bit width
  msb: number;
  lsb: number;
  isReg: boolean;
}

export interface VerilogParam {
  name: string;
  value: number;
}

export interface VerilogAssign {
  target: string;
  targetRaw?: string;
  targetBit?: number;
  targetMsb?: number;
  targetLsb?: number;
  expression: string;
  delay?: string;
}

export interface VerilogAlwaysBlock {
  sensitivity: string; // 'posedge clk', '*', etc.
  body: string;
  type: 'combinational' | 'sequential';
}

export interface VerilogInitialBlock {
  body: string;
}

export interface VerilogWire {
  name: string;
  width: number;
  msb: number;
  lsb: number;
}

export interface VerilogReg {
  name: string;
  width: number;
  msb: number;
  lsb: number;
}

export interface VerilogInstance {
  moduleName: string;
  instanceName: string;
  connections: Record<string, string>;       // named: portName → expression
  positionalArgs?: string[];                 // positional: ordered arg expressions
}

export interface VerilogGatePrimitive {
  gate: string;           // "and", "or", "xor", "not", "nand", "nor", "xnor", "buf"
  instanceName?: string;  // optional instance name
  delay?: string;
  output: string;         // first arg is output
  inputs: string[];       // remaining args are inputs
}

export interface VerilogModule {
  name: string;
  ports: VerilogPort[];
  params: VerilogParam[];
  wires: VerilogWire[];
  regs: VerilogReg[];
  assigns: VerilogAssign[];
  alwaysBlocks: VerilogAlwaysBlock[];
  initialBlocks: VerilogInitialBlock[];
  instances: VerilogInstance[];
  gatePrimitives: VerilogGatePrimitive[];
  raw: string;
}

export interface ParseResult {
  modules: VerilogModule[];
  errors: string[];
}

function stripComments(src: string): string {
  // Remove single-line comments
  let result = src.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
}

// Find the balanced begin/end block starting at the given index (pointing to 'begin')
// Returns the substring from 'begin' to its matching 'end', or null if unbalanced
function extractBalancedBlock(src: string, startIdx: number): string | null {
  let depth = 0;
  let i = startIdx;
  while (i < src.length) {
    const rest = src.slice(i);
    const beginMatch = rest.match(/^\bbegin\b/);
    if (beginMatch) {
      depth++;
      i += 5; // length of 'begin'
      continue;
    }
    const endMatch = rest.match(/^\bend\b/);
    if (endMatch) {
      depth--;
      if (depth === 0) {
        return src.slice(startIdx, i + 3); // include 'end'
      }
      i += 3; // length of 'end'
      continue;
    }
    i++;
  }
  return null;
}

function splitTopLevel(src: string, delimiter = ','): string[] {
  const out: string[] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') bracket++;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === '{') brace++;
    else if (c === '}') brace = Math.max(0, brace - 1);
    else if (c === delimiter && paren === 0 && bracket === 0 && brace === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = src.slice(start).trim();
  if (last) out.push(last);
  return out;
}

function parseConstNumber(src: string): number | null {
  const s = src.trim().replace(/_/g, '');
  const sized = s.match(/^(?:\d+)?'[sS]?([bBoOdDhH])([0-9a-fA-FxXzZ?]+)$/);
  if (sized) {
    if (/[xXzZ?]/.test(sized[2])) return null;
    const radix = sized[1].toLowerCase() === 'b' ? 2 : sized[1].toLowerCase() === 'o' ? 8 : sized[1].toLowerCase() === 'h' ? 16 : 10;
    return parseInt(sized[2], radix);
  }
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

function evalConstExpr(src: string, params: Map<string, number>): number | null {
  const toks = src.match(/(?:\d+)?'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ?_]+|\d+|[A-Za-z_]\w*|<<|>>|[()+\-*/%]/g) || [];
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];

  const parsePrimary = (): number | null => {
    const t = next();
    if (!t) return null;
    if (t === '(') {
      const v = parseAdd();
      if (next() !== ')') return null;
      return v;
    }
    if (/^[A-Za-z_]\w*$/.test(t)) return params.get(t) ?? null;
    return parseConstNumber(t);
  };
  const parseUnary = (): number | null => {
    if (peek() === '+') { next(); return parseUnary(); }
    if (peek() === '-') { next(); const v = parseUnary(); return v === null ? null : -v; }
    return parsePrimary();
  };
  const parseMul = (): number | null => {
    let v = parseUnary();
    while (v !== null && peek() !== undefined && ['*', '/', '%'].includes(peek()!)) {
      const op = next();
      const r = parseUnary();
      if (r === null) return null;
      if (op === '*') v *= r;
      else if (op === '/') v = r === 0 ? null : Math.trunc(v / r);
      else v = r === 0 ? null : v % r;
    }
    return v;
  };
  const parseAdd = (): number | null => {
    let v = parseMul();
    while (v !== null && peek() !== undefined && ['+', '-', '<<', '>>'].includes(peek()!)) {
      const op = next();
      const r = parseMul();
      if (r === null) return null;
      if (op === '+') v += r;
      else if (op === '-') v -= r;
      else if (op === '<<') v <<= r;
      else v >>= r;
    }
    return v;
  };

  const result = parseAdd();
  return result !== null && i === toks.length ? result : null;
}

function parseWidth(widthStr: string, params = new Map<string, number>()): { width: number; msb: number; lsb: number } {
  const match = widthStr.match(/\[([^:\]]+):([^\]]+)\]/);
  if (match) {
    const msb = evalConstExpr(match[1], params);
    const lsb = evalConstExpr(match[2], params);
    if (msb !== null && lsb !== null) {
      return { width: Math.abs(msb - lsb) + 1, msb, lsb };
    }
  }
  return { width: 1, msb: 0, lsb: 0 };
}

function parsePorts(portSection: string, bodySection: string, params: Map<string, number>): VerilogPort[] {
  const ports: VerilogPort[] = [];

  // Try ANSI-style ports (direction in port list)
  let current: { direction: 'input' | 'output' | 'inout'; isReg: boolean; widthStr: string } | null = null;
  for (const part of splitTopLevel(portSection)) {
    const m = part.match(/^(?:(input|output|inout)\b\s*)?(?:(wire|reg|logic)\b\s*)?(?:signed\s+)?(\[[^\]]+\]\s*)?(.+)$/);
    if (!m) continue;
    if (m[1]) {
      current = {
        direction: m[1] as 'input' | 'output' | 'inout',
        isReg: m[2] === 'reg' || m[2] === 'logic',
        widthStr: (m[3] || '').trim(),
      };
    } else if (current && (m[2] || m[3])) {
      current = {
        direction: current.direction,
        isReg: m[2] ? (m[2] === 'reg' || m[2] === 'logic') : current.isReg,
        widthStr: (m[3] || current.widthStr).trim(),
      };
    }
    if (!current) continue;
    const nameMatch = m[4].trim().match(/^(\w+)/);
    if (!nameMatch) continue;
    const { width, msb, lsb } = parseWidth(current.widthStr, params);
    ports.push({ name: nameMatch[1], direction: current.direction, width, msb, lsb, isReg: current.isReg });
  }

  if (ports.length > 0) return ports;

  // Non-ANSI style: port names in module header, directions in body
  const portNames: string[] = portSection.match(/\w+/g) || [];
  const dirRegex = /\b(input|output|inout)\s+(?:(wire|reg|logic)\s+)?(?:signed\s+)?(\[[^\]]+\])?\s*(\w+(?:\s*,\s*\w+)*)\s*;/g;
  let match;

  while ((match = dirRegex.exec(bodySection)) !== null) {
    const direction = match[1] as 'input' | 'output' | 'inout';
    const isReg = match[2] === 'reg' || match[2] === 'logic';
    const widthStr = match[3] || '';
    const { width, msb, lsb } = parseWidth(widthStr, params);
    const names = match[4].split(',').map(n => n.trim());
    for (const name of names) {
      if (portNames.includes(name)) {
        ports.push({ name, direction, width, msb, lsb, isReg });
      }
    }
  }

  return ports;
}

function parseWires(body: string, params: Map<string, number>): VerilogWire[] {
  const wires: VerilogWire[] = [];
  const regex = /\bwire\b\s*(?:signed\s+)?(\[[^\]]+\])?\s*(\w+(?:\s*,\s*\w+)*)\s*;/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const widthStr = match[1] || '';
    const { width, msb, lsb } = parseWidth(widthStr, params);
    const names = match[2].split(',').map(n => n.trim());
    for (const name of names) {
      wires.push({ name, width, msb, lsb });
    }
  }
  return wires;
}

function parseRegs(body: string, params: Map<string, number>): VerilogReg[] {
  const regs: VerilogReg[] = [];
  const regex = /\breg\b\s*(?:signed\s+)?(\[[^\]]+\])?\s*(\w+(?:\s*,\s*\w+)*)\s*;/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const widthStr = match[1] || '';
    const { width, msb, lsb } = parseWidth(widthStr, params);
    const names = match[2].split(',').map(n => n.trim());
    for (const name of names) {
      regs.push({ name, width, msb, lsb });
    }
  }
  // Parse integer declarations as 32-bit regs
  const intRegex = /\binteger\s+(\w+(?:\s*,\s*\w+)*)\s*;/g;
  while ((match = intRegex.exec(body)) !== null) {
    const names = match[1].split(',').map(n => n.trim());
    for (const name of names) {
      regs.push({ name, width: 32, msb: 31, lsb: 0 });
    }
  }
  return regs;
}

function parseAssigns(body: string): VerilogAssign[] {
  const assigns: VerilogAssign[] = [];
  const regex = /\bassign\s+(?:(#\s*(?:\([^)]*\)|\S+))\s*)?(.+?)\s*=\s*([^;]+);/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const delay = match[1]?.replace(/^#\s*/, '').trim();
    const targetRaw = match[2].trim();
    const targetMatch = targetRaw.match(/^(\w+)(\[\d+(?::\d+)?\])?$/);
    const assign: VerilogAssign = {
      target: targetMatch?.[1] ?? targetRaw,
      targetRaw,
      expression: match[3].trim(),
      delay,
    };
    if (targetMatch?.[2]) {
      const bitMatch = targetMatch[2].match(/\[(\d+)(?::(\d+))?\]/);
      if (bitMatch) {
        if (bitMatch[2] !== undefined) {
          assign.targetMsb = parseInt(bitMatch[1]);
          assign.targetLsb = parseInt(bitMatch[2]);
        } else {
          assign.targetBit = parseInt(bitMatch[1]);
        }
      }
    }
    assigns.push(assign);
  }
  return assigns;
}

function parseAlwaysBlocks(body: string): VerilogAlwaysBlock[] {
  const blocks: VerilogAlwaysBlock[] = [];
  const headerRegex = /\balways\s*@\s*\(([^)]*)\)\s*/g;
  let match;
  while ((match = headerRegex.exec(body)) !== null) {
    const sensitivity = match[1].trim();
    const afterHeader = match.index + match[0].length;
    let blockBody: string;
    if (body.slice(afterHeader).match(/^\s*begin\b/)) {
      const beginIdx = body.indexOf('begin', afterHeader);
      const extracted = extractBalancedBlock(body, beginIdx);
      if (extracted) {
        blockBody = extracted;
        headerRegex.lastIndex = beginIdx + extracted.length;
      } else {
        continue;
      }
    } else {
      // Single-statement body. May contain nested begin/end (e.g. `always @(*) if (cond) begin ... end`).
      // Walk characters until a top-level statement terminator (`;` outside any begin/end).
      const end = findStatementEnd(body, afterHeader);
      if (end === -1) continue;
      blockBody = body.slice(afterHeader, end);
      headerRegex.lastIndex = end;
    }
    const type = sensitivity.includes('posedge') || sensitivity.includes('negedge')
      ? 'sequential' : 'combinational';
    blocks.push({ sensitivity, body: blockBody.trim(), type });
  }
  return blocks;
}

// Find the end of a single procedural statement starting at `start`. Treats nested
// begin/end as one balanced block, otherwise terminates at the first `;` at depth 0.
// Returns the index just past the terminator (or past the matching `end`), or -1.
function findStatementEnd(src: string, start: number): number {
  let i = start;
  // Skip leading whitespace
  while (i < src.length && /\s/.test(src[i])) i++;
  let depth = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    if (rest.match(/^\bbegin\b/)) { depth++; i += 5; continue; }
    if (rest.match(/^\bend\b/)) {
      if (depth > 0) {
        depth--;
        i += 3;
        if (depth === 0) return i;
        continue;
      }
      return i; // unbalanced — bail out
    }
    if (depth === 0 && src[i] === ';') return i + 1;
    i++;
  }
  return -1;
}

function parseInitialBlocks(body: string): VerilogInitialBlock[] {
  const blocks: VerilogInitialBlock[] = [];
  const headerRegex = /\binitial\s+/g;
  let match;
  while ((match = headerRegex.exec(body)) !== null) {
    const afterHeader = match.index + match[0].length;
    if (body.slice(afterHeader).match(/^\s*begin\b/)) {
      const beginIdx = body.indexOf('begin', afterHeader);
      const extracted = extractBalancedBlock(body, beginIdx);
      if (extracted) {
        blocks.push({ body: extracted.trim() });
        headerRegex.lastIndex = beginIdx + extracted.length;
      }
    } else {
      const end = findStatementEnd(body, afterHeader);
      if (end !== -1) {
        blocks.push({ body: body.slice(afterHeader, end).trim() });
        headerRegex.lastIndex = end;
      }
    }
  }
  return blocks;
}

function parseParams(paramSection: string, body: string): VerilogParam[] {
  const params: VerilogParam[] = [];
  const seen = new Set<string>();
  const addParam = (part: string) => {
    const cleaned = part
      .replace(/^\s*(?:parameter|localparam)\b/, '')
      .replace(/^\s*(?:integer|real|time|signed)\b/, '')
      .replace(/^\s*\[[^\]]+\]/, '')
      .trim();
    const match = cleaned.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match || seen.has(match[1])) return;
    const current = new Map(params.map(p => [p.name, p.value]));
    const value = parseConstNumber(match[2]) ?? evalConstExpr(match[2], current);
    if (value === null) return;
    seen.add(match[1]);
    params.push({ name: match[1], value });
  };
  for (const part of splitTopLevel(paramSection)) addParam(part);
  const bodyParamRe = /\b(?:localparam|parameter)\b\s+([^;]+);/g;
  let match;
  while ((match = bodyParamRe.exec(body)) !== null) {
    for (const part of splitTopLevel(match[1])) addParam(part);
  }
  return params;
}

function paramsToMap(params: VerilogParam[]): Map<string, number> {
  return new Map(params.map(p => [p.name, p.value]));
}

function compareConst(left: number, op: string, right: number): boolean {
  switch (op) {
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    case '!=': return left !== right;
    case '==': return left === right;
  }
  return false;
}

function expandGenerateBlocks(body: string, params: Map<string, number>): string {
  const genForRe = /(?:\bgenvar\s+\w+\s*;\s*)?\bgenerate\s+for\s*\(\s*(\w+)\s*=\s*([^;]+?)\s*;\s*\1\s*(<=|>=|==|!=|<|>)\s*([^;]+?)\s*;\s*\1\s*=\s*\1\s*([+-])\s*([^)]+?)\s*\)\s*begin(?:\s*:\s*\w+)?([\s\S]*?)\bend\s*endgenerate\b/g;
  return body.replace(genForRe, (_all, iterName: string, startSrc: string, op: string, endSrc: string, stepOp: string, stepSrc: string, genBody: string) => {
    const start = evalConstExpr(startSrc, params);
    const end = evalConstExpr(endSrc, params);
    const step = evalConstExpr(stepSrc, params);
    if (start === null || end === null || step === null || step === 0) return '';
    const out: string[] = [];
    let value = start;
    let guard = 0;
    while (compareConst(value, op, end) && guard++ < 10000) {
      out.push(genBody.replace(new RegExp(`\\b${iterName}\\b`, 'g'), String(value)));
      value = stepOp === '+' ? value + step : value - step;
    }
    return out.join('\n');
  }).replace(/\bgenvar\s+\w+\s*;/g, '');
}

const GATE_PRIMITIVES = new Set([
  'and', 'or', 'xor', 'not', 'nand', 'nor', 'xnor', 'buf',
]);

function parseGatePrimitives(body: string): VerilogGatePrimitive[] {
  const primitives: VerilogGatePrimitive[] = [];
  // Match: gate_type [#delay] [instance_name] ( output, input1, input2, ... );
  // The instance name is optional. Args are comma-separated identifiers.
  const regex = /\b(and|or|xor|not|nand|nor|xnor|buf)\s*(?:(#\s*(?:\([^)]*\)|\S+))\s*)?(?:(\w+)\s*)?\(\s*([^)]+)\)\s*;/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const gate = match[1];
    const delay = match[2]?.replace(/^#\s*/, '').trim();
    const instanceName = match[3] || undefined;
    const args = match[4].split(',').map(s => s.trim()).filter(Boolean);
    if (args.length < 2) continue;
    primitives.push({
      gate,
      instanceName,
      delay,
      output: args[0],
      inputs: args.slice(1),
    });
  }
  return primitives;
}

function parseInstances(body: string): VerilogInstance[] {
  const instances: VerilogInstance[] = [];
  // Match: module_name instance_name ( ... );
  // The args inside parens can be named (.port(wire)) or positional (expr, expr, ...).
  const regex = /\b(\w+)\s+(\w+)\s*\(\s*([\s\S]*?)\)\s*;/g;
  let match;
  const keywords = new Set(['module', 'input', 'output', 'inout', 'wire', 'reg', 'assign',
    'always', 'initial', 'begin', 'end', 'if', 'else', 'case', 'endcase', 'for', 'while',
    'parameter', 'localparam', 'integer', 'real', 'time', 'genvar', 'generate', 'endgenerate']);

  while ((match = regex.exec(body)) !== null) {
    const moduleName = match[1];
    const instanceName = match[2];
    if (keywords.has(moduleName)) continue;
    if (GATE_PRIMITIVES.has(moduleName)) continue; // handled by parseGatePrimitives

    const argsStr = match[3].trim();
    if (!argsStr) continue;

    if (argsStr.includes('.')) {
      // Named port connections: .port(wire), ...
      const connections: Record<string, string> = {};
      const connRegex = /\.(\w+)\s*\(([^)]*)\)/g;
      let connMatch;
      while ((connMatch = connRegex.exec(argsStr)) !== null) {
        connections[connMatch[1]] = connMatch[2].trim();
      }
      instances.push({ moduleName, instanceName, connections });
    } else {
      // Positional connections: expr, expr, ...
      const args = argsStr.split(',').map(s => s.trim()).filter(Boolean);
      instances.push({ moduleName, instanceName, connections: {}, positionalArgs: args });
    }
  }
  return instances;
}

export function parseVerilog(source: string): ParseResult {
  const errors: string[] = [];
  const modules: VerilogModule[] = [];
  const cleaned = stripComments(source);

  const moduleRegex = /\bmodule\s+(\w+)\s*(?:#\s*\(([^)]*)\))?\s*(?:\(([^)]*)\))?\s*;([\s\S]*?)\bendmodule\b/g;
  let match;

  while ((match = moduleRegex.exec(cleaned)) !== null) {
    const name = match[1];
    const paramSection = match[2] || '';
    const portSection = match[3] || '';
    const body = match[4];

    try {
      const params = parseParams(paramSection, body);
      const paramMap = paramsToMap(params);
      const expandedBody = expandGenerateBlocks(body, paramMap);
      const mod: VerilogModule = {
        name,
        ports: parsePorts(portSection, expandedBody, paramMap),
        params,
        wires: parseWires(expandedBody, paramMap),
        regs: parseRegs(expandedBody, paramMap),
        assigns: parseAssigns(expandedBody),
        alwaysBlocks: parseAlwaysBlocks(expandedBody),
        initialBlocks: parseInitialBlocks(expandedBody),
        instances: parseInstances(expandedBody),
        gatePrimitives: parseGatePrimitives(expandedBody),
        raw: match[0].replace(body, expandedBody),
      };
      modules.push(mod);
    } catch (e) {
      errors.push(`Error parsing module ${name}: ${(e as Error).message}`);
    }
  }

  if (modules.length === 0 && cleaned.trim().length > 0) {
    errors.push('No valid module definitions found');
  }

  return { modules, errors };
}
