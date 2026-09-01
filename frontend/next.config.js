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

const FALLBACK_BACKEND_URL = "https://testly-1pdv.onrender.com";

const BACKEND_URL =
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:4000" : FALLBACK_BACKEND_URL);

if (!process.env.BACKEND_URL && process.env.NODE_ENV !== "development") {
  console.warn(
    `[next.config] Using fallback BACKEND_URL=${FALLBACK_BACKEND_URL}. Set BACKEND_URL explicitly in Vercel to avoid stale production defaults.`
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    if (!BACKEND_URL) return [];
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL.replace(/\/$/, "")}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;