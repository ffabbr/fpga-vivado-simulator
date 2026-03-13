'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { SimulationResult } from '@/lib/verilog-simulator';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ZoomIn, ZoomOut, Maximize2, ChevronLeft, ChevronRight } from 'lucide-react';

interface WaveformViewerProps {
  simulation: SimulationResult | null;
  selectedSignals?: string[];
}

const SIGNAL_HEIGHT = 32;
const LABEL_WIDTH = 160;
const HEADER_HEIGHT = 32;
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
    timeText: isDark ? '#71717a' : '#71717a',
    rowEven: isDark ? '#0c0c0e' : '#fafafa',
    rowOdd: isDark ? '#09090b' : '#ffffff',
    separator: isDark ? '#1a1a1e' : '#e4e4e7',
    labelSep: isDark ? '#27272a' : '#d4d4d8',
  };
}

export default function WaveformViewer({ simulation, selectedSignals }: WaveformViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [scrollX, setScrollX] = useState(0);
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const [displayMode, setDisplayMode] = useState<'binary' | 'hex' | 'decimal'>('hex');
  const [visibleSignals, setVisibleSignals] = useState<string[]>([]);

  useEffect(() => {
    if (simulation && simulation.signals.length > 0) {
      if (selectedSignals && selectedSignals.length > 0) {
        setVisibleSignals(selectedSignals);
      } else {
        setVisibleSignals(simulation.signals.slice(0, 20));
      }
    }
  }, [simulation, selectedSignals]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !simulation || simulation.waveform.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const tc = getThemeColors();
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = Math.max(
      HEADER_HEIGHT + visibleSignals.length * SIGNAL_HEIGHT + 20,
      container.clientHeight
    );

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = tc.bg;
    ctx.fillRect(0, 0, width, height);

    const waveWidth = width - LABEL_WIDTH;
    const maxTime = simulation.duration || simulation.waveform[simulation.waveform.length - 1].time;
    const timeScale = (waveWidth * zoom) / Math.max(maxTime, 1);

    // Draw time header
    ctx.fillStyle = tc.headerBg;
    ctx.fillRect(0, 0, width, HEADER_HEIGHT);
    ctx.strokeStyle = tc.headerBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_HEIGHT);
    ctx.lineTo(width, HEADER_HEIGHT);
    ctx.stroke();

    // Time markers
    const timeStep = calculateTimeStep(maxTime, waveWidth, zoom);
    ctx.fillStyle = tc.timeText;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';

    for (let t = 0; t <= maxTime; t += timeStep) {
      const x = LABEL_WIDTH + (t * timeScale) - scrollX;
      if (x < LABEL_WIDTH || x > width) continue;

      ctx.fillText(`${t}ns`, x, 12);
      ctx.strokeStyle = tc.gridLine;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Draw each signal
    visibleSignals.forEach((signalName, idx) => {
      const y = HEADER_HEIGHT + idx * SIGNAL_HEIGHT;
      const color = COLORS[idx % COLORS.length];
      const signalWidth = simulation.signalWidths[signalName] || 1;

      // Label background
      ctx.fillStyle = idx % 2 === 0 ? tc.rowEven : tc.rowOdd;
      ctx.fillRect(0, y, width, SIGNAL_HEIGHT);

      // Separator
      ctx.strokeStyle = tc.separator;
      ctx.beginPath();
      ctx.moveTo(0, y + SIGNAL_HEIGHT);
      ctx.lineTo(width, y + SIGNAL_HEIGHT);
      ctx.stroke();

      // Label
      ctx.fillStyle = color;
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      const label = signalWidth > 1 ? `${signalName}[${signalWidth - 1}:0]` : signalName;
      ctx.fillText(label, 8, y + SIGNAL_HEIGHT / 2 + 4);

      // Label separator
      ctx.strokeStyle = tc.labelSep;
      ctx.beginPath();
      ctx.moveTo(LABEL_WIDTH, y);
      ctx.lineTo(LABEL_WIDTH, y + SIGNAL_HEIGHT);
      ctx.stroke();

      // Draw waveform
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      const padding = 4;
      const waveTop = y + padding;
      const waveBot = y + SIGNAL_HEIGHT - padding;
      const waveMid = y + SIGNAL_HEIGHT / 2;

      for (let i = 0; i < simulation.waveform.length; i++) {
        const point = simulation.waveform[i];
        const value = point.signals[signalName] ?? 0;
        const x = LABEL_WIDTH + (point.time * timeScale) - scrollX;
        const nextPoint = simulation.waveform[i + 1];
        const nextX = nextPoint
          ? LABEL_WIDTH + (nextPoint.time * timeScale) - scrollX
          : width;

        if (nextX < LABEL_WIDTH || x > width) continue;

        if (signalWidth === 1) {
          const yPos = value ? waveTop : waveBot;
          if (i === 0) {
            ctx.moveTo(Math.max(x, LABEL_WIDTH), yPos);
          } else {
            ctx.lineTo(Math.max(x, LABEL_WIDTH), yPos);
          }
          ctx.lineTo(Math.min(nextX, width), yPos);
        } else {
          if (i > 0) {
            ctx.moveTo(Math.max(x - 2, LABEL_WIDTH), waveTop);
            ctx.lineTo(Math.max(x, LABEL_WIDTH), waveMid);
            ctx.lineTo(Math.max(x - 2, LABEL_WIDTH), waveBot);
            ctx.moveTo(Math.max(x + 2, LABEL_WIDTH), waveTop);
            ctx.lineTo(Math.max(x, LABEL_WIDTH), waveMid);
            ctx.lineTo(Math.max(x + 2, LABEL_WIDTH), waveBot);
          }
          ctx.moveTo(Math.max(x + 2, LABEL_WIDTH), waveTop);
          ctx.lineTo(Math.min(nextX - 2, width), waveTop);
          ctx.moveTo(Math.max(x + 2, LABEL_WIDTH), waveBot);
          ctx.lineTo(Math.min(nextX - 2, width), waveBot);

          const textX = Math.max(x + 6, LABEL_WIDTH + 4);
          if (textX < nextX - 10 && textX < width) {
            ctx.save();
            ctx.fillStyle = color;
            ctx.font = '9px monospace';
            ctx.textAlign = 'left';
            const valueStr = formatValue(value, signalWidth, displayMode);
            ctx.fillText(valueStr, textX, waveMid + 3);
            ctx.restore();
          }
        }
      }
      ctx.stroke();
    });

    // Draw cursor
    if (cursorTime !== null) {
      const cx = LABEL_WIDTH + (cursorTime * timeScale) - scrollX;
      if (cx >= LABEL_WIDTH && cx <= width) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, height);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#facc15';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${cursorTime}ns`, cx, HEADER_HEIGHT - 4);
      }
    }
  }, [simulation, visibleSignals, zoom, scrollX, cursorTime, displayMode]);

  useEffect(() => {
    drawWaveform();
  }, [drawWaveform]);

  useEffect(() => {
    const handleResize = () => drawWaveform();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [drawWaveform]);

  // Redraw when theme changes
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

    const maxTime = simulation.duration || simulation.waveform[simulation.waveform.length - 1].time;
    const waveWidth = rect.width - LABEL_WIDTH;
    const timeScale = (waveWidth * zoom) / Math.max(maxTime, 1);
    const time = Math.round((x - LABEL_WIDTH + scrollX) / timeScale);
    setCursorTime(Math.max(0, Math.min(time, maxTime)));
  }, [simulation, zoom, scrollX]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.8 : 1.25;
      setZoom(z => Math.max(0.1, Math.min(50, z * delta)));
    } else {
      setScrollX(s => Math.max(0, s + e.deltaX + e.deltaY));
    }
  }, []);

  const zoomToFit = useCallback(() => {
    setZoom(1);
    setScrollX(0);
  }, []);

  if (!simulation || simulation.waveform.length === 0) {
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
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom(z => Math.min(50, z * 1.5))}>
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
            <SelectItem value="binary">Binary</SelectItem>
            <SelectItem value="decimal">Decimal</SelectItem>
          </SelectContent>
        </Select>

        {cursorTime !== null && (
          <>
            <div className="w-px h-4 bg-border" />
            <span className="text-xs text-yellow-500 font-mono">T = {cursorTime}ns</span>
            {visibleSignals.slice(0, 3).map(sig => {
              const point = simulation.waveform.reduce((prev, curr) =>
                curr.time <= cursorTime! ? curr : prev
              );
              const val = point?.signals[sig] ?? 0;
              const w = simulation.signalWidths[sig] || 1;
              return (
                <span key={sig} className="text-xs text-muted-foreground font-mono">
                  {sig}={formatValue(val, w, displayMode)}
                </span>
              );
            })}
          </>
        )}

        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground">
          {simulation.waveform.length} samples | {simulation.duration}ns
        </span>
      </div>

      {/* Waveform canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden cursor-crosshair"
        onWheel={handleWheel}
      >
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          className="block"
        />
      </div>
    </div>
  );
}

function calculateTimeStep(maxTime: number, width: number, zoom: number): number {
  const targetSteps = (width * zoom) / 80;
  const rawStep = maxTime / Math.max(targetSteps, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function formatValue(value: number, width: number, mode: 'binary' | 'hex' | 'decimal'): string {
  const mask = width >= 32 ? 0xFFFFFFFF : (1 << width) - 1;
  const v = value & mask;
  switch (mode) {
    case 'binary': return `${width}'b${v.toString(2).padStart(width, '0')}`;
    case 'hex': return `${width}'h${v.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0')}`;
    case 'decimal': return v.toString();
  }
}
