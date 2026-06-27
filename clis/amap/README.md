# amap — opencli POI adapter (key-free, GCJ-02 coordinates)

A vendored [opencli](https://github.com/jackwener/opencli) site adapter for **AMap / 高德地图**
(`www.amap.com`). It exists to supply **map coordinates** for the json-render `Map` component in
this repo: other local-life sources (e.g. dianping) return rich detail but **no latitude/longitude**,
so amap fills that gap.

## What it does

`opencli amap search "<keyword>" --city <city>` → place rows with coordinates:

| column | notes |
|--------|-------|
| `rank` | result order |
| `poiId` | AMap POI id |
| `name` | place name |
| `lng`, `lat` | **GCJ-02**, numeric (the must-have) |
| `rating` | star rating when available |
| `category` | AMap category path |
| `tel`, `district`, `address` | contact / location |
| `url` | `https://www.amap.com/place/<poiId>` |

## How it works (strategy: INTERCEPT, no API key)

`www.amap.com` loads the AMap JSAPI 2.0 (`window.AMap`) with the **site's own embedded web key**.
The adapter navigates there and runs `AMap.PlaceSearch` (with `extensions:'all'`) in page context,
then extracts `poi.location` (`.lng`/`.lat`) inside `page.evaluate` (it does not serialize back to
Node as an array). **No user API key, no `restapi.amap.com`.** Coordinates are GCJ-02, matching
高德/Gaode raster tiles — so the `Map` component plots them with zero datum conversion.

## Install

This is a private opencli adapter (no build). Copy it where opencli looks for local adapters:

```sh
mkdir -p ~/.opencli/clis/amap
cp clis/amap/search.js ~/.opencli/clis/amap/search.js
# optional: seed site memory used for verify
mkdir -p ~/.opencli/sites/amap/verify ~/.opencli/sites/amap/fixtures
cp clis/amap/endpoints.json clis/amap/field-map.json clis/amap/notes.md ~/.opencli/sites/amap/
cp clis/amap/verify/search.json ~/.opencli/sites/amap/verify/
cp clis/amap/fixtures/search-sample.json ~/.opencli/sites/amap/fixtures/
```

Verify: `opencli browser verify amap/search`.

## Wiring to the `Map` component

The agent emits a `Map` spec that fetches places via `ux_data`:

```json
{ "type": "Map",
  "on": { "mount": { "action": "ux_data", "params": {
      "key": "places",
      "request": { "site": "amap", "command": "search",
                   "positional": ["咖啡"], "args": { "city": "上海" } } } } },
  "bind": { "data": "/data/places", "status": "/status/places" } }
```

`amap` returns `lat`/`lng` directly, so the `Map`'s default `latPath`/`lngPath` need no override.

Files here: `search.js` (adapter), `endpoints.json` / `field-map.json` / `notes.md` (site memory),
`verify/search.json` (verify spec), `fixtures/search-sample.json` (a response sample for offline replay).
