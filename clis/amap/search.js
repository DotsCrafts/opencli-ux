/**
 * amap search — POI place search by keyword (+ optional city/area).
 *
 * GOAL: supply GCJ-02 coordinates (lng/lat) for each POI, which dianping does
 * NOT provide. Drives the amap WEB site (www.amap.com) and reuses the page's
 * OWN already-loaded AMap JSAPI (window.AMap, embedded with the site's web key)
 * to run AMap.PlaceSearch in page context. No user API key required.
 *
 * Strategy: INTERCEPT-class — execute the page's own loaded runtime service
 * (the JSAPI PlaceSearch) rather than replaying a signed internal XHR. A raw
 * Node-side fetch of /service/poiInfo or /service/poiTipsSearchlite hangs
 * (the site signs those requests via page runtime), so we reuse the loaded
 * JSAPI instead — same data, GCJ-02 coords, no secret reproduction.
 *
 * AMap.PlaceSearch with extensions:'all' returns, per POI:
 *   id, name, type (category chain), location [lng,lat] (GCJ-02), address,
 *   tel, adname (district), pname/cityname, rating, cost (人均), website, ...
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import {
    ArgumentError,
    CommandExecutionError,
    EmptyResultError,
    TimeoutError,
} from '@jackwener/opencli/errors';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25; // AMap.PlaceSearch single-page max

function requireLimit(raw) {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
        throw new ArgumentError(`limit must be an integer between 1 and ${MAX_LIMIT}, got ${JSON.stringify(raw)}`);
    }
    return n;
}

/**
 * Build the page-context Promise expression. Waits for window.AMap, loads the
 * PlaceSearch plugin, runs the search, and resolves a plain serializable object.
 * Values are JSON-injected so keyword/city are safely quoted.
 */
function buildSearchJs(keyword, city, pageSize) {
    const KW = JSON.stringify(keyword);
    const CITY = JSON.stringify(city || '');
    const SIZE = JSON.stringify(pageSize);
    return `
  new Promise((resolve) => {
    const KW = ${KW};
    const CITY = ${CITY};
    const SIZE = ${SIZE};
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 18000);
    const run = () => {
      try {
        window.AMap.plugin(['AMap.PlaceSearch'], () => {
          try {
            const opt = { pageSize: SIZE, pageIndex: 1, extensions: 'all' };
            if (CITY) { opt.city = CITY; opt.citylimit = true; }
            const ps = new window.AMap.PlaceSearch(opt);
            ps.search(KW, (status, result) => {
              if (done) return;
              clearTimeout(timer);
              const raw = (result && result.poiList && result.poiList.pois) || [];
              const info = (result && result.info) || '';
              // location is an AMap.LngLat object (.lng/.lat) — extract here
              // while live; it does not serialize back to Node as an array.
              const pois = raw.map((p) => {
                const loc = p.location || {};
                const lng = (typeof loc.getLng === 'function') ? loc.getLng() : loc.lng;
                const lat = (typeof loc.getLat === 'function') ? loc.getLat() : loc.lat;
                return {
                  id: p.id, name: p.name, type: p.type, address: p.address,
                  tel: p.tel, adname: p.adname, rating: p.rating, lng: lng, lat: lat,
                };
              });
              finish({ ok: true, status: String(status), info: String(info), pois: pois });
            });
          } catch (e) { clearTimeout(timer); finish({ ok: false, reason: 'search_init: ' + (e && e.message) }); }
        });
      } catch (e) { clearTimeout(timer); finish({ ok: false, reason: 'plugin_load: ' + (e && e.message) }); }
    };
    if (window.AMap && window.AMap.plugin) { run(); return; }
    let ticks = 0;
    const iv = setInterval(() => {
      ticks += 1;
      if (window.AMap && window.AMap.plugin) { clearInterval(iv); run(); }
      else if (ticks > 60) { clearInterval(iv); clearTimeout(timer); finish({ ok: false, reason: 'amap_not_loaded' }); }
    }, 250);
  })
`;
}

function toNumberOrNull(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

cli({
    site: 'amap',
    name: 'search',
    access: 'read',
    description: '高德地图 POI 地点搜索（按关键词 + 城市/区域），返回 GCJ-02 经纬度',
    domain: 'www.amap.com',
    strategy: Strategy.INTERCEPT,
    browser: true,
    args: [
        { name: 'keyword', required: true, positional: true, help: '搜索关键词，例如 "咖啡"' },
        { name: 'city', help: '城市或区域名（如 上海 / 静安区），或 adcode。不传则全国搜索' },
        { name: 'limit', type: 'int', default: DEFAULT_LIMIT, help: `返回数量（1-${MAX_LIMIT}，单页）` },
    ],
    columns: ['rank', 'poiId', 'name', 'lng', 'lat', 'rating', 'category', 'tel', 'district', 'address', 'url'],
    func: async (page, kwargs) => {
        const keyword = String(kwargs.keyword || '').trim();
        if (!keyword) throw new ArgumentError('keyword', 'must be a non-empty string');
        const city = kwargs.city == null ? '' : String(kwargs.city).trim();
        const limit = requireLimit(kwargs.limit);

        try {
            await page.goto('https://www.amap.com/');
        } catch (e) {
            throw new CommandExecutionError(`amap navigation failed: ${e?.message || e}`);
        }
        await page.wait(2);

        let result;
        try {
            result = await page.evaluate(buildSearchJs(keyword, city, limit));
        } catch (e) {
            throw new CommandExecutionError(`amap PlaceSearch evaluation failed: ${e?.message || e}`);
        }

        if (!result || !result.ok) {
            const reason = result?.reason || 'unknown';
            if (reason === 'timeout' || reason === 'amap_not_loaded') {
                throw new TimeoutError(`amap PlaceSearch timed out (${reason}) — JSAPI did not load or search did not return`);
            }
            throw new CommandExecutionError(`amap PlaceSearch failed: ${reason}`);
        }

        const status = result.status;
        const pois = Array.isArray(result.pois) ? result.pois : [];
        if (status !== 'complete') {
            // AMap returns status 'no_data' when there are genuinely no results.
            if (status === 'no_data' || pois.length === 0) {
                throw new EmptyResultError(`amap search "${keyword}"`, result.info || 'no POI results');
            }
            throw new CommandExecutionError(`amap PlaceSearch returned status="${status}" info="${result.info || ''}"`);
        }
        if (pois.length === 0) {
            throw new EmptyResultError(`amap search "${keyword}"`, result.info || 'no POI results');
        }

        const rows = pois.slice(0, limit).map((p, i) => {
            const lng = toNumberOrNull(p.lng);
            const lat = toNumberOrNull(p.lat);
            const poiId = String(p.id || '');
            return {
                rank: i + 1,
                poiId,
                name: String(p.name || ''),
                lng,
                lat,
                rating: toNumberOrNull(p.rating),
                category: String(p.type || ''),
                tel: String(p.tel || ''),
                district: String(p.adname || ''),
                address: typeof p.address === 'string' ? p.address : '',
                url: poiId ? `https://www.amap.com/place/${poiId}` : '',
            };
        });

        // Coordinates are the whole point — fail loudly if they didn't come through.
        if (rows.some((r) => r.lng === null || r.lat === null)) {
            throw new CommandExecutionError('amap PlaceSearch returned POIs without GCJ-02 coordinates');
        }
        return rows;
    },
});
