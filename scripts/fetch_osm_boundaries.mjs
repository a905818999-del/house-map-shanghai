/**
 * fetch_osm_boundaries.mjs
 *
 * Fetches landuse=residential and place=neighbourhood polygons from OSM
 * via the Overpass API, matches them to communities.json by name + proximity,
 * and writes data/processed/boundaries.json with GCJ-02 coordinates.
 *
 * Usage:  node scripts/fetch_osm_boundaries.mjs
 * Requires: Node 18+ (native fetch)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// GCJ-02 <-> WGS-84 conversion
// ---------------------------------------------------------------------------

const GCJ_A  = 6378245.0;
const GCJ_EE = 0.00669342162296594;
const GCJ_PI = 3.14159265358979324;

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y +
            0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * GCJ_PI) +
          20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * GCJ_PI) +
          40.0 * Math.sin(y / 3.0 * GCJ_PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * GCJ_PI) +
          320.0 * Math.sin(y * GCJ_PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x +
            0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * GCJ_PI) +
          20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * GCJ_PI) +
          40.0 * Math.sin(x / 3.0 * GCJ_PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * GCJ_PI) +
          300.0 * Math.sin(x / 30.0 * GCJ_PI)) * 2.0 / 3.0;
  return ret;
}

function delta(lng, lat) {
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * GCJ_PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * GCJ_PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * GCJ_PI);
  return { dLat, dLng };
}

/** Convert GCJ-02 to WGS-84 */
function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };
  const d = delta(lng, lat);
  return { lng: lng - d.dLng, lat: lat - d.dLat };
}

/** Convert WGS-84 to GCJ-02 */
function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };
  const d = delta(lng, lat);
  return { lng: lng + d.dLng, lat: lat + d.dLat };
}

// ---------------------------------------------------------------------------
// Haversine distance (metres)
// ---------------------------------------------------------------------------

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = v => v * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray casting) — coords are [lng, lat]
// ---------------------------------------------------------------------------

function pointInPolygon(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Name normalisation & matching
// ---------------------------------------------------------------------------

const NAME_SUFFIXES = [
  '小区', '花园', '苑', '公寓', '新村', '社区',
  '家园', '城', '府', '居', '庭', '阁', '楼'
];

function normaliseName(name) {
  if (!name) return '';
  let n = name.trim();
  for (const s of NAME_SUFFIXES) {
    if (n.endsWith(s) && n.length > s.length) {
      n = n.slice(0, -s.length);
    }
  }
  return n;
}

function nameMatch(a, b) {
  if (!a || !b) return false;
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (na === nb) return true;
  if (na.length >= 2 && nb.length >= 2) {
    if (na.includes(nb) || nb.includes(na)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Polygon centroid (simple average of vertices)
// ---------------------------------------------------------------------------

function centroid(ring) {
  let sumLng = 0, sumLat = 0;
  for (const [lng, lat] of ring) { sumLng += lng; sumLat += lat; }
  return [sumLng / ring.length, sumLat / ring.length];
}

// ---------------------------------------------------------------------------
// Overpass API query
// ---------------------------------------------------------------------------

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Split Shanghai into a 4x4 grid of tiles to avoid Overpass timeout
const BBOX = { south: 30.7, west: 120.8, north: 31.9, east: 122.2 };
const GRID_ROWS = 4;
const GRID_COLS = 4;

function buildTileQueries() {
  const tiles = [];
  const latStep = (BBOX.north - BBOX.south) / GRID_ROWS;
  const lngStep = (BBOX.east - BBOX.west) / GRID_COLS;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const s = (BBOX.south + r * latStep).toFixed(4);
      const n = (BBOX.south + (r + 1) * latStep).toFixed(4);
      const w = (BBOX.west + c * lngStep).toFixed(4);
      const e = (BBOX.west + (c + 1) * lngStep).toFixed(4);
      const bbox = `${s},${w},${n},${e}`;
      tiles.push({
        label: `tile[${r},${c}] (${bbox})`,
        query: `[out:json][timeout:60];
(
  way["landuse"="residential"](${bbox});
  relation["landuse"="residential"](${bbox});
  way["place"="neighbourhood"](${bbox});
  relation["place"="neighbourhood"](${bbox});
);
out body;
>;
out skel qt;`,
      });
    }
  }
  return tiles;
}

async function fetchOneTile(query, label, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  Fetching ${label} (attempt ${attempt})...`);
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (res.status === 429 || res.status === 504) {
        console.warn(`  Got HTTP ${res.status} for ${label}, waiting 30s...`);
        await sleep(30000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return data.elements || [];
    } catch (err) {
      console.error(`  ${label} attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) { await sleep(10000); }
      else {
        console.warn(`  Skipping ${label} after ${retries} failures`);
        return [];
      }
    }
  }
  return [];
}

async function fetchOverpass() {
  const tiles = buildTileQueries();
  console.log(`Fetching OSM data for Shanghai in ${tiles.length} tiles...`);
  const allElements = [];
  for (let i = 0; i < tiles.length; i++) {
    const { query, label } = tiles[i];
    const elements = await fetchOneTile(query, label);
    allElements.push(...elements);
    console.log(`  ${label}: ${elements.length} elements (running total: ${allElements.length})`);
    if (i < tiles.length - 1) await sleep(5000); // rate limit
  }
  // Deduplicate by element type+id
  const seen = new Set();
  const deduped = [];
  for (const el of allElements) {
    const key = `${el.type}:${el.id}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(el); }
  }
  console.log(`Total after dedup: ${deduped.length} elements`);
  return { elements: deduped };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Parse Overpass response into polygons
// ---------------------------------------------------------------------------

function parseOverpassResponse(data) {
  const elements = data.elements || [];

  // Classify elements
  const nodeMap = new Map();
  const ways = [];
  const relations = [];

  let nodeCount = 0, wayCount = 0, relCount = 0;

  for (const el of elements) {
    if (el.type === 'node') {
      nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
      nodeCount++;
    } else if (el.type === 'way') {
      ways.push(el);
      wayCount++;
    } else if (el.type === 'relation') {
      relations.push(el);
      relCount++;
    }
  }

  console.log(`Received ${elements.length} elements (${nodeCount} nodes, ${wayCount} ways, ${relCount} relations)`);

  // Build a lookup from way id to its resolved coordinates
  const wayNodeMap = new Map(); // wayId -> [[lng,lat], ...]
  for (const w of ways) {
    if (!w.nodes) continue;
    const coords = [];
    let valid = true;
    for (const nid of w.nodes) {
      const nd = nodeMap.get(nid);
      if (!nd) { valid = false; break; }
      coords.push([nd.lon, nd.lat]); // [lng, lat]
    }
    if (valid && coords.length >= 3) {
      wayNodeMap.set(w.id, coords);
    }
  }

  const polygons = []; // { name, ring: [[lng,lat],...] }

  // Ways with relevant tags
  for (const w of ways) {
    if (!w.tags) continue;
    const hasRelevantTag = (w.tags.landuse === 'residential' || w.tags.place === 'neighbourhood');
    if (!hasRelevantTag) continue;
    const name = w.tags.name || w.tags['name:zh'] || null;
    if (!name) continue; // skip unnamed
    const ring = wayNodeMap.get(w.id);
    if (!ring) {
      console.warn(`Warning: way ${w.id} ("${name}") has missing nodes, skipping`);
      continue;
    }
    polygons.push({ name, ring });
  }

  // Relations with relevant tags
  for (const r of relations) {
    if (!r.tags) continue;
    const hasRelevantTag = (r.tags.landuse === 'residential' || r.tags.place === 'neighbourhood');
    if (!hasRelevantTag) continue;
    const name = r.tags.name || r.tags['name:zh'] || null;
    if (!name) continue;
    if (!r.members) continue;

    // Collect outer ways
    const outerWayIds = r.members
      .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === ''))
      .map(m => m.ref);

    if (outerWayIds.length === 0) {
      console.warn(`Warning: relation ${r.id} ("${name}") has no outer ways, skipping`);
      continue;
    }

    // Chain way nodes into a single ring
    const segments = [];
    let missingWay = false;
    for (const wid of outerWayIds) {
      const coords = wayNodeMap.get(wid);
      if (!coords) { missingWay = true; break; }
      segments.push(coords);
    }
    if (missingWay) {
      console.warn(`Warning: relation ${r.id} ("${name}") has missing way nodes, skipping`);
      continue;
    }

    // Simple chain: concatenate segments, removing duplicated junction points
    const ring = [];
    for (const seg of segments) {
      for (let i = 0; i < seg.length; i++) {
        if (ring.length > 0 && i === 0) {
          const last = ring[ring.length - 1];
          if (last[0] === seg[0][0] && last[1] === seg[0][1]) continue;
        }
        ring.push(seg[i]);
      }
    }

    if (ring.length >= 3) {
      polygons.push({ name, ring });
    } else {
      console.warn(`Warning: relation ${r.id} ("${name}") produced ring with < 3 points, skipping`);
    }
  }

  console.log(`Reconstructed ${polygons.length} polygons with names`);
  return polygons;
}

// ---------------------------------------------------------------------------
// Match OSM polygons to communities
// ---------------------------------------------------------------------------

function matchPolygons(polygons, communities) {
  console.log(`Matching against ${communities.length} communities...`);

  // Pre-convert community coordinates to WGS-84
  const commWgs = communities.map(c => {
    const w = gcj02ToWgs84(c.lng, c.lat);
    return { ...c, wgsLng: w.lng, wgsLat: w.lat };
  });

  // For each polygon, find best community match
  // Then resolve conflicts (one polygon per community, one community per polygon)
  const candidates = []; // { polyIdx, commIdx, score }

  for (let pi = 0; pi < polygons.length; pi++) {
    const poly = polygons[pi];
    const [cLng, cLat] = centroid(poly.ring);

    for (let ci = 0; ci < commWgs.length; ci++) {
      const comm = commWgs[ci];

      // Name match check
      if (!nameMatch(poly.name, comm.name)) continue;

      // Distance check (WGS-84 space)
      const dist = haversine(comm.wgsLat, comm.wgsLng, cLat, cLng);
      if (dist > 500) continue;

      // Proximity score: 1.0 at 0m, 0.0 at 500m
      const proximityScore = Math.max(0, 1 - dist / 500);

      // Point-in-polygon bonus
      const pip = pointInPolygon(comm.wgsLng, comm.wgsLat, poly.ring);

      // Name match is binary here (already passed)
      const nameScore = 1.0;

      let score = nameScore * 0.6 + proximityScore * 0.4;
      if (pip) score = Math.min(1.0, score + 0.1);

      if (score > 0.5) {
        candidates.push({ polyIdx: pi, commIdx: ci, score });
      }
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Greedy assignment: each polygon and each community matched at most once
  const usedPoly = new Set();
  const usedComm = new Set();
  const matches = []; // { community, polygon, score }

  for (const c of candidates) {
    if (usedPoly.has(c.polyIdx) || usedComm.has(c.commIdx)) continue;
    usedPoly.add(c.polyIdx);
    usedComm.add(c.commIdx);
    matches.push({
      community: communities[c.commIdx],
      polygon: polygons[c.polyIdx],
      score: c.score,
    });
  }

  console.log(`Matched: ${matches.length} / ${communities.length} (${(matches.length / communities.length * 100).toFixed(1)}%)`);
  return matches;
}

// ---------------------------------------------------------------------------
// Convert polygon ring to GCJ-02 and round
// ---------------------------------------------------------------------------

function ringToGcj02(ring) {
  return ring.map(([lng, lat]) => {
    const g = wgs84ToGcj02(lng, lat);
    return [
      Math.round(g.lng * 1e6) / 1e6,
      Math.round(g.lat * 1e6) / 1e6,
    ];
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load communities
  const commPath = join(ROOT, 'data', 'processed', 'communities.json');
  const commData = JSON.parse(await readFile(commPath, 'utf-8'));
  const communities = commData.communities;
  console.log(`Loaded ${communities.length} communities from communities.json`);

  // Fetch OSM data
  const osmData = await fetchOverpass();

  // Parse polygons
  const polygons = parseOverpassResponse(osmData);

  // Match
  const matches = matchPolygons(polygons, communities);

  // Build output
  const boundaries = {};
  for (const m of matches) {
    const gcjRing = ringToGcj02(m.polygon.ring);
    boundaries[m.community.id] = {
      rings: [gcjRing],
      source: 'osm',
    };
  }

  const totalOsmPolygons = polygons.length;
  // Count total named polygons from the overpass response (ways+relations with tags and name)
  const namedOsmPolygons = polygons.length; // all polygons in our list already have names

  const output = {
    _meta: {
      source: 'osm_overpass',
      fetched_at: new Date().toISOString().slice(0, 10),
      total_osm_polygons: totalOsmPolygons,
      named_osm_polygons: namedOsmPolygons,
      matched: matches.length,
      unmatched_communities: communities.length - matches.length,
      match_rate_percent: Math.round(matches.length / communities.length * 1000) / 10,
    },
    boundaries,
  };

  // Write output
  const outPath = join(ROOT, 'data', 'processed', 'boundaries.json');
  await mkdir(dirname(outPath), { recursive: true });
  console.log('Writing boundaries.json...');
  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Done. Wrote ${outPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
