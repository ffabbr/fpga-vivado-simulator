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
      // Prevent duplicate filenames — deduplicate by appending _N suffix
      let finalName = action.file.name;
      const existingNames = new Set(state.files.map(f => f.name));
      if (existingNames.has(finalName)) {
        const ext = finalName.lastIndexOf('.');
        const base = ext > 0 ? finalName.slice(0, ext) : finalName;
        const extension = ext > 0 ? finalName.slice(ext) : '';
        let n = 1;
        while (existingNames.has(`${base}_${n}${extension}`)) n++;
        finalName = `${base}_${n}${extension}`;
      }
      const file = finalName !== action.file.name
        ? { ...action.file, name: finalName, path: `/${finalName}` }
        : action.file;
      const files = [...state.files, file];
      return {
        ...state,
        files,
        activeFileId: file.id,
        openFileIds: [...state.openFileIds, file.id],
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

    case 'RENAME_FILE': {
      // Prevent duplicate filenames on rename
      const nameExists = state.files.some(f => f.id !== action.id && f.name === action.name);
      if (nameExists) return state;
      return {
        ...state,
        files: state.files.map(f =>
          f.id === action.id
            ? { ...f, name: action.name, path: `/${action.name}`, updatedAt: Date.now() }
            : f
        ),
      };
    }

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

// Empty project (used for new projects and first visit)
export function createEmptyProject(): ProjectState {
  return {
    name: 'FPGA Project',
    files: [],
    activeFileId: null,
    openFileIds: [],
    consoleMessages: [],
    topModule: null,
    targetDevice: 'xc7a35tcpg236-1',
  };
}

// Example project with sample files
export function createDefaultProject(): ProjectState {
  const fullAdderFile = createFile('FullAdder.v', `\`timescale 1ns / 1ps

module FullAdder(
    input  a,
    input  b,
    input  ci,
    output s,
    output co
);

    wire w1, w2, w3;

    xor g1(w1, a, b);
    xor g2(s, w1, ci);

    and g3(w2, a, b);
    and g4(w3, w1, ci);
    or  g5(co, w2, w3);

endmodule`, 'verilog');

  const fourBitAdderFile = createFile('FourBitAdder.v', `\`timescale 1ns / 1ps

module FourBitAdder(input[3:0] a, input[3:0] b, output[4:0] s );

    wire [2:0] cobus;
    FullAdder adder_0 (a[0], b[0], 0, s[0], cobus[0]);
    FullAdder adder_1 (a[1], b[1], cobus[0], s[1], cobus[1]);
    FullAdder adder_2 (a[2], b[2], cobus[1], s[2], cobus[2]);
    FullAdder adder_3 (a[3], b[3], cobus[2], s[3], s[4]);


endmodule`, 'verilog');

  const constraintsFile = createFile('Basys3_Master.xdc', `set_property PACKAGE_PIN V17 [get_ports {a[0]}]
set_property PACKAGE_PIN V16 [get_ports {a[1]}]
set_property PACKAGE_PIN W16 [get_ports {a[2]}]
set_property PACKAGE_PIN W17 [get_ports {a[3]}]
set_property PACKAGE_PIN W15 [get_ports {b[0]}]
set_property PACKAGE_PIN V15 [get_ports {b[1]}]
set_property PACKAGE_PIN W14 [get_ports {b[2]}]
set_property PACKAGE_PIN W13 [get_ports {b[3]}]
set_property PACKAGE_PIN U16 [get_ports {s[0]}]
set_property PACKAGE_PIN E19 [get_ports {s[1]}]
set_property PACKAGE_PIN U19 [get_ports {s[2]}]
set_property PACKAGE_PIN V19 [get_ports {s[3]}]
set_property PACKAGE_PIN W18 [get_ports {s[4]}]
set_property IOSTANDARD LVCMOS33 [get_ports {a b s}]`, 'constraints');

  return {
    name: 'FPGA Project',
    files: [fullAdderFile, fourBitAdderFile, constraintsFile],
    activeFileId: fourBitAdderFile.id,
    openFileIds: [fullAdderFile.id, fourBitAdderFile.id],
    consoleMessages: [],
    topModule: 'FourBitAdder',
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
