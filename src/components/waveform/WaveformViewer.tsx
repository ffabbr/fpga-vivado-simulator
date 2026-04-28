'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  type SimulationResult, type SignalTrace, type V4,
  v4FormatHex, v4FormatBin, v4FormatDec,
} from '@/lib/verilog-simulator';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ZoomIn, ZoomOut, ChevronLeft, ChevronRight, Download, ChevronDown, Check } from 'lucide-react';

interface WaveformViewerProps {
  simulation: SimulationResult | null;
  selectedSignals?: string[];
}

type WaveformRow = SignalTrace & {
  parentName?: string;
  bitIndex?: number;
};

const SIGNAL_HEIGHT = 28;
const LABEL_WIDTH = 200;
const HEADER_HEIGHT = 28;
const COLORS = [
  '#22c55e', '#3b82f6', '#eab308', '#ef4444', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#8b5cf6',
];
const EMPTY_TRACES: SignalTrace[] = [];
const EMPTY_TRACE_MAP: Record<string, SignalTrace> = {};

function getThemeColors() {
  const isDark = document.documentElement.classList.contains('dark');
  return {
    bg: isDark ? '#09090b' : '#ffffff',
    gridLine: isDark ? '#1f1f23' : '#e4e4e7',
    timeText: isDark ? '#a1a1aa' : '#52525b',
    rowEven: isDark ? '#0c0c0e' : '#fafafa',
    rowOdd: isDark ? '#09090b' : '#ffffff',
    separator: isDark ? '#1a1a1e' : '#e4e4e7',
    labelSep: isDark ? '#27272a' : '#d4d4d8',
    valueText: isDark ? '#e4e4e7' : '#18181b',
    xColor: '#ef4444',
  };
}

type SignalScopeMode = 'top' | 'all';
type DisplayMode = 'hex' | 'bin' | 'dec';

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  hex: 'Hex',
  bin: 'Binary',
  dec: 'Decimal',
};

const SIGNAL_SCOPE_LABELS: Record<SignalScopeMode, string> = {
  top: 'Top signals',
  all: 'All signals',
};

function isTopScopeSignal(trace: SignalTrace): boolean {
  return !trace.isMemory && trace.name.split('.').length === 2;
}

// Default signal selection: testbench/top-scope only, matching Vivado's less noisy default.
function defaultPick(traces: SignalTrace[], scopeMode: SignalScopeMode): string[] {
  const candidates = scopeMode === 'top'
    ? traces.filter(isTopScopeSignal)
    : traces;
  const picked = candidates.slice(0, 24);
  if (picked.length === 0) return traces.filter(t => !t.isMemory).slice(0, 24).map(t => t.name);
  return picked.map(t => t.name);
}

// Binary-search: find the index of the last change at or before time t
function changeAt(trace: SignalTrace, t: number): V4 | null {
  if (trace.changes.length === 0) return null;
  let lo = 0, hi = trace.changes.length - 1;
  if (t < trace.changes[0].time) return trace.changes[0].value;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (trace.changes[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return trace.changes[lo].value;
}

function formatV(v: V4, w: number, mode: 'hex' | 'bin' | 'dec'): string {
  if (mode === 'hex') return v4FormatHex(v, w);
  if (mode === 'bin') return v4FormatBin(v, w);
  return v4FormatDec(v, w);
}

function valuesEqual(a: V4 | null, b: V4 | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.v === b.v && a.x === b.x;
}

function bitTrace(parent: SignalTrace, bitIndex: number): WaveformRow {
  const changes = parent.changes
    .map(change => ({
      time: change.time,
      value: {
        v: (change.value.v >> BigInt(bitIndex)) & 1n,
        x: (change.value.x >> BigInt(bitIndex)) & 1n,
      },
    }))
    .filter((change, idx, arr) => idx === 0 || !valuesEqual(change.value, arr[idx - 1].value));

  return {
    name: `${parent.name}[${bitIndex}]`,
    parentName: parent.name,
    bitIndex,
    width: 1,
    isMemory: false,
    changes,
  };
}

export default function WaveformViewer({ simulation, selectedSignals }: WaveformViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [scrollX, setScrollX] = useState(0);
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('hex');
  const [signalScopeMode, setSignalScopeMode] = useState<SignalScopeMode>('top');
  const [visibleSignals, setVisibleSignals] = useState<string[]>([]);
  const [expandedBuses, setExpandedBuses] = useState<Set<string>>(() => new Set());

  const allTraces = simulation?.signals ?? EMPTY_TRACES;
  const tracesByName = simulation?.signalsByName ?? EMPTY_TRACE_MAP;

  useEffect(() => {
    if (!simulation || simulation.signals.length === 0) {
      setVisibleSignals([]);
      return;
    }
    if (selectedSignals && selectedSignals.length > 0) {
      setVisibleSignals(selectedSignals);
    } else {
      setVisibleSignals(defaultPick(simulation.signals, signalScopeMode));
    }
  }, [simulation, selectedSignals, signalScopeMode]);

  const visibleTraces = useMemo(
    () => visibleSignals.map(n => tracesByName[n]).filter(Boolean),
    [visibleSignals, tracesByName]
  );

  const waveformRows = useMemo<WaveformRow[]>(() => {
    const rows: WaveformRow[] = [];
    for (const trace of visibleTraces) {
      rows.push(trace);
      if (trace.width > 1 && expandedBuses.has(trace.name)) {
        for (let bit = trace.width - 1; bit >= 0; bit--) {
          rows.push(bitTrace(trace, bit));
        }
      }
    }
    return rows;
  }, [visibleTraces, expandedBuses]);

  const pickerTraces = useMemo(() => {
    return signalScopeMode === 'top'
      ? allTraces.filter(isTopScopeSignal)
      : allTraces;
  }, [allTraces, signalScopeMode]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !simulation || waveformRows.length === 0) {
      if (canvas && container) {
        const dpr = window.devicePixelRatio || 1;
        const tc = getThemeColors();
        canvas.width = container.clientWidth * dpr;
        canvas.height = container.clientHeight * dpr;
        canvas.style.width = `${container.clientWidth}px`;
        canvas.style.height = `${container.clientHeight}px`;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.scale(dpr, dpr);
          ctx.fillStyle = tc.bg;
          ctx.fillRect(0, 0, container.clientWidth, container.clientHeight);
        }
      }
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const tc = getThemeColors();
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = Math.max(
      HEADER_HEIGHT + waveformRows.length * SIGNAL_HEIGHT + 8,
      container.clientHeight
    );

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    ctx.fillStyle = tc.bg;
    ctx.fillRect(0, 0, width, height);

    const waveWidth = width - LABEL_WIDTH;
    const maxTime = Math.max(simulation.duration, 1);
    const timeScale = (waveWidth * zoom) / maxTime;

    // Header
    ctx.fillStyle = tc.rowEven;
    ctx.fillRect(0, 0, width, HEADER_HEIGHT);
    ctx.strokeStyle = tc.separator;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_HEIGHT + 0.5);
    ctx.lineTo(width, HEADER_HEIGHT + 0.5);
    ctx.stroke();

    // Time markers
    const timeStep = niceStep(maxTime, waveWidth, zoom);
    ctx.fillStyle = tc.timeText;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    for (let t = 0; t <= maxTime; t += timeStep) {
      const x = LABEL_WIDTH + t * timeScale - scrollX;
      if (x < LABEL_WIDTH || x > width) continue;
      ctx.fillText(`${t}ns`, x, HEADER_HEIGHT - 8);
      ctx.strokeStyle = tc.gridLine;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, HEADER_HEIGHT);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }

    // Each signal
    for (let idx = 0; idx < waveformRows.length; idx++) {
      const trace = waveformRows[idx];
      const y = HEADER_HEIGHT + idx * SIGNAL_HEIGHT;
      const color = COLORS[idx % COLORS.length];

      // Row background
      ctx.fillStyle = idx % 2 === 0 ? tc.rowEven : tc.rowOdd;
      ctx.fillRect(0, y, width, SIGNAL_HEIGHT);

      // Row separator
      ctx.strokeStyle = tc.separator;
      ctx.beginPath();
      ctx.moveTo(0, y + SIGNAL_HEIGHT + 0.5);
      ctx.lineTo(width, y + SIGNAL_HEIGHT + 0.5);
      ctx.stroke();

      // Label
      ctx.fillStyle = tc.valueText;
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      const shortName = trace.parentName
        ? `[${trace.bitIndex}]`
        : (trace.name.split('.').slice(1).join('.') || trace.name);
      const label = trace.width > 1 ? `${shortName}[${trace.width - 1}:0]` : shortName;
      const marker = trace.width > 1 ? (expandedBuses.has(trace.name) ? '▾ ' : '▸ ') : (trace.parentName ? '  ' : '');
      const labelX = trace.parentName ? 28 : 8;
      ctx.fillText(truncate(`${marker}${label}`, trace.parentName ? 22 : 24), labelX, y + SIGNAL_HEIGHT / 2 + 4);

      // Label/wave separator
      ctx.strokeStyle = tc.labelSep;
      ctx.beginPath();
      ctx.moveTo(LABEL_WIDTH + 0.5, y);
      ctx.lineTo(LABEL_WIDTH + 0.5, y + SIGNAL_HEIGHT);
      ctx.stroke();

      // Wave
      const padding = 4;
      const waveTop = y + padding;
      const waveBot = y + SIGNAL_HEIGHT - padding;
      const waveMid = y + SIGNAL_HEIGHT / 2;

      const changes = trace.changes;
      if (changes.length === 0) continue;

      ctx.lineWidth = 1.4;
      if (trace.width === 1) {
        // single-bit: square wave with x as red center band
        for (let i = 0; i < changes.length; i++) {
          const cur = changes[i];
          const next = changes[i + 1];
          const tStart = cur.time;
          const tEnd = next ? next.time : maxTime;
          const x0 = LABEL_WIDTH + tStart * timeScale - scrollX;
          const x1 = LABEL_WIDTH + tEnd * timeScale - scrollX;
          if (x1 < LABEL_WIDTH || x0 > width) continue;
          const cx0 = Math.max(x0, LABEL_WIDTH);
          const cx1 = Math.min(x1, width);
          const isX = (cur.value.x & 1n) !== 0n;
          if (isX) {
            ctx.strokeStyle = tc.xColor;
            ctx.beginPath();
            ctx.moveTo(cx0, waveTop);
            ctx.lineTo(cx1, waveTop);
            ctx.moveTo(cx0, waveBot);
            ctx.lineTo(cx1, waveBot);
            ctx.stroke();
            ctx.fillStyle = tc.xColor + '22';
            ctx.fillRect(cx0, waveTop, cx1 - cx0, waveBot - waveTop);
          } else {
            const lvl = (cur.value.v & 1n) === 1n ? waveTop : waveBot;
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.moveTo(cx0, lvl);
            ctx.lineTo(cx1, lvl);
            ctx.stroke();
            // edge transition
            if (next && x1 >= LABEL_WIDTH && x1 <= width) {
              const nIsX = (next.value.x & 1n) !== 0n;
              const nLvl = nIsX ? waveMid : ((next.value.v & 1n) === 1n ? waveTop : waveBot);
              if (nLvl !== lvl) {
                ctx.beginPath();
                ctx.moveTo(x1, lvl);
                ctx.lineTo(x1, nLvl);
                ctx.stroke();
              }
            }
          }
        }
      } else {
        // multi-bit: bus shape with hex value text
        for (let i = 0; i < changes.length; i++) {
          const cur = changes[i];
          const next = changes[i + 1];
          const tStart = cur.time;
          const tEnd = next ? next.time : maxTime;
          const x0 = LABEL_WIDTH + tStart * timeScale - scrollX;
          const x1 = LABEL_WIDTH + tEnd * timeScale - scrollX;
          if (x1 < LABEL_WIDTH || x0 > width) continue;
          const cx0 = Math.max(x0, LABEL_WIDTH);
          const cx1 = Math.min(x1, width);
          const hasX = (cur.value.x & ((1n << BigInt(trace.width)) - 1n)) !== 0n;
          ctx.strokeStyle = hasX ? tc.xColor : color;

          // bus outline
          ctx.beginPath();
          ctx.moveTo(cx0 + 1, waveMid);
          ctx.lineTo(Math.min(cx0 + 3, cx1), waveTop);
          ctx.lineTo(Math.max(cx1 - 3, cx0), waveTop);
          ctx.lineTo(cx1, waveMid);
          ctx.lineTo(Math.max(cx1 - 3, cx0), waveBot);
          ctx.lineTo(Math.min(cx0 + 3, cx1), waveBot);
          ctx.closePath();
          ctx.stroke();
          if (hasX) {
            ctx.fillStyle = tc.xColor + '22';
            ctx.fill();
          }

          // Value text
          if (cx1 - cx0 > 18) {
            ctx.fillStyle = tc.valueText;
            ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.textAlign = 'left';
            const valStr = formatV(cur.value, trace.width, displayMode);
            const tx = Math.max(cx0 + 6, LABEL_WIDTH + 4);
            const maxChars = Math.floor((cx1 - tx) / 6);
            ctx.fillText(truncate(valStr, Math.max(1, maxChars)), tx, waveMid + 3);
          }
        }
      }
    }

    // Cursor
    if (cursorTime !== null) {
      const cx = LABEL_WIDTH + cursorTime * timeScale - scrollX;
      if (cx >= LABEL_WIDTH && cx <= width) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, 0);
        ctx.lineTo(cx + 0.5, height);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#facc15';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${cursorTime}ns`, cx, HEADER_HEIGHT - 8);
      }
    }
  }, [simulation, waveformRows, zoom, scrollX, cursorTime, displayMode, expandedBuses]);

  useEffect(() => { drawWaveform(); }, [drawWaveform]);

  useEffect(() => {
    const handleResize = () => drawWaveform();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [drawWaveform]);

  useEffect(() => {
    const observer = new MutationObserver(() => drawWaveform());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [drawWaveform]);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (!simulation || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < LABEL_WIDTH) {
      const y = e.clientY - rect.top;
      const rowIndex = Math.floor((y - HEADER_HEIGHT) / SIGNAL_HEIGHT);
      const row = waveformRows[rowIndex];
      if (row && row.width > 1 && !row.parentName) {
        setExpandedBuses(prev => {
          const next = new Set(prev);
          if (next.has(row.name)) next.delete(row.name);
          else next.add(row.name);
          return next;
        });
      }
      return;
    }
    const maxTime = Math.max(simulation.duration, 1);
    const waveWidth = rect.width - LABEL_WIDTH;
    const timeScale = (waveWidth * zoom) / maxTime;
    const time = Math.round((x - LABEL_WIDTH + scrollX) / timeScale);
    setCursorTime(Math.max(0, Math.min(time, maxTime)));
  }, [simulation, zoom, scrollX, waveformRows]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = Math.exp(-e.deltaY * 0.002);
      setZoom(z => Math.max(0.1, Math.min(200, z * delta)));
    } else {
      setScrollX(s => Math.max(0, s + e.deltaX + e.deltaY));
    }
  }, []);

  const toggleSignal = useCallback((name: string) => {
    setVisibleSignals(cur => cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name]);
  }, []);

  const handleExportJson = useCallback(() => {
    if (!simulation) return;
    // BigInts (V4.v / V4.x) need explicit serialization
    const replacer = (_k: string, v: unknown) =>
      typeof v === 'bigint' ? v.toString(16) + 'n' : v;
    const payload = {
      duration: simulation.duration,
      timeUnitNs: simulation.timeUnitNs,
      errors: simulation.errors,
      logs: simulation.logs,
      signals: simulation.signals.map(s => ({
        name: s.name,
        width: s.width,
        isMemory: s.isMemory,
        changes: s.changes.map(c => ({ time: c.time, v: c.value.v.toString(16), x: c.value.x.toString(16) })),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, replacer, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `waveform_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [simulation]);

  if (!simulation || simulation.signals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Run a simulation to view waveforms
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/50">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom(z => Math.min(200, z * 1.5))}>
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom(z => Math.max(0.1, z / 1.5))}>
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setScrollX(s => Math.max(0, s - 100))}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setScrollX(s => s + 100)}>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>

        <div className="w-px h-4 bg-border" />

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="h-7 w-24 justify-between text-xs font-mono bg-background">
                {DISPLAY_MODE_LABELS[displayMode]}
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-(--anchor-width)">
            {(Object.keys(DISPLAY_MODE_LABELS) as DisplayMode[]).map(mode => (
              <DropdownMenuItem key={mode} onClick={() => setDisplayMode(mode)} className="text-xs">
                {DISPLAY_MODE_LABELS[mode]}
                {displayMode === mode && <Check className="ml-auto h-3.5 w-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="h-7 w-32 justify-between text-xs font-mono bg-background">
                {SIGNAL_SCOPE_LABELS[signalScopeMode]}
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-(--anchor-width)">
            {(Object.keys(SIGNAL_SCOPE_LABELS) as SignalScopeMode[]).map(mode => (
              <DropdownMenuItem key={mode} onClick={() => setSignalScopeMode(mode)} className="text-xs">
                {SIGNAL_SCOPE_LABELS[mode]}
                {signalScopeMode === mode && <Check className="ml-auto h-3.5 w-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {cursorTime !== null && (
          <>
            <div className="w-px h-4 bg-border" />
            <span className="text-xs text-yellow-500 font-mono">T = {cursorTime}ns</span>
          </>
        )}

        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleExportJson} title="Download waveform JSON for debugging">
          <Download className="h-3.5 w-3.5" />
        </Button>
        <span className="text-[10px] text-muted-foreground">
          {visibleTraces.length}/{simulation.signals.length} signals · {simulation.duration}ns
        </span>
      </div>

      {/* Body: side panel + canvas */}
      <div className="flex-1 flex overflow-hidden">
        {/*
        <div className="w-56 border-r border-border bg-muted/20 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto text-xs font-mono">
            {pickerTraces.map(t => {
              const checked = visibleSignals.includes(t.name);
              const cursorVal = cursorTime !== null ? changeAt(t, cursorTime) : null;
              return (
                <label
                  key={t.name}
                  className="flex items-center gap-2 px-2 py-0.5 hover:bg-muted cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSignal(t.name)}
                    className="h-3 w-3"
                  />
                  <span className="flex-1 truncate" title={t.name}>
                    {t.name}{t.width > 1 ? `[${t.width - 1}:0]` : ''}
                  </span>
                  {cursorVal && (
                    <span className="text-muted-foreground">
                      {formatV(cursorVal, t.width, displayMode).slice(0, 8)}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
        */}

        {/* Canvas */}
        <div
          ref={containerRef}
          className="flex-1 overflow-auto cursor-crosshair"
          onWheel={handleWheel}
        >
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            className="block"
          />
        </div>
      </div>
    </div>
  );
}

function niceStep(maxTime: number, width: number, zoom: number): number {
  const targetSteps = (width * zoom) / 80;
  const rawStep = maxTime / Math.max(targetSteps, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rawStep, 1))));
  const normalized = rawStep / magnitude;
  if (normalized <= 1) return Math.max(magnitude, 1);
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(1, n - 1)) + '…';
}

// Avoid unused-import warning when SimulationResult is only referenced in a generic context
void valuesEqual;
