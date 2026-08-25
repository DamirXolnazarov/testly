/**
 * theme.js — Testly brand tokens, derived from the logo.
 *
 * Scope note: these tokens are for Testly's OWN surfaces only — landing,
 * admin login/dashboard/test room, and the student pre-test flow. The
 * IELTS exam interface itself (IELTSCDReplica.jsx) intentionally does NOT
 * use these — it stays a faithful monochrome replica of the real IELTS CD
 * UI, per the design brief. Don't import this into that file.
 */

export const COLORS = {
  navy: "#111D40",
  navyMuted: "#5B6178",
  purple: "#5B50E6",
  purpleHover: "#4A40D6",
  purpleSoft: "#EEECFD",
  bg: "#F7F8FC",
  border: "#E7E8F2",
  white: "#FFFFFF",
};

export const RADIUS = {
  sm: "9px",
  md: "12px",
  lg: "16px",
};