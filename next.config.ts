import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      'webworker-threads': './src/lib/empty-module.js',
      'elkjs': 'elkjs/lib/elk.bundled.js',
    },
  },
};

export default nextConfig;
