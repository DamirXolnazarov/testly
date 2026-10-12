/**
 * _document.js
 * Custom Next.js Document — document-level structure only.
 *
 * NOTE: the viewport meta tag lives in _app.js via next/head, NOT here.
 * Next warns that viewport meta should not be used in _document's <Head>.
 */
import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
