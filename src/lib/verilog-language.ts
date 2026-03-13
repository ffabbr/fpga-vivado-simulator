// Monaco editor Verilog language definition

export const verilogLanguageConfig = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/'] as [string, string],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ] as [string, string][],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
  folding: {
    markers: {
      start: /^\s*\/\/\s*#?region\b/,
      end: /^\s*\/\/\s*#?endregion\b/,
    },
  },
};

export const verilogTokensProvider = {
  defaultToken: '',
  tokenPostfix: '.v',

  keywords: [
    'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'integer',
    'real', 'time', 'realtime', 'parameter', 'localparam', 'assign', 'always',
    'initial', 'begin', 'end', 'if', 'else', 'case', 'casez', 'casex', 'endcase',
    'default', 'for', 'while', 'repeat', 'forever', 'fork', 'join', 'task',
    'endtask', 'function', 'endfunction', 'generate', 'endgenerate', 'genvar',
    'posedge', 'negedge', 'or', 'and', 'nand', 'nor', 'xor', 'xnor', 'not',
    'buf', 'bufif0', 'bufif1', 'notif0', 'notif1', 'pullup', 'pulldown',
    'supply0', 'supply1', 'tri', 'triand', 'trior', 'tri0', 'tri1', 'wand',
    'wor', 'defparam', 'specify', 'endspecify', 'primitive', 'endprimitive',
    'table', 'endtable', 'macromodule', 'disable', 'wait', 'force', 'release',
    'signed', 'unsigned',
  ],

  systemTasks: [
    '$display', '$write', '$monitor', '$finish', '$stop', '$time', '$realtime',
    '$random', '$readmemh', '$readmemb', '$dumpfile', '$dumpvars', '$fopen',
    '$fclose', '$fwrite', '$fread', '$fscanf', '$feof', '$sformat', '$signed',
    '$unsigned', '$clog2',
  ],

  operators: [
    '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||',
    '++', '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '>>>',
    '===', '!==', '~&', '~|', '~^', '^~',
  ],

  symbols: /[=><!~?:&|+\-*/^%]+/,

  tokenizer: {
    root: [
      // Compiler directives
      [/`\w+/, 'keyword.directive'],

      // System tasks
      [/\$\w+/, 'keyword.system'],

      // Identifiers and keywords
      [/[a-zA-Z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'identifier',
        },
      }],

      // Whitespace
      { include: '@whitespace' },

      // Numbers
      [/\d+'[bBoOdDhH][0-9a-fA-F_xXzZ]+/, 'number.sized'],
      [/'[bBoOdDhH][0-9a-fA-F_xXzZ]+/, 'number.sized'],
      [/\d+\.\d+/, 'number.float'],
      [/\d+/, 'number'],

      // Strings
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string', '@string'],

      // Delimiters
      [/[{}()[\]]/, '@brackets'],
      [/[;,.]/, 'delimiter'],

      // Operators
      [/@symbols/, {
        cases: {
          '@operators': 'operator',
          '@default': '',
        },
      }],
    ],

    whitespace: [
      [/[ \t\r\n]+/, 'white'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
    ],

    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],

    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
  },
};

export const verilogDarkTheme = {
  base: 'vs-dark' as const,
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '569cd6', fontStyle: 'bold' },
    { token: 'keyword.directive', foreground: 'c586c0' },
    { token: 'keyword.system', foreground: 'dcdcaa' },
    { token: 'comment', foreground: '6a9955' },
    { token: 'string', foreground: 'ce9178' },
    { token: 'number', foreground: 'b5cea8' },
    { token: 'number.sized', foreground: 'b5cea8' },
    { token: 'number.float', foreground: 'b5cea8' },
    { token: 'operator', foreground: 'd4d4d4' },
    { token: 'identifier', foreground: '9cdcfe' },
    { token: 'delimiter', foreground: 'd4d4d4' },
  ],
  colors: {
    'editor.background': '#09090b',
    'editor.foreground': '#d4d4d4',
    'editorLineNumber.foreground': '#858585',
    'editorCursor.foreground': '#aeafad',
    'editor.selectionBackground': '#264f78',
    'editor.lineHighlightBackground': '#18181b',
  },
};

export const verilogLightTheme = {
  base: 'vs' as const,
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '0000ff', fontStyle: 'bold' },
    { token: 'keyword.directive', foreground: 'af00db' },
    { token: 'keyword.system', foreground: '795e26' },
    { token: 'comment', foreground: '008000' },
    { token: 'string', foreground: 'a31515' },
    { token: 'number', foreground: '098658' },
    { token: 'number.sized', foreground: '098658' },
    { token: 'number.float', foreground: '098658' },
    { token: 'operator', foreground: '000000' },
    { token: 'identifier', foreground: '001080' },
    { token: 'delimiter', foreground: '000000' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#000000',
    'editorLineNumber.foreground': '#999999',
    'editorCursor.foreground': '#000000',
    'editor.selectionBackground': '#add6ff',
    'editor.lineHighlightBackground': '#f5f5f5',
  },
};
