import React, { useState, useEffect } from "react";
import Head from "next/head";
import AdminLogin from "./AdminLogin";
import Studio from "../components/studio/Studio";
import { adminFetch, clearToken } from "../lib/adminApi";

/**
 * /studio — Testly Studio. Same sign-in as /admin for now (self-serve
 * accounts and plans are a later phase), then the one-screen studio.
 */
export default function StudioPage() {
  const [state, setState] = useState("checking"); // checking | out | in
  const [admin, setAdmin] = useState(null);

  useEffect(() => {
    adminFetch("/api/auth/me")
      .then((data) => { setAdmin(data.admin); setState("in"); })
      .catch(() => setState("out"));
  }, []);

  return (
    <>
      <Head>
        <title>Testly Studio</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;650;700&display=swap" rel="stylesheet" />
      </Head>
      {state === "checking" && <div style={{ position: "fixed", inset: 0, background: "#0c0d11" }} />}
      {state === "out" && <AdminLogin onSuccess={(a) => { setAdmin(a); setState("in"); }} />}
      {state === "in" && <Studio admin={admin} onLogout={() => { clearToken(); setState("out"); }} />}
    </>
  );
}
