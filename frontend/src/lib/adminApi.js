/**
 * adminApi.js
 * Thin fetch wrapper for admin routes — attaches the stored JWT and
 * normalizes 401s so the dashboard can bounce back to login cleanly.
 * Token lives in localStorage under "testly_admin_token"; swap for an
 * httpOnly cookie if this ever needs to be XSS-hardened beyond a pilot.
 */

const TOKEN_KEY = "testly_admin_token";

export function getToken() {
  return typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
}

export function setToken(token) {
  if (typeof window !== "undefined") localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
}

/** Fetch wrapper for admin-protected routes. Throws on non-2xx with the
 * server's { error } message when available. Fires onUnauthorized() on 401
 * so the caller can redirect to login without every call site checking. */
export async function adminFetch(path, options = {}, onUnauthorized) {
  const token = getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    onUnauthorized && onUnauthorized();
    throw new Error("Session expired — please log in again.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`);
    if (Array.isArray(body.details)) err.details = body.details;
    throw err;
  }
  return res.json();
}