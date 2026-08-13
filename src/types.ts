export interface Poi {
  id: string
  name: string
  cat: string
  lat: number
  lon: number
  src: 'seed'
  /** Indoor POIs live inside a building and render as a highlighted room, not a dot. */
  building?: string
  level?: number
  /** Id of the room polygon containing this POI. */
  room?: string
  aliases?: string[]
  hours?: string
  wheelchair?: string
  phone?: string
  url?: string
  desc?: string
  kind?: string
}

export interface Category {
  label: string
  color: string
  pin: boolean
}

/** One searchable room on a floor plan. */
export interface RoomDoc {
  id: string
  name: string
  building: string
  level: number
  /** Set when an indoor POI sits inside this room. */
  poiId?: string
}

export interface Campus {
  meta: {
    name: string
    built: string
    center: [number, number]
    attribution: string
    counts: Record<string, number>
    sample?: boolean
  }
  categories: Record<string, Category>
  pois: Poi[]
  rooms: RoomDoc[]
}

export interface Floors {
  /** Building name -> floor plan. */
  [building: string]: {
    levels: number[]
    byLevel: Record<string, GeoJSON.FeatureCollection>
  }
}

export interface GeoData {
  boundary: GeoJSON.FeatureCollection
  buildings: GeoJSON.FeatureCollection
  paths: GeoJSON.FeatureCollection
  floors: Floors
}

export interface Graph {
  lat: number[]
  lon: number[]
  /** [a, b, metres, footSeconds, bikeSeconds, flags] */
  edges: [number, number, number, number, number, number][]
}

export type Profile = 'foot' | 'bike'

export interface Route {
  coords: [number, number][]
  seconds: number
  metres: number
  steps: boolean
  indoor: boolean
  unpaved: boolean
}
