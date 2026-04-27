'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  type SimulationResult, type SignalTrace, type V4,
  v4FormatHex, v4FormatBin, v4FormatDec,
} from '@/lib/verilog-simulator';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ZoomIn, ZoomOut, Maximize2, ChevronLeft, ChevronRight, Search } from 'lucide-react';

interface WaveformViewerProps {
  simulation: SimulationResult | null;
  selectedSignals?: string[];
}

const SIGNAL_HEIGHT = 28;
const LABEL_WIDTH = 200;
const HEADER_HEIGHT = 28;
const COLORS = [
  '#22c55e', '#3b82f6', '#eab308', '#ef4444', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#8b5cf6',
];

function getThemeColors() {
  const isDark = document.documentElement.classList.contains('dark');
  return {
    bg: isDark ? '#09090b' : '#ffffff',
    headerBg: isDark ? '#18181b' : '#f4f4f5',
    headerBorder: isDark ? '#27272a' : '#d4d4d8',
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

// Default signal selection: testbench-scope only (one dot in path = top-only)
function defaultPick(traces: SignalTrace[]): string[] {
  const top = traces.filter(t => t.name.split('.').length === 2);
  if (top.length === 0) return traces.slice(0, 12).map(t => t.name);
  return top.slice(0, 24).map(t => t.name);
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

export default function WaveformViewer({ simulation, selectedSignals }: WaveformViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [scrollX, setScrollX] = useState(0);
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const [displayMode, setDisplayMode] = useState<'hex' | 'bin' | 'dec'>('hex');
  const [visibleSignals, setVisibleSignals] = useState<string[]>([]);
  const [signalFilter, setSignalFilter] = useState('');

  const allTraces = simulation?.signals ?? [];
  const tracesByName = simulation?.signalsByName ?? {};

  useEffect(() => {
    if (!simulation || simulation.signals.length === 0) {
      setVisibleSignals([]);
      return;
    }
    if (selectedSignals && selectedSignals.length > 0) {
      setVisibleSignals(selectedSignals);
    } else {
      setVisibleSignals(defaultPick(simulation.signals));
    }
  }, [simulation, selectedSignals]);

  const visibleTraces = useMemo(
    () => visibleSignals.map(n => tracesByName[n]).filter(Boolean),
    [visibleSignals, tracesByName]
  );

  const filteredAll = useMemo(() => {
    const q = signalFilter.trim().toLowerCase();
    if (!q) return allTraces;
    return allTraces.filter(t => t.name.toLowerCase().includes(q));
  }, [allTraces, signalFilter]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !simulation || visibleTraces.length === 0) {
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
      HEADER_HEIGHT + visibleTraces.length * SIGNAL_HEIGHT + 8,
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
    ctx.fillStyle = tc.headerBg;
    ctx.fillRect(0, 0, width, HEADER_HEIGHT);
    ctx.strokeStyle = tc.headerBorder;
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
    for (let idx = 0; idx < visibleTraces.length; idx++) {
      const trace = visibleTraces[idx];
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
      const shortName = trace.name.split('.').slice(1).join('.') || trace.name;
      const label = trace.width > 1 ? `${shortName}[${trace.width - 1}:0]` : shortName;
      ctx.fillText(truncate(label, 24), 8, y + SIGNAL_HEIGHT / 2 + 4);

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
  }, [simulation, visibleTraces, zoom, scrollX, cursorTime, displayMode]);

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
    if (x < LABEL_WIDTH) return;
    const maxTime = Math.max(simulation.duration, 1);
    const waveWidth = rect.width - LABEL_WIDTH;
    const timeScale = (waveWidth * zoom) / maxTime;
    const time = Math.round((x - LABEL_WIDTH + scrollX) / timeScale);
    setCursorTime(Math.max(0, Math.min(time, maxTime)));
  }, [simulation, zoom, scrollX]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.8 : 1.25;
      setZoom(z => Math.max(0.1, Math.min(200, z * delta)));
    } else {
      setScrollX(s => Math.max(0, s + e.deltaX + e.deltaY));
    }
  }, []);

  const zoomToFit = useCallback(() => {
    setZoom(1);
    setScrollX(0);
  }, []);

  const toggleSignal = useCallback((name: string) => {
    setVisibleSignals(cur => cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name]);
  }, []);

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
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={zoomToFit}>
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setScrollX(s => Math.max(0, s - 100))}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setScrollX(s => s + 100)}>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>

        <div className="w-px h-4 bg-border" />

        <Select value={displayMode} onValueChange={(v) => setDisplayMode(v as typeof displayMode)}>
          <SelectTrigger className="h-7 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hex">Hex</SelectItem>
            <SelectItem value="bin">Binary</SelectItem>
            <SelectItem value="dec">Decimal</SelectItem>
          </SelectContent>
        </Select>

        {cursorTime !== null && (
          <>
            <div className="w-px h-4 bg-border" />
            <span className="text-xs text-yellow-500 font-mono">T = {cursorTime}ns</span>
          </>
        )}

        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground">
          {simulation.signals.length} signals · {simulation.duration}ns
        </span>
      </div>

      {/* Body: side panel + canvas */}
      <div className="flex-1 flex overflow-hidden">
        {/* Signal picker */}
        <div className="w-56 border-r border-border bg-muted/20 flex flex-col overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <input
                type="text"
                value={signalFilter}
                onChange={(e) => setSignalFilter(e.target.value)}
                placeholder="Filter signals…"
                className="w-full h-7 pl-7 pr-2 text-xs bg-background border border-border rounded outline-none focus:border-primary"
              />
            </div>
          </div>
          <div className="flex-1 overflow-auto text-xs font-mono">
            {filteredAll.map(t => {
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
