import { globalStyle } from '@vanilla-extract/css';

globalStyle('html, body', {
  fontFamily: '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif',
  WebkitFontSmoothing: 'antialiased',
  MozOsxFontSmoothing: 'grayscale',
});

globalStyle('code, pre, .mono', {
  fontFamily: '"JetBrains Mono", "Fira Code", monospace',
});
