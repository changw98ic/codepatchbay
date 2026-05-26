// SVG filter definitions for Liquid Glass noise texture
// Injected as inline SVG in the document head for backdrop-filter reference

export function createGlassFilterSVG(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0">
  <defs>
    <filter id="glass-noise" x="0%" y="0%" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" result="noise"/>
      <feColorMatrix type="saturate" values="0" in="noise" result="grayNoise"/>
      <feComponentTransfer in="grayNoise" result="subtleNoise">
        <feFuncA type="linear" slope="0.05"/>
      </feComponentTransfer>
      <feBlend in="SourceGraphic" in2="subtleNoise" mode="overlay"/>
    </filter>
    <filter id="glass-displacement" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.01" numOctaves="2" result="warp"/>
      <feDisplacementMap in="SourceGraphic" in2="warp" scale="2" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
</svg>`;
}

export function injectGlassFilters(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('glass-svg-filters')) return;

  const div = document.createElement('div');
  div.id = 'glass-svg-filters';
  div.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  div.innerHTML = createGlassFilterSVG();
  document.head.appendChild(div);
}
