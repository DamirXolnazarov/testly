/**
 * _document.js
 * Custom Next.js Document — the correct place for tags that must be in
 * every page's real <head>, before any component renders.
 *
 * The viewport meta tag below was missing from the entire app. Without it,
 * mobile browsers assume a desktop-width layout (~980px) and shrink the
 * whole rendered page to fit the screen — which is what caused every page
 * to look oversized/zoomed-out and have elements clipped at the edges on
 * phones. This single tag fixes that root cause for every page at once;
 * it does not by itself make individual page layouts adapt their content
 * (spacing, stacking, font sizes) to a narrow screen — that's the separate,
 * per-page responsive work also done in this change.
 */
import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
