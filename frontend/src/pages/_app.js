export default function App({ Component, pageProps }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        html, body, #__next { width:100%; min-height:100%; margin:0; padding:0; }
        *, *::before, *::after { box-sizing:border-box; }
      ` }} />
      <Component {...pageProps} />
    </>
  );
}