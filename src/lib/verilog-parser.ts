// Verilog Parser - Parses Verilog source into an AST

export interface VerilogPort {
  name: string;
  direction: 'input' | 'output' | 'inout';
  width: number; // bit width
  msb: number;
  lsb: number;
  widthRaw?: string;
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
  widthRaw?: string;
}

export interface VerilogReg {
  name: string;
  width: number;
  msb: number;
  lsb: number;
  widthRaw?: string;
}

export interface VerilogInstance {
  moduleName: string;
  instanceName: string;
  connections: Record<string, string>;       // named: portName → expression
  positionalArgs?: string[];                 // positional: ordered arg expressions
  parameterOverrides?: Record<string, string>;
  positionalParameterOverrides?: string[];
  isArray?: boolean;
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

function skipWhitespace(src: string, idx: number): number {
  let i = idx;
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function readBalanced(src: string, startIdx: number, open = '(', close = ')'): { content: string; end: number } | null {
  if (src[startIdx] !== open) return null;
  let depth = 0;
  let inString = false;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { content: src.slice(startIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

// Find the balanced begin/end block starting at the given index (pointing to 'begin')
// Returns the substring from 'begin' to its matching 'end', or null if unbalanced
function extractBalancedBlock(src: string, startIdx: number): string | null {
  const end = findStatementEnd(src, startIdx);
  return end === -1 ? null : src.slice(startIdx, end);
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
  const toks = src.match(/(?:\d+)?'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ?_]+|\d+|\$clog2|[A-Za-z_]\w*|<<|>>|\*\*|[()+\-*/%]/g) || [];
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
    if (t === '$clog2') {
      if (next() !== '(') return null;
      const v = parseAdd();
      if (next() !== ')' || v === null || v <= 0) return null;
      return Math.ceil(Math.log2(v));
    }
    if (/^[A-Za-z_]\w*$/.test(t)) return params.get(t) ?? null;
    return parseConstNumber(t);
  };
  const parseUnary = (): number | null => {
    if (peek() === '+') { next(); return parseUnary(); }
    if (peek() === '-') { next(); const v = parseUnary(); return v === null ? null : -v; }
    return parsePrimary();
  };
  const parsePow = (): number | null => {
    let v = parseUnary();
    if (v !== null && peek() === '**') {
      next();
      const r = parsePow();
      v = r === null || r < 0 ? null : v ** r;
    }
    return v;
  };
  const parseMul = (): number | null => {
    let v = parsePow();
    while (v !== null && peek() !== undefined && ['*', '/', '%'].includes(peek()!)) {
      const op = next();
      const r = parsePow();
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
    const m = part.match(/^(?:(input|output|inout)\b\s*)?(?:(wire|reg|logic|tri|wand|wor|triand|trior|supply0|supply1)\b\s*)?(?:signed\s+)?(\[[^\]]+\]\s*)?(.+)$/);
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
    ports.push({ name: nameMatch[1], direction: current.direction, width, msb, lsb, widthRaw: current.widthStr, isReg: current.isReg });
  }

  if (ports.length > 0) return ports;

  // Non-ANSI style: port names in module header, directions in body
  const portNames: string[] = portSection.match(/\w+/g) || [];
  const dirRegex = /\b(input|output|inout)\s+(?:(wire|reg|logic|tri|wand|wor|triand|trior|supply0|supply1)\s+)?(?:signed\s+)?(\[[^\]]+\])?\s*([^;]+)\s*;/g;
  let match;

  while ((match = dirRegex.exec(bodySection)) !== null) {
    const direction = match[1] as 'input' | 'output' | 'inout';
    const isReg = match[2] === 'reg' || match[2] === 'logic';
    const widthStr = match[3] || '';
    const { width, msb, lsb } = parseWidth(widthStr, params);
    const names = splitTopLevel(match[4]).map(n => n.trim());
    for (const part of names) {
      const name = part.match(/^(\w+)/)?.[1];
      if (!name) continue;
      if (portNames.includes(name)) {
        ports.push({ name, direction, width, msb, lsb, widthRaw: widthStr, isReg });
      }
    }
  }

  return ports;
}

function parseWires(body: string, params: Map<string, number>): VerilogWire[] {
  const wires: VerilogWire[] = [];
  const regex = /\b(?:wire|tri|wand|wor|triand|trior|supply0|supply1)\b\s*(?:signed\s+)?(\[[^\]]+\])?\s*([^;]+)\s*;/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const widthStr = match[1] || '';
    const { width, msb, lsb } = parseWidth(widthStr, params);
    const names = splitTopLevel(match[2]).map(n => n.trim());
    for (const part of names) {
      const name = part.match(/^(\w+)/)?.[1];
      if (!name) continue;
      wires.push({ name, width, msb, lsb, widthRaw: widthStr });
    }
  }
  return wires;
}

function parseRegs(body: string, params: Map<string, number>): VerilogReg[] {
  const regs: VerilogReg[] = [];
  const regex = /\b(reg|logic|time|realtime|real)\b\s*(?:signed\s+)?(\[[^\]]+\])?\s*([^;]+)\s*;/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const declType = match[1];
    const widthStr = match[2] || '';
    const parsed = parseWidth(widthStr, params);
    const width = widthStr ? parsed.width : (declType === 'time' || declType === 'realtime' || declType === 'real' ? 64 : 1);
    const msb = widthStr ? parsed.msb : width - 1;
    const lsb = widthStr ? parsed.lsb : 0;
    const names = splitTopLevel(match[3]).map(n => n.trim());
    for (const part of names) {
      const name = part.match(/^(\w+)/)?.[1];
      if (!name) continue;
      regs.push({ name, width, msb, lsb, widthRaw: widthStr });
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
  const headerRegex = /\balways(?:_(comb|latch|ff))?\b/g;
  let match;
  while ((match = headerRegex.exec(body)) !== null) {
    const flavor = match[1] as string | undefined;
    let i = skipWhitespace(body, match.index + match[0].length);
    let sensitivity = flavor === 'comb' || flavor === 'latch' ? '*' : '';
    if (body[i] === '@') {
      i = skipWhitespace(body, i + 1);
      if (body[i] === '*') {
        sensitivity = '*';
        i++;
      } else if (body[i] === '(') {
        const sens = readBalanced(body, i);
        if (!sens) continue;
        sensitivity = sens.content.trim();
        i = sens.end;
      }
    }
    const afterHeader = i;
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
    const type = flavor === 'comb' || flavor === 'latch'
      ? 'combinational'
      : sensitivity.includes('posedge') || sensitivity.includes('negedge')
      ? 'sequential' : 'combinational';
    blocks.push({ sensitivity, body: blockBody.trim(), type });
  }
  return blocks;
}

// Find the end of a single procedural statement starting at `start`. Treats nested
// begin/end as one balanced block, otherwise terminates at the first `;` at depth 0.
// Returns the index just past the terminator (or past the matching `end`), or -1.
function findStatementEnd(src: string, start: number): number {
  let i = skipWhitespace(src, start);
  const stack: string[] = [];
  let inString = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      if (c === '\\') i += 2;
      else { if (c === '"') inString = false; i++; }
      continue;
    }
    if (c === '"') { inString = true; i++; continue; }

    const rest = src.slice(i);
    const word = rest.match(/^[A-Za-z_]\w*/)?.[0];
    if (word) {
      if (['begin', 'case', 'casex', 'casez', 'fork', 'task', 'function', 'specify'].includes(word)) {
        stack.push(word);
        i += word.length;
        continue;
      }
      const top = stack[stack.length - 1];
      if ((word === 'end' && top === 'begin') ||
          (word === 'endcase' && ['case', 'casex', 'casez'].includes(top)) ||
          ((word === 'join' || word === 'join_any' || word === 'join_none') && top === 'fork') ||
          (word === 'endtask' && top === 'task') ||
          (word === 'endfunction' && top === 'function') ||
          (word === 'endspecify' && top === 'specify')) {
        stack.pop();
        i += word.length;
        if (stack.length === 0) return i;
        continue;
      }
      i += word.length;
      continue;
    }
    if (stack.length === 0 && c === ';') return i + 1;
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

function expandGenerateBlocks(body: string, params: Map<string, number>): { body: string; errors: string[] } {
  const errors: string[] = [];
  const genForRe = /(?:\bgenvar\s+\w+\s*;\s*)?\bgenerate\s+for\s*\(\s*(\w+)\s*=\s*([^;]+?)\s*;\s*\1\s*(<=|>=|==|!=|<|>)\s*([^;]+?)\s*;\s*\1\s*=\s*\1\s*([+-])\s*([^)]+?)\s*\)\s*begin(?:\s*:\s*\w+)?([\s\S]*?)\bend\s*endgenerate\b/g;
  let expanded = body.replace(genForRe, (_all, iterName: string, startSrc: string, op: string, endSrc: string, stepOp: string, stepSrc: string, genBody: string) => {
    const start = evalConstExpr(startSrc, params);
    const end = evalConstExpr(endSrc, params);
    const step = evalConstExpr(stepSrc, params);
    if (start === null || end === null || step === null || step === 0) {
      errors.push(`Unsupported generate for expression: ${iterName}`);
      return '';
    }
    const out: string[] = [];
    let value = start;
    let guard = 0;
    while (compareConst(value, op, end) && guard++ < 10000) {
      out.push(genBody.replace(new RegExp(`\\b${iterName}\\b`, 'g'), String(value)));
      value = stepOp === '+' ? value + step : value - step;
    }
    return out.join('\n');
  });

  const genIfRe = /\bgenerate\s+if\s*\(([^)]+)\)\s*begin(?:\s*:\s*\w+)?([\s\S]*?)\bend(?:\s*else\s*begin(?:\s*:\s*\w+)?([\s\S]*?)\bend)?\s*endgenerate\b/g;
  expanded = expanded.replace(genIfRe, (_all, condSrc: string, thenBody: string, elseBody: string | undefined) => {
    const cond = evalConstExpr(condSrc, params);
    if (cond === null) {
      errors.push(`Unsupported generate if expression: ${condSrc.trim()}`);
      return '';
    }
    return cond !== 0 ? thenBody : (elseBody ?? '');
  });

  const genCaseRe = /\bgenerate\s+case\s*\(([^)]+)\)([\s\S]*?)\bendcase\s*endgenerate\b/g;
  expanded = expanded.replace(genCaseRe, (_all, selSrc: string, caseBody: string) => {
    const sel = evalConstExpr(selSrc, params);
    if (sel === null) {
      errors.push(`Unsupported generate case expression: ${selSrc.trim()}`);
      return '';
    }
    let defaultBody = '';
    for (const item of caseBody.matchAll(/([^:;]+)\s*:\s*begin(?:\s*:\s*\w+)?([\s\S]*?)\bend/g)) {
      const label = item[1].trim();
      if (label === 'default') {
        defaultBody = item[2];
        continue;
      }
      for (const part of splitTopLevel(label)) {
        const v = evalConstExpr(part, params);
        if (v === sel) return item[2];
      }
    }
    return defaultBody;
  });

  expanded = expanded.replace(/\bgenvar\s+\w+\s*;/g, '');
  if (/\bgenerate\b/.test(expanded) || /\bendgenerate\b/.test(expanded)) {
    errors.push('Unsupported generate block form');
  }
  return { body: expanded, errors };
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
  const keywords = new Set(['module', 'input', 'output', 'inout', 'wire', 'reg', 'assign',
    'always', 'initial', 'begin', 'end', 'if', 'else', 'case', 'endcase', 'for', 'while',
    'parameter', 'localparam', 'integer', 'real', 'realtime', 'time', 'logic', 'tri', 'wand',
    'wor', 'triand', 'trior', 'supply0', 'supply1', 'genvar', 'generate', 'endgenerate',
    'always_comb', 'always_latch', 'always_ff', 'task', 'function', 'specify']);

  const wordRe = /\b(\w+)\b/g;
  let match;
  while ((match = wordRe.exec(body)) !== null) {
    const moduleName = match[1];
    if (keywords.has(moduleName)) continue;
    if (GATE_PRIMITIVES.has(moduleName)) continue; // handled by parseGatePrimitives
    let i = skipWhitespace(body, match.index + moduleName.length);

    let parameterOverrides: Record<string, string> | undefined;
    let positionalParameterOverrides: string[] | undefined;
    if (body[i] === '#') {
      i = skipWhitespace(body, i + 1);
      if (body[i] !== '(') continue;
      const params = readBalanced(body, i);
      if (!params) continue;
      const parts = splitTopLevel(params.content);
      if (parts.some(p => p.trim().startsWith('.'))) {
        parameterOverrides = {};
        for (const part of parts) {
          const dot = part.trim().match(/^\.(\w+)\s*\(([\s\S]*)\)$/);
          if (dot) parameterOverrides[dot[1]] = dot[2].trim();
        }
      } else {
        positionalParameterOverrides = parts;
      }
      i = skipWhitespace(body, params.end);
    }

    const instMatch = body.slice(i).match(/^(\w+)/);
    if (!instMatch) continue;
    const instanceName = instMatch[1];
    i = skipWhitespace(body, i + instanceName.length);

    let isArray = false;
    if (body[i] === '[') {
      const arr = readBalanced(body, i, '[', ']');
      if (!arr) continue;
      isArray = true;
      i = skipWhitespace(body, arr.end);
    }

    if (body[i] !== '(') continue;
    const args = readBalanced(body, i);
    if (!args) continue;
    const afterArgs = skipWhitespace(body, args.end);
    if (body[afterArgs] !== ';') continue;
    wordRe.lastIndex = afterArgs + 1;

    const argsStr = args.content.trim();
    const instBase = { moduleName, instanceName, parameterOverrides, positionalParameterOverrides, isArray };
    if (!argsStr) {
      instances.push({ ...instBase, connections: {} });
    } else if (splitTopLevel(argsStr).some(p => p.trim().startsWith('.'))) {
      const connections: Record<string, string> = {};
      for (const part of splitTopLevel(argsStr)) {
        const trimmed = part.trim();
        const name = trimmed.match(/^\.(\w+)\s*\(/)?.[1];
        const openIdx = trimmed.indexOf('(');
        if (!name || openIdx === -1) continue;
        const arg = readBalanced(trimmed, openIdx);
        if (arg) connections[name] = arg.content.trim();
      }
      instances.push({ ...instBase, connections });
    } else {
      instances.push({ ...instBase, connections: {}, positionalArgs: splitTopLevel(argsStr).map(s => s.trim()).filter(Boolean) });
    }
  }
  return instances;
}

interface ModuleSection {
  name: string;
  paramSection: string;
  portSection: string;
  body: string;
  raw: string;
  isMacromodule: boolean;
}

function scanModules(cleaned: string, errors: string[]): ModuleSection[] {
  const sections: ModuleSection[] = [];
  const moduleRe = /\b(macromodule|module)\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = moduleRe.exec(cleaned)) !== null) {
    const isMacromodule = match[1] === 'macromodule';
    const name = match[2];
    let i = skipWhitespace(cleaned, match.index + match[0].length);
    let paramSection = '';
    let portSection = '';

    if (cleaned[i] === '#') {
      i = skipWhitespace(cleaned, i + 1);
      const params = readBalanced(cleaned, i);
      if (!params) {
        errors.push(`Error parsing module ${name}: unbalanced parameter list`);
        continue;
      }
      paramSection = params.content;
      i = skipWhitespace(cleaned, params.end);
    }

    if (cleaned[i] === '(') {
      const ports = readBalanced(cleaned, i);
      if (!ports) {
        errors.push(`Error parsing module ${name}: unbalanced port list`);
        continue;
      }
      portSection = ports.content;
      i = skipWhitespace(cleaned, ports.end);
    }

    if (cleaned[i] !== ';') {
      errors.push(`Error parsing module ${name}: expected ';' after module header`);
      continue;
    }
    const bodyStart = i + 1;
    const endRe = /\bendmodule\b/g;
    endRe.lastIndex = bodyStart;
    const endMatch = endRe.exec(cleaned);
    if (!endMatch) {
      errors.push(`Error parsing module ${name}: missing endmodule`);
      continue;
    }
    const body = cleaned.slice(bodyStart, endMatch.index);
    const raw = cleaned.slice(match.index, endMatch.index + endMatch[0].length);
    sections.push({ name, paramSection, portSection, body, raw, isMacromodule });
    moduleRe.lastIndex = endMatch.index + endMatch[0].length;
  }
  return sections;
}

function detectUnsupportedConstructs(moduleName: string, body: string, isMacromodule: boolean): string[] {
  const errors: string[] = [];
  if (isMacromodule) errors.push(`Unsupported construct in ${moduleName}: macromodule is parsed as module`);
  const checks: { re: RegExp; label: string }[] = [
    { re: /\bdefparam\b/, label: 'defparam' },
    { re: /\\[^\s]+/, label: 'escaped identifiers' },
    { re: /\bwait\s*\(/, label: 'wait statements' },
    { re: /\bevent\b/, label: 'named events' },
    { re: /\bfork\b|\bjoin(?:_any|_none)?\b/, label: 'fork/join execution' },
    { re: /\bforce\b|\brelease\b/, label: 'force/release' },
    { re: /\bdeassign\b/, label: 'deassign' },
    { re: /\bdisable\b/, label: 'disable' },
    { re: /\bspecify\b/, label: 'specify blocks' },
    { re: /\btask\b|\bendtask\b/, label: 'task execution' },
    { re: /\bfunction\b|\bendfunction\b/, label: 'function execution' },
    { re: /\bprimitive\b|\bendprimitive\b|\btable\b/, label: 'UDP primitives' },
  ];
  for (const check of checks) {
    if (check.re.test(body)) errors.push(`Unsupported construct in ${moduleName}: ${check.label}`);
  }
  const unsupportedGate = body.match(/\b(bufif0|bufif1|notif0|notif1|nmos|pmos|cmos|tran|tranif0|tranif1|rtran|pullup|pulldown)\b/);
  if (unsupportedGate) errors.push(`Unsupported construct in ${moduleName}: gate primitive ${unsupportedGate[1]}`);
  return errors;
}

function detectUnsupportedDirectives(source: string): string[] {
  const errors: string[] = [];
  for (const match of source.matchAll(/`(define|undef|include|ifdef|ifndef|elsif|else|endif|default_nettype|celldefine|endcelldefine)\b/g)) {
    errors.push(`Unsupported preprocessor directive: \`${match[1]}`);
  }
  return Array.from(new Set(errors));
}

export function parseVerilog(source: string): ParseResult {
  const errors: string[] = [];
  const modules: VerilogModule[] = [];
  const cleaned = stripComments(source);
  errors.push(...detectUnsupportedDirectives(cleaned));

  for (const section of scanModules(cleaned, errors)) {
    const { name, paramSection, portSection, body } = section;

    try {
      const params = parseParams(paramSection, body);
      const paramMap = paramsToMap(params);
      const expanded = expandGenerateBlocks(body, paramMap);
      for (const e of expanded.errors) errors.push(`Unsupported construct in ${name}: ${e}`);
      const expandedBody = expanded.body;
      errors.push(...detectUnsupportedConstructs(name, expandedBody, section.isMacromodule));
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
        raw: section.raw.replace(body, expandedBody),
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
