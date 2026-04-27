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
  targetBit?: number;
  targetMsb?: number;
  targetLsb?: number;
  expression: string;
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

function parseWidth(widthStr: string): { width: number; msb: number; lsb: number } {
  const match = widthStr.match(/\[(\d+):(\d+)\]/);
  if (match) {
    const msb = parseInt(match[1]);
    const lsb = parseInt(match[2]);
    return { width: msb - lsb + 1, msb, lsb };
  }
  return { width: 1, msb: 0, lsb: 0 };
}

function parsePorts(portSection: string, bodySection: string): VerilogPort[] {
  const ports: VerilogPort[] = [];

  // Try ANSI-style ports (direction in port list)
  const ansiPortRegex = /\b(input|output|inout)\s*(reg\s+)?\s*(\[\d+:\d+\])?\s*(\w+)/g;
  let match;

  // Check in port list first
  while ((match = ansiPortRegex.exec(portSection)) !== null) {
    const direction = match[1] as 'input' | 'output' | 'inout';
    const isReg = !!match[2];
    const widthStr = match[3] || '';
    const { width, msb, lsb } = parseWidth(widthStr);
    ports.push({ name: match[4], direction, width, msb, lsb, isReg });
  }

  if (ports.length > 0) return ports;

  // Non-ANSI style: port names in module header, directions in body
  const portNames: string[] = portSection.match(/\w+/g) || [];
  const dirRegex = /\b(input|output|inout)\s+(reg\s+)?(\[\d+:\d+\])?\s*(\w+(?:\s*,\s*\w+)*)\s*;/g;

  while ((match = dirRegex.exec(bodySection)) !== null) {
    const direction = match[1] as 'input' | 'output' | 'inout';
    const isReg = !!match[2];
    const widthStr = match[3] || '';
    const { width, msb, lsb } = parseWidth(widthStr);
    const names = match[4].split(',').map(n => n.trim());
    for (const name of names) {
      if (portNames.includes(name)) {
        ports.push({ name, direction, width, msb, lsb, isReg });
      }
    }
  }

  return ports;
}

function parseWires(body: string): VerilogWire[] {
  const wires: VerilogWire[] = [];
  const regex = /\bwire\s+(\[\d+:\d+\])?\s*(\w+(?:\s*,\s*\w+)*)\s*;/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const widthStr = match[1] || '';
    const { width, msb, lsb } = parseWidth(widthStr);
    const names = match[2].split(',').map(n => n.trim());
    for (const name of names) {
      wires.push({ name, width, msb, lsb });
    }
  }
  return wires;
}

function parseRegs(body: string): VerilogReg[] {
  const regs: VerilogReg[] = [];
  const regex = /\breg\s+(\[\d+:\d+\])?\s*(\w+(?:\s*,\s*\w+)*)\s*;/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const widthStr = match[1] || '';
    const { width, msb, lsb } = parseWidth(widthStr);
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
  const regex = /\bassign\s+(\w+)(\[\d+(?::\d+)?\])?\s*=\s*([^;]+);/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const assign: VerilogAssign = {
      target: match[1],
      expression: match[3].trim(),
    };
    if (match[2]) {
      const bitMatch = match[2].match(/\[(\d+)(?::(\d+))?\]/);
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
      const semi = body.indexOf(';', afterHeader);
      if (semi !== -1) {
        blocks.push({ body: body.slice(afterHeader, semi + 1).trim() });
        headerRegex.lastIndex = semi + 1;
      }
    }
  }
  return blocks;
}

function parseParams(body: string): VerilogParam[] {
  const params: VerilogParam[] = [];
  const regex = /\bparameter\s+(\w+)\s*=\s*(\d+)/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    params.push({ name: match[1], value: parseInt(match[2]) });
  }
  return params;
}

const GATE_PRIMITIVES = new Set([
  'and', 'or', 'xor', 'not', 'nand', 'nor', 'xnor', 'buf',
]);

function parseGatePrimitives(body: string): VerilogGatePrimitive[] {
  const primitives: VerilogGatePrimitive[] = [];
  // Match: gate_type [instance_name] ( output, input1, input2, ... );
  // The instance name is optional. Args are comma-separated identifiers.
  const regex = /\b(and|or|xor|not|nand|nor|xnor|buf)\s*(?:(\w+)\s*)?\(\s*([^)]+)\)\s*;/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const gate = match[1];
    const instanceName = match[2] || undefined;
    const args = match[3].split(',').map(s => s.trim()).filter(Boolean);
    if (args.length < 2) continue;
    primitives.push({
      gate,
      instanceName,
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

  const moduleRegex = /\bmodule\s+(\w+)\s*(?:#\s*\([^)]*\))?\s*(?:\(([^)]*)\))?\s*;([\s\S]*?)\bendmodule\b/g;
  let match;

  while ((match = moduleRegex.exec(cleaned)) !== null) {
    const name = match[1];
    const portSection = match[2] || '';
    const body = match[3];

    try {
      const mod: VerilogModule = {
        name,
        ports: parsePorts(portSection, body),
        params: parseParams(body),
        wires: parseWires(body),
        regs: parseRegs(body),
        assigns: parseAssigns(body),
        alwaysBlocks: parseAlwaysBlocks(body),
        initialBlocks: parseInitialBlocks(body),
        instances: parseInstances(body),
        gatePrimitives: parseGatePrimitives(body),
        raw: match[0],
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
