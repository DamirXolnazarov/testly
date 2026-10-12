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
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;

  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        ...(options.headers || {}),
        // FormData (used for zip/file uploads) must NOT get an explicit
        // Content-Type here — the browser sets multipart/form-data with the
        // correct boundary itself only when Content-Type is left unset. If we
        // force application/json (as this used to do unconditionally for any
        // truthy body), Express's express.json() middleware tries to parse
        // the raw multipart bytes as JSON and throws "PayloadTooLargeError"
        // the moment the file exceeds its small default text-body limit —
        // the upload never even reaches multer.
        ...(options.body && !isFormData ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (e) {
    throw new Error("The backend is temporarily unavailable. Please refresh and try again.");
  }

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

/**
 * POSTs to an admin route that answers with server-sent events (the AI
 * Studio chat) and calls onEvent(eventName, data) for each one as it
 * arrives. Resolves when the stream ends; throws like adminFetch does when
 * the request is refused before any stream starts.
 */
export async function adminStream(path, body, onEvent, onUnauthorized) {
  const token = getToken();
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("The backend is temporarily unavailable. Please refresh and try again.");
  }

  if (res.status === 401) {
    clearToken();
    onUnauthorized && onUnauthorized();
    throw new Error("Session expired — please log in again.");
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Events are separated by a blank line; keep any unfinished tail.
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue; // keep-alive comment
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      onEvent(event, parsed);
    }
  }
}
