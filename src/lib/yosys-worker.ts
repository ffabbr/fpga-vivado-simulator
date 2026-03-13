// Fix Next.js Web Worker Blob loading issue — MUST run before @yowasp/yosys is
// imported, because the yosys bundle captures a reference to `fetch` at module
// evaluation time. Using a static `import` would hoist the yosys module above
// this code, so we use a dynamic `import()` below instead.
const originalFetch = self.fetch.bind(self);
const workerOrigin = (() => {
  if (self.location.origin && self.location.origin !== 'null') {
    return self.location.origin;
  }
  const m = self.location.href.match(/^(?:blob:)?(https?:\/\/[^/]+)/);
  return m ? m[1] : '';
})();

function rewriteWorkerUrl(raw: string): string | null {
  if (!workerOrigin) return null;

  if (raw.startsWith('/')) {
    return workerOrigin + raw;
  }

  if (raw.startsWith('blob:')) {
    const pathname = raw.replace(/^blob:https?:\/\/[^/]+/, '');
    if (pathname.startsWith('/')) {
      return workerOrigin + pathname;
    }
  }

  return null;
}

self.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
  if (input instanceof Request) {
    const rewritten = rewriteWorkerUrl(input.url);
    if (rewritten) {
      return originalFetch(new Request(rewritten, input), init);
    }
    return originalFetch(input, init);
  }

  if (input instanceof URL) {
    const rewritten = rewriteWorkerUrl(input.href);
    if (rewritten) {
      return originalFetch(rewritten, init);
    }
    return originalFetch(input, init);
  }

  if (typeof input === 'string') {
    const rewritten = rewriteWorkerUrl(input);
    if (rewritten) {
      return originalFetch(rewritten, init);
    }
  }

  return originalFetch(input, init);
};

// Lazy-loaded reference — only imported on first synthesis call
let runYosysFn: typeof import('@yowasp/yosys').runYosys | null = null;

async function getRunYosys() {
  if (!runYosysFn) {
    const mod = await import('@yowasp/yosys');
    runYosysFn = mod.runYosys;
  }
  return runYosysFn;
}

interface SynthesizeMessage {
  type: 'synthesize';
  id: number;
  files: Record<string, string>;
  topModule: string;
}

self.onmessage = async (e: MessageEvent<SynthesizeMessage>) => {
  const { id, files, topModule } = e.data;
  const logs: string[] = [];

  try {
    const runYosys = await getRunYosys();

    // Build virtual filesystem — concatenate all Verilog sources into a single
    // file so that multi-module designs work reliably with the WASM VFS.
    const vfs: Record<string, string> = {};
    const combinedSource = Object.values(files).join('\n\n');
    vfs['design.v'] = combinedSource;

    // Build Yosys synthesis script
    vfs['synth.ys'] = [
      'read_verilog design.v',
      `synth -top ${topModule}`,
      // Gate-level simulator evaluates primitive cells; flatten removes
      // hierarchical user-defined cells (e.g. FullAdder instances) from top.
      'flatten',
      'abc -g AND,OR,XOR,MUX',
      'clean -purge',
      'write_json netlist.json',
    ].join('\n');

    const decoder = new TextDecoder();
    const result = await runYosys(['-s', 'synth.ys'], vfs, {
      stdout: (bytes: Uint8Array | null) => { if (bytes) logs.push(decoder.decode(bytes)); },
      stderr: (bytes: Uint8Array | null) => { if (bytes) logs.push(decoder.decode(bytes)); },
    });

    // Read netlist from output
    const netlistRaw = result?.['netlist.json'];
    if (!netlistRaw) {
      self.postMessage({ type: 'error', id, error: 'Yosys did not produce netlist.json', log: logs.join('\n') });
      return;
    }

    const netlistStr = typeof netlistRaw === 'string' ? netlistRaw : new TextDecoder().decode(netlistRaw as Uint8Array);
    const netlist = JSON.parse(netlistStr);

    self.postMessage({ type: 'result', id, netlist, log: logs.join('\n') });
  } catch (err) {
    self.postMessage({ type: 'error', id, error: (err as Error).message, log: logs.join('\n') });
  }
};
