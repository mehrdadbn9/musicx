
const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = '<!doctype html>\n<html lang="en" dir="ltr">\n  <head>\n    <meta charset="UTF-8" />\n    <!-- viewport-fit=cover lets the app paint behind the notch and the home\n         indicator, which is what an installed PWA should look like. It also\n         makes env(safe-area-inset-*) report real values — everything pinned\n         to an edge (the dock FAB, toasts, the footer) pads itself with them. -->\n    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />\n\n    <title>MusicX — every song, one search</title>\n    <meta\n      name="description"\n      content="Paste a Spotify, YouTube, SoundCloud, Apple Music or Deezer link — or search every catalog at once — and download tagged MP3s at the quality you pick, or stream them in-browser. Free, no account."\n    />\n    <meta name="theme-color" content="#0b0a10" />\n    <meta name="mobile-web-app-capable" content="yes" />\n    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />\n    <meta name="apple-mobile-web-app-title" content="MusicX" />\n\n    <!-- Icons -->\n    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />\n    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />\n    <link rel="manifest" href="/manifest.webmanifest" />\n\n    <!-- Open Graph / Twitter. When deploying, replace the og:url and og:image\n         values with absolute URLs on your domain — scrapers need them. -->\n    <meta property="og:type" content="website" />\n    <meta property="og:site_name" content="MusicX" />\n    <meta property="og:locale" content="en_US" />\n    <meta property="og:title" content="MusicX — every song, one search" />\n    <meta\n      property="og:description"\n      content="Paste a Spotify, YouTube, SoundCloud, Apple Music or Deezer link — or search every catalog at once — and download tagged MP3s, or stream them in-browser. Free, no account."\n    />\n    <meta property="og:image" content="/og.png" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />\n    <meta name="twitter:card" content="summary_large_image" />\n    <meta name="twitter:title" content="MusicX — every song, one search" />\n    <meta\n      name="twitter:description"\n      content="Paste a Spotify, YouTube, SoundCloud, Apple Music or Deezer link — or search every catalog at once — and download tagged MP3s, or stream them in-browser. Free, no account."\n    />\n    <meta name="twitter:image" content="/og.png" />\n\n    <script type="application/ld+json">\n      {\n        "@context": "https://schema.org",\n        "@type": "WebApplication",\n        "name": "MusicX",\n        "applicationCategory": "MultimediaApplication",\n        "operatingSystem": "Web",\n        "inLanguage": "en",\n        "description": "Paste a Spotify, YouTube, SoundCloud, Apple Music or Deezer link — or search every catalog at once — and download tagged MP3s, or stream them in-browser. Free, no account.",\n        "offers": { "@type": "Offer", "price": "0" }\n      }\n    </script>\n\n    <!-- Self-hosted Inter (docs/DESIGN.md): preload exactly the weights the UI\n         uses. hrefs must match the url()s in index.css byte-for-byte, and font\n         preloads need crossorigin even same-origin, or they download twice.\n         Vazirmatn stays behind Inter for Persian glyphs and loads on demand. -->\n    <link\n      rel="preload"\n      as="font"\n      type="font/woff2"\n      href="/fonts/Inter-400.woff2"\n      crossorigin\n    />\n    <link\n      rel="preload"\n      as="font"\n      type="font/woff2"\n      href="/fonts/Inter-500.woff2"\n      crossorigin\n    />\n    <link\n      rel="preload"\n      as="font"\n      type="font/woff2"\n      href="/fonts/Inter-600.woff2"\n      crossorigin\n    />\n    <link\n      rel="preload"\n      as="font"\n      type="font/woff2"\n      href="/fonts/Inter-700.woff2"\n      crossorigin\n    />\n    <script type="module" crossorigin src="file:///root/music/local/unstream-main/frontend/dist/assets/index-h_92c6Eh.js"></script>\n    <link rel="stylesheet" crossorigin href="/assets/index-BPRD6QXX.css">\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n';
const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'http://localhost:8080/',
  pretendToBeVisual: true,
});
const { window } = dom;
// minimal shims
window.matchMedia = window.matchMedia || function(){ return { matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }; };
window.scrollTo = window.scrollTo || function(){};
if (!window.localStorage) {
  const store = {};
  window.localStorage = { getItem:k=>store[k]??null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
}
window.requestAnimationFrame = window.requestAnimationFrame || ((cb)=>setTimeout(()=>cb(Date.now()),0));
window.cancelAnimationFrame = window.cancelAnimationFrame || ((id)=>clearTimeout(id));
const errors = [];
window.addEventListener('error', e => errors.push('ERROR: ' + (e.error?.stack || e.message)));
window.onerror = (m,s,l,c,err) => errors.push('ONERROR: ' + (err?.stack || m));
const code = fs.readFileSync('/root/music/local/unstream-main/frontend/dist/assets/index-h_92c6Eh.js', 'utf8');
try {
  const fn = new Function('window','document','navigator','self','globalThis','import','module','exports', code);
  fn(window, window.document, window.navigator, window, window, undefined, undefined, undefined);
} catch (e) {
  errors.push('THROW: ' + (e.stack || e.message));
}
// give React a tick
setTimeout(() => {
  const root = window.document.getElementById('root');
  console.log('=== ROOT innerHTML length:', root ? root.innerHTML.length : 'NO ROOT');
  console.log('=== ROOT first 400:', root ? root.innerHTML.slice(0,400) : '');
  console.log('=== ERRORS (' + errors.length + ') ===');
  errors.slice(0,10).forEach(e => console.log(e.slice(0,800)));
  process.exit(0);
}, 1500);
