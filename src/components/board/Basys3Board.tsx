'use client';

import { useState, useCallback, useMemo } from 'react';
import { GateLevelSimulator, type YosysNetlist } from '@/lib/gate-sim';
import {
  buildBoardMapping,
  boardInputsToUserPorts,
  userOutputsToBoardOutputs,
} from '@/lib/constraints-parser';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Zap } from 'lucide-react';

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
  const dpOn = active && !(dp & 1);
  return (
    <div className="w-[42px] h-[60px] bg-[#0c0c0c] flex items-center justify-center relative overflow-hidden border-r border-[#1a1a1a] last:border-r-0">
      <div className="absolute inset-0 bg-red-500/5 mix-blend-overlay" />
      <svg viewBox="0 0 60 90" className="w-[75%] h-[80%] origin-center skew-x-[-6deg] opacity-90 drop-shadow-[0_0_2px_rgba(255,0,0,0.2)]">
        <SegmentPaths color="#220505" segments={0x7F} />
        {active && <SegmentPaths color="#ff1e1e" segments={~segments & 0x7F} glow />}
      </svg>
      {/* Decimal point */}
      <div
        className={`absolute bottom-[4px] right-[4px] w-[5px] h-[5px] rounded-full ${dpOn ? 'bg-[#ff1e1e] shadow-[0_0_4px_rgba(255,30,30,0.8)]' : 'bg-[#220505]'}`}
      />
    </div>
  );
}

function SegmentPaths({ color, segments, glow }: { color: string; segments: number; glow?: boolean }) {
  const g = glow ? " drop-shadow-[0_0_4px_rgba(255,0,0,0.8)]" : "";
  const paths = [
    segments & 0x01 ? <polygon key="a" points="14,6 46,6 42,12 18,12" fill={color} className={g} /> : null,
    segments & 0x02 ? <polygon key="b" points="48,8 48,42 42,39 42,14" fill={color} className={g} /> : null,
    segments & 0x04 ? <polygon key="c" points="48,48 48,82 42,76 42,51" fill={color} className={g} /> : null,
    segments & 0x08 ? <polygon key="d" points="14,84 46,84 42,78 18,78" fill={color} className={g} /> : null,
    segments & 0x10 ? <polygon key="e" points="12,48 12,82 18,76 18,51" fill={color} className={g} /> : null,
    segments & 0x20 ? <polygon key="f" points="12,8 12,42 18,39 18,14" fill={color} className={g} /> : null,
    segments & 0x40 ? <polygon key="g" points="14,45 46,45 40,49 20,49 14,45" fill={color} className={g} /> : null,
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
        {/* Board title & status */}
        <div className="flex items-center gap-3 w-[740px]">
          <Badge variant="secondary" className="bg-blue-900/50 text-blue-400 border-blue-700">
            Basys 3
          </Badge>
          <span className="text-xs text-muted-foreground">Artix-7 XC7A35T</span>
          {gateSim ? (
            <Badge variant="secondary" className="bg-green-900/50 text-green-400 border-green-700 text-[10px]">
              Synthesized
            </Badge>
          ) : (
            <Badge variant="secondary" className="bg-muted text-muted-foreground border-border text-[10px]">
              Not synthesized
            </Badge>
          )}
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground font-mono">
             LED: 0x{(outputs.led & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')} | 
             SW: 0x{switches.reduce((acc, s, i) => acc | (s ? 1 << i : 0), 0).toString(16).toUpperCase().padStart(4, '0')}
          </span>
        </div>

        {/* Synthesis prompt when no netlist */}
        {!gateSim && (
          <div className="w-[740px] rounded-xl border border-blue-500/30 bg-card/80 px-4 py-4 shadow-lg shadow-blue-500/10 backdrop-blur-sm">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-md border border-blue-500/40 bg-blue-500/10 p-2 text-blue-600 dark:text-blue-300">
                  <Zap className="h-4 w-4" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">Synthesis Required</p>
                  <p className="text-xs text-muted-foreground">Design must be synthesized to simulate on the board.</p>
                </div>
              </div>
            {onSynthesize && (
              <Button
                size="sm"
                variant="default"
                className="bg-blue-600 hover:bg-blue-500 text-white"
                onClick={onSynthesize}
                disabled={isSynthesizing}
              >
                {isSynthesizing ? 'Synthesizing...' : 'Synthesize Now'}
              </Button>
            )}
            </div>
          </div>
        )}

        {/* PCB Board - Realistic View */}
        <div className="relative w-[740px] h-[480px] bg-[#1a365d] rounded-xl border border-[#14294a] shadow-2xl shadow-blue-900/20 overflow-hidden font-mono text-zinc-200 select-none ring-4 ring-[#0f1f38]">
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:20px_20px] opacity-20 pointer-events-none" />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: [
                'radial-gradient(circle at 10px 12px, rgba(255,255,255,0.42) 0 0.9px, transparent 1.1px)',
                'radial-gradient(circle at 34px 22px, rgba(255,255,255,0.34) 0 0.8px, transparent 1.1px)',
                'radial-gradient(circle at 22px 34px, rgba(255,255,255,0.30) 0 0.8px, transparent 1.1px)',
                'linear-gradient(27deg, transparent 0 44%, rgba(255,255,255,0.09) 45%, rgba(255,255,255,0.09) 46%, transparent 47%)',
              ].join(','),
              backgroundSize: '44px 44px, 58px 58px, 72px 72px, 110px 110px',
              backgroundRepeat: 'repeat',
              opacity: 0.55,
              mixBlendMode: 'screen',
            }}
          />

          {/* Mounting Holes */}
          <div className="absolute top-3 left-3 w-5 h-5 rounded-full bg-zinc-950 border-4 border-zinc-400/20 shadow-inner" />
          <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-zinc-950 border-4 border-zinc-400/20 shadow-inner" />
          <div className="absolute bottom-3 left-3 w-5 h-5 rounded-full bg-zinc-950 border-4 border-zinc-400/20 shadow-inner" />
          <div className="absolute bottom-3 right-3 w-5 h-5 rounded-full bg-zinc-950 border-4 border-zinc-400/20 shadow-inner" />

          {/* Silkscreen Logos */}
          <div className="absolute top-[160px] left-[160px] flex items-center gap-2 opacity-80">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white">
              <path d="M12 2L2 22h20L12 2z" />
              <path d="M12 8l-6 10h12l-6-10z" />
            </svg>
            <div className="flex flex-col">
              <span className="text-xl font-bold tracking-wider text-white">DIGILENT</span>
              <span className="text-[8px]">www.digilentinc.com</span>
            </div>
          </div>
          
          <div className="absolute top-[165px] right-[100px] flex gap-2 opacity-80">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-white">
               <rect x="2" y="2" width="8" height="8" />
               <rect x="14" y="14" width="8" height="8" />
               <rect x="14" y="2" width="8" height="8" />
               <rect x="2" y="14" width="8" height="8" />
            </svg>
            <div className="flex flex-col">
              <span className="text-xl font-bold tracking-wider text-white">XILINX</span>
              <span className="text-[8px] tracking-widest">| UNIVERSITY PROGRAM</span>
            </div>
          </div>

          <div className="absolute bottom-[200px] left-[300px] opacity-80">
             <span className="text-3xl font-bold text-white tracking-widest bg-[#1a365d] px-2 py-1 border-2 border-white rounded-md">BASYS 3</span>
          </div>

          {/* Top Panel Connectors */}
          <div className="absolute top-0 left-[90px] w-12 h-16 bg-zinc-900 flex flex-col justify-end p-2 border-b border-zinc-700">
             <div className="text-[7px] text-center mb-1 text-white">POWER</div>
             <div className="w-full h-8 bg-black rounded-sm relative shadow-inner flex shrink-0">
               <div className="absolute top-0 w-full h-1/2 bg-zinc-300 rounded-sm shadow-sm" />
             </div>
          </div>
          <div className="absolute top-0 left-[160px] w-14 h-12 bg-zinc-300 border-b border-zinc-400 rounded-b-sm shadow-md flex justify-center">
             <div className="w-8 h-4 bg-zinc-900 rounded-b-sm" />
             <div className="absolute -bottom-4 text-[7px] text-white">PROG</div>
          </div>
          <div className="absolute top-0 left-[300px] w-32 h-16 flex flex-col items-center">
            <div className="w-full h-12 bg-[#2c2c2c] border-b-4 border-[#1a1a1a] rounded-b shadow-md flex justify-between px-2 pt-2">
               <div className="w-4 h-4 rounded-full bg-zinc-300/50" />
               <div className="w-4 h-4 rounded-full bg-zinc-300/50" />
            </div>
            <div className="text-[8px] text-white mt-1">VGA</div>
          </div>
          <div className="absolute top-0 right-[150px] w-20 h-24 bg-zinc-200 border-b border-zinc-300 rounded-b shadow-md flex flex-col items-center pt-2 gap-2">
            <div className="w-16 h-4 bg-black rounded-sm" />
            <div className="w-16 h-4 bg-black rounded-sm" />
            <div className="absolute -bottom-4 text-[7px] text-white">USB</div>
          </div>
          
          {/* Main FPGA Chip */}
          <div className="absolute top-[130px] left-[350px] w-[90px] h-[90px] bg-zinc-800 rounded-sm border border-zinc-700 shadow-xl flex flex-col items-center justify-center p-2">
            <span className="text-[10px] text-zinc-500 font-bold tracking-widest">ARTIX-7</span>
            <span className="text-[7px] text-zinc-600">XC7A35T</span>
            <div className="w-4 h-4 rounded-full bg-zinc-900 absolute bottom-2 left-2 shadow-inner" />
          </div>

          {/* PMOD Connectors */}
          <div className="absolute top-[80px] left-0 flex items-center">
            <div className="w-6 h-20 bg-zinc-900 border-r border-y border-zinc-700 rounded-r-sm shadow-md flex justify-center py-1">
              <div className="flex flex-wrap flex-col gap-1 w-2">
                 {[...Array(6)].map((_,i) => <div key={`ja1-${i}`} className="w-1.5 h-1.5 bg-yellow-400/30 rounded-full" />)}
                 {[...Array(6)].map((_,i) => <div key={`ja2-${i}`} className="w-1.5 h-1.5 bg-yellow-400/30 rounded-full" />)}
              </div>
            </div>
            <span className="text-[9px] text-white ml-2">JA</span>
          </div>
          <div className="absolute top-[230px] left-0 flex items-center">
            <div className="w-6 h-20 bg-zinc-900 border-r border-y border-zinc-700 rounded-r-sm shadow-md flex justify-center py-1">
              <div className="flex flex-wrap flex-col gap-1 w-2">
                 {[...Array(6)].map((_,i) => <div key={`jd1-${i}`} className="w-1.5 h-1.5 bg-yellow-400/30 rounded-full" />)}
                 {[...Array(6)].map((_,i) => <div key={`jd2-${i}`} className="w-1.5 h-1.5 bg-yellow-400/30 rounded-full" />)}
              </div>
            </div>
            <span className="text-[9px] text-white ml-2">JXADC</span>
          </div>
          <div className="absolute top-[100px] right-0 flex items-center flex-row-reverse">
            <div className="w-6 h-20 bg-zinc-900 border-l border-y border-zinc-700 rounded-l-sm shadow-md flex justify-center py-1">
               <div className="flex flex-wrap flex-col gap-1 w-2">
                 {[...Array(6)].map((_,i) => <div key={`jb1-${i}`} className="w-1.5 h-1.5 bg-yellow-400/30 rounded-full" />)}
                 {[...Array(6)].map((_,i) => <div key={`jb2-${i}`} className="w-1.5 h-1.5 bg-yellow-400/30 rounded-full" />)}
              </div>
            </div>
            <span className="text-[9px] text-white mr-2">JB</span>
          </div>
          <div className="absolute top-[250px] right-0 flex items-center flex-row-reverse">
            <div className="w-6 h-20 bg-zinc-900 border-l border-y border-zinc-700 rounded-l-sm shadow-md flex justify-center py-1">
               <div className="flex flex-wrap flex-col gap-1 w-2">
                 {[...Array(6)].map((_,i) => <div key={`jc1-${i}`} className="w-1.5 h-1.5 bg-yellow-400/30 rounded-full" />)}
                 {[...Array(6)].map((_,i) => <div key={`jc2-${i}`} className="w-1.5 h-1.5 bg-yellow-400/30 rounded-full" />)}
              </div>
            </div>
            <span className="text-[9px] text-white mr-2">JC</span>
          </div>

          {/* 7-Segment Display Module */}
          <div className="absolute bottom-[130px] left-[70px]">
            <span className="text-[8px] text-white block mb-1">DISP1</span>
            <div className="flex bg-[#0a0a0a] border-4 border-zinc-800 p-1 rounded-sm shadow-lg">
              {[3, 2, 1, 0].map(i => (
                <SevenSegDisplay
                  key={i}
                  segments={outputs.seg}
                  dp={outputs.dp}
                  active={!((outputs.an >> i) & 1)}
                />
              ))}
            </div>
          </div>

          {/* Buttons Area */}
          <div className="absolute bottom-[145px] right-[130px] w-32 h-32">
            <BoardButton
              label="U"
              silkscreen="BTNU"
              active={buttons.btnU}
              onPress={() => pressButton('btnU')}
              onRelease={() => releaseButton('btnU')}
              className="absolute top-0 left-[40px]"
            />
            <BoardButton
              label="L"
              silkscreen="BTNL"
              active={buttons.btnL}
              onPress={() => pressButton('btnL')}
              onRelease={() => releaseButton('btnL')}
              className="absolute top-[40px] left-0 mt-2"
            />
            <BoardButton
              label="C"
              silkscreen="BTNC"
              active={buttons.btnC}
              onPress={() => pressButton('btnC')}
              onRelease={() => releaseButton('btnC')}
              className="absolute top-[40px] left-[40px] mt-2"
            />
            <BoardButton
              label="R"
              silkscreen="BTNR"
              active={buttons.btnR}
              onPress={() => pressButton('btnR')}
              onRelease={() => releaseButton('btnR')}
              className="absolute top-[40px] left-[80px] mt-2"
            />
            <BoardButton
              label="D"
              silkscreen="BTND"
              active={buttons.btnD}
              onPress={() => pressButton('btnD')}
              onRelease={() => releaseButton('btnD')}
              className="absolute top-[80px] left-[40px] mt-4"
            />
          </div>

          {/* LEDs Array */}
          <div className="absolute bottom-[70px] left-0 w-full px-[54px] flex justify-between flex-row-reverse">
             {Array.from({ length: 16 }, (_, i) => {
               const isOn = (outputs.led >> i) & 1;
               return (
                 <Tooltip key={`led-${i}`}>
                   <TooltipTrigger>
                     <div className="flex flex-col items-center gap-1 w-8">
                       <span className="text-[8px] font-bold text-white mb-1">LD{i}</span>
                       <div
                         className={`w-3 h-2 rounded-[1px] transition-all duration-75 shadow-sm ${
                           isOn
                             ? 'bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.9)]'
                             : 'bg-zinc-600/50'
                         }`}
                       />
                     </div>
                   </TooltipTrigger>
                   <TooltipContent className="text-xs">
                      LED[{i}]
                   </TooltipContent>
                 </Tooltip>
               );
             })}
          </div>

          {/* Switches Array */}
          <div className="absolute bottom-[20px] left-0 w-full px-[54px] flex justify-between flex-row-reverse">
             {Array.from({ length: 16 }, (_, i) => (
                <Tooltip key={`sw-${i}`}>
                  <TooltipTrigger>
                    <div 
                      className="flex flex-col items-center w-8 cursor-pointer group"
                      onClick={() => toggleSwitch(i)}
                    >
                      {/* Switch Body - MORE OBVIOUS SWITCH STATE */}
                      <div className={`w-5 h-9 bg-zinc-950 rounded border border-zinc-800 p-0.5 shadow-[inset_0_2px_4px_rgba(0,0,0,0.6)] flex justify-center relative overflow-hidden transition-colors ${switches[i] ? 'bg-zinc-900 border-zinc-700' : ''}`}>
                        {/* Switch Track underlying color to indicate ON */}
                        <div className={`absolute top-0 w-full h-1/2 bg-green-500/20 transition-opacity ${switches[i] ? 'opacity-100' : 'opacity-0'}`} />
                        <div className="w-1 h-full bg-black rounded-full shadow-inner z-0" />
                        {/* Switch Slider */}
                        <div className={`absolute w-[18px] h-[16px] rounded-[2px] shadow-sm transition-all duration-150 z-10 flex flex-col items-center justify-center ${
                          switches[i] 
                            ? 'top-[2px] bg-white border-b-2 border-zinc-300 shadow-[0_2px_5px_rgba(0,0,0,0.5)] scale-105' 
                            : 'bottom-[2px] bg-zinc-500 border-t-2 border-zinc-400 shadow-[0_-2px_5px_rgba(0,0,0,0.5)]'
                        }`}>
                          <div className={`w-3 h-[2px] flex flex-col gap-[2px] ${switches[i] ? 'opacity-100' : 'opacity-50'}`}>
                            <div className="w-full h-[1px] bg-black/30" />
                            <div className="w-full h-[1px] bg-black/30" />
                          </div>
                        </div>
                      </div>
                      <span className="text-[7px] text-zinc-400 mt-2">({['V17','V16','W16','W17','W15','V15','W14','W13','V2','T3','T2','R3','W2','U1','T1','R2'][i]})</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">
                     Switch {i}
                  </TooltipContent>
                </Tooltip>
             ))}
          </div>

        </div>
      </div>
    </TooltipProvider>
  );
}


function BoardButton({
  label, silkscreen, active, onPress, onRelease, className
}: {
  label: string;
  silkscreen: string;
  active: boolean;
  onPress: () => void;
  onRelease: () => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center ${className}`}>
      <span className="text-[9px] text-zinc-300 font-mono mb-1">{silkscreen}</span>
      <button 
        className={`w-7 h-7 rounded-full border-2 flex items-center justify-center font-bold text-xs transition-all select-none shadow-md ${
          active 
            ? 'bg-zinc-300 border-zinc-100 text-zinc-900 scale-95 shadow-inner' 
            : 'bg-zinc-700 border-zinc-500 text-zinc-200 hover:bg-zinc-600'
        }`}
        onMouseDown={onPress}
        onMouseUp={onRelease}
        onMouseLeave={onRelease}
      >
        {label}
      </button>
    </div>
  );
}
