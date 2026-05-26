import { globalStyle } from '@vanilla-extract/css';

globalStyle('*', {
  margin: 0,
  padding: 0,
  boxSizing: 'border-box',
});

globalStyle('html, body, #root', {
  height: '100%',
  width: '100%',
});

globalStyle('body', {
  lineHeight: 1.5,
  textSizeAdjust: '100%',
});

globalStyle('a', {
  color: 'inherit',
  textDecoration: 'none',
});

globalStyle('button', {
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
});

globalStyle('ul, ol', {
  listStyle: 'none',
});

globalStyle('img', {
  maxWidth: '100%',
  display: 'block',
});

globalStyle('::-webkit-scrollbar', {
  width: '6px',
  height: '6px',
});

globalStyle('::-webkit-scrollbar-track', {
  background: 'transparent',
});

globalStyle('::-webkit-scrollbar-thumb', {
  background: 'rgba(138, 147, 166, 0.3)',
  borderRadius: '3px',
});

globalStyle('::-webkit-scrollbar-thumb:hover', {
  background: 'rgba(138, 147, 166, 0.5)',
});
