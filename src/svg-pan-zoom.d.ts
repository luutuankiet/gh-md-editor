// v0.7.3: svg-pan-zoom v3.6.2 ships without TypeScript types. Local shim
// covers the surface we actually use in src/lib/mermaid.ts — destroy() for
// the morphdom discard hook, zoom/pan/fit/center for the toolbar buttons,
// zoomAtPointBy for the custom wheel handler.
declare module 'svg-pan-zoom' {
  export interface Instance {
    destroy(): void;
    zoomBy(n: number): Instance;
    zoomAtPointBy(n: number, p: { x: number; y: number }): Instance;
    resetZoom(): Instance;
    resetPan(): Instance;
    fit(): Instance;
    center(): Instance;
    disableDblClickZoom(): Instance;
    [k: string]: any;
  }
  export interface Options {
    panEnabled?: boolean;
    controlIconsEnabled?: boolean;
    zoomEnabled?: boolean;
    dblClickZoomEnabled?: boolean;
    mouseWheelZoomEnabled?: boolean;
    preventMouseEventsDefault?: boolean;
    zoomScaleSensitivity?: number;
    minZoom?: number;
    maxZoom?: number;
    fit?: boolean;
    contain?: boolean;
    center?: boolean;
    refreshRate?: number | 'auto';
    [k: string]: any;
  }
  function svgPanZoom(svgElement: SVGElement | string, options?: Options): Instance;
  export default svgPanZoom;
}
