import Head from "next/head";

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        {/* Viewport belongs here (next/head), not in _document.js — Next warns
            against viewport meta in _document's <Head>. Without it, mobile
            browsers assume ~980px desktop width and shrink the page. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=5"
        />
      </Head>
      <style dangerouslySetInnerHTML={{ __html: `
        html, body, #__next { width:100%; min-height:100%; margin:0; padding:0; }
        *, *::before, *::after { box-sizing:border-box; }
      ` }} />
      <Component {...pageProps} />
    </>
  );
}