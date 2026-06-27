## 2026-06-27 by opencli-adapter-author (amap/search)

First adapter for 高德地图 web. GOAL was GCJ-02 coords (dianping has none).

### Strategy: INTERCEPT (browser, reuse page's loaded JSAPI)
- www.amap.com is a Next.js map app; it loads AMap JSAPI 2.0 (`window.AMap`) with
  the site's OWN embedded web key. We navigate to https://www.amap.com/ then run
  `AMap.PlaceSearch` in page context (`page.evaluate` awaits the Promise, ~ctrip pattern).
  NO user API key required.
- `extensions:'all'` gives rating + adname(district) + cost + website on top of
  the base name/type/location/address/tel.

### Dead ends (don't repeat)
- Raw Node/`eval` fetch of `/service/poiInfo` and `/service/poiTipsSearchlite` HANGS
  (page signs these; opencli `eval` returns empty on its internal timeout). `cityList`
  fetches fine, so it's request-signing, not CORS.
- Driving the SSR search UI (type into #search input + Enter / click search btn) does
  NOT fire a POI XHR — the React controlled input ignores synthetic events; URL query
  param alone (`/ssr/search?query=咖啡`) also does not fire a search. Hence JSAPI route.
- `poiInfo` etc. response bodies are not captured by the daemon network buffer (size 0).

### Field gotcha
- `poi.location` is an `AMap.LngLat` OBJECT (`.lng`/`.lat`), NOT a plain array.
  `JSON.stringify` of it looks like `[lng,lat]` in-page but it does NOT serialize back
  to Node as an array — extract `lng`/`lat` INSIDE `page.evaluate` before returning.
- Coords are GCJ-02 (verified vs People's Square pin). Do not apply any offset.

### Infra
- Browser bridge "render" profile service worker was dead (commands hung at 124).
  `opencli daemon status` showed "none selected"; `opencli profile use 8zypvxwj` (a
  live profile) fixed it. If browser cmds hang: check `daemon status` profile selection.

### Not done
- geocode.js (address -> lng/lat) deferred. AMap.Geocoder plugin would work the same way
  (in-page, reuse JSAPI). Quick follow-up if needed.
- Pagination > 25 (PlaceSearch single-page max) not implemented; limit capped at 25.
