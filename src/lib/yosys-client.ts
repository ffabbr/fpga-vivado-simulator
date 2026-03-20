export interface SynthesisResult {
  netlist: unknown;
  log: string;
}

export class SynthesisError extends Error {
  log: string;
  constructor(message: string, log: string) {
    super(message);
    this.name = 'SynthesisError';
    this.log = log;
  }
}

export class YosysClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (r: SynthesisResult) => void;
    reject: (e: Error) => void;
  }>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(
        new URL('./yosys-worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.worker.onmessage = (e: MessageEvent) => {
        const { type, id, netlist, log, error } = e.data;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);

        if (type === 'result') {
          p.resolve({ netlist, log });
        } else {
          p.reject(new SynthesisError(error ?? 'Unknown synthesis error', log ?? ''));
        }
      };
      this.worker.onerror = (e) => {
        // Reject all pending on worker crash
        for (const [, p] of this.pending) {
          p.reject(new Error(`Worker error: ${e.message}`));
        }
        this.pending.clear();
      };
    }
    return this.worker;
  }

  synthesize(files: Record<string, string>, topModule: string): Promise<SynthesisResult> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.getWorker().postMessage({ type: 'synthesize', id, files, topModule });
    });
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    for (const [, p] of this.pending) {
      p.reject(new Error('Client terminated'));
    }
    this.pending.clear();
  }
}
