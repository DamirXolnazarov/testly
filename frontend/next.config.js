/**
 * next.config.js
 * Proxies /api/* to the backend (Express, port 4000 by default) so every
 * fetch('/api/...') call already scattered through the components (adminApi.js,
 * ExamSession.jsx, PreTestFlow.jsx) just works with zero CORS setup — the
 * browser only ever talks to the Next.js dev server, which forwards server-side.
 *
 * If your backend runs on a different port/host, change BACKEND_URL below
 * (or set it via an env var — see the fallback).
 */

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;