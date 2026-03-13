// Global state management using React context + useReducer pattern
// Virtual file system for the project

export interface ProjectFile {
  id: string;
  name: string;
  path: string;
  content: string;
  type: 'verilog' | 'testbench' | 'constraints' | 'memory' | 'other';
  isModified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConsoleMessage {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success' | 'log';
  message: string;
  timestamp: number;
  source?: string;
}

export interface ProjectState {
  name: string;
  files: ProjectFile[];
  activeFileId: string | null;
  openFileIds: string[];
  consoleMessages: ConsoleMessage[];
  topModule: string | null;
  targetDevice: string;
}

export type ProjectAction =
  | { type: 'SET_PROJECT_NAME'; name: string }
  | { type: 'ADD_FILE'; file: ProjectFile }
  | { type: 'UPDATE_FILE'; id: string; content: string }
  | { type: 'RENAME_FILE'; id: string; name: string }
  | { type: 'DELETE_FILE'; id: string }
  | { type: 'SET_ACTIVE_FILE'; id: string }
  | { type: 'OPEN_FILE'; id: string }
  | { type: 'CLOSE_FILE'; id: string }
  | { type: 'MARK_SAVED'; id: string }
  | { type: 'ADD_CONSOLE_MESSAGE'; message: ConsoleMessage }
  | { type: 'CLEAR_CONSOLE' }
  | { type: 'SET_TOP_MODULE'; name: string }
  | { type: 'LOAD_PROJECT'; state: ProjectState };

let nextId = 1;
export function generateId(): string {
  return `file_${Date.now()}_${nextId++}`;
}

export function generateMsgId(): string {
  return `msg_${Date.now()}_${nextId++}`;
}

export function createFile(
  name: string,
  content: string,
  type: ProjectFile['type']
): ProjectFile {
  const id = generateId();
  return {
    id,
    name,
    path: `/${name}`,
    content,
    type,
    isModified: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function projectReducer(state: ProjectState, action: ProjectAction): ProjectState {
  switch (action.type) {
    case 'SET_PROJECT_NAME':
      return { ...state, name: action.name };

    case 'ADD_FILE': {
      const files = [...state.files, action.file];
      return {
        ...state,
        files,
        activeFileId: action.file.id,
        openFileIds: [...state.openFileIds, action.file.id],
      };
    }

    case 'UPDATE_FILE':
      return {
        ...state,
        files: state.files.map(f =>
          f.id === action.id
            ? { ...f, content: action.content, isModified: true, updatedAt: Date.now() }
            : f
        ),
      };

    case 'RENAME_FILE':
      return {
        ...state,
        files: state.files.map(f =>
          f.id === action.id
            ? { ...f, name: action.name, path: `/${action.name}`, updatedAt: Date.now() }
            : f
        ),
      };

    case 'DELETE_FILE': {
      const files = state.files.filter(f => f.id !== action.id);
      const openFileIds = state.openFileIds.filter(id => id !== action.id);
      let activeFileId = state.activeFileId;
      if (activeFileId === action.id) {
        activeFileId = openFileIds[openFileIds.length - 1] || null;
      }
      return { ...state, files, openFileIds, activeFileId };
    }

    case 'SET_ACTIVE_FILE':
      return { ...state, activeFileId: action.id };

    case 'OPEN_FILE':
      return {
        ...state,
        activeFileId: action.id,
        openFileIds: state.openFileIds.includes(action.id)
          ? state.openFileIds
          : [...state.openFileIds, action.id],
      };

    case 'CLOSE_FILE': {
      const openFileIds = state.openFileIds.filter(id => id !== action.id);
      let activeFileId = state.activeFileId;
      if (activeFileId === action.id) {
        const idx = state.openFileIds.indexOf(action.id);
        activeFileId = openFileIds[Math.min(idx, openFileIds.length - 1)] || null;
      }
      return { ...state, openFileIds, activeFileId };
    }

    case 'MARK_SAVED':
      return {
        ...state,
        files: state.files.map(f =>
          f.id === action.id ? { ...f, isModified: false } : f
        ),
      };

    case 'ADD_CONSOLE_MESSAGE':
      return {
        ...state,
        consoleMessages: [...state.consoleMessages, action.message],
      };

    case 'CLEAR_CONSOLE':
      return { ...state, consoleMessages: [] };

    case 'SET_TOP_MODULE':
      return { ...state, topModule: action.name };

    case 'LOAD_PROJECT':
      return action.state;

    default:
      return state;
  }
}

// Default project with example files
export function createDefaultProject(): ProjectState {
  const designFile = createFile('top.v', `module top(
    input [15:0] sw,
    input btnC,
    input btnU,
    input btnD,
    input btnL,
    input btnR,
    input clk,
    output [15:0] led,
    output [6:0] seg,
    output dp,
    output [3:0] an
);

    // 2-bit full adder
    // sw[1:0] = A, sw[3:2] = B, sw[4] = Cin
    wire [1:0] A, B;
    wire Cin;
    wire [1:0] Sum;
    wire Cout;

    assign A = sw[1:0];
    assign B = sw[3:2];
    assign Cin = sw[4];

    // Intermediate carry
    wire C1;

    // Bit 0: full adder
    assign Sum[0] = A[0] ^ B[0] ^ Cin;
    assign C1 = (A[0] & B[0]) | (A[0] & Cin) | (B[0] & Cin);

    // Bit 1: full adder
    assign Sum[1] = A[1] ^ B[1] ^ C1;
    assign Cout = (A[1] & B[1]) | (A[1] & C1) | (B[1] & C1);

    // Display result on LEDs: led[1:0] = Sum, led[2] = Cout
    assign led = {13'b0, Cout, Sum};

    // 7-segment: show result (0-7)
    reg [6:0] seg_out;
    wire [2:0] result;
    assign result = {Cout, Sum};

    assign an = 4'b1110; // Enable rightmost digit only
    assign seg = seg_out;
    assign dp = 1'b1;    // Decimal point off

    always @(*) begin
        case (result)
            3'd0: seg_out = 7'b0000001;
            3'd1: seg_out = 7'b1001111;
            3'd2: seg_out = 7'b0010010;
            3'd3: seg_out = 7'b0000110;
            3'd4: seg_out = 7'b1001100;
            3'd5: seg_out = 7'b0100100;
            3'd6: seg_out = 7'b0100000;
            3'd7: seg_out = 7'b0001111;
            default: seg_out = 7'b1111111;
        endcase
    end

endmodule`, 'verilog');

  const testbenchFile = createFile('top_tb.v', `\`timescale 1ns / 1ps

module top_tb;
    reg [15:0] sw;
    reg btnC, btnU, btnD, btnL, btnR;
    reg clk;
    wire [15:0] led;
    wire [6:0] seg;
    wire dp;
    wire [3:0] an;

    // Instantiate the Unit Under Test (UUT)
    top uut (
        .sw(sw),
        .btnC(btnC),
        .btnU(btnU),
        .btnD(btnD),
        .btnL(btnL),
        .btnR(btnR),
        .clk(clk),
        .led(led),
        .seg(seg),
        .dp(dp),
        .an(an)
    );

    // Clock generation
    always #5 clk = ~clk;

    initial begin
        // Initialize inputs
        sw = 0;
        btnC = 0;
        btnU = 0;
        btnD = 0;
        btnL = 0;
        btnR = 0;
        clk = 0;

        // Wait for global reset
        #100;

        // Test all input combinations for 2-bit full adder
        // A=sw[1:0], B=sw[3:2], Cin=sw[4]

        // 0 + 0 + 0 = 0
        sw = 16'b0000000000_00_00_0;
        #100;

        // 1 + 1 + 0 = 2 (Sum=10, Cout=0)
        sw = 16'b0000000000_01_01_0;
        #100;

        // 3 + 1 + 0 = 4 (Sum=00, Cout=1)
        sw = 16'b0000000000_01_11_0;
        #100;

        // 3 + 3 + 0 = 6 (Sum=10, Cout=1)
        sw = 16'b0000000000_11_11_0;
        #100;

        // 3 + 3 + 1 = 7 (Sum=11, Cout=1)
        sw = 16'b0000000000_11_11_1;
        #100;

        // 2 + 1 + 1 = 4 (Sum=00, Cout=1)
        sw = 16'b0000000000_01_10_1;
        #100;

        $display("Simulation complete");
        $finish;
    end

endmodule`, 'testbench');

  const constraintsFile = createFile('Basys3_Master.xdc', `## Basys 3 Constraints File

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
`, 'constraints');

  return {
    name: 'FPGA Project',
    files: [designFile, testbenchFile, constraintsFile],
    activeFileId: designFile.id,
    openFileIds: [designFile.id, testbenchFile.id],
    consoleMessages: [],
    topModule: 'top',
    targetDevice: 'xc7a35tcpg236-1',
  };
}

// Save/load to localStorage
const STORAGE_KEY = 'fpga-vivado-project';

export function saveProject(state: ProjectState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save project:', e);
  }
}

export function loadProject(): ProjectState | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (data) return JSON.parse(data);
  } catch (e) {
    console.error('Failed to load project:', e);
  }
  return null;
}
