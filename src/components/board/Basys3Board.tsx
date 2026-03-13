'use client';

import { useState, useCallback, useMemo } from 'react';
import { GateLevelSimulator, type YosysNetlist } from '@/lib/gate-sim';
import {
  buildBoardMapping,
  boardInputsToUserPorts,
  userOutputsToBoardOutputs,
} from '@/lib/constraints-parser';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface Basys3BoardProps {
  moduleName: string;
  netlist?: YosysNetlist | null;
  constraintsSource?: string;
  isSynthesizing?: boolean;
  onSynthesize?: () => void;
}

// 7-segment display segment mapping (active low for Basys 3)
// Segments: a=0, b=1, c=2, d=3, e=4, f=5, g=6
function SevenSegDisplay({ segments, dp, active }: { segments: number; dp: number; active: boolean }) {
  if (!active) {
    return (
      <div className="w-16 h-24 bg-zinc-900 rounded border border-zinc-700 flex items-center justify-center">
        <svg viewBox="0 0 60 90" className="w-12 h-20">
          {/* All segments off */}
          <SegmentPaths color="#1a1a1a" segments={0x7F} />
        </svg>
      </div>
    );
  }

  return (
    <div className="w-16 h-24 bg-zinc-900 rounded border border-zinc-700 flex items-center justify-center relative">
      <svg viewBox="0 0 60 90" className="w-12 h-20">
        <SegmentPaths color="#1a1a1a" segments={0x7F} />
        <SegmentPaths color="#ff2222" segments={~segments & 0x7F} />
      </svg>
      {/* Decimal point */}
      <div
        className={`absolute bottom-2 right-2 w-2 h-2 rounded-full ${!(dp & 1) ? 'bg-red-500 shadow-[0_0_6px_rgba(255,0,0,0.6)]' : 'bg-zinc-800'}`}
      />
    </div>
  );
}

function SegmentPaths({ color, segments }: { color: string; segments: number }) {
  // Segments: bit 0=a(top), 1=b(topR), 2=c(botR), 3=d(bot), 4=e(botL), 5=f(topL), 6=g(mid)
  const paths = [
    segments & 0x01 ? <polygon key="a" points="10,5 50,5 46,11 14,11" fill={color} /> : null,    // a - top
    segments & 0x02 ? <polygon key="b" points="50,7 50,42 46,38 46,13" fill={color} /> : null,    // b - top right
    segments & 0x04 ? <polygon key="c" points="50,48 50,83 46,79 46,52" fill={color} /> : null,   // c - bot right
    segments & 0x08 ? <polygon key="d" points="10,85 50,85 46,79 14,79" fill={color} /> : null,   // d - bottom
    segments & 0x10 ? <polygon key="e" points="10,48 10,83 14,79 14,52" fill={color} /> : null,   // e - bot left
    segments & 0x20 ? <polygon key="f" points="10,7 10,42 14,38 14,13" fill={color} /> : null,    // f - top left
    segments & 0x40 ? <polygon key="g" points="10,44 50,44 46,48 14,48" fill={color} /> : null,   // g - middle
  ];
  return <>{paths}</>;
}

export default function Basys3Board({ moduleName, netlist, constraintsSource, isSynthesizing, onSynthesize }: Basys3BoardProps) {
  const [switches, setSwitches] = useState<boolean[]>(new Array(16).fill(false));
  const [buttons, setButtons] = useState({ btnC: false, btnU: false, btnD: false, btnL: false, btnR: false });

  const topPortNames = useMemo(() => {
    const ports = netlist?.modules?.[moduleName]?.ports;
    return ports ? Object.keys(ports) : [];
  }, [netlist, moduleName]);

  // Build constraint-based port mapping
  const rawPortMapping = useMemo(() => {
    if (!constraintsSource) return null;
    const mappings = buildBoardMapping(constraintsSource);
    return mappings.length > 0 ? mappings : null;
  }, [constraintsSource]);

  const portMapping = useMemo(() => {
    if (!rawPortMapping) return null;
    if (topPortNames.length === 0) return rawPortMapping;
    const topPorts = new Set(topPortNames);
    const filtered = rawPortMapping.filter(m => topPorts.has(m.userPort));
    return filtered.length > 0 ? filtered : rawPortMapping;
  }, [rawPortMapping, topPortNames]);

  const mappedTopPorts = useMemo(() => {
    if (!portMapping || topPortNames.length === 0) return 0;
    const topPorts = new Set(topPortNames);
    const covered = new Set<string>();
    for (const m of portMapping) {
      if (topPorts.has(m.userPort)) covered.add(m.userPort);
    }
    return covered.size;
  }, [portMapping, topPortNames]);

  // Build gate-level simulator when netlist changes
  const gateSim = useMemo(() => {
    if (!netlist || !moduleName) return null;
    try {
      return new GateLevelSimulator(netlist, moduleName);
    } catch (e) {
      console.warn('Failed to create gate-level simulator:', e);
      return null;
    }
  }, [netlist, moduleName]);

  // Build board-level inputs
  const boardInputs = useMemo(() => {
    let swVal = 0;
    for (let i = 0; i < 16; i++) {
      if (switches[i]) swVal |= (1 << i);
    }
    return {
      sw: swVal,
      clk: 0,
      btnC: buttons.btnC ? 1 : 0,
      btnU: buttons.btnU ? 1 : 0,
      btnD: buttons.btnD ? 1 : 0,
      btnL: buttons.btnL ? 1 : 0,
      btnR: buttons.btnR ? 1 : 0,
    };
  }, [switches, buttons]);

  // Evaluate design via gate-level simulator only
  const outputs = useMemo(() => {
    const defaults = { led: 0, seg: 0x7F, dp: 1, an: 0xF };
    if (!gateSim) return defaults;
    try {
      const simInputs = portMapping
        ? boardInputsToUserPorts(boardInputs, portMapping)
        : boardInputs;

      const rawResult = gateSim.evaluate(simInputs);

      if (portMapping) {
        const boardOut = userOutputsToBoardOutputs(rawResult, portMapping);
        return {
          led: boardOut.led ?? 0,
          seg: boardOut.seg ?? 0x7F,
          dp: boardOut.dp ?? 1,
          an: boardOut.an ?? 0xF,
        };
      }

      return {
        led: rawResult.led ?? 0,
        seg: rawResult.seg ?? 0x7F,
        dp: rawResult.dp ?? 1,
        an: rawResult.an ?? 0xF,
      };
    } catch (e) {
      console.warn('Board simulation error:', e);
      return defaults;
    }
  }, [gateSim, boardInputs, portMapping]);

  const debugRawOutputs = useMemo(() => {
    if (!gateSim) return null;
    try {
      const simInputs = portMapping
        ? boardInputsToUserPorts(boardInputs, portMapping)
        : boardInputs;
      return gateSim.evaluate(simInputs);
    } catch {
      return null;
    }
  }, [gateSim, boardInputs, portMapping]);

  const toggleSwitch = useCallback((idx: number) => {
    setSwitches(prev => {
      const next = [...prev];
      next[idx] = !next[idx];
      return next;
    });
  }, []);

  const pressButton = useCallback((name: keyof typeof buttons) => {
    setButtons(prev => ({ ...prev, [name]: true }));
  }, []);

  const releaseButton = useCallback((name: keyof typeof buttons) => {
    setButtons(prev => ({ ...prev, [name]: false }));
  }, []);

  return (
    <TooltipProvider>
      <div className="flex flex-col items-center gap-4 p-4">
        {/* Board title */}
        <div className="flex items-center gap-3">
          <Badge variant="secondary" className="bg-green-900/50 text-green-400 border-green-700">
            Basys 3
          </Badge>
          <span className="text-xs text-zinc-500">Artix-7 XC7A35T</span>
          {gateSim ? (
            <Badge variant="secondary" className="bg-blue-900/50 text-blue-400 border-blue-700 text-[10px]">
              Synthesized
            </Badge>
          ) : (
            <Badge variant="secondary" className="bg-zinc-800/50 text-zinc-500 border-zinc-700 text-[10px]">
              Not synthesized
            </Badge>
          )}
        </div>

        {/* Synthesis prompt when no netlist */}
        {!gateSim && (
          <div className="flex flex-col items-center gap-2 py-4 text-sm text-muted-foreground">
            <p>Design must be synthesized to simulate on the board.</p>
            {onSynthesize && (
              <button
                className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-500 disabled:opacity-50"
                onClick={onSynthesize}
                disabled={isSynthesizing}
              >
                {isSynthesizing ? 'Synthesizing...' : 'Synthesize Now'}
              </button>
            )}
          </div>
        )}

        {/* PCB Board */}
        <div className="relative bg-gradient-to-br from-green-950 via-green-900 to-green-950 rounded-2xl border-2 border-green-800 p-6 shadow-2xl shadow-green-950/50 min-w-[640px]">
          {/* Board silk screen text */}
          <div className="absolute top-2 left-4 text-[10px] text-green-600/50 font-mono">DIGILENT</div>
          <div className="absolute top-2 right-4 text-[10px] text-green-600/50 font-mono">REV B</div>

          {/* 7-Segment Displays */}
          <div className="flex justify-center gap-1 mb-6">
            <div className="text-[9px] text-green-600/60 font-mono absolute -mt-4">7-SEG DISPLAY</div>
            {[3, 2, 1, 0].map(i => (
              <SevenSegDisplay
                key={i}
                segments={outputs.seg}
                dp={outputs.dp}
                active={!((outputs.an >> i) & 1)}
              />
            ))}
          </div>

          {/* LEDs */}
          <div className="flex justify-center gap-2 mb-6">
            <div className="flex flex-col items-center gap-1">
              <div className="text-[9px] text-green-600/60 font-mono">LEDs</div>
              <div className="flex gap-1.5 flex-row-reverse">
                {Array.from({ length: 16 }, (_, i) => {
                  const isOn = (outputs.led >> i) & 1;
                  return (
                    <Tooltip key={i}>
                      <TooltipTrigger >
                        <div className="flex flex-col items-center gap-0.5">
                          <div
                            className={`w-3 h-3 rounded-full transition-all duration-100 ${
                              isOn
                                ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.7)]'
                                : 'bg-zinc-800 border border-zinc-700'
                            }`}
                          />
                          <span className="text-[7px] text-green-700/60">{i}</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        LED[{i}]: {isOn ? 'ON' : 'OFF'}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex justify-center mb-6">
            <div className="flex flex-col items-center gap-1">
              <div className="text-[9px] text-green-600/60 font-mono mb-1">BUTTONS</div>
              <div className="grid grid-cols-3 gap-1 w-24">
                <div />
                <BoardButton
                  label="U"
                  active={buttons.btnU}
                  onPress={() => pressButton('btnU')}
                  onRelease={() => releaseButton('btnU')}
                />
                <div />
                <BoardButton
                  label="L"
                  active={buttons.btnL}
                  onPress={() => pressButton('btnL')}
                  onRelease={() => releaseButton('btnL')}
                />
                <BoardButton
                  label="C"
                  active={buttons.btnC}
                  onPress={() => pressButton('btnC')}
                  onRelease={() => releaseButton('btnC')}
                  isCenter
                />
                <BoardButton
                  label="R"
                  active={buttons.btnR}
                  onPress={() => pressButton('btnR')}
                  onRelease={() => releaseButton('btnR')}
                />
                <div />
                <BoardButton
                  label="D"
                  active={buttons.btnD}
                  onPress={() => pressButton('btnD')}
                  onRelease={() => releaseButton('btnD')}
                />
                <div />
              </div>
            </div>
          </div>

          {/* Switches */}
          <div className="flex flex-col items-center gap-1">
            <div className="text-[9px] text-green-600/60 font-mono">SWITCHES</div>
            <div className="flex gap-1.5 flex-row-reverse">
              {Array.from({ length: 16 }, (_, i) => (
                <Tooltip key={i}>
                  <TooltipTrigger
                    className="flex flex-col items-center gap-0.5 cursor-pointer group"
                    onClick={() => toggleSwitch(i)}
                  >
                    <div className={`w-4 h-8 rounded-sm border transition-all ${
                      switches[i]
                        ? 'bg-zinc-300 border-zinc-400'
                        : 'bg-zinc-700 border-zinc-600'
                    }`}>
                      <div className={`w-full h-4 rounded-sm transition-all ${
                        switches[i]
                          ? 'bg-white shadow-sm translate-y-0'
                          : 'bg-zinc-500 translate-y-4'
                      }`} />
                    </div>
                    <span className="text-[7px] text-green-700/60">{i}</span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    SW[{i}]: {switches[i] ? '1 (HIGH)' : '0 (LOW)'}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>

          {/* Port indicators */}
          <div className="flex justify-between mt-4 px-2">
            <div className="flex gap-2">
              <div className="w-8 h-4 bg-zinc-800 rounded-sm border border-zinc-600" title="USB" />
              <div className="text-[7px] text-green-700/50 self-center">USB</div>
            </div>
            <div className="flex gap-2">
              <div className="text-[7px] text-green-700/50 self-center">VGA</div>
              <div className="w-10 h-4 bg-blue-950 rounded-sm border border-blue-800" title="VGA" />
            </div>
            <div className="flex gap-2">
              <div className="text-[7px] text-green-700/50 self-center">PMOD</div>
              <div className="flex gap-0.5">
                {[0, 1, 2, 3].map(i => (
                  <div key={i} className="w-1.5 h-3 bg-zinc-800 rounded-sm border border-zinc-700" />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Signal Status */}
        <div className="flex flex-wrap gap-2 text-xs font-mono max-w-[640px]">
          <span className="text-zinc-500">SW:</span>
          <span className="text-green-400">
            {(() => {
              let v = 0;
              switches.forEach((s, i) => { if (s) v |= (1 << i); });
              return `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
            })()}
          </span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">LED:</span>
          <span className="text-green-400">
            0x{(outputs.led & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')}
          </span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">SEG:</span>
          <span className="text-green-400">
            0x{(outputs.seg & 0x7F).toString(16).toUpperCase().padStart(2, '0')}
          </span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">AN:</span>
          <span className="text-green-400">
            0x{(outputs.an & 0xF).toString(16).toUpperCase()}
          </span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">MAP:</span>
          <span className={mappedTopPorts > 0 ? 'text-green-400' : 'text-amber-400'}>
            {mappedTopPorts}/{topPortNames.length || 0} ports
          </span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">RAW:</span>
          <span className="text-green-400">
            {debugRawOutputs
              ? Object.entries(debugRawOutputs)
                .slice(0, 4)
                .map(([k, v]) => `${k}=0x${(v >>> 0).toString(16).toUpperCase()}`)
                .join(', ')
              : 'n/a'}
          </span>
        </div>
      </div>
    </TooltipProvider>
  );
}

function BoardButton({
  label, active, onPress, onRelease, isCenter = false,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  onRelease: () => void;
  isCenter?: boolean;
}) {
  return (
    <button
      className={`w-7 h-7 rounded-full border-2 text-[9px] font-bold transition-all select-none ${
        active
          ? 'bg-zinc-300 border-zinc-100 text-zinc-900 scale-95 shadow-inner'
          : isCenter
          ? 'bg-red-900 border-red-700 text-red-300 hover:bg-red-800'
          : 'bg-zinc-700 border-zinc-500 text-zinc-300 hover:bg-zinc-600'
      }`}
      onMouseDown={onPress}
      onMouseUp={onRelease}
      onMouseLeave={onRelease}
    >
      {label}
    </button>
  );
}
