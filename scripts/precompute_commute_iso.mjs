/**
 * 预计算通勤等时圈数据
 * 对 communities.json 中所有小区，批量查询到工作地点的通勤时间
 * 输出: data/processed/commute_iso_driving.json / commute_iso_transit.json
 *
 * 用法:
 *   node scripts/precompute_commute_iso.mjs --target-lng 121.4737 --target-lat 31.2304 --mode driving
 *   node scripts/precompute_commute_iso.mjs --target-lng 121.4737 --target-lat 31.2304 --mode transit
 *
 * 环境变量:
 *   AMAP_KEY=your_key (也可在命令行 --key 传入)
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── CLI 参数解析 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const AMAP_KEY = get('--key') || process.env.AMAP_KEY || '1cf0650cf8cc24f862e1d3a1d023b93c';
const TARGET_LNG = parseFloat(get('--target-lng') || '0');
const TARGET_LAT = parseFloat(get('--target-lat') || '0');
const MODE = get('--mode') || 'driving'; // driving | transit
const BATCH_SIZE = parseInt(get('--batch') || '5');   // 并发数（高德限速友好）
const DELAY_MS = parseInt(get('--delay') || '200');   // 批次间隔 ms
const RESUME = args.includes('--resume');              // 断点续跑
const LIMIT = parseInt(get('--limit') || '0');        // 调试：只处理前N条

if (!TARGET_LNG || !TARGET_LAT) {
  console.error('用法: node precompute_commute_iso.mjs --target-lng <lng> --target-lat <lat> [--mode driving|transit] [--key AMAP_KEY]');
  process.exit(1);
}

// ── 常量 ────────────────────────────────────────────────────────────────────
const OUT_FILE = path.join(ROOT, `data/processed/commute_iso_${MODE}.json`);
const TEMP_FILE = OUT_FILE + '.tmp';

// ── HTTP 工具 ────────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 100)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 高德 API ─────────────────────────────────────────────────────────────────
async function queryDriving(fromLng, fromLat, toLng, toLat) {
  const url = `https://restapi.amap.com/v3/direction/driving?origin=${fromLng},${fromLat}&destination=${toLng},${toLat}&output=JSON&key=${AMAP_KEY}`;
  const data = await httpGet(url);
  if (data.status === '1' && data.route?.paths?.[0]) {
    return Math.round(data.route.paths[0].duration / 60); // 秒→分钟
  }
  return null;
}

async function queryTransit(fromLng, fromLat, toLng, toLat) {
  const city = '021'; // 上海
  const url = `https://restapi.amap.com/v3/direction/transit/integrated?origin=${fromLng},${fromLat}&destination=${toLng},${toLat}&city=${city}&output=JSON&key=${AMAP_KEY}`;
  const data = await httpGet(url);
  if (data.status === '1' && data.route?.transits?.[0]) {
    return Math.round(data.route.transits[0].duration / 60);
  }
  return null;
}

async function queryOne(community) {
  try {
    const minutes = MODE === 'driving'
      ? await queryDriving(community.lng, community.lat, TARGET_LNG, TARGET_LAT)
      : await queryTransit(community.lng, community.lat, TARGET_LNG, TARGET_LAT);
    return { id: community.id, minutes };
  } catch (e) {
    return { id: community.id, minutes: null, error: e.message };
  }
}

// ── 时间档位 ─────────────────────────────────────────────────────────────────
function getTier(minutes) {
  if (minutes === null) return null;
  if (minutes <= 15) return 0;
  if (minutes <= 25) return 1;
  if (minutes <= 35) return 2;
  if (minutes <= 45) return 3;
  if (minutes <= 55) return 4;
  return 5;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/processed/communities.json'), 'utf-8'));
  let communities = raw.communities.filter(c => c.lat && c.lng);

  if (LIMIT > 0) communities = communities.slice(0, LIMIT);

  console.log(`共 ${communities.length} 个小区，目标: ${TARGET_LNG},${TARGET_LAT}，模式: ${MODE}`);

  // 断点续跑：加载已有结果
  let results = {};
  if (RESUME && fs.existsSync(TEMP_FILE)) {
    results = JSON.parse(fs.readFileSync(TEMP_FILE, 'utf-8'));
    console.log(`断点续跑：已有 ${Object.keys(results).length} 条结果`);
  }

  const todo = communities.filter(c => !(c.id in results));
  console.log(`待查询: ${todo.length} 条`);

  let done = 0;
  const total = todo.length;
  const startTime = Date.now();

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(queryOne));

    for (const r of batchResults) {
      results[r.id] = { minutes: r.minutes, tier: getTier(r.minutes) };
    }
    done += batch.length;

    // 进度
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = done / elapsed;
    const eta = Math.round((total - done) / rate);
    process.stdout.write(`\r进度: ${done}/${total} | 速率: ${rate.toFixed(1)}/s | ETA: ${eta}s    `);

    // 每100条保存临时文件
    if (done % 100 === 0) {
      fs.writeFileSync(TEMP_FILE, JSON.stringify(results));
    }

    if (i + BATCH_SIZE < total) await sleep(DELAY_MS);
  }

  console.log('\n查询完成，生成输出文件...');

  // 构建输出：每个小区保留 lat/lng/minutes/tier
  const output = {
    _meta: {
      mode: MODE,
      target: { lng: TARGET_LNG, lat: TARGET_LAT },
      generated_at: new Date().toISOString(),
      total: communities.length,
      success: Object.values(results).filter(r => r.minutes !== null).length,
    },
    points: communities.map(c => ({
      id: c.id,
      name: c.name,
      lat: c.lat,
      lng: c.lng,
      minutes: results[c.id]?.minutes ?? null,
      tier: results[c.id]?.tier ?? null,
    })).filter(p => p.minutes !== null),
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output));
  if (fs.existsSync(TEMP_FILE)) fs.unlinkSync(TEMP_FILE);

  console.log(`输出: ${OUT_FILE}`);
  console.log(`成功: ${output._meta.success}/${output._meta.total}`);

  // 档位统计
  const tierCounts = [0, 0, 0, 0, 0, 0];
  for (const p of output.points) {
    if (p.tier !== null) tierCounts[p.tier]++;
  }
  const TIER_LABELS = ['≤15', '15-25', '25-35', '35-45', '45-55', '55+'];
  console.log('档位分布:');
  TIER_LABELS.forEach((l, i) => console.log(`  ${l}min: ${tierCounts[i]}`));
}

main().catch(e => { console.error(e); process.exit(1); });
