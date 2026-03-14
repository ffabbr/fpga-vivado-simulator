'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FileCode2, Cpu, Search, BookOpen } from 'lucide-react';

const WELCOME_STORAGE_KEY = 'fpga-studio-welcomed';

const pages = [
  {
    icon: FileCode2,
    title: 'Welcome to FPGA Studio',
    description: 'A browser-based FPGA development environment with Verilog editing, synthesis, simulation, and board emulation — no installation required.',
    imageDark: '/Editor-Close.webp',
    imageLight: '/Editor-Close-Light.webp',
    imageAlt: 'FPGA Studio code editor',
  },
  {
    icon: Cpu,
    title: 'Board Emulation',
    description: 'Synthesize your Verilog designs with Yosys and interact with a virtual Basys 3 FPGA board — toggle switches, see LEDs respond in real time.',
    imageDark: '/Board-Close.webp',
    imageLight: '/Board-Close-Light.webp',
    imageAlt: 'Basys 3 board emulation',
  },
  {
    icon: Search,
    title: 'Command Palette',
    description: 'Press Cmd/Ctrl+K to quickly search files, run synthesis, start simulations, and access all features from one place.',
    imageDark: '/Command-Close.webp',
    imageLight: '/Command-Close-Light.webp',
    imageAlt: 'Command palette',
  },
  {
    icon: BookOpen,
    title: 'Get Started',
    description: 'Create a new Verilog file to start from scratch, or load the built-in example project to explore a working 4-bit adder design.',
    imageDark: null,
    imageLight: null,
    imageAlt: null,
  },
];

interface WelcomeDialogProps {
  onLoadExample: () => void;
}

export default function WelcomeDialog({ onLoadExample }: WelcomeDialogProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const welcomed = localStorage.getItem(WELCOME_STORAGE_KEY);
    if (!welcomed) {
      setOpen(true);
    }
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  const handleClose = () => {
    localStorage.setItem(WELCOME_STORAGE_KEY, 'true');
    setOpen(false);
  };

  const handleLoadExample = () => {
    localStorage.setItem(WELCOME_STORAGE_KEY, 'true');
    setOpen(false);
    onLoadExample();
  };

  const isLastPage = page === pages.length - 1;
  const current = pages[page];
  const Icon = current.icon;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) handleClose();
    }}>
      <DialogContent className="sm:max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-primary" />
            {current.title}
          </DialogTitle>
          <DialogDescription>{current.description}</DialogDescription>
        </DialogHeader>

        {current.imageDark && (
          <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-border bg-muted">
            <Image
              src={isDark ? current.imageDark : current.imageLight!}
              alt={current.imageAlt || ''}
              fill
              className="object-cover"
              priority
            />
          </div>
        )}

        {/* Page indicators */}
        <div className="flex justify-center gap-1.5">
          {pages.map((_, i) => (
            <button
              key={i}
              onClick={() => setPage(i)}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === page ? 'bg-primary' : 'bg-muted-foreground/30'
              }`}
            />
          ))}
        </div>

        <DialogFooter>
          {isLastPage ? (
            <>
              <Button variant="outline" onClick={handleLoadExample}>
                <BookOpen className="h-4 w-4 mr-2" />
                Load Example
              </Button>
              <Button onClick={handleClose}>
                Start
              </Button>
            </>
          ) : (
            <Button onClick={() => setPage(page + 1)}>
              Next
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
