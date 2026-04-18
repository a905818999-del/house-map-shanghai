/**
 * fetch_ring_roads.mjs
 * 从 OSM Overpass API 获取上海三条环线真实路网数据，输出 data/rings.json
 *
 * 坐标系：OSM 是 WGS84，高德地图需要 GCJ02，脚本自动转换。
 * Usage: node scripts/fetch_ring_roads.mjs
 */

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OVERPASS_NODES = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

// ── WGS84 → GCJ02 ──────────────────────────────────────────────────────────
const A = 6378245.0, EE = 0.00669342162296594, PI = Math.PI;
function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function transformLat(x, y) {
  let r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
  r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2/3;
  r += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI)) * 2/3;
  r += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30)) * 2/3;
  return r;
}
function transformLng(x, y) {
  let r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
  r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI)) * 2/3;
  r += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI)) * 2/3;
  r += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI)) * 2/3;
  return r;
}
function wgs2gcj(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  const dLat = transformLat(lng - 105, lat - 35);
  const dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * PI;
  const magic = Math.sin(radLat);
  const sqrtMagic = Math.sqrt(1 - EE * magic * magic);
  const dLatFinal = dLat * 180 / (A * (1 - EE) / (sqrtMagic ** 3) * PI);
  const dLngFinal = dLng * 180 / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + dLngFinal, lat + dLatFinal];
}

// ── Overpass 查询 ────────────────────────────────────────────────────────────
async function overpassQuery(query) {
  for (const node of OVERPASS_NODES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(node, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(60000),
        });
        const text = await resp.text();
        const data = JSON.parse(text);
        return data;
      } catch (e) {
        console.log(`  ${node} failed (attempt ${attempt+1}): ${e.message?.slice(0,60)}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  throw new Error('All Overpass nodes failed');
}

// 把多段 way 按照端点连接顺序拼成连续折线
function joinWays(ways) {
  if (ways.length === 0) return [];

  // 每条 way 的端点
  const segments = ways.map(w => w.geometry.map(p => [p.lon, p.lat]));
  if (segments.length === 1) return segments[0];

  const result = [...segments[0]];
  const remaining = segments.slice(1);

  while (remaining.length > 0) {
    const tail = result[result.length - 1];
    let bestIdx = -1, bestDist = Infinity, bestReverse = false;

    for (let i = 0; i < remaining.length; i++) {
      const seg = remaining[i];
      const head = seg[0], headR = seg[seg.length - 1];
      const d1 = dist(tail, head), d2 = dist(tail, headR);
      if (d1 < bestDist) { bestDist = d1; bestIdx = i; bestReverse = false; }
      if (d2 < bestDist) { bestDist = d2; bestIdx = i; bestReverse = true; }
    }

    const seg = remaining.splice(bestIdx, 1)[0];
    const pts = bestReverse ? [...seg].reverse() : seg;
    // 跳过第一个点（重复）
    result.push(...pts.slice(1));
  }
  return result;
}

function dist([ax, ay], [bx, by]) {
  return Math.hypot(ax - bx, ay - by);
}

// ── 查询各环线 ────────────────────────────────────────────────────────────────
async function fetchRing(name, query) {
  console.log(`Fetching ${name}...`);
  const data = await overpassQuery(query);
  const ways = data.elements.filter(e => e.type === 'way' && e.geometry?.length > 0);
  console.log(`  ${ways.length} ways, ${ways.reduce((s, w) => s + w.geometry.length, 0)} pts total`);
  return ways;
}

async function main() {
  // 内环高架路
  const innerWays = await fetchRing('内环高架路',
    `[out:json][timeout:50];
    way["name"="内环高架路"](30.9,121.2,31.5,121.7);
    out geom;`
  );

  // 中环路（注意 OSM 里叫"中环路"或"中环高架路"）
  let middleWays = await fetchRing('中环路',
    `[out:json][timeout:50];
    (way["name"="中环路"](30.9,121.2,31.5,121.7);
     way["name"="中环高架路"](30.9,121.2,31.5,121.7););
    out geom;`
  );

  // 外环高速
  const outerWays = await fetchRing('外环高速',
    `[out:json][timeout:50];
    (way["name"="外环高速"](30.9,121.2,31.5,121.7);
     way["name"="外环路"](30.9,121.2,31.5,121.7););
    out geom;`
  );

  console.log('\nJoining ways...');
  const innerPts = joinWays(innerWays);
  const middlePts = joinWays(middleWays);
  const outerPts = joinWays(outerWays);

  console.log(`Inner: ${innerPts.length} pts, Middle: ${middlePts.length} pts, Outer: ${outerPts.length} pts`);

  // 转 GCJ02
  function toGcj(pts) {
    return pts.map(([lng, lat]) => wgs2gcj(lng, lat));
  }

  // 读当前 rings.json 保留 caz
  const currentPath = join(ROOT, 'data', 'rings.json');
  let current;
  try {
    const txt = await import('node:fs').then(m => m.readFileSync(currentPath, 'utf8'));
    current = JSON.parse(txt);
  } catch {
    current = { caz: { path: [], name: 'CAZ' } };
  }

  const rings = {
    rings: {
      inner: {
        name: '内环',
        color: '#E74C3C',
        path: toGcj(innerPts),
      },
      middle: {
        name: '中环',
        color: '#E67E22',
        path: toGcj(middlePts),
      },
      outer: {
        name: '外环',
        color: '#95A5A6',
        path: toGcj(outerPts),
      },
    },
    caz: current.caz,
  };

  await writeFile(currentPath, JSON.stringify(rings, null, 2), 'utf8');
  console.log(`\nDone! Written to data/rings.json`);
  console.log(`Inner: ${innerPts.length}pts, Middle: ${middlePts.length}pts, Outer: ${outerPts.length}pts`);
}

main().catch(e => { console.error(e); process.exit(1); });
