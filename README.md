# amrita.town

A multi-floor map of Amrita Vishwa Vidyapeetam, Bengaluru.

The map shows buildings, rooms, canteens, and walking routes.
The building footprints and the campus wall come from OpenStreetMap (ODbL).
There is no tile server and no runtime data source.
The map renders from three static JSON files.

## How the map works

The app is a Vite + TypeScript project.
It uses MapLibre GL to draw the map.
The basemap comes from your curated GeoJSON files.
There is no API key.

The app has these features:

- A search palette (press Cmd+K)
- Category layers
- Light and dark themes
- A multi-floor building view
- Walking and cycling routes with an ETA
- An optional satellite view (ESRI World Imagery, no API key)
- An in-app draw tool that saves shapes straight into `data/curated`

The satellite view is the only feature that loads external tiles.
It needs internet and shows Esri attribution while it is on.
The map works fully offline when the satellite view is off.
The draw tool is the only feature that writes files.
It works only in local development, behind `bun run dev`.

## Commands

Run these commands in the project folder.

- `bun install` — install the dependencies.
- `bun run build:data` — build the data files from `data/curated`.
- `bun run dev` — build the data and start the dev server.
- `bun run test` — run the typecheck, the data build, and the smoke tests.
- `bun run build` — build the data and the production bundle.
- `bun run preview` — preview the production bundle.
- `bun run verify` — test the site in headless Chrome.

Note: `bun run verify` needs a Chrome binary.
If no Chrome binary is found, the script stops with a message.

## How the data flows

The campus wall and the building footprints are a real OpenStreetMap base.
The base is already in `data/curated`.
You trace everything else with the in-app draw tool.
The draw tool writes your shapes straight into `data/curated`.
It works only when you run `bun run dev`.
You can also trace at [geojson.io](https://geojson.io) and save each trace
as a GeoJSON file into `data/curated`.
After any trace, the build writes these files:

- `public/data/campus.json` — the places and the rooms
- `public/data/geo.json` — the map geometry
- `public/data/graph.json` — the routing network

Note: `public/font` ships only the `0-255` and `256-511` glyph ranges
(Latin-1). Labels using other characters render without glyphs — add the
needed ranges from Noto Sans before publishing real traced names.

## The curated files

Each file is a GeoJSON FeatureCollection.
A file can carry the marker `"_sample": true` at the top level.
The build prints a loud warning and names the file while any marker is present.
Remove the marker when you finish a file.

### data/curated/boundary.geojson

This file holds the campus parcels.
Each polygon is one parcel.
The build drops everything outside every polygon.
The main parcel already holds the real campus wall from OpenStreetMap.
Add a second polygon for a detached parcel.
Example: a hostel block across the road.
A point is on campus when it falls inside any polygon.

### data/curated/buildings.geojson

This file has the building footprints.
The file already holds the real footprints from OpenStreetMap.
Most footprints have no name yet.
Label each building to give it a name.
Each feature has these properties:

- `name` — the display name. Optional, but unique when present. `indoor.geojson` references a building by its exact name.
- `cat` — the category key. Optional. Use the list below.
- `levels` — the number of floors. Optional. Default is `1`.

### data/curated/paths.geojson

This file has the roads and the walkable paths.
The drivable roads already come from OpenStreetMap.
Their `kind` is `road`. Do not trace buildings — they clutter the map.
Trace the campus paths with the draw tool.
Each feature has these properties:

- `kind` — the path type. Use `path`, `road`, or `steps`.
- `surface` — the surface type. Use `paved`, `asphalt`, or `unpaved`.

Make the path ends touch. A shared endpoint becomes a routing junction. Use the same coordinate for both ends.

### data/curated/indoor.geojson

This file has the room polygons.
This file is empty. Trace the rooms.
Each feature has these properties:

- `building` — the exact building name from `buildings.geojson`. Required.
- `level` — the floor number. Required. Ground is `0`.
- `room` — the display name. Required.
- `kind` — the room type. Use `room`, `corridor`, `stairs`, `lift`, or `toilet`.

Do not let two rooms overlap on the same building and level.
The build reports an overlap as a warning.

### data/curated/pois.geojson

This file has the places.
This file is empty. Trace the places.
Each feature has these properties:

- `name` — the display name. Required.
- `cat` — the category key. Required. Use the list below.
- `building` — the building name. Use it for an indoor place.
- `level` — the floor number. Use it for an indoor place.
- `hours` — the opening hours. Use the `opening_hours` syntax. Example: `Mo-Fr 09:00-20:00`.
- `desc` — one line that tells why a student cares.
- `aliases` — an array of extra names.
- `wheelchair` — use `yes`, `limited`, or `no`.

Put each indoor place inside its room polygon. The build drops an indoor place that has no room.

### The category keys

Use one of these keys for the `cat` property.

- `lecture` — Lecture halls
- `academic` — Academic blocks
- `admin` — Admin and help
- `hostel` — Hostels
- `mess` — Messes
- `canteen` — Canteens and cafes
- `shop` — Shops
- `library` — Library
- `health` — Health
- `sports` — Sports
- `transport` — Transport
- `water` — Water
- `atm` — ATMs and banks
- `worship` — Worship
- `toilet` — Toilets
- `parking` — Parking
- `green` — Open ground

## How to trace the campus

The quickest way is the in-app draw tool.

1. Run `bun run dev` and open the map.
2. Turn on the satellite view. The globe button is in the header.
3. Turn on the draw tool. The pencil button is next to the globe button.
4. Choose the layer type: Boundary, Building, Path, POI, or Room.
5. Click on the map to add points.
   Press F (or Enter) to finish the shape, Esc to cancel it,
   and Ctrl+Z to remove the last point you placed.
6. Fill in the properties form and select Add to map.
7. Select Save. The map rebuilds and reloads.

The draw tool works only in local development.
On the deployed site the pencil button stays disabled.

Drawn shapes stay on the map until you save them.
They are drafts, not data yet.
The drafts list in the toolbar shows every unsaved shape.
You can delete a draft from that list.
Unsaved drafts are lost when you reload the page.

You can edit a draft before you save it.
Click the draft to select it.
Double-click it to edit its points.
Drag a point to move it.
Drag a midpoint handle on the outline to insert a point.
Hold Alt and click anywhere on the shape to insert a point there.
Hold Alt and click a point to delete that point.
Middle-click and drag to pan the map while you draw.

To label an existing building, open `data/curated/buildings.geojson` at
the draw tool, select Building, and trace over its footprint.
Or edit the file directly at [geojson.io](https://geojson.io):
select a footprint, edit its properties, set the `name` and the `cat` and
`levels` if you know them, then save the file back to the same path.

Follow these rules when you trace:

- Make the path ends touch. A shared endpoint becomes a routing junction. Use the same coordinate for both ends.
- Put each indoor place inside its room polygon. The build drops an indoor place that has no room.
- Make each building name unique. `indoor.geojson` references a building by its exact name.
- Do not let two rooms overlap on the same building and level. The build reports an overlap as a warning.
- Trace only what you can see. Do not copy coordinates from another map.

## The draw tool

The pencil button in the header opens the draw toolbar.
The toolbar sits at the bottom of the map.
It has a layer picker, a hints line, and a save button.
The editor is maplibre-gl-draw.

- Boundary draws a campus parcel. Draw one polygon per parcel. Saving appends to the current boundary.
- Building draws a building footprint with a name, a category, and a floor count.
- Path draws a walkable line with a kind and a surface.
- POI draws a point with a name and a category. Add a building and a floor to make it an indoor place.
- Room draws a room polygon inside a building. Pick the building and the floor, then name the room.

Press Enter or double-click to finish a shape.
Press Escape to cancel the current shape.
Press Escape again to close the draw tool.
Click a draft to select it.
Double-click a draft to edit its points.
Middle-click and drag to pan the map.

The room form suggests building names from `data/curated/buildings.geojson`.
A room that names a missing building is dropped at build time.

## The multi-floor view

Click a building with more than one floor.
The floor bar appears at the bottom of the map.
The floor bar shows one chip for each floor.
The chip shows `G` for the ground floor.
The map opens the ground floor of the building.
Click a chip to switch to that floor.

Search for a room to open its building and floor.
Example: type `room 203` in the search palette.

## The no-dots rule

Indoor places have no pins.
The room that contains an indoor place glows brighter.
The rest of the floor stays dimmer.
The focused room is the brightest.
Outdoor places keep small dots.

Click a glowing room to open its place.
Click an empty room to select it.
Press Escape or close the floor bar to return to the campus view.

## Sample data

This project ships with a real OpenStreetMap base.
The base holds the campus wall and the building footprints.
It does not hold paths, rooms, or places.
Those files are empty. Trace them before you share the map.

The build warns while any file carries `"_sample": true`.
No file carries the marker now.

## Sources

The campus wall, the building footprints, and the drivable roads come from
OpenStreetMap. OpenStreetMap data is © OpenStreetMap contributors and is
licensed under the ODbL. Keep the attribution in the app footer and in the
About panel.

All paths, rooms, and places are traced from the satellite view.
Do not copy coordinates out of another map.
Trace each point and polygon from the satellite view.

## License

Code is MIT. Map data is © OpenStreetMap contributors (ODbL).
