import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
    resolveAlias: {
      'webworker-threads': './src/lib/empty-module.js',
      'elkjs': 'elkjs/lib/elk.bundled.js',
    },
  },
};

export default nextConfig;
