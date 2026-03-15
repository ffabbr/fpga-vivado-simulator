'use client';

import { useRef, useCallback, useEffect, useState } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { verilogLanguageConfig, verilogTokensProvider, verilogDarkTheme, verilogLightTheme } from '@/lib/verilog-language';
import type * as Monaco from 'monaco-editor';

declare global {
  interface Window {
    __fpgaActiveEditor?: Monaco.editor.IStandaloneCodeEditor;
  }
}

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
  readOnly?: boolean;
}

export default function CodeEditor({ value, onChange, language, readOnly = false }: CodeEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [isDark, setIsDark] = useState(true);

  // Watch for theme changes on <html> class
  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
    const observer = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains('dark');
      setIsDark(dark);
      if (monacoRef.current) {
        monacoRef.current.editor.setTheme(dark ? 'vivado-dark' : 'vivado-light');
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    window.__fpgaActiveEditor = editor;

    editor.onDidFocusEditorText(() => {
      window.__fpgaActiveEditor = editor;
    });

    editor.onDidDispose(() => {
      if (window.__fpgaActiveEditor === editor) {
        delete window.__fpgaActiveEditor;
      }
    });

    // Register Verilog language
    if (!monaco.languages.getLanguages().some((l: { id: string }) => l.id === 'verilog')) {
      monaco.languages.register({ id: 'verilog', extensions: ['.v', '.sv', '.vh'] });
      monaco.languages.setMonarchTokensProvider('verilog', verilogTokensProvider as Monaco.languages.IMonarchLanguage);
      monaco.languages.setLanguageConfiguration('verilog', verilogLanguageConfig as Monaco.languages.LanguageConfiguration);
    }

    // Register XDC language
    if (!monaco.languages.getLanguages().some((l: { id: string }) => l.id === 'xdc')) {
      monaco.languages.register({ id: 'xdc', extensions: ['.xdc'] });
      monaco.languages.setMonarchTokensProvider('xdc', {
        tokenizer: {
          root: [
            [/#.*$/, 'comment'],
            [/set_property|get_ports|get_pins|create_clock/, 'keyword'],
            [/PACKAGE_PIN|IOSTANDARD|LVCMOS33|LVCMOS18/, 'type'],
            [/\{[^}]*\}/, 'string'],
            [/\[[^\]]*\]/, 'tag'],
            [/[A-Z]\d+/, 'number'],
            [/-\w+/, 'attribute'],
            [/[\d.]+/, 'number'],
          ],
        },
      } as Monaco.languages.IMonarchLanguage);
    }

    // Define both themes
    monaco.editor.defineTheme('vivado-dark', verilogDarkTheme);
    monaco.editor.defineTheme('vivado-light', verilogLightTheme);

    // Set theme based on current mode
    const dark = document.documentElement.classList.contains('dark');
    monaco.editor.setTheme(dark ? 'vivado-dark' : 'vivado-light');

    // Verilog completions
    monaco.languages.registerCompletionItemProvider('verilog', {
      provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const suggestions: Monaco.languages.CompletionItem[] = [
          {
            label: 'module',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'module ${1:name}(\n\t${2:ports}\n);\n\t${0}\nendmodule',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Module declaration',
            range,
          },
          {
            label: 'always_comb',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'always @(*) begin\n\t${0}\nend',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Combinational always block',
            range,
          },
          {
            label: 'always_ff',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'always @(posedge ${1:clk}) begin\n\t${0}\nend',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Sequential always block',
            range,
          },
          {
            label: 'always_ff_reset',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'always @(posedge ${1:clk} or posedge ${2:reset}) begin\n\tif (${2:reset}) begin\n\t\t${3}\n\tend else begin\n\t\t${0}\n\tend\nend',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Sequential always block with async reset',
            range,
          },
          {
            label: 'testbench',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: '`timescale 1ns / 1ps\n\nmodule ${1:tb_name};\n\t// Inputs\n\treg ${2:clk};\n\n\t// Outputs\n\twire ${3:out};\n\n\t// Instantiate UUT\n\t${4:module_name} uut (\n\t\t.${2:clk}(${2:clk})\n\t);\n\n\t// Clock generation\n\talways #5 ${2:clk} = ~${2:clk};\n\n\tinitial begin\n\t\t${2:clk} = 0;\n\t\t#100;\n\t\t${0}\n\t\t$$finish;\n\tend\n\nendmodule',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Testbench template',
            range,
          },
          {
            label: 'case',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'case (${1:expr})\n\t${2:value}: ${3:statement};\n\tdefault: ${0:statement};\nendcase',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Case statement',
            range,
          },
          {
            label: 'if_else',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'if (${1:condition}) begin\n\t${2}\nend else begin\n\t${0}\nend',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'If-else block',
            range,
          },
          {
            label: 'assign',
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: 'assign ${1:target} = ${0:expression};',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Continuous assignment',
            range,
          },
          ...[
            'input', 'output', 'inout', 'wire', 'reg', 'integer', 'parameter',
            'localparam', 'genvar', 'generate', 'endgenerate',
          ].map(kw => ({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            range,
          })),
        ];

        return { suggestions };
      },
    });

    // Override Cmd/Ctrl+K so it reaches the document-level CommandMenu listener
    // instead of being consumed by Monaco's chord keybinding system
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        ctrlKey: true,
        bubbles: true,
      }));
    });

    editor.updateOptions({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      renderLineHighlight: 'line',
      tabSize: 4,
      insertSpaces: true,
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true },
      readOnly,
    });
  }, [readOnly]);

  // Detect language from file content/extension
  const detectedLang = language || 'verilog';

  useEffect(() => {
    if (editorRef.current && monacoRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        monacoRef.current.editor.setModelLanguage(model, detectedLang);
      }
    }
  }, [detectedLang]);

  return (
    <div className="h-full w-full">
      <Editor
        height="100%"
        defaultLanguage={detectedLang}
        value={value}
        onChange={(v) => onChange(v || '')}
        onMount={handleEditorMount}
        theme={isDark ? 'vivado-dark' : 'vivado-light'}
        loading={
          <div className="flex items-center justify-center h-full bg-background text-muted-foreground">
            Loading editor...
          </div>
        }
      />
    </div>
  );
}
