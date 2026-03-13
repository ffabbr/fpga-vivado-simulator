import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FPGA Studio - Vivado-like FPGA Simulator",
  description: "Web-based FPGA development environment with Verilog editor, simulator, and Basys 3 board emulation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${geistMono.variable} antialiased bg-background`}>
        {children}
        <Analytics />
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
