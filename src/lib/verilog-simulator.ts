// Verilog Simulator — event-driven, 4-state, in-browser.
//
// Pipeline:
//   parseVerilog (verilog-parser.ts)
//     → elaborate (build module instance tree, allocate signals, resolve port maps)
//     → compile (parse procedural bodies into statement AST)
//     → schedule (event-driven generator-based execution with NBA region)
//     → record (per-signal change list)
//
// Coverage: enough Verilog-2005 for typical educational testbenches:
//   - reg/wire incl. memory arrays
//   - assign (continuous, comb-sensitive)
//   - initial / always (explicit list, posedge/negedge, *, no-sensitivity loops)
//   - blocking and non-blocking assigns; concatenated LHS
//   - if/else, case, for, repeat, while, begin/end
//   - intra-statement delays (#N stmt;) and inter-statement delays (#N;), with `timescale`
//   - bit/range select (LHS and RHS), memory indexing (LHS and RHS)
//   - 4-state ===, !==, x/z literals (x≡z)
//   - reduction & unary ops, full binary op set, ternary
//   - $display, $write, $monitor (treated as $display), $finish, $time, $readmemh
//   - module hierarchy with named or positional port connections

import { parseVerilog, type VerilogModule } from './verilog-parser';

// ============================================================
// 4-state value model
// ============================================================
//
// A value is { v, x } where each bit i represents the logical bit value:
//   v=0 x=0 → logic 0
//   v=1 x=0 → logic 1
//   any v with x=1 → x (z is collapsed to x for simplicity)

export interface V4 {
  v: bigint;
  x: bigint;
}

function bmask(w: number): bigint {
  return w <= 0 ? 0n : (1n << BigInt(w)) - 1n;
}

function v4Zero(): V4 { return { v: 0n, x: 0n }; }
function v4FromBig(n: bigint, w: number): V4 { return { v: n & bmask(w), x: 0n }; }
function v4FromNum(n: number, w: number): V4 { return v4FromBig(BigInt(n), w); }
function v4X(w: number): V4 { return { v: 0n, x: bmask(w) }; }
function v4One(): V4 { return { v: 1n, x: 0n }; }

function v4Eq(a: V4, b: V4, w: number): boolean {
  const m = bmask(w);
  return (a.v & m) === (b.v & m) && (a.x & m) === (b.x & m);
}

function v4HasX(a: V4, w: number): boolean {
  return (a.x & bmask(w)) !== 0n;
}

function v4Resize(a: V4, w: number): V4 {
  const m = bmask(w);
  return { v: a.v & m, x: a.x & m };
}

function v4Truthy(a: V4, w: number): boolean {
  // false iff all bits are 0; x bits are treated as "ambiguous → false" (iverilog matches this)
  const m = bmask(w);
  return (a.v & m & ~a.x) !== 0n;
}

function v4Bit(a: V4, i: number): V4 {
  const bit = BigInt(i);
  return { v: (a.v >> bit) & 1n, x: (a.x >> bit) & 1n };
}

function v4Slice(a: V4, msb: number, lsb: number): V4 {
  const w = msb - lsb + 1;
  const sh = BigInt(lsb);
  return { v: (a.v >> sh) & bmask(w), x: (a.x >> sh) & bmask(w) };
}

function v4WriteSlice(orig: V4, msb: number, lsb: number, val: V4, fullW: number): V4 {
  const sw = msb - lsb + 1;
  const sh = BigInt(lsb);
  const sm = bmask(sw) << sh;
  const fm = bmask(fullW);
  const newV = ((orig.v & ~sm) | ((val.v & bmask(sw)) << sh)) & fm;
  const newX = ((orig.x & ~sm) | ((val.x & bmask(sw)) << sh)) & fm;
  return { v: newV, x: newX };
}

function v4Concat(parts: { val: V4; w: number }[]): { val: V4; w: number } {
  let v = 0n, x = 0n, w = 0;
  for (const p of parts) {
    v = (v << BigInt(p.w)) | (p.val.v & bmask(p.w));
    x = (x << BigInt(p.w)) | (p.val.x & bmask(p.w));
    w += p.w;
  }
  return { val: { v, x }, w };
}

// ── bitwise ──────────────────────────────────────────────
function v4And(a: V4, b: V4, w: number): V4 {
  const m = bmask(w);
  const a0 = ~a.v & ~a.x & m;
  const b0 = ~b.v & ~b.x & m;
  const def0 = (a0 | b0) & m;
  const def1 = (a.v & b.v & ~a.x & ~b.x) & m;
  return { v: def1, x: m & ~def0 & ~def1 };
}
function v4Or(a: V4, b: V4, w: number): V4 {
  const m = bmask(w);
  const a1 = (a.v & ~a.x) & m;
  const b1 = (b.v & ~b.x) & m;
  const def1 = (a1 | b1) & m;
  const def0 = (~a.v & ~a.x & ~b.v & ~b.x) & m;
  return { v: def1, x: m & ~def0 & ~def1 };
}
function v4Xor(a: V4, b: V4, w: number): V4 {
  const m = bmask(w);
  const xm = (a.x | b.x) & m;
  return { v: (a.v ^ b.v) & m & ~xm, x: xm };
}
function v4Not(a: V4, w: number): V4 {
  const m = bmask(w);
  return { v: (~a.v) & m & ~a.x, x: a.x & m };
}

// ── reduction (returns 1 bit) ───────────────────────────
function v4ReduceAnd(a: V4, w: number): V4 {
  const m = bmask(w);
  if ((a.x & m) !== 0n) {
    // If any 0 bit exists (definitely 0), result is 0; otherwise x
    if ((~a.v & ~a.x & m) !== 0n) return v4FromBig(0n, 1);
    return v4X(1);
  }
  return ((a.v & m) === m) ? v4One() : v4FromBig(0n, 1);
}
function v4ReduceOr(a: V4, w: number): V4 {
  const m = bmask(w);
  if (((a.v & ~a.x) & m) !== 0n) return v4One();
  if ((a.x & m) !== 0n) return v4X(1);
  return v4FromBig(0n, 1);
}
function v4ReduceXor(a: V4, w: number): V4 {
  const m = bmask(w);
  if ((a.x & m) !== 0n) return v4X(1);
  let p = 0n, val = a.v & m;
  while (val) { p ^= val & 1n; val >>= 1n; }
  return v4FromBig(p, 1);
}

// ── arithmetic (x propagates: any x in either → all-x) ──
function v4Add(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w)) return v4X(w);
  return v4FromBig((a.v + b.v) & bmask(w), w);
}
function v4Sub(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w)) return v4X(w);
  const m = bmask(w);
  return v4FromBig((a.v - b.v) & m, w);
}
function v4Mul(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w)) return v4X(w);
  return v4FromBig((a.v * b.v) & bmask(w), w);
}
function v4Div(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w) || b.v === 0n) return v4X(w);
  return v4FromBig(a.v / b.v, w);
}
function v4Mod(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w) || b.v === 0n) return v4X(w);
  return v4FromBig(a.v % b.v, w);
}
function v4Shl(a: V4, b: V4, w: number): V4 {
  if (v4HasX(b, 32)) return v4X(w);
  return v4FromBig((a.v << b.v) & bmask(w), w);
}
function v4Shr(a: V4, b: V4, w: number): V4 {
  if (v4HasX(b, 32)) return v4X(w);
  return v4FromBig((a.v & bmask(w)) >> b.v, w);
}

// ── relational (3-state semantics: x if any x) ───────────
function v4Lt(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w)) return v4X(1);
  return a.v < b.v ? v4One() : v4FromBig(0n, 1);
}
function v4Le(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w)) return v4X(1);
  return a.v <= b.v ? v4One() : v4FromBig(0n, 1);
}
function v4Gt(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w)) return v4X(1);
  return a.v > b.v ? v4One() : v4FromBig(0n, 1);
}
function v4Ge(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w)) return v4X(1);
  return a.v >= b.v ? v4One() : v4FromBig(0n, 1);
}

// ── 3-state ==/!=, 4-state ===/!== ──────────────────────
function v4LogEq(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w)) return v4X(1);
  const m = bmask(w);
  return (a.v & m) === (b.v & m) ? v4One() : v4FromBig(0n, 1);
}
function v4LogNeq(a: V4, b: V4, w: number): V4 {
  if (v4HasX(a, w) || v4HasX(b, w)) return v4X(1);
  const m = bmask(w);
  return (a.v & m) !== (b.v & m) ? v4One() : v4FromBig(0n, 1);
}
function v4CaseEq(a: V4, b: V4, w: number): V4 {
  return v4Eq(a, b, w) ? v4One() : v4FromBig(0n, 1);
}
function v4CaseNeq(a: V4, b: V4, w: number): V4 {
  return v4Eq(a, b, w) ? v4FromBig(0n, 1) : v4One();
}

function v4CaseMatches(a: V4, b: V4, w: number, kind: 'case' | 'casex' | 'casez'): boolean {
  if (kind === 'case') return v4Eq(a, b, w);
  const m = bmask(w);
  // z is collapsed into x in this simulator, so casez and casex share wildcard matching here.
  const compareMask = m & ~((a.x | b.x) & m);
  return ((a.v ^ b.v) & compareMask) === 0n;
}

// ── format ──────────────────────────────────────────────
export function v4FormatHex(a: V4, w: number): string {
  const nib = Math.max(1, Math.ceil(w / 4));
  if (!v4HasX(a, w)) return (a.v & bmask(w)).toString(16).padStart(nib, '0');
  const out: string[] = [];
  for (let i = nib - 1; i >= 0; i--) {
    const sh = BigInt(i * 4);
    const xn = (a.x >> sh) & 0xfn;
    const vn = (a.v >> sh) & 0xfn;
    out.push(xn !== 0n ? 'x' : vn.toString(16));
  }
  return out.join('');
}
export function v4FormatBin(a: V4, w: number): string {
  const out: string[] = [];
  for (let i = w - 1; i >= 0; i--) {
    const sh = BigInt(i);
    const xb = (a.x >> sh) & 1n;
    const vb = (a.v >> sh) & 1n;
    out.push(xb !== 0n ? 'x' : (vb !== 0n ? '1' : '0'));
  }
  return out.join('');
}
export function v4FormatDec(a: V4, w: number): string {
  if (v4HasX(a, w)) return 'x';
  return (a.v & bmask(w)).toString(10);
}

// ============================================================
// Public output types
// ============================================================

export interface SignalChange {
  time: number;
  value: V4;
}

export interface SignalTrace {
  name: string;       // hierarchical name e.g. "ALU_test.alu.alu_val"
  width: number;
  isMemory: boolean;
  changes: SignalChange[];
}

export interface SimulationLog {
  time: number;
  message: string;
}

export interface SimulationResult {
  signals: SignalTrace[];
  signalsByName: Record<string, SignalTrace>;
  duration: number;
  timeUnitNs: number;
  errors: string[];
  logs: SimulationLog[];
  // Backwards-compat fields (legacy WaveformViewer used these — kept as empty defaults)
  waveform?: never;
  signalWidths?: Record<string, number>;
}

const TIME_UNIT_NS: Record<string, number> = {
  s: 1_000_000_000,
  ms: 1_000_000,
  us: 1_000,
  ns: 1,
  ps: 0.001,
  fs: 0.000001,
};

interface TimescaleDirective {
  index: number;
  timeUnitNs: number;
}

function parseTimescaleMagnitude(raw: string, unitRaw: string): number | null {
  const mag = Number.parseFloat(raw);
  const unit = TIME_UNIT_NS[unitRaw.toLowerCase()];
  if (!Number.isFinite(mag) || unit === undefined) return null;
  return mag * unit;
}

function findTimescaleDirectives(source: string): TimescaleDirective[] {
  const out: TimescaleDirective[] = [];
  const re = /`timescale\s+(\d+(?:\.\d+)?)\s*(s|ms|us|ns|ps|fs)\s*\/\s*\d+(?:\.\d+)?\s*(s|ms|us|ns|ps|fs)/ig;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const timeUnitNs = parseTimescaleMagnitude(m[1], m[2]);
    if (timeUnitNs !== null) out.push({ index: m.index, timeUnitNs });
  }
  return out;
}

function detectTimeUnitNs(sources: Record<string, string>): number {
  for (const source of Object.values(sources)) {
    const first = findTimescaleDirectives(source)[0];
    if (first) return first.timeUnitNs;
  }
  return 1;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectModuleTimeUnitNs(source: string, modules: VerilogModule[]): Map<string, number> {
  const out = new Map<string, number>();
  const directives = findTimescaleDirectives(source);
  for (const mod of modules) {
    const moduleMatch = new RegExp(`\\bmodule\\s+${escapeRegExp(mod.name)}\\b`).exec(source);
    const moduleIndex = moduleMatch?.index ?? source.indexOf(mod.raw);
    let timeUnitNs = 1;
    for (const directive of directives) {
      if (moduleIndex >= 0 && directive.index > moduleIndex) break;
      timeUnitNs = directive.timeUnitNs;
    }
    out.set(mod.name, timeUnitNs);
  }
  return out;
}

// ============================================================
// Expression AST
// ============================================================

type Expr =
  | { kind: 'num'; w: number; val: V4; raw?: string }
  | { kind: 'id'; name: string }
  | { kind: 'bit'; base: Expr; idx: Expr }
  | { kind: 'range'; base: Expr; msb: number; lsb: number }
  | { kind: 'concat'; parts: Expr[] }
  | { kind: 'replicate'; count: number; inner: Expr }
  | { kind: 'unary'; op: string; arg: Expr }
  | { kind: 'binary'; op: string; l: Expr; r: Expr }
  | { kind: 'ternary'; c: Expr; t: Expr; f: Expr }
  | { kind: 'sysfunc'; name: string; args: Expr[] };

// ============================================================
// Statement AST
// ============================================================

type LValue =
  | { kind: 'id'; name: string }
  | { kind: 'bit'; name: string; idx: Expr }                    // signal[i]  OR  memory[i]
  | { kind: 'range'; name: string; msb: number; lsb: number }   // signal[m:l]
  | { kind: 'memBitSel'; name: string; idx: Expr; bit: Expr }   // mem[i][b]
  | { kind: 'memRangeSel'; name: string; idx: Expr; msb: number; lsb: number } // mem[i][m:l]
  | { kind: 'concat'; parts: LValue[] };

type Stmt =
  | { kind: 'block'; body: Stmt[] }
  | { kind: 'assign'; target: LValue; expr: Expr; nonblocking: boolean; delay?: number }
  | { kind: 'delay'; ns: number; inner?: Stmt }
  | { kind: 'eventCtrl'; sens: Sensitivity; inner?: Stmt }
  | { kind: 'if'; cond: Expr; then: Stmt; else?: Stmt }
  | { kind: 'case'; sel: Expr; items: { labels: Expr[] | 'default'; body: Stmt }[]; casex: 'case' | 'casex' | 'casez' }
  | { kind: 'for'; init: Stmt; cond: Expr; step: Stmt; body: Stmt }
  | { kind: 'while'; cond: Expr; body: Stmt }
  | { kind: 'repeat'; count: Expr; body: Stmt }
  | { kind: 'forever'; body: Stmt }
  | { kind: 'sys'; name: string; args: (Expr | { kind: 'str'; value: string })[] };

interface SensEntry { signal: string; edge: 'posedge' | 'negedge' | 'level' }
interface Sensitivity {
  any: boolean;             // @(*)
  list: SensEntry[];
}

// ============================================================
// Tokenizer (used for both expression and statement parsing)
// ============================================================

interface Tok { type: string; value: string; pos: number }

const KEYWORDS = new Set([
  'begin','end','if','else','case','casex','casez','endcase','for','while','repeat','forever',
  'posedge','negedge','default','assign'
]);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i+1] === '/')) i++; i += 2; continue; }

    // Sized number: 32'h1234, 4'bxxxx, 8'd255
    const sizedM = src.slice(i).match(/^(\d+)?'([sS]?)([bBoOdDhH])([0-9a-fA-FxXzZ_?]+)/);
    if (sizedM) {
      toks.push({ type: 'num', value: sizedM[0], pos: i });
      i += sizedM[0].length;
      continue;
    }
    // Plain integer/decimal. Decimal values are mainly used by delays.
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9_]/.test(src[j])) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        j++;
        while (j < src.length && /[0-9_]/.test(src[j])) j++;
      }
      toks.push({ type: 'num', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    // String literal
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++;
        j++;
      }
      toks.push({ type: 'str', value: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    // Identifier / keyword (including $-system)
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const lc = word.toLowerCase();
      const t = KEYWORDS.has(lc) ? lc : (word.startsWith('$') ? 'sysid' : 'id');
      toks.push({ type: t, value: word, pos: i });
      i = j;
      continue;
    }
    // Multi-char ops
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (three === '===' || three === '!==' || three === '<<<' || three === '>>>') {
      toks.push({ type: 'op', value: three, pos: i }); i += 3; continue;
    }
    if (['==','!=','<=','>=','&&','||','<<','>>','**','~&','~|','~^'].includes(two)) {
      toks.push({ type: 'op', value: two, pos: i }); i += 2; continue;
    }
    // Single-char punctuation/op
    if ('+-*/%&|^~!?:<>=(){}[];,@#'.includes(c)) {
      toks.push({ type: 'op', value: c, pos: i }); i++; continue;
    }
    // Unknown — skip
    i++;
  }
  return toks;
}

class Parser {
  toks: Tok[];
  i = 0;
  constructor(toks: Tok[]) { this.toks = toks; }

  peek(off = 0): Tok | undefined { return this.toks[this.i + off]; }
  next(): Tok | undefined { return this.toks[this.i++]; }
  check(type: string, value?: string): boolean {
    const t = this.peek(); if (!t) return false;
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }
  match(type: string, value?: string): boolean {
    if (this.check(type, value)) { this.i++; return true; }
    return false;
  }
  expect(type: string, value?: string): Tok {
    const t = this.next();
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`Parse error: expected ${type}${value ? ' "' + value + '"' : ''}, got ${t ? t.type + ' "' + t.value + '"' : 'EOF'} at pos ${t?.pos ?? -1}`);
    }
    return t;
  }
  eof(): boolean { return this.i >= this.toks.length; }

  // ────────── Expression precedence (lowest → highest) ──────────
  // ?:  →  ||  →  &&  →  |  →  ^  →  &  →  ==/!=/===/!==  →  </<=/>/>=  →  <</>>  →  +/-  →  *///%  →  unary
  parseExpr(): Expr { return this.parseTernary(); }
  parseTernary(): Expr {
    const c = this.parseLogOr();
    if (this.match('op', '?')) {
      const t = this.parseExpr();
      this.expect('op', ':');
      const f = this.parseExpr();
      return { kind: 'ternary', c, t, f };
    }
    return c;
  }
  parseLogOr(): Expr {
    let l = this.parseLogAnd();
    while (this.match('op', '||')) { const r = this.parseLogAnd(); l = { kind: 'binary', op: '||', l, r }; }
    return l;
  }
  parseLogAnd(): Expr {
    let l = this.parseBitOr();
    while (this.match('op', '&&')) { const r = this.parseBitOr(); l = { kind: 'binary', op: '&&', l, r }; }
    return l;
  }
  parseBitOr(): Expr {
    let l = this.parseBitXor();
    while (this.peek()?.type === 'op' && this.peek()?.value === '|' && this.peek(1)?.value !== '|') {
      this.next(); const r = this.parseBitXor(); l = { kind: 'binary', op: '|', l, r };
    }
    return l;
  }
  parseBitXor(): Expr {
    let l = this.parseBitAnd();
    while (this.peek()?.type === 'op' && (this.peek()?.value === '^')) {
      this.next(); const r = this.parseBitAnd(); l = { kind: 'binary', op: '^', l, r };
    }
    return l;
  }
  parseBitAnd(): Expr {
    let l = this.parseEq();
    while (this.peek()?.type === 'op' && this.peek()?.value === '&' && this.peek(1)?.value !== '&') {
      this.next(); const r = this.parseEq(); l = { kind: 'binary', op: '&', l, r };
    }
    return l;
  }
  parseEq(): Expr {
    let l = this.parseRel();
    while (this.peek()?.type === 'op' && ['==','!=','===','!=='].includes(this.peek()!.value)) {
      const op = this.next()!.value; const r = this.parseRel(); l = { kind: 'binary', op, l, r };
    }
    return l;
  }
  parseRel(): Expr {
    let l = this.parseShift();
    while (this.peek()?.type === 'op' && ['<','<=','>','>='].includes(this.peek()!.value)) {
      const op = this.next()!.value; const r = this.parseShift(); l = { kind: 'binary', op, l, r };
    }
    return l;
  }
  parseShift(): Expr {
    let l = this.parseAdd();
    while (this.peek()?.type === 'op' && ['<<','>>','<<<','>>>'].includes(this.peek()!.value)) {
      const op = this.next()!.value; const r = this.parseAdd(); l = { kind: 'binary', op, l, r };
    }
    return l;
  }
  parseAdd(): Expr {
    let l = this.parseMul();
    while (this.peek()?.type === 'op' && ['+','-'].includes(this.peek()!.value)) {
      const op = this.next()!.value; const r = this.parseMul(); l = { kind: 'binary', op, l, r };
    }
    return l;
  }
  parseMul(): Expr {
    let l = this.parseUnary();
    while (this.peek()?.type === 'op' && ['*','/','%'].includes(this.peek()!.value)) {
      const op = this.next()!.value; const r = this.parseUnary(); l = { kind: 'binary', op, l, r };
    }
    return l;
  }
  parseUnary(): Expr {
    const t = this.peek();
    if (t?.type === 'op' && ['!','~','-','+','&','|','^','~&','~|','~^'].includes(t.value)) {
      // Disambiguate unary &/|/^ from binary by context (this is called after operator → must be unary)
      this.next();
      const arg = this.parseUnary();
      return { kind: 'unary', op: t.value, arg };
    }
    return this.parsePostfix();
  }
  parsePostfix(): Expr {
    let e = this.parsePrim();
    while (true) {
      if (this.check('op', '[')) {
        this.next();
        const a = this.parseExpr();
        if (this.match('op', ':')) {
          // Range part-select; bounds must be compile-time constants per Verilog-2001
          const b = this.parseExpr();
          this.expect('op', ']');
          const msb = exprConstInt(a), lsb = exprConstInt(b);
          if (msb !== null && lsb !== null) {
            // Works for plain signals AND for chained accesses like memory[idx][msb:lsb]
            // — evalExpr's 'range' case evaluates the base recursively.
            e = { kind: 'range', base: e, msb, lsb };
          } else {
            // Variable bounds (`+:` / `-:`) aren't supported yet — bail to bit 0
            e = { kind: 'bit', base: e, idx: a };
          }
        } else {
          this.expect('op', ']');
          e = { kind: 'bit', base: e, idx: a };
        }
      } else break;
    }
    return e;
  }
  parsePrim(): Expr {
    const t = this.next();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'num') return { kind: 'num', raw: t.value, ...parseNumberLit(t.value) };
    if (t.type === 'id') return { kind: 'id', name: t.value };
    if (t.type === 'sysid') {
      // System function call — only $time and similar take no args here
      if (this.match('op', '(')) {
        const args: Expr[] = [];
        if (!this.check('op', ')')) {
          args.push(this.parseExpr());
          while (this.match('op', ',')) args.push(this.parseExpr());
        }
        this.expect('op', ')');
        return { kind: 'sysfunc', name: t.value, args };
      }
      return { kind: 'sysfunc', name: t.value, args: [] };
    }
    if (t.type === 'op' && t.value === '(') {
      const e = this.parseExpr();
      this.expect('op', ')');
      return e;
    }
    if (t.type === 'op' && t.value === '{') {
      // Concatenation or replication
      const first = this.parseExpr();
      if (this.match('op', '{')) {
        // Replication: {N{expr}}
        const inner = this.parseExpr();
        this.expect('op', '}');
        this.expect('op', '}');
        const count = exprConstInt(first);
        if (count === null) throw new Error('Replication count must be constant');
        return { kind: 'replicate', count, inner };
      }
      const parts: Expr[] = [first];
      while (this.match('op', ',')) parts.push(this.parseExpr());
      this.expect('op', '}');
      return { kind: 'concat', parts };
    }
    throw new Error(`Unexpected token "${t.value}" at pos ${t.pos}`);
  }
}

function exprConstInt(e: Expr, params = new Map<string, number>()): number | null {
  if (e.kind === 'num') {
    if ((e.val.x & bmask(e.w)) !== 0n) return null;
    return Number(e.val.v);
  }
  if (e.kind === 'id') return params.get(e.name) ?? null;
  if (e.kind === 'unary' && e.op === '-') {
    const v = exprConstInt(e.arg, params); return v === null ? null : -v;
  }
  if (e.kind === 'unary' && e.op === '+') {
    return exprConstInt(e.arg, params);
  }
  if (e.kind === 'binary') {
    const l = exprConstInt(e.l, params);
    const r = exprConstInt(e.r, params);
    if (l === null || r === null) return null;
    switch (e.op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return r === 0 ? null : Math.trunc(l / r);
      case '%': return r === 0 ? null : l % r;
      case '<<': return l << r;
      case '>>': return l >> r;
    }
  }
  return null;
}

function exprConstNumber(e: Expr, params = new Map<string, number>()): number | null {
  if (e.kind === 'num') {
    if ((e.val.x & bmask(e.w)) !== 0n) return null;
    if (e.raw && !e.raw.includes("'")) return Number.parseFloat(e.raw.replace(/_/g, ''));
    return Number(e.val.v);
  }
  if (e.kind === 'id') return params.get(e.name) ?? null;
  if (e.kind === 'unary' && e.op === '-') {
    const v = exprConstNumber(e.arg, params); return v === null ? null : -v;
  }
  if (e.kind === 'unary' && e.op === '+') {
    return exprConstNumber(e.arg, params);
  }
  if (e.kind === 'binary') {
    const l = exprConstNumber(e.l, params);
    const r = exprConstNumber(e.r, params);
    if (l === null || r === null) return null;
    switch (e.op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return r === 0 ? null : l / r;
      case '%': return r === 0 ? null : l % r;
      case '<<': return l << r;
      case '>>': return l >> r;
    }
  }
  if (e.kind === 'ternary') {
    const c = exprConstNumber(e.c, params);
    if (c === null) return null;
    return exprConstNumber(c !== 0 ? e.t : e.f, params);
  }
  return null;
}

function parseNumberLit(s: string): { w: number; val: V4 } {
  // sized: 32'h1234, 4'bxxxx, 100'h00...
  const m = s.match(/^(\d+)?'([sS]?)([bBoOdDhH])([0-9a-fA-FxXzZ_?]+)$/);
  if (m) {
    const w = m[1] ? parseInt(m[1]) : 32;
    const base = m[3].toLowerCase();
    const digits = m[4].replace(/_/g, '');
    let v = 0n, x = 0n;
    const radix = base === 'b' ? 1 : base === 'o' ? 3 : base === 'h' ? 4 : 0;
    if (radix > 0) {
      for (const ch of digits) {
        const c = ch.toLowerCase();
        v <<= BigInt(radix); x <<= BigInt(radix);
        if (c === 'x' || c === '?' || c === 'z') {
          x |= bmask(radix);
        } else {
          v |= BigInt(parseInt(c, base === 'b' ? 2 : base === 'o' ? 8 : 16));
        }
      }
    } else {
      // decimal
      v = BigInt(parseInt(digits, 10));
    }
    return { w, val: { v: v & bmask(w), x: x & bmask(w) } };
  }
  // plain decimal
  const n = parseInt(s.replace(/_/g, ''), 10);
  return { w: 32, val: { v: BigInt(n) & bmask(32), x: 0n } };
}

function parseDelayNumber(raw: string): number {
  if (raw.includes("'")) {
    const n = parseNumberLit(raw);
    if ((n.val.x & bmask(n.w)) !== 0n) throw new Error('Delay literal cannot contain x/z bits');
    return Number(n.val.v);
  }
  return Number.parseFloat(raw.replace(/_/g, ''));
}

function applyDelayUnit(value: number, explicitUnit: string | undefined, timeUnitNs: number): number {
  const multiplier = explicitUnit ? TIME_UNIT_NS[explicitUnit.toLowerCase()] : timeUnitNs;
  if (multiplier === undefined || !Number.isFinite(value)) throw new Error('Invalid delay value');
  return value * multiplier;
}

function parseDelayValue(p: Parser, params: Map<string, number>, timeUnitNs: number): number {
  if (p.match('op', '(')) {
    if (p.peek()?.type === 'num' && p.peek(1)?.type === 'id' && TIME_UNIT_NS[p.peek(1)!.value.toLowerCase()] !== undefined && p.peek(2)?.value === ')') {
      const value = parseDelayNumber(p.next()!.value);
      const unit = p.next()!.value;
      p.expect('op', ')');
      return applyDelayUnit(value, unit, timeUnitNs);
    }
    const min = p.parseExpr();
    let selected = min;
    if (p.match('op', ':')) {
      selected = p.parseExpr(); // min:typ:max delays use typ in this simulator.
      if (p.match('op', ':')) p.parseExpr();
    }
    p.expect('op', ')');
    const value = exprConstNumber(selected, params);
    if (value === null) throw new Error('Delay expression must be constant or parameter-based');
    return applyDelayUnit(value, undefined, timeUnitNs);
  }

  if (p.peek()?.type === 'num') {
    const value = parseDelayNumber(p.next()!.value);
    const unitTok = p.peek();
    const unit = unitTok?.type === 'id' && TIME_UNIT_NS[unitTok.value.toLowerCase()] !== undefined
      ? p.next()!.value
      : undefined;
    return applyDelayUnit(value, unit, timeUnitNs);
  }

  const expr = p.parseExpr();
  const value = exprConstNumber(expr, params);
  if (value === null) throw new Error('Delay expression must be constant or parameter-based');
  return applyDelayUnit(value, undefined, timeUnitNs);
}

function parseDelayString(raw: string | undefined, params: Map<string, number>, timeUnitNs: number): number | undefined {
  if (!raw) return undefined;
  const p = new Parser(tokenize(`#${raw}`));
  p.expect('op', '#');
  return parseDelayValue(p, params, timeUnitNs);
}

// ============================================================
// Statement parser
// ============================================================

function parseStatementsFromString(src: string, params = new Map<string, number>(), timeUnitNs = 1): Stmt[] {
  const toks = tokenize(src);
  const p = new Parser(toks);
  const stmts: Stmt[] = [];
  while (!p.eof()) {
    const s = parseStmt(p, params, timeUnitNs);
    if (s) stmts.push(s);
  }
  return stmts;
}

function parseStmt(p: Parser, params = new Map<string, number>(), timeUnitNs = 1): Stmt | null {
  const t = p.peek();
  if (!t) return null;

  // Skip stray semicolons
  if (t.type === 'op' && t.value === ';') { p.next(); return null; }

  if (t.type === 'begin') {
    p.next();
    const body: Stmt[] = [];
    while (!p.eof() && !p.check('end')) {
      const s = parseStmt(p, params, timeUnitNs); if (s) body.push(s);
    }
    p.expect('end');
    return { kind: 'block', body };
  }

  if (t.type === 'if') {
    p.next();
    p.expect('op', '(');
    const cond = p.parseExpr();
    p.expect('op', ')');
    const thenS = parseStmt(p, params, timeUnitNs) ?? { kind: 'block', body: [] };
    let elseS: Stmt | undefined;
    if (p.check('else')) {
      p.next();
      elseS = parseStmt(p, params, timeUnitNs) ?? { kind: 'block', body: [] };
    }
    return { kind: 'if', cond, then: thenS, else: elseS };
  }

  if (t.type === 'case' || t.type === 'casex' || t.type === 'casez') {
    const which = t.type as 'case' | 'casex' | 'casez';
    p.next();
    p.expect('op', '(');
    const sel = p.parseExpr();
    p.expect('op', ')');
    const items: { labels: Expr[] | 'default'; body: Stmt }[] = [];
    while (!p.eof() && !p.check('id', 'endcase') && p.peek()?.value !== 'endcase') {
      if (p.check('default')) {
        p.next(); p.match('op', ':');
        const body = parseStmt(p, params, timeUnitNs) ?? { kind: 'block', body: [] };
        items.push({ labels: 'default', body });
      } else {
        const labels: Expr[] = [p.parseExpr()];
        while (p.match('op', ',')) labels.push(p.parseExpr());
        p.expect('op', ':');
        const body = parseStmt(p, params, timeUnitNs) ?? { kind: 'block', body: [] };
        items.push({ labels, body });
      }
    }
    // 'endcase' is a keyword we tokenize as id
    if (p.peek()?.value === 'endcase') p.next();
    return { kind: 'case', sel, items, casex: which };
  }

  if (t.type === 'for') {
    p.next();
    p.expect('op', '(');
    const init = parseSimpleStmt(p, params, timeUnitNs);
    p.match('op', ';');
    const cond = p.parseExpr();
    p.expect('op', ';');
    const step = parseSimpleStmt(p, params, timeUnitNs);
    p.expect('op', ')');
    const body = parseStmt(p, params, timeUnitNs) ?? { kind: 'block', body: [] };
    return { kind: 'for', init: init ?? { kind: 'block', body: [] }, cond, step: step ?? { kind: 'block', body: [] }, body };
  }

  if (t.type === 'while') {
    p.next();
    p.expect('op', '(');
    const cond = p.parseExpr();
    p.expect('op', ')');
    const body = parseStmt(p, params, timeUnitNs) ?? { kind: 'block', body: [] };
    return { kind: 'while', cond, body };
  }

  if (t.type === 'repeat') {
    p.next();
    p.expect('op', '(');
    const count = p.parseExpr();
    p.expect('op', ')');
    const body = parseStmt(p, params, timeUnitNs) ?? { kind: 'block', body: [] };
    return { kind: 'repeat', count, body };
  }

  if (t.type === 'forever') {
    p.next();
    const body = parseStmt(p, params, timeUnitNs) ?? { kind: 'block', body: [] };
    return { kind: 'forever', body };
  }

  if (t.type === 'op' && t.value === '#') {
    p.next();
    const ns = parseDelayValue(p, params, timeUnitNs);
    if (p.match('op', ';')) return { kind: 'delay', ns };
    const inner = parseStmt(p, params, timeUnitNs) ?? undefined;
    return { kind: 'delay', ns, inner };
  }

  if (t.type === 'op' && t.value === '@') {
    p.next();
    const sens = parseSensitivity(p);
    if (p.match('op', ';')) return { kind: 'eventCtrl', sens };
    const inner = parseStmt(p, params, timeUnitNs) ?? undefined;
    return { kind: 'eventCtrl', sens, inner };
  }

  if (t.type === 'sysid') {
    p.next();
    const args: (Expr | { kind: 'str'; value: string })[] = [];
    if (p.match('op', '(')) {
      if (!p.check('op', ')')) {
        do {
          if (p.check('str')) { args.push({ kind: 'str', value: p.next()!.value }); }
          else args.push(p.parseExpr());
        } while (p.match('op', ','));
      }
      p.expect('op', ')');
    }
    p.match('op', ';');
    return { kind: 'sys', name: t.value, args };
  }

  // Statement starting with identifier → assignment
  return parseAssignStmt(p, params, timeUnitNs);
}

function parseSimpleStmt(p: Parser, params = new Map<string, number>(), timeUnitNs = 1): Stmt | null {
  // Used inside for(...) — disallows trailing ';'
  const t = p.peek();
  if (!t) return null;
  if (t.type === 'op' && t.value === ';') return null;
  return parseAssignStmt(p, params, timeUnitNs, /*requireSemi=*/false);
}

function parseAssignStmt(p: Parser, params = new Map<string, number>(), timeUnitNs = 1, requireSemi = true): Stmt | null {
  const lhs = parseLValue(p, params);
  if (!lhs) return null;
  const opTok = p.peek();
  if (!opTok) return null;
  let nonblocking = false;
  if (opTok.type === 'op' && opTok.value === '<=') { p.next(); nonblocking = true; }
  else if (opTok.type === 'op' && opTok.value === '=') { p.next(); }
  else {
    // Bare expression-statement-like? Not valid in Verilog procedural — skip token.
    return null;
  }

  // intra-assignment delay: signal = #5 expr;
  let delay: number | undefined;
  if (p.match('op', '#')) {
    delay = parseDelayValue(p, params, timeUnitNs);
  }

  const expr = p.parseExpr();
  if (requireSemi) p.match('op', ';');
  return { kind: 'assign', target: lhs, expr, nonblocking, delay };
}

function parseLValue(p: Parser, params = new Map<string, number>()): LValue | null {
  if (p.check('op', '{')) {
    p.next();
    const parts: LValue[] = [];
    parts.push(parseLValue(p, params)!);
    while (p.match('op', ',')) parts.push(parseLValue(p, params)!);
    p.expect('op', '}');
    return { kind: 'concat', parts };
  }
  if (!p.check('id')) return null;
  const name = p.next()!.value;
  if (p.match('op', '[')) {
    const a = p.parseExpr();
    if (p.match('op', ':')) {
      const b = p.parseExpr();
      p.expect('op', ']');
      const msb = exprConstInt(a, params), lsb = exprConstInt(b, params);
      if (msb === null || lsb === null) {
        // Variable range — uncommon — treat as bit-sel msb
        return { kind: 'bit', name, idx: a };
      }
      return { kind: 'range', name, msb, lsb };
    }
    p.expect('op', ']');
    // Could be memory[idx] or signal[bit]; we resolve at execution time using ctx info
    // BUT memory[i][bit] / memory[i][m:l] needs additional brackets
    if (p.match('op', '[')) {
      const b1 = p.parseExpr();
      if (p.match('op', ':')) {
        const b2 = p.parseExpr();
        p.expect('op', ']');
        const msb = exprConstInt(b1, params), lsb = exprConstInt(b2, params);
        if (msb === null || lsb === null) return { kind: 'bit', name, idx: a };
        return { kind: 'memRangeSel', name, idx: a, msb, lsb };
      }
      p.expect('op', ']');
      return { kind: 'memBitSel', name, idx: a, bit: b1 };
    }
    return { kind: 'bit', name, idx: a };
  }
  return { kind: 'id', name };
}

function parseSensitivity(p: Parser): Sensitivity {
  if (!p.match('op', '(')) {
    // @* form: @(*) but written as @* maybe
    if (p.match('op', '*')) return { any: true, list: [] };
    return { any: false, list: [] };
  }
  if (p.match('op', '*')) {
    p.expect('op', ')');
    return { any: true, list: [] };
  }
  const list: SensEntry[] = [];
  do {
    let edge: 'posedge' | 'negedge' | 'level' = 'level';
    if (p.match('posedge')) edge = 'posedge';
    else if (p.match('negedge')) edge = 'negedge';
    const e = p.parseExpr();
    const sigName = exprToSignalName(e);
    if (sigName) list.push({ signal: sigName, edge });
  } while (p.match('op', ',') || p.match('id', 'or'));
  p.expect('op', ')');
  return { any: list.length === 0, list };
}

function exprToSignalName(e: Expr): string | null {
  if (e.kind === 'id') return e.name;
  if (e.kind === 'bit' && e.base.kind === 'id') return e.base.name;
  if (e.kind === 'range' && e.base.kind === 'id') return e.base.name;
  return null;
}

// Walk an expression and collect all signal names it reads (for @(*) inference)
function collectReadSignals(e: Expr, out: Set<string>): void {
  switch (e.kind) {
    case 'id': out.add(e.name); return;
    case 'bit': collectReadSignals(e.base, out); collectReadSignals(e.idx, out); return;
    case 'range': collectReadSignals(e.base, out); return;
    case 'concat': e.parts.forEach(p => collectReadSignals(p, out)); return;
    case 'replicate': collectReadSignals(e.inner, out); return;
    case 'unary': collectReadSignals(e.arg, out); return;
    case 'binary': collectReadSignals(e.l, out); collectReadSignals(e.r, out); return;
    case 'ternary': collectReadSignals(e.c, out); collectReadSignals(e.t, out); collectReadSignals(e.f, out); return;
    case 'sysfunc': e.args.forEach(a => collectReadSignals(a, out)); return;
    case 'num': return;
  }
}
function collectStmtReadSignals(s: Stmt, out: Set<string>): void {
  switch (s.kind) {
    case 'block': s.body.forEach(c => collectStmtReadSignals(c, out)); return;
    case 'assign': collectReadSignals(s.expr, out);
      // Read indices from LHS that involve expressions
      const lv = s.target;
      if (lv.kind === 'bit') collectReadSignals(lv.idx, out);
      if (lv.kind === 'memBitSel') { collectReadSignals(lv.idx, out); collectReadSignals(lv.bit, out); }
      if (lv.kind === 'memRangeSel') collectReadSignals(lv.idx, out);
      return;
    case 'if': collectReadSignals(s.cond, out); collectStmtReadSignals(s.then, out); if (s.else) collectStmtReadSignals(s.else, out); return;
    case 'case': collectReadSignals(s.sel, out);
      s.items.forEach(it => { if (it.labels !== 'default') it.labels.forEach(l => collectReadSignals(l, out)); collectStmtReadSignals(it.body, out); });
      return;
    case 'for': collectStmtReadSignals(s.init, out); collectReadSignals(s.cond, out); collectStmtReadSignals(s.step, out); collectStmtReadSignals(s.body, out); return;
    case 'while': collectReadSignals(s.cond, out); collectStmtReadSignals(s.body, out); return;
    case 'repeat': collectReadSignals(s.count, out); collectStmtReadSignals(s.body, out); return;
    case 'forever': collectStmtReadSignals(s.body, out); return;
    case 'delay': if (s.inner) collectStmtReadSignals(s.inner, out); return;
    case 'eventCtrl': if (s.inner) collectStmtReadSignals(s.inner, out); return;
    case 'sys': s.args.forEach(a => { if ('kind' in a && a.kind !== 'str') collectReadSignals(a, out); }); return;
  }
}

// ============================================================
// Memory-array detection (parser doesn't expose these)
// ============================================================

interface MemoryDecl { name: string; width: number; depth: number }
function stripCommentsRaw(src: string): string {
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
function findMemories(modSrc: string): MemoryDecl[] {
  const mems: MemoryDecl[] = [];
  const cleaned = stripCommentsRaw(modSrc);
  // reg [W-1:0] name [0:N-1];   or   reg name [0:N-1];
  const re = /\breg\b\s*(\[(\d+):(\d+)\])?\s*(\w+)\s*\[(\d+)\s*:\s*(\d+)\]\s*;/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const width = m[1] ? Math.abs(parseInt(m[2]) - parseInt(m[3])) + 1 : 1;
    const a = parseInt(m[5]), b = parseInt(m[6]);
    mems.push({ name: m[4], width, depth: Math.abs(a - b) + 1 });
  }
  return mems;
}

// always begin ... end  (no @ sensitivity — typically clock generators)
function findUnsensitizedAlways(modSrcRaw: string): string[] {
  const modSrc = stripCommentsRaw(modSrcRaw);
  const out: string[] = [];
  // Match `always` NOT followed by `@` (skipping any intervening whitespace).
  // Plain `(?!@)` after greedy `\s*` fails — the engine can satisfy `\s*` with zero chars.
  const re = /\balways\b(?!\s*@)/g;
  let m;
  while ((m = re.exec(modSrc)) !== null) {
    const start = m.index + m[0].length;
    // Take balanced begin/end or up to next ;
    let i = start;
    while (i < modSrc.length && /\s/.test(modSrc[i])) i++;
    if (modSrc.slice(i, i + 5) === 'begin') {
      let depth = 0; let j = i;
      while (j < modSrc.length) {
        if (modSrc.slice(j, j + 5).match(/^begin\b/)) { depth++; j += 5; continue; }
        if (modSrc.slice(j, j + 3).match(/^end\b/)) { depth--; j += 3; if (depth === 0) break; continue; }
        j++;
      }
      out.push(modSrc.slice(i, j));
    } else {
      const semi = modSrc.indexOf(';', i);
      if (semi !== -1) out.push(modSrc.slice(i, semi + 1));
    }
  }
  return out;
}

// ============================================================
// Simulator state
// ============================================================

interface Signal {
  name: string;       // hierarchical
  width: number;
  value: V4;
  // Subscribers fire whenever value changes
  subscribers: Set<Subscriber>;
  trace: SignalChange[];
  recordChanges: boolean;
}

interface MemoryStore {
  name: string;
  path: string;
  width: number;
  depth: number;
  data: V4[];
  traces: SignalChange[][];
  subscribers: Set<Subscriber>;
}

type Subscriber = () => void;

interface ScopeData {
  path: string;
  signals: Map<string, Signal>;
  memories: Map<string, MemoryStore>;
  params: Map<string, number>;
  mod: VerilogModule;
}

interface SchedEvent {
  time: number;
  region: 0 | 1; // 0 = active, 1 = NBA commit
  seq: number;
  fn: () => void;
}

class Scheduler {
  events: SchedEvent[] = [];
  now = 0;
  seqCounter = 0;
  finished = false;
  maxTime = 100000;

  schedule(time: number, region: 0 | 1, fn: () => void): void {
    this.events.push({ time, region, seq: this.seqCounter++, fn });
  }

  run(): void {
    while (!this.finished && this.events.length > 0) {
      // Pop the earliest event by (time, region, seq)
      let bestIdx = 0;
      for (let i = 1; i < this.events.length; i++) {
        const a = this.events[bestIdx], b = this.events[i];
        if (b.time < a.time || (b.time === a.time && b.region < a.region) ||
            (b.time === a.time && b.region === a.region && b.seq < a.seq)) {
          bestIdx = i;
        }
      }
      const e = this.events[bestIdx];
      this.events.splice(bestIdx, 1);
      if (e.time > this.maxTime) { this.now = this.maxTime; break; }
      this.now = e.time;
      try { e.fn(); } catch (err) {
        if (err instanceof FinishSignal) { this.finished = true; break; }
        throw err;
      }
    }
  }
}

class FinishSignal {}

// ============================================================
// Lookup helper: find signal by hierarchical name search
// ============================================================

class SimContext {
  scopes: ScopeData[] = [];
  signalsByName = new Map<string, Signal>();
  topScope!: ScopeData;
  tbScope!: ScopeData;
  scheduler = new Scheduler();
  errors: string[] = [];
  logs: SimulationLog[] = [];
  fileMap: Record<string, string> = {};
  duration = 0;
  timeUnitNs = 1;
  moduleTimeUnitNs = new Map<string, number>();

  resolveSignal(scope: ScopeData, name: string): Signal | undefined {
    return scope.signals.get(name);
  }

  resolveMemory(scope: ScopeData, name: string): MemoryStore | undefined {
    return scope.memories.get(name);
  }
}

function timeUnitForScope(scope: ScopeData, ctx: SimContext): number {
  return ctx.moduleTimeUnitNs.get(scope.mod.name) ?? ctx.timeUnitNs;
}

function currentTimeInUnits(scope: ScopeData, ctx: SimContext): number {
  return ctx.scheduler.now / timeUnitForScope(scope, ctx);
}

function formatTimeValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(12)));
}

// ============================================================
// Expression evaluator
// ============================================================

function evalExpr(e: Expr, scope: ScopeData, ctx: SimContext): { val: V4; w: number } {
  switch (e.kind) {
    case 'num': return { val: e.val, w: e.w };
    case 'id': {
      const sig = scope.signals.get(e.name);
      if (sig) return { val: sig.value, w: sig.width };
      const param = scope.params.get(e.name);
      if (param !== undefined) return { val: v4FromNum(param, 32), w: 32 };
      // unknown identifier → x of width 1 (could be a memory reference used incorrectly)
      return { val: v4X(1), w: 1 };
    }
    case 'bit': {
      // base is identifier; check if it's a memory
      if (e.base.kind === 'id') {
        const mem = scope.memories.get(e.base.name);
        if (mem) {
          const idxR = evalExpr(e.idx, scope, ctx);
          if (v4HasX(idxR.val, idxR.w)) return { val: v4X(mem.width), w: mem.width };
          const i = Number(idxR.val.v);
          if (i < 0 || i >= mem.depth) return { val: v4X(mem.width), w: mem.width };
          return { val: mem.data[i], w: mem.width };
        }
      }
      const baseR = evalExpr(e.base, scope, ctx);
      const idxR = evalExpr(e.idx, scope, ctx);
      if (v4HasX(idxR.val, idxR.w)) return { val: v4X(1), w: 1 };
      const bit = Number(idxR.val.v);
      return { val: v4Bit(baseR.val, bit), w: 1 };
    }
    case 'range': {
      // Could be signal[m:l] or memory[i][m:l] (handled separately via 'memRangeSel' on RHS — but we don't have a memRange kind in Expr, so handle in parsePostfix would have created a 'bit' chain... fallback)
      const baseR = evalExpr(e.base, scope, ctx);
      const w = e.msb - e.lsb + 1;
      return { val: v4Slice(baseR.val, e.msb, e.lsb), w };
    }
    case 'concat': {
      const parts = e.parts.map(p => {
        const r = evalExpr(p, scope, ctx);
        return { val: r.val, w: r.w };
      });
      const c = v4Concat(parts);
      return { val: c.val, w: c.w };
    }
    case 'replicate': {
      const r = evalExpr(e.inner, scope, ctx);
      const parts = Array.from({ length: e.count }, () => ({ val: r.val, w: r.w }));
      const c = v4Concat(parts);
      return { val: c.val, w: c.w };
    }
    case 'unary': {
      const r = evalExpr(e.arg, scope, ctx);
      switch (e.op) {
        case '~': return { val: v4Not(r.val, r.w), w: r.w };
        case '!': {
          const b = v4Truthy(r.val, r.w) ? v4FromBig(0n, 1) : v4One();
          if (v4HasX(r.val, r.w) && !((r.val.v & ~r.val.x & bmask(r.w)) !== 0n)) return { val: v4X(1), w: 1 };
          return { val: b, w: 1 };
        }
        case '-': return { val: v4Sub(v4Zero(), r.val, r.w), w: r.w };
        case '+': return r;
        case '&':  return { val: v4ReduceAnd(r.val, r.w), w: 1 };
        case '|':  return { val: v4ReduceOr(r.val, r.w),  w: 1 };
        case '^':  return { val: v4ReduceXor(r.val, r.w), w: 1 };
        case '~&': return { val: v4Not(v4ReduceAnd(r.val, r.w), 1), w: 1 };
        case '~|': return { val: v4Not(v4ReduceOr(r.val, r.w),  1), w: 1 };
        case '~^': return { val: v4Not(v4ReduceXor(r.val, r.w), 1), w: 1 };
      }
      return r;
    }
    case 'binary': {
      const a = evalExpr(e.l, scope, ctx);
      const b = evalExpr(e.r, scope, ctx);
      const w = Math.max(a.w, b.w);
      const A = v4Resize(a.val, w);
      const B = v4Resize(b.val, w);
      switch (e.op) {
        case '+': return { val: v4Add(A, B, w), w };
        case '-': return { val: v4Sub(A, B, w), w };
        case '*': return { val: v4Mul(A, B, w), w };
        case '/': return { val: v4Div(A, B, w), w };
        case '%': return { val: v4Mod(A, B, w), w };
        case '&': return { val: v4And(A, B, w), w };
        case '|': return { val: v4Or(A, B, w),  w };
        case '^': return { val: v4Xor(A, B, w), w };
        case '<<': case '<<<': return { val: v4Shl(A, b.val, w), w };
        case '>>': case '>>>': return { val: v4Shr(A, b.val, w), w };
        case '<':  return { val: v4Lt(A, B, w),  w: 1 };
        case '<=': return { val: v4Le(A, B, w),  w: 1 };
        case '>':  return { val: v4Gt(A, B, w),  w: 1 };
        case '>=': return { val: v4Ge(A, B, w),  w: 1 };
        case '==': return { val: v4LogEq(A, B, w),  w: 1 };
        case '!=': return { val: v4LogNeq(A, B, w), w: 1 };
        case '===':return { val: v4CaseEq(A, B, w),  w: 1 };
        case '!==':return { val: v4CaseNeq(A, B, w), w: 1 };
        case '&&': {
          const at = v4Truthy(A, w), bt = v4Truthy(B, w);
          if (at && bt) return { val: v4One(), w: 1 };
          // short-circuit not modeled; if either is firmly 0 → 0
          const aZero = !at && !v4HasX(A, w);
          const bZero = !bt && !v4HasX(B, w);
          if (aZero || bZero) return { val: v4FromBig(0n, 1), w: 1 };
          return { val: v4X(1), w: 1 };
        }
        case '||': {
          const at = v4Truthy(A, w), bt = v4Truthy(B, w);
          if (at || bt) return { val: v4One(), w: 1 };
          if (!v4HasX(A, w) && !v4HasX(B, w)) return { val: v4FromBig(0n, 1), w: 1 };
          return { val: v4X(1), w: 1 };
        }
      }
      return { val: v4Zero(), w: 1 };
    }
    case 'ternary': {
      const c = evalExpr(e.c, scope, ctx);
      if (v4HasX(c.val, c.w)) {
        const t = evalExpr(e.t, scope, ctx);
        const f = evalExpr(e.f, scope, ctx);
        const w = Math.max(t.w, f.w);
        // x → propagate to bit-by-bit "x where t,f differ"
        const T = v4Resize(t.val, w), F = v4Resize(f.val, w);
        const m = bmask(w);
        const diff = (T.v ^ F.v) & m;
        return { val: { v: T.v & ~diff, x: diff | T.x | F.x }, w };
      }
      return v4Truthy(c.val, c.w) ? evalExpr(e.t, scope, ctx) : evalExpr(e.f, scope, ctx);
    }
    case 'sysfunc': {
      if (e.name === '$time' || e.name === '$stime' || e.name === '$realtime') {
        return { val: v4FromBig(BigInt(Math.trunc(currentTimeInUnits(scope, ctx))), 32), w: 32 };
      }
      return { val: v4Zero(), w: 32 };
    }
  }
}

// ============================================================
// LValue write (with sensitivity firing)
// ============================================================

function writeSignal(sig: Signal, newVal: V4): void {
  const w = sig.width;
  const m = bmask(w);
  const oldV = sig.value;
  const masked: V4 = { v: newVal.v & m, x: newVal.x & m };
  if ((masked.v & m) === (oldV.v & m) && (masked.x & m) === (oldV.x & m)) return;
  sig.value = masked;
  if (sig.recordChanges) {
    sig.trace.push({ time: SCHED_NOW(), value: masked });
  }
  // Fire subscribers (snapshot — they may add new subscribers)
  for (const fn of Array.from(sig.subscribers)) {
    try { fn(); } catch (err) { if (err instanceof FinishSignal) throw err; /* swallow */ }
  }
}

function writeMemory(mem: MemoryStore, index: number, newVal: V4): void {
  if (index < 0 || index >= mem.depth) return;
  const w = mem.width;
  const m = bmask(w);
  const oldV = mem.data[index];
  const masked: V4 = { v: newVal.v & m, x: newVal.x & m };
  if ((masked.v & m) === (oldV.v & m) && (masked.x & m) === (oldV.x & m)) return;
  mem.data[index] = masked;
  mem.traces[index].push({ time: SCHED_NOW(), value: masked });
  for (const fn of Array.from(mem.subscribers)) {
    try { fn(); } catch (err) { if (err instanceof FinishSignal) throw err; /* swallow */ }
  }
}

let CURRENT_SCHED: Scheduler | null = null;
function SCHED_NOW(): number { return CURRENT_SCHED ? CURRENT_SCHED.now : 0; }

function writeLValue(lv: LValue, val: V4, valW: number, scope: ScopeData, ctx: SimContext): void {
  switch (lv.kind) {
    case 'id': {
      const sig = scope.signals.get(lv.name);
      if (!sig) return;
      writeSignal(sig, v4Resize(val, sig.width));
      return;
    }
    case 'bit': {
      // Could be signal[i] or memory[i]
      const mem = scope.memories.get(lv.name);
      if (mem) {
        const idxR = evalExpr(lv.idx, scope, ctx);
        if (v4HasX(idxR.val, idxR.w)) return;
        const i = Number(idxR.val.v);
        writeMemory(mem, i, v4Resize(val, mem.width));
        return;
      }
      const sig = scope.signals.get(lv.name);
      if (!sig) return;
      const idxR = evalExpr(lv.idx, scope, ctx);
      if (v4HasX(idxR.val, idxR.w)) return;
      const bit = Number(idxR.val.v);
      const newVal = v4WriteSlice(sig.value, bit, bit, val, sig.width);
      writeSignal(sig, newVal);
      return;
    }
    case 'range': {
      const sig = scope.signals.get(lv.name);
      if (!sig) return;
      const newVal = v4WriteSlice(sig.value, lv.msb, lv.lsb, val, sig.width);
      writeSignal(sig, newVal);
      return;
    }
    case 'memBitSel': {
      const mem = scope.memories.get(lv.name);
      if (!mem) return;
      const idxR = evalExpr(lv.idx, scope, ctx);
      if (v4HasX(idxR.val, idxR.w)) return;
      const i = Number(idxR.val.v);
      const bitR = evalExpr(lv.bit, scope, ctx);
      if (v4HasX(bitR.val, bitR.w)) return;
      const bit = Number(bitR.val.v);
      if (i < 0 || i >= mem.depth) return;
      writeMemory(mem, i, v4WriteSlice(mem.data[i], bit, bit, val, mem.width));
      return;
    }
    case 'memRangeSel': {
      const mem = scope.memories.get(lv.name);
      if (!mem) return;
      const idxR = evalExpr(lv.idx, scope, ctx);
      if (v4HasX(idxR.val, idxR.w)) return;
      const i = Number(idxR.val.v);
      if (i < 0 || i >= mem.depth) return;
      writeMemory(mem, i, v4WriteSlice(mem.data[i], lv.msb, lv.lsb, val, mem.width));
      return;
    }
    case 'concat': {
      // {a, b, c} = expr — split val across parts in declaration order (msb→lsb)
      // Compute width of each part to slice
      const partWidths: number[] = lv.parts.map(p => lvalWidth(p, scope));
      let bitPos = partWidths.reduce((a, b) => a + b, 0); // total
      for (let i = 0; i < lv.parts.length; i++) {
        const w = partWidths[i];
        bitPos -= w;
        const partVal = v4Slice(val, bitPos + w - 1, bitPos);
        writeLValue(lv.parts[i], partVal, w, scope, ctx);
      }
      return;
    }
  }
}

function lvalWidth(lv: LValue, scope: ScopeData): number {
  switch (lv.kind) {
    case 'id': return scope.signals.get(lv.name)?.width ?? 1;
    case 'bit': return 1;
    case 'range': return lv.msb - lv.lsb + 1;
    case 'memBitSel': return 1;
    case 'memRangeSel': return lv.msb - lv.lsb + 1;
    case 'concat': return lv.parts.reduce((a, p) => a + lvalWidth(p, scope), 0);
  }
}

// ============================================================
// Statement execution as generators
// ============================================================
//
// A process yields a "wait reason" until it should resume.
// We call gen.next() to advance; the scheduler arranges resumption.

type Yield =
  | { type: 'delay'; ns: number }
  | { type: 'wait'; signals: SensEntry[] };  // wait until any of these triggers

function* execBlock(stmts: Stmt[], scope: ScopeData, ctx: SimContext): Generator<Yield, void, void> {
  for (const s of stmts) yield* execStmt(s, scope, ctx);
}

function* execStmt(s: Stmt, scope: ScopeData, ctx: SimContext): Generator<Yield, void, void> {
  switch (s.kind) {
    case 'block':
      yield* execBlock(s.body, scope, ctx);
      return;
    case 'assign': {
      const r = evalExpr(s.expr, scope, ctx);
      if (s.delay !== undefined) {
        const valSnap = r.val, wSnap = r.w, lvSnap = s.target;
        if (s.nonblocking) {
          ctx.scheduler.schedule(ctx.scheduler.now + s.delay, 1, () => {
            writeLValue(lvSnap, valSnap, wSnap, scope, ctx);
          });
        } else {
          yield { type: 'delay', ns: s.delay };
          writeLValue(lvSnap, valSnap, wSnap, scope, ctx);
        }
        return;
      }
      if (s.nonblocking) {
        // Snapshot value, schedule commit in NBA region of current time
        const valSnap = r.val, wSnap = r.w, lvSnap = s.target;
        ctx.scheduler.schedule(ctx.scheduler.now, 1, () => {
          writeLValue(lvSnap, valSnap, wSnap, scope, ctx);
        });
      } else {
        writeLValue(s.target, r.val, r.w, scope, ctx);
      }
      return;
    }
    case 'delay': {
      yield { type: 'delay', ns: s.ns };
      if (s.inner) yield* execStmt(s.inner, scope, ctx);
      return;
    }
    case 'eventCtrl': {
      yield { type: 'wait', signals: s.sens.list };
      if (s.inner) yield* execStmt(s.inner, scope, ctx);
      return;
    }
    case 'if': {
      const c = evalExpr(s.cond, scope, ctx);
      if (v4Truthy(c.val, c.w)) yield* execStmt(s.then, scope, ctx);
      else if (s.else) yield* execStmt(s.else, scope, ctx);
      return;
    }
    case 'case': {
      const sel = evalExpr(s.sel, scope, ctx);
      let matched = false;
      let defaultBody: Stmt | null = null;
      for (const item of s.items) {
        if (item.labels === 'default') { defaultBody = item.body; continue; }
        if (matched) continue;
        for (const lab of item.labels) {
          const labV = evalExpr(lab, scope, ctx);
          const w = Math.max(sel.w, labV.w);
          if (v4CaseMatches(v4Resize(sel.val, w), v4Resize(labV.val, w), w, s.casex)) { matched = true; break; }
        }
        if (matched) { yield* execStmt(item.body, scope, ctx); break; }
      }
      if (!matched && defaultBody) yield* execStmt(defaultBody, scope, ctx);
      return;
    }
    case 'for': {
      yield* execStmt(s.init, scope, ctx);
      let guard = 0;
      while (guard++ < 100000) {
        const c = evalExpr(s.cond, scope, ctx);
        if (!v4Truthy(c.val, c.w)) break;
        yield* execStmt(s.body, scope, ctx);
        yield* execStmt(s.step, scope, ctx);
      }
      return;
    }
    case 'while': {
      let guard = 0;
      while (guard++ < 100000) {
        const c = evalExpr(s.cond, scope, ctx);
        if (!v4Truthy(c.val, c.w)) break;
        yield* execStmt(s.body, scope, ctx);
      }
      return;
    }
    case 'repeat': {
      const c = evalExpr(s.count, scope, ctx);
      const n = v4HasX(c.val, c.w) ? 0 : Number(c.val.v);
      for (let k = 0; k < n && k < 100000; k++) yield* execStmt(s.body, scope, ctx);
      return;
    }
    case 'forever': {
      let guard = 0;
      while (guard++ < 1000000) {
        yield* execStmt(s.body, scope, ctx);
      }
      return;
    }
    case 'sys': {
      runSysTask(s, scope, ctx);
      return;
    }
  }
}

function runSysTask(s: Stmt & { kind: 'sys' }, scope: ScopeData, ctx: SimContext): void {
  switch (s.name) {
    case '$display':
    case '$write':
    case '$monitor':
    case '$strobe': {
      const msg = formatDisplayArgs(s.args, scope, ctx);
      ctx.logs.push({ time: ctx.scheduler.now, message: msg });
      return;
    }
    case '$finish':
    case '$stop': {
      throw new FinishSignal();
    }
    case '$readmemh':
    case '$readmemb': {
      const fileArg = s.args[0];
      const memArg = s.args[1];
      if (!fileArg || (fileArg as { kind: string }).kind !== 'str') return;
      const fname = (fileArg as { kind: 'str'; value: string }).value;
      if (!memArg || (memArg as { kind: string }).kind !== 'id') return;
      const memName = ((memArg as Expr) as { kind: 'id'; name: string }).name;
      const mem = scope.memories.get(memName);
      if (!mem) return;
      const content = ctx.fileMap[fname] ?? Object.entries(ctx.fileMap).find(([k]) => k.endsWith('/' + fname) || k === fname)?.[1];
      if (!content) {
        ctx.errors.push(`$readmemh: file not found: ${fname}`);
        return;
      }
      const radix = s.name === '$readmemh' ? 16 : 2;
      readMemFromText(mem, content, radix);
      return;
    }
    case '$dumpfile':
    case '$dumpvars':
    case '$dumpon':
    case '$dumpoff':
      return;
  }
}

function readMemFromText(mem: MemoryStore, content: string, radix: number): void {
  // Strip line comments and /* */ comments
  const cleaned = content
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = cleaned.split(/\s+/).map(t => t.trim().replace(/_/g, '')).filter(Boolean);
  const w = mem.width;
  let idx = 0;
  for (const tok of tokens) {
    if (idx >= mem.depth) break;
    if (tok.startsWith('@')) {
      const nextIdx = parseInt(tok.slice(1), 16);
      if (!Number.isNaN(nextIdx)) idx = nextIdx;
      continue;
    }
    let v = 0n, x = 0n;
    const bitsPerDigit = radix === 16 ? 4 : 1;
    for (const ch of tok) {
      const c = ch.toLowerCase();
      v <<= BigInt(bitsPerDigit); x <<= BigInt(bitsPerDigit);
      if (c === 'x' || c === 'z' || c === '?') {
        x |= bmask(bitsPerDigit);
      } else {
        const digit = parseInt(c, radix);
        if (Number.isNaN(digit)) {
          x |= bmask(bitsPerDigit);
        } else {
          v |= BigInt(digit);
        }
      }
    }
    writeMemory(mem, idx, { v: v & bmask(w), x: x & bmask(w) });
    idx++;
  }
}

function formatDisplayArgs(args: (Expr | { kind: 'str'; value: string })[], scope: ScopeData, ctx: SimContext): string {
  if (args.length === 0) return '';
  const first = args[0];
  // Format string?
  if ('kind' in first && first.kind === 'str') {
    let out = '';
    let argi = 1;
    const fmt = first.value;
    for (let i = 0; i < fmt.length; i++) {
      const c = fmt[i];
      if (c === '%' && i + 1 < fmt.length) {
        // skip optional width spec
        let j = i + 1;
        while (j < fmt.length && /[0-9]/.test(fmt[j])) j++;
        const sp = fmt[j].toLowerCase();
        const a = args[argi++];
        const valR = a && (a as { kind: string }).kind !== 'str'
          ? evalExpr(a as Expr, scope, ctx) : { val: v4Zero(), w: 0 };
        switch (sp) {
          case 'd': out += v4FormatDec(valR.val, valR.w); break;
          case 'h': case 'x': out += v4FormatHex(valR.val, valR.w); break;
          case 'b': out += v4FormatBin(valR.val, valR.w); break;
          case 't': out += formatTimeValue(currentTimeInUnits(scope, ctx)); break;
          case 's': out += a && (a as { kind: string }).kind === 'str' ? (a as { kind: 'str'; value: string }).value : v4FormatDec(valR.val, valR.w); break;
          case 'm': out += scope.path; break;
          case '%': out += '%'; break;
          default: out += sp;
        }
        i = j;
      } else if (c === '\\' && i + 1 < fmt.length) {
        const e = fmt[i + 1];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else out += e;
        i++;
      } else {
        out += c;
      }
    }
    return out;
  }
  // No format string — just space-separated decimals
  return args.map(a => {
    if ((a as { kind: string }).kind === 'str') return (a as { kind: 'str'; value: string }).value;
    const r = evalExpr(a as Expr, scope, ctx);
    return v4FormatDec(r.val, r.w);
  }).join(' ');
}

// ============================================================
// Process (initial / always) driver
// ============================================================

function runProcess(make: () => Generator<Yield, void, void>, scope: ScopeData, ctx: SimContext, restartOnFinish: boolean): void {
  let gen = make();
  const pump = (): void => {
    while (true) {
      let r;
      try { r = gen.next(); } catch (err) {
        if (err instanceof FinishSignal) throw err;
        ctx.errors.push(`Runtime error: ${(err as Error).message}`);
        return;
      }
      if (r.done) {
        if (restartOnFinish) { gen = make(); continue; }
        return;
      }
      const y = r.value;
      if (y.type === 'delay') {
        const target = ctx.scheduler.now + y.ns;
        ctx.scheduler.schedule(target, 0, pump);
        return;
      }
      if (y.type === 'wait') {
        // Subscribe to the listed signals (or all signals if 'any' was empty)
        const subs: { sig: Signal; cb: Subscriber }[] = [];
        const fired = { v: false };
        const onFire = (e: SensEntry, prev: V4, curr: V4) => {
          if (fired.v) return;
          if (e.edge === 'posedge') {
            // 0→1 transition on bit 0
            const oldB = (prev.v & 1n) - (prev.x & 1n);
            const newB = (curr.v & 1n) - (curr.x & 1n);
            if (oldB === 1n || newB !== 1n) return;
          } else if (e.edge === 'negedge') {
            const oldB = (prev.v & 1n);
            const newB = (curr.v & 1n);
            if (!(oldB === 1n && newB === 0n && (curr.x & 1n) === 0n)) return;
          }
          fired.v = true;
          // Unsubscribe all
          for (const { sig, cb } of subs) sig.subscribers.delete(cb);
          // Resume on next active region tick at current time
          ctx.scheduler.schedule(ctx.scheduler.now, 0, pump);
        };
        for (const e of y.signals) {
          const sig = scope.signals.get(e.signal);
          if (!sig) continue;
          let prev = sig.value;
          const cb = () => {
            const curr = sig.value;
            const p = prev; prev = curr;
            onFire(e, p, curr);
          };
          sig.subscribers.add(cb);
          subs.push({ sig, cb });
        }
        if (subs.length === 0) {
          // No signals to wait on — drop process
          return;
        }
        return;
      }
    }
  };
  pump();
}

// Continuous-assign style: re-evaluate `expr` and write `target` whenever any RHS signal changes
function bindContinuous(target: LValue, expr: Expr, scope: ScopeData, ctx: SimContext, delay?: number): void {
  const reads = new Set<string>();
  collectReadSignals(expr, reads);
  let version = 0;
  const evalAndWrite = () => {
    const r = evalExpr(expr, scope, ctx);
    const localVersion = ++version;
    const commit = () => {
      if (localVersion === version) writeLValue(target, r.val, r.w, scope, ctx);
    };
    if (delay !== undefined) ctx.scheduler.schedule(ctx.scheduler.now + delay, 0, commit);
    else commit();
  };
  // Also need RHS for index-bearing LValues? We treat target as simple here.
  // Also for indexed LHS like x[i] = y, the i would need to be in the read set too.
  collectLValueReads(target, reads);
  // Initial evaluation
  evalAndWrite();
  // Subscribe — if a sig is later created, this won't pick it up. We bind once.
  for (const sn of reads) {
    const sig = scope.signals.get(sn);
    if (sig) {
      sig.subscribers.add(evalAndWrite);
      continue;
    }
    const mem = scope.memories.get(sn);
    if (mem) mem.subscribers.add(evalAndWrite);
  }
}

function collectLValueReads(lv: LValue, out: Set<string>): void {
  switch (lv.kind) {
    case 'bit': collectReadSignals(lv.idx, out); return;
    case 'memBitSel': collectReadSignals(lv.idx, out); collectReadSignals(lv.bit, out); return;
    case 'memRangeSel': collectReadSignals(lv.idx, out); return;
    case 'concat': lv.parts.forEach(p => collectLValueReads(p, out)); return;
  }
}

function gatePrimitiveExpr(gate: string, inputs: string[]): Expr | null {
  const exprs = inputs.map(input => new Parser(tokenize(input)).parseExpr());
  if (exprs.length === 0) return null;
  const reduce = (op: string) => exprs.slice(1).reduce<Expr>((l, r) => ({ kind: 'binary', op, l, r }), exprs[0]);
  switch (gate) {
    case 'buf': return exprs[0];
    case 'not': return { kind: 'unary', op: '~', arg: exprs[0] };
    case 'and': return reduce('&');
    case 'or': return reduce('|');
    case 'xor': return reduce('^');
    case 'nand': return { kind: 'unary', op: '~', arg: reduce('&') };
    case 'nor': return { kind: 'unary', op: '~', arg: reduce('|') };
    case 'xnor': return { kind: 'unary', op: '~', arg: reduce('^') };
  }
  return null;
}

// Bind an `always @(*)` or always with explicit list
function bindAlways(stmts: Stmt[], sens: Sensitivity | 'auto', scope: ScopeData, ctx: SimContext): void {
  const reads = new Set<string>();
  for (const s of stmts) collectStmtReadSignals(s, reads);

  const isEdgeSensitive = sens !== 'auto' && sens.list.some(e => e.edge === 'posedge' || e.edge === 'negedge');

  if (isEdgeSensitive) {
    // Edge sensitive: model as a process that loops { wait edge; run body }
    const sensList = (sens as Sensitivity).list;
    const make = function* (): Generator<Yield, void, void> {
      yield { type: 'wait', signals: sensList };
      yield* execBlock(stmts, scope, ctx);
    };
    runProcess(make, scope, ctx, /*restartOnFinish=*/true);
    return;
  }

  // Level-sensitive (always @(*) or named list): re-run body whenever any read sig changes
  const fire = () => {
    // Run the whole body synchronously (no delays expected in pure-comb always @(*))
    const gen = execBlock(stmts, scope, ctx);
    while (true) {
      const r = gen.next();
      if (r.done) return;
      // If a comb body has a delay, defer rest — but practically, this shouldn't happen.
      const y = r.value;
      if (y.type === 'delay') {
        ctx.scheduler.schedule(ctx.scheduler.now + y.ns, 0, () => {
          while (!gen.next().done) {/* ignore further yields */}
        });
        return;
      }
      if (y.type === 'wait') return;
    }
  };

  // Determine sources: explicit list if non-'*'; else collected reads
  let sources: string[];
  if (sens !== 'auto' && !sens.any && sens.list.length > 0) {
    sources = sens.list.map(e => e.signal);
  } else {
    sources = Array.from(reads);
  }

  // Initial run
  fire();
  for (const sn of sources) {
    const sig = scope.signals.get(sn);
    if (sig) {
      sig.subscribers.add(fire);
      continue;
    }
    const mem = scope.memories.get(sn);
    if (mem) mem.subscribers.add(fire);
  }
}

// ============================================================
// Module elaboration
// ============================================================

function elaborate(
  modules: VerilogModule[],
  topName: string,
  tbName: string,
  ctx: SimContext,
): void {
  const byName = new Map(modules.map(m => [m.name, m]));

  function makeScope(mod: VerilogModule, path: string): ScopeData {
    const sc: ScopeData = {
      path,
      signals: new Map(),
      memories: new Map(),
      params: new Map(mod.params.map(p => [p.name, p.value])),
      mod,
    };
    // Allocate signals from ports, wires, regs
    const allDecls: { name: string; width: number }[] = [];
    for (const p of mod.ports) allDecls.push({ name: p.name, width: p.width });
    for (const w of mod.wires) allDecls.push({ name: w.name, width: w.width });
    for (const r of mod.regs) allDecls.push({ name: r.name, width: r.width });
    // Memory declarations
    const mems = findMemories(mod.raw);
    const memNames = new Set(mems.map(m => m.name));
    for (const decl of allDecls) {
      if (memNames.has(decl.name)) continue;
      if (sc.signals.has(decl.name)) continue;
      const sig: Signal = {
        name: `${path}.${decl.name}`,
        width: decl.width,
        value: v4X(decl.width),
        subscribers: new Set(),
        trace: [{ time: 0, value: v4X(decl.width) }],
        recordChanges: true,
      };
      sc.signals.set(decl.name, sig);
      ctx.signalsByName.set(sig.name, sig);
    }
    for (const mem of mems) {
      const data: V4[] = Array.from({ length: mem.depth }, () => v4X(mem.width));
      const traces: SignalChange[][] = data.map(value => [{ time: 0, value }]);
      sc.memories.set(mem.name, { name: mem.name, path: `${path}.${mem.name}`, width: mem.width, depth: mem.depth, data, traces, subscribers: new Set() });
    }
    ctx.scopes.push(sc);
    return sc;
  }

  function compileScope(sc: ScopeData): void {
    const mod = sc.mod;
    const timeUnitNs = ctx.moduleTimeUnitNs.get(mod.name) ?? ctx.timeUnitNs;

    // Continuous assigns
    for (const a of mod.assigns) {
      try {
        const exprAst = new Parser(tokenize(a.expression)).parseExpr();
        const target = parseLValue(new Parser(tokenize(a.targetRaw ?? a.target)), sc.params);
        if (!target) throw new Error(`invalid assignment target "${a.targetRaw ?? a.target}"`);
        bindContinuous(target, exprAst, sc, ctx, parseDelayString(a.delay, sc.params, timeUnitNs));
      } catch (err) {
        ctx.errors.push(`assign in ${sc.path}: ${(err as Error).message}`);
      }
    }

    // Gate primitives
    for (const gp of mod.gatePrimitives) {
      try {
        const target = parseLValue(new Parser(tokenize(gp.output)), sc.params);
        const exprAst = gatePrimitiveExpr(gp.gate, gp.inputs);
        if (target && exprAst) bindContinuous(target, exprAst, sc, ctx, parseDelayString(gp.delay, sc.params, timeUnitNs));
      } catch (err) {
        ctx.errors.push(`gate primitive in ${sc.path}: ${(err as Error).message}`);
      }
    }

    // Initial blocks
    for (const ib of mod.initialBlocks) {
      try {
        const stmts = parseStatementsFromString(ib.body, sc.params, timeUnitNs);
        runProcess(() => execBlock(stmts, sc, ctx), sc, ctx, false);
      } catch (err) {
        ctx.errors.push(`initial in ${sc.path}: ${(err as Error).message}`);
      }
    }

    // Always blocks (with @(...) sensitivity)
    for (const ab of mod.alwaysBlocks) {
      try {
        const stmts = parseStatementsFromString(ab.body, sc.params, timeUnitNs);
        const sens = parseSensitivityFromString(ab.sensitivity);
        bindAlways(stmts, sens, sc, ctx);
      } catch (err) {
        ctx.errors.push(`always in ${sc.path}: ${(err as Error).message}`);
      }
    }

    // Always blocks WITHOUT sensitivity (clock generators etc.)
    for (const body of findUnsensitizedAlways(mod.raw)) {
      try {
        const stmts = parseStatementsFromString(body, sc.params, timeUnitNs);
        // Wrap in forever-loop semantics: such a block runs forever, restarting at end
        const make = function* (): Generator<Yield, void, void> {
          yield* execBlock(stmts, sc, ctx);
        };
        runProcess(make, sc, ctx, /*restartOnFinish=*/true);
      } catch (err) {
        ctx.errors.push(`always in ${sc.path}: ${(err as Error).message}`);
      }
    }

    // Submodule instances — recurse
    for (const inst of mod.instances) {
      const sub = byName.get(inst.moduleName);
      if (!sub) continue;
      const subPath = `${sc.path}.${inst.instanceName}`;
      const subScope = makeScope(sub, subPath);
      compileScope(subScope);
      // After child compile, set up bidirectional bindings using a small helper
      bridgeInstance(sc, subScope, inst, sub, ctx);
    }
  }

  const tbMod = byName.get(tbName);
  if (!tbMod) { ctx.errors.push(`Testbench module not found: ${tbName}`); return; }
  if (topName && !byName.has(topName)) ctx.errors.push(`Top module not found: ${topName}`);
  ctx.tbScope = makeScope(tbMod, tbName);
  ctx.topScope = ctx.tbScope;
  compileScope(ctx.tbScope);
  if (topName && topName !== tbName && byName.has(topName) && !ctx.scopes.some(sc => sc.mod.name === topName)) {
    ctx.errors.push(`Top module "${topName}" is not instantiated by testbench "${tbName}"`);
  }
}

function parseSensitivityFromString(s: string): Sensitivity {
  if (!s) return { any: true, list: [] };
  const t = s.trim();
  if (t === '*') return { any: true, list: [] };
  // tokenize & parse a sensitivity list — wrap with "@(...)" for the parser
  const toks = tokenize('(' + t + ')');
  const p = new Parser(toks);
  if (!p.match('op', '(')) return { any: false, list: [] };
  if (p.match('op', '*')) { p.expect('op', ')'); return { any: true, list: [] }; }
  const list: SensEntry[] = [];
  do {
    let edge: 'posedge' | 'negedge' | 'level' = 'level';
    if (p.match('posedge')) edge = 'posedge';
    else if (p.match('negedge')) edge = 'negedge';
    if (!p.check('id')) break;
    const e = p.parseExpr();
    const sn = exprToSignalName(e);
    if (sn) list.push({ signal: sn, edge });
  } while (p.match('op', ',') || p.match('id', 'or'));
  return { any: list.length === 0, list };
}

// ============================================================
// Port bridging between parent and child instance
// ============================================================

function bridgeInstance(
  parent: ScopeData,
  child: ScopeData,
  inst: { moduleName: string; instanceName: string; connections: Record<string, string>; positionalArgs?: string[] },
  childMod: VerilogModule,
  ctx: SimContext,
): void {
  for (let i = 0; i < childMod.ports.length; i++) {
    const port = childMod.ports[i];
    let expr: string | undefined;
    if (inst.positionalArgs) expr = inst.positionalArgs[i];
    else expr = inst.connections[port.name];
    if (!expr) continue;
    try {
      const exprAst = new Parser(tokenize(expr)).parseExpr();
      const childPortLv: LValue = { kind: 'id', name: port.name };
      const parentLv = exprToLValue(expr, parent.params);

      if (port.direction === 'input') {
        // parent expr → child port
        bindCrossScope(parent, child, exprAst, childPortLv, ctx);
      } else if (port.direction === 'output') {
        // child port → parent expr
        const childExprAst: Expr = { kind: 'id', name: port.name };
        if (parentLv) bindCrossScope(child, parent, childExprAst, parentLv, ctx);
      } else {
        // inout — bidirectional, but we approximate as input (parent→child)
        bindCrossScope(parent, child, exprAst, childPortLv, ctx);
      }
    } catch { /* ignore */ }
  }
}

function bindCrossScope(srcScope: ScopeData, dstScope: ScopeData, srcExpr: Expr, dstLv: LValue, ctx: SimContext): void {
  const reads = new Set<string>();
  collectReadSignals(srcExpr, reads);
  collectLValueReads(dstLv, reads); // dst index reads are in dstScope, but typically constant
  const fire = () => {
    const r = evalExpr(srcExpr, srcScope, ctx);
    writeLValue(dstLv, r.val, r.w, dstScope, ctx);
  };
  fire();
  for (const sn of reads) {
    const sig = srcScope.signals.get(sn);
    if (sig) {
      sig.subscribers.add(fire);
      continue;
    }
    const mem = srcScope.memories.get(sn);
    if (mem) mem.subscribers.add(fire);
  }
}

function exprToLValue(src: string, params = new Map<string, number>()): LValue | null {
  try {
    const toks = tokenize(src);
    const p = new Parser(toks);
    return parseLValue(p, params);
  } catch { return null; }
}

// ============================================================
// Public entry point
// ============================================================

export function simulate(
  sources: Record<string, string>,
  topModule: string,
  testbenchModule: string,
  maxTimeNs: number = 2000,
  files: Record<string, string> = {},
): SimulationResult {
  const allModules: VerilogModule[] = [];
  const moduleTimeUnitNs = new Map<string, number>();
  const errors: string[] = [];
  for (const [filename, source] of Object.entries(sources)) {
    const r = parseVerilog(source);
    if (r.errors.length > 0) for (const e of r.errors) errors.push(`${filename}: ${e}`);
    for (const [moduleName, timeUnitNs] of detectModuleTimeUnitNs(source, r.modules)) {
      moduleTimeUnitNs.set(moduleName, timeUnitNs);
    }
    allModules.push(...r.modules);
  }

  const ctx = new SimContext();
  ctx.fileMap = { ...sources, ...files };
  ctx.timeUnitNs = detectTimeUnitNs(sources);
  ctx.moduleTimeUnitNs = moduleTimeUnitNs;
  ctx.scheduler.maxTime = maxTimeNs;
  CURRENT_SCHED = ctx.scheduler;

  try {
    elaborate(allModules, topModule, testbenchModule, ctx);
  } catch (err) {
    if (!(err instanceof FinishSignal)) errors.push(`Elaboration error: ${(err as Error).message}`);
  }

  // Run scheduler
  try {
    ctx.scheduler.run();
  } catch (err) {
    if (!(err instanceof FinishSignal)) errors.push(`Sim error: ${(err as Error).message}`);
  }
  ctx.duration = ctx.scheduler.now;
  CURRENT_SCHED = null;

  // Build output
  const signals: SignalTrace[] = [];
  const signalsByName: Record<string, SignalTrace> = {};
  const signalWidths: Record<string, number> = {};
  for (const sig of ctx.signalsByName.values()) {
    const trace: SignalTrace = {
      name: sig.name,
      width: sig.width,
      isMemory: false,
      changes: sig.trace,
    };
    signals.push(trace);
    signalsByName[sig.name] = trace;
    // Also expose unqualified name for backwards compat (last-write-wins; deeper hierarchies will just shadow)
    const last = sig.name.split('.').pop()!;
    if (!signalsByName[last]) signalsByName[last] = trace;
    signalWidths[sig.name] = sig.width;
    signalWidths[last] = sig.width;
  }
  for (const sc of ctx.scopes) {
    for (const mem of sc.memories.values()) {
      for (let i = 0; i < mem.depth; i++) {
        const name = `${mem.path}[${i}]`;
        const trace: SignalTrace = {
          name,
          width: mem.width,
          isMemory: true,
          changes: mem.traces[i],
        };
        signals.push(trace);
        signalsByName[name] = trace;
        signalWidths[name] = mem.width;
      }
    }
  }
  signals.sort((a, b) => a.name.localeCompare(b.name));

  return {
    signals,
    signalsByName,
    duration: ctx.duration,
    timeUnitNs: 1,
    errors: [...errors, ...ctx.errors],
    logs: ctx.logs,
    signalWidths,
  };
}
