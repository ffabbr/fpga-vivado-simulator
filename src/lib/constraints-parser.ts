// XDC Constraints Parser for Basys 3
// Maps Verilog ports to physical FPGA pins

export interface PinConstraint {
  port: string;
  pin: string;
  ioStandard: string;
}

export interface ClockConstraint {
  port: string;
  periodNs: number;
  dutyCycle: number;
}

export interface ConstraintSet {
  pins: PinConstraint[];
  clocks: ClockConstraint[];
  errors: string[];
}

export function parseXDC(source: string): ConstraintSet {
  const pins: PinConstraint[] = [];
  const clocks: ClockConstraint[] = [];
  const errors: string[] = [];

  const lines = source.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // set_property PACKAGE_PIN V17 [get_ports {sw[0]}]
    const pinMatch = line.match(/set_property\s+PACKAGE_PIN\s+(\w+)\s+\[get_ports\s+\{?(\w+(?:\[\d+\])?)\}?\]/i);
    if (pinMatch) {
      pins.push({ port: pinMatch[2], pin: pinMatch[1], ioStandard: 'LVCMOS33' });
      continue;
    }

    // set_property IOSTANDARD LVCMOS33 [get_ports {sw[0]}]
    const ioMatch = line.match(/set_property\s+IOSTANDARD\s+(\w+)\s+\[get_ports\s+\{?(\w+(?:\[\d+\])?)\}?\]/i);
    if (ioMatch) {
      const existing = pins.find(p => p.port === ioMatch[2]);
      if (existing) existing.ioStandard = ioMatch[1];
      continue;
    }

    // create_clock -add -name sys_clk_pin -period 10.00 -waveform {0 5} [get_ports clk]
    const clkMatch = line.match(/create_clock.*-period\s+([\d.]+).*\[get_ports\s+\{?(\w+)\}?\]/i);
    if (clkMatch) {
      const period = parseFloat(clkMatch[1]);
      clocks.push({ port: clkMatch[2], periodNs: period, dutyCycle: 50 });
      continue;
    }
  }

  return { pins, clocks, errors };
}

// ─── Basys 3 pin → board signal mapping ───
// Built from the official Basys 3 master XDC: each PACKAGE_PIN maps to a
// board-level signal (sw, led, seg, dp, an, btnC, …) at a specific bit index.

interface BoardSignalBit {
  signal: string; // e.g. "sw", "led", "seg", "an", "dp", "btnC"
  bit: number;    // bit index within the signal (0 for scalar signals)
}

const BASYS3_PIN_MAP: Record<string, BoardSignalBit> = {
  // Switches
  V17: { signal: 'sw', bit: 0 },  V16: { signal: 'sw', bit: 1 },
  W16: { signal: 'sw', bit: 2 },  W17: { signal: 'sw', bit: 3 },
  W15: { signal: 'sw', bit: 4 },  V15: { signal: 'sw', bit: 5 },
  W14: { signal: 'sw', bit: 6 },  W13: { signal: 'sw', bit: 7 },
  V2:  { signal: 'sw', bit: 8 },  T3:  { signal: 'sw', bit: 9 },
  T2:  { signal: 'sw', bit: 10 }, R3:  { signal: 'sw', bit: 11 },
  W2:  { signal: 'sw', bit: 12 }, U1:  { signal: 'sw', bit: 13 },
  T1:  { signal: 'sw', bit: 14 }, R2:  { signal: 'sw', bit: 15 },
  // LEDs
  U16: { signal: 'led', bit: 0 },  E19: { signal: 'led', bit: 1 },
  U19: { signal: 'led', bit: 2 },  V19: { signal: 'led', bit: 3 },
  W18: { signal: 'led', bit: 4 },  U15: { signal: 'led', bit: 5 },
  U14: { signal: 'led', bit: 6 },  V14: { signal: 'led', bit: 7 },
  V13: { signal: 'led', bit: 8 },  V3:  { signal: 'led', bit: 9 },
  W3:  { signal: 'led', bit: 10 }, U3:  { signal: 'led', bit: 11 },
  P3:  { signal: 'led', bit: 12 }, N3:  { signal: 'led', bit: 13 },
  P1:  { signal: 'led', bit: 14 }, L1:  { signal: 'led', bit: 15 },
  // 7-segment
  W7:  { signal: 'seg', bit: 0 },  W6:  { signal: 'seg', bit: 1 },
  U8:  { signal: 'seg', bit: 2 },  V8:  { signal: 'seg', bit: 3 },
  U5:  { signal: 'seg', bit: 4 },  V5:  { signal: 'seg', bit: 5 },
  U7:  { signal: 'seg', bit: 6 },
  V7:  { signal: 'dp', bit: 0 },
  // Anodes
  U2:  { signal: 'an', bit: 0 },  U4:  { signal: 'an', bit: 1 },
  V4:  { signal: 'an', bit: 2 },  W4:  { signal: 'an', bit: 3 },
  // Buttons
  U18: { signal: 'btnC', bit: 0 }, T18: { signal: 'btnU', bit: 0 },
  W19: { signal: 'btnL', bit: 0 }, T17: { signal: 'btnR', bit: 0 },
  U17: { signal: 'btnD', bit: 0 },
  // Clock
  W5:  { signal: 'clk', bit: 0 },
};

/**
 * Parse a port spec like "a[2]" or "btnC" into { name, bit }.
 */
function parsePortSpec(port: string): { name: string; bit: number } {
  const m = port.match(/^(\w+)\[(\d+)\]$/);
  if (m) return { name: m[1], bit: parseInt(m[2], 10) };
  return { name: port, bit: 0 };
}

/**
 * Bit-level mapping entry: one bit of a user port ↔ one bit of a board signal.
 */
export interface BitMapping {
  boardSignal: string; // "sw", "led", "seg", etc.
  boardBit: number;
  userPort: string;    // "a", "s", etc.
  userBit: number;
}

/**
 * Given a user XDC source, builds the mapping between board signals and user ports.
 * Uses PACKAGE_PIN assignments to look up which Basys 3 board signal each user port
 * bit corresponds to.
 *
 * If the user XDC maps ports with the standard names (sw, led, …) this is an identity
 * mapping and the board works as before. If the user maps custom names (a, b, s, co),
 * the mapping translates between them.
 */
export function buildBoardMapping(userXDC: string): BitMapping[] {
  const userConstraints = parseXDC(userXDC);
  const mappings: BitMapping[] = [];

  for (const pinC of userConstraints.pins) {
    const boardSig = BASYS3_PIN_MAP[pinC.pin];
    if (!boardSig) continue; // unknown pin — skip

    const { name, bit } = parsePortSpec(pinC.port);
    mappings.push({
      boardSignal: boardSig.signal,
      boardBit: boardSig.bit,
      userPort: name,
      userBit: bit,
    });
  }

  return mappings;
}

/**
 * Convert board-level inputs (sw bitmask, button booleans, etc.) to user port values
 * using the constraint mapping.
 */
export function boardInputsToUserPorts(
  boardInputs: Record<string, number>,
  mappings: BitMapping[],
): Record<string, number> {
  // Board input signals: sw, clk, btnC, btnU, btnD, btnL, btnR
  const BOARD_INPUT_SIGNALS = new Set(['sw', 'clk', 'btnC', 'btnU', 'btnD', 'btnL', 'btnR']);
  const result: Record<string, number> = {};

  for (const m of mappings) {
    if (!BOARD_INPUT_SIGNALS.has(m.boardSignal)) continue;
    const boardVal = boardInputs[m.boardSignal] ?? 0;
    const bitVal = (boardVal >> m.boardBit) & 1;
    result[m.userPort] = (result[m.userPort] ?? 0) | (bitVal << m.userBit);
  }

  return result;
}

/**
 * Convert user port output values to board-level outputs (led, seg, dp, an bitmasks)
 * using the constraint mapping.
 */
export function userOutputsToBoardOutputs(
  userOutputs: Record<string, number>,
  mappings: BitMapping[],
): Record<string, number> {
  const BOARD_INPUT_SIGNALS = new Set(['sw', 'clk', 'btnC', 'btnU', 'btnD', 'btnL', 'btnR']);
  const result: Record<string, number> = {};

  for (const m of mappings) {
    if (BOARD_INPUT_SIGNALS.has(m.boardSignal)) continue; // skip input signals
    const userVal = userOutputs[m.userPort] ?? 0;
    const bitVal = (userVal >> m.userBit) & 1;
    result[m.boardSignal] = (result[m.boardSignal] ?? 0) | (bitVal << m.boardBit);
  }

  return result;
}

// Default Basys 3 XDC template
export const BASYS3_XDC_TEMPLATE = `## Basys 3 Rev B Master XDC File

## Clock signal
set_property PACKAGE_PIN W5 [get_ports clk]
set_property IOSTANDARD LVCMOS33 [get_ports clk]
create_clock -add -name sys_clk_pin -period 10.00 -waveform {0 5} [get_ports clk]

## Switches
set_property PACKAGE_PIN V17 [get_ports {sw[0]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[0]}]
set_property PACKAGE_PIN V16 [get_ports {sw[1]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[1]}]
set_property PACKAGE_PIN W16 [get_ports {sw[2]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[2]}]
set_property PACKAGE_PIN W17 [get_ports {sw[3]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[3]}]
set_property PACKAGE_PIN W15 [get_ports {sw[4]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[4]}]
set_property PACKAGE_PIN V15 [get_ports {sw[5]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[5]}]
set_property PACKAGE_PIN W14 [get_ports {sw[6]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[6]}]
set_property PACKAGE_PIN W13 [get_ports {sw[7]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[7]}]
set_property PACKAGE_PIN V2 [get_ports {sw[8]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[8]}]
set_property PACKAGE_PIN T3 [get_ports {sw[9]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[9]}]
set_property PACKAGE_PIN T2 [get_ports {sw[10]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[10]}]
set_property PACKAGE_PIN R3 [get_ports {sw[11]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[11]}]
set_property PACKAGE_PIN W2 [get_ports {sw[12]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[12]}]
set_property PACKAGE_PIN U1 [get_ports {sw[13]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[13]}]
set_property PACKAGE_PIN T1 [get_ports {sw[14]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[14]}]
set_property PACKAGE_PIN R2 [get_ports {sw[15]}]
set_property IOSTANDARD LVCMOS33 [get_ports {sw[15]}]

## LEDs
set_property PACKAGE_PIN U16 [get_ports {led[0]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[0]}]
set_property PACKAGE_PIN E19 [get_ports {led[1]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[1]}]
set_property PACKAGE_PIN U19 [get_ports {led[2]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[2]}]
set_property PACKAGE_PIN V19 [get_ports {led[3]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[3]}]
set_property PACKAGE_PIN W18 [get_ports {led[4]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[4]}]
set_property PACKAGE_PIN U15 [get_ports {led[5]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[5]}]
set_property PACKAGE_PIN U14 [get_ports {led[6]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[6]}]
set_property PACKAGE_PIN V14 [get_ports {led[7]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[7]}]
set_property PACKAGE_PIN V13 [get_ports {led[8]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[8]}]
set_property PACKAGE_PIN V3 [get_ports {led[9]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[9]}]
set_property PACKAGE_PIN W3 [get_ports {led[10]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[10]}]
set_property PACKAGE_PIN U3 [get_ports {led[11]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[11]}]
set_property PACKAGE_PIN P3 [get_ports {led[12]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[12]}]
set_property PACKAGE_PIN N3 [get_ports {led[13]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[13]}]
set_property PACKAGE_PIN P1 [get_ports {led[14]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[14]}]
set_property PACKAGE_PIN L1 [get_ports {led[15]}]
set_property IOSTANDARD LVCMOS33 [get_ports {led[15]}]

## 7 segment display
set_property PACKAGE_PIN W7 [get_ports {seg[0]}]
set_property IOSTANDARD LVCMOS33 [get_ports {seg[0]}]
set_property PACKAGE_PIN W6 [get_ports {seg[1]}]
set_property IOSTANDARD LVCMOS33 [get_ports {seg[1]}]
set_property PACKAGE_PIN U8 [get_ports {seg[2]}]
set_property IOSTANDARD LVCMOS33 [get_ports {seg[2]}]
set_property PACKAGE_PIN V8 [get_ports {seg[3]}]
set_property IOSTANDARD LVCMOS33 [get_ports {seg[3]}]
set_property PACKAGE_PIN U5 [get_ports {seg[4]}]
set_property IOSTANDARD LVCMOS33 [get_ports {seg[4]}]
set_property PACKAGE_PIN V5 [get_ports {seg[5]}]
set_property IOSTANDARD LVCMOS33 [get_ports {seg[5]}]
set_property PACKAGE_PIN U7 [get_ports {seg[6]}]
set_property IOSTANDARD LVCMOS33 [get_ports {seg[6]}]
set_property PACKAGE_PIN V7 [get_ports {dp}]
set_property IOSTANDARD LVCMOS33 [get_ports {dp}]
set_property PACKAGE_PIN U2 [get_ports {an[0]}]
set_property IOSTANDARD LVCMOS33 [get_ports {an[0]}]
set_property PACKAGE_PIN U4 [get_ports {an[1]}]
set_property IOSTANDARD LVCMOS33 [get_ports {an[1]}]
set_property PACKAGE_PIN V4 [get_ports {an[2]}]
set_property IOSTANDARD LVCMOS33 [get_ports {an[2]}]
set_property PACKAGE_PIN W4 [get_ports {an[3]}]
set_property IOSTANDARD LVCMOS33 [get_ports {an[3]}]

## Buttons
set_property PACKAGE_PIN U18 [get_ports btnC]
set_property IOSTANDARD LVCMOS33 [get_ports btnC]
set_property PACKAGE_PIN T18 [get_ports btnU]
set_property IOSTANDARD LVCMOS33 [get_ports btnU]
set_property PACKAGE_PIN W19 [get_ports btnL]
set_property IOSTANDARD LVCMOS33 [get_ports btnL]
set_property PACKAGE_PIN T17 [get_ports btnR]
set_property IOSTANDARD LVCMOS33 [get_ports btnR]
set_property PACKAGE_PIN U17 [get_ports btnD]
set_property IOSTANDARD LVCMOS33 [get_ports btnD]
`;
