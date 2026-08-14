/**
 * Minimal types for maplibre-gl-draw (the MapLibre fork of mapbox-gl-draw).
 *
 * The package ships its own index.d.ts, but it imports 'kt-maplibre-gl' (a
 * maplibre fork) which is not installed here, so tsc would fail on the import
 * chain. tsconfig maps 'maplibre-gl-draw' to this file instead — types only;
 * the bundler still resolves the real package at build time.
 */
declare module 'maplibre-gl-draw' {
  import type { ControlPosition, IControl, Map as MLMap } from 'maplibre-gl'

  interface DrawControls {
    point?: boolean | object
    line_string?: boolean | object
    polygon?: boolean | object
    trash?: boolean | object
    combine_features?: boolean | object
    uncombine_features?: boolean | object
  }

  interface DrawOptions {
    displayControlsDefault?: boolean
    controls?: DrawControls
    styles?: object[]
    defaultMode?: string
    keybindings?: boolean
    touchEnabled?: boolean
    boxSelect?: boolean
    clickBuffer?: number
    touchBuffer?: number
    userProperties?: boolean
  }

  interface DrawEvent {
    type: string
    features?: GeoJSON.Feature[]
    mode?: string
  }

  class MapboxDraw implements IControl {
    constructor(options?: DrawOptions)
    onAdd(map: MLMap): HTMLElement
    onRemove(map: MLMap): void
    getDefaultPosition(): ControlPosition
    changeMode(mode: string, opts?: Record<string, unknown>): void
    getMode(): string
    add(features: GeoJSON.Feature | GeoJSON.FeatureCollection): string[]
    get(featureId: string): GeoJSON.Feature | undefined
    getAll(): GeoJSON.FeatureCollection
    getSelected(): GeoJSON.FeatureCollection
    delete(ids: string | string[]): void
    setFeatureProperty(featureId: string, property: string, value: unknown): void
    // NOTE: the instance has NO .on() — 1.6.x has no event emitter of its
    // own. It fires 'draw.create' | 'draw.update' | 'draw.delete' |
    // 'draw.modechange' on the map instead; listen with map.on(type, fn).
  }

  export default MapboxDraw
}
