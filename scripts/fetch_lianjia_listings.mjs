/**
 * 链家二手房具体房源抓取脚本
 * 按小区ID抓每套在售房源（总价、单价、面积、室型、楼层、朝向等）
 * 支持断点续传：已抓的小区自动跳过
 *
 * 用法：
 *   node scripts/fetch_lianjia_listings.mjs           # 全量（通勤圈2896个小区）
 *   node scripts/fetch_lianjia_listings.mjs --test    # 测试模式（前5个小区）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const COOKIE = '_ga=GA1.2.293870317.1765633686; _ga_GVYN2J1PCG=GS2.2.s1776443400$o3$g0$t1776443400$j60$l0$h0; _ga_LRLL77SF11=GS2.2.s1776443400$o3$g0$t1776443400$j60$l0$h0; _gid=GA1.2.1004112428.1776443399; crosSdkDT2019DeviceId=bz9me1--1vlpj0-kxh3tsc3ped9f5r-ttv4wsge7; ftkrc_=ee63d70a-3351-4137-80b9-470d8d4e90f1; Hm_lpvt_46bf127ac9b856df503ec2dbf942b67e=1776443386; Hm_lvt_46bf127ac9b856df503ec2dbf942b67e=1776356428,1776443386; HMACCOUNT=AB41D70375C4B3C6; lfrc_=4fd35644-c847-4381-be3d-9e932b15c5a5; lianjia_ssid=01833cf1-acc5-4769-bcab-e7a30b5be24e; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%221960f5059553d0-0bcf56a18fd5d98-26011c51-2073600-1960f5059561c9a%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%22%24latest_traffic_source_type%22%3A%22%E7%9B%B4%E6%8E%A5%E6%B5%81%E9%87%8F%22%2C%22%24latest_search_keyword%22%3A%22%E6%9C%AA%E5%8F%96%E5%88%B0%E5%80%BC_%E7%9B%B4%E6%8E%A5%E6%89%93%E5%BC%80%22%2C%22%24latest_referrer%22%3A%22%22%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTk2MGY1MDU5NTUzZDAtMGJjZjU2YTE4ZmQ1ZDk4LTI2MDExYzUxLTIwNzM2MDAtMTk2MGY1MDU5NTYxYzlhIn0%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%221960f5059553d0-0bcf56a18fd5d98-26011c51-2073600-1960f5059561c9a%22%7D; lianjia_uuid=bz9me1--1vlpj0-kxh3tsc3ped9f5r-ttv4wsge7; Select_Menu_Type=1; _jzqa=1.3489988099467754700.1765633686.1776356428.1776443399.3; _jzqx=1.1776443399.1776443399.1.jzqsr=sh.lianjia.com|jzqct=/.-1; _jzqb=1.6.10.1776443399.1; lianjia_token=2.0014e0d8f8c5a9c59d32d7e9e2fa5f74b7; lianjia_token_secure=2.0014e0d8f8c5a9c59d32d7e9e2fa5f74b7; _qddaz=QD.undefined; fp=4fd35644c8474381bed39e932b15c5a5; ld=Zllllllll02eSblllllllllFTlllllll3S4llllllplllllll9lll5@@@@@@@@@@';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
];

const testMode = process.argv.includes('--test');
const OUT_FILE = path.join(ROOT, 'data/raw/lianjia_listings_commute.json');
const SAVE_EVERY = 50;

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return sleep(min + Math.random() * (max - min)); }

async function fetchListings(xiaoquId, name) {
  const url = `https://sh.lianjia.com/ershoufang/${xiaoquId}/`;
  const headers = {
    'User-Agent': randomUA(),
    'Cookie': COOKIE,
    'Referer': 'https://sh.lianjia.com/ershoufang/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 403 || res.status === 521) return { status: 'blocked', listings: [] };
      if (res.status !== 200) {
        await sleep(3000);
        continue;
      }
      const html = await res.text();
      if (html.includes('验证码') || html.includes('captcha')) return { status: 'blocked', listings: [] };

      const listings = [];
      // 匹配每个房源 li 块
      const liPattern = /<li class="clear"[^>]*>([\s\S]*?)<\/li>/g;
      let liMatch;
      while ((liMatch = liPattern.exec(html)) !== null) {
        const li = liMatch[1];
        if (!li.includes('houseInfo')) continue;

        // 总价
        const totalM = li.match(/<div class="totalPrice[^"]*"><span>(\d+\.?\d*)<\/span>/);
        const total_price = totalM ? parseFloat(totalM[1]) : null;

        // 单价
        const unitM = li.match(/unitPrice[^>]*>.*?(\d{4,6})元\/平/s);
        const unit_price = unitM ? parseInt(unitM[1]) : null;

        // 房源基本信息
        const houseM = li.match(/houseInfo[^>]*>(.*?)<\/div>/s);
        const houseInfo = houseM ? houseM[1].replace(/<[^>]+>/g, '').trim() : '';
        const parts = houseInfo.split('|').map(s => s.trim());

        // 小区名
        const nameM = li.match(/positionInfo[^>]*>.*?<a[^>]*>([^<]+)<\/a>/s);
        const xiaoqu_name = nameM ? nameM[1].trim() : name;

        // 楼层/年份
        const floorM = li.match(/houseInfo[^>]*>[\s\S]*?<div class="positionInfo[^>]*>([\s\S]*?)<\/div>/s);

        const listing = {
          xiaoqu_id: xiaoquId,
          xiaoqu_name,
          total_price,
          unit_price,
          configuration: parts[0] || null,
          area: parts[1] ? parseFloat(parts[1]) : null,
          towards: parts[2] || null,
          decorate: parts[3] || null,
          storey: parts[4] || null,
          period: parts[5] || null,
        };

        if (total_price || unit_price) listings.push(listing);
      }

      return { status: listings.length > 0 ? 'ok' : 'empty', listings };
    } catch (e) {
      await sleep(3000);
    }
  }
  return { status: 'error', listings: [] };
}

async function main() {
  // 读取目标小区
  const communitiesRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/processed/communities.json'), 'utf-8'));
  const communities = communitiesRaw.communities || communitiesRaw;
  // 新漕河泾B座坐标，筛选10km范围内有source_url的小区
  const WORK_LNG = 121.4186, WORK_LAT = 31.1524, RADIUS_KM = 10;
  function dist(lat1, lng1, lat2, lng2) {
    const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  const target = communities.filter(c => c.source_url && c.lat && c.lng && dist(WORK_LAT, WORK_LNG, c.lat, c.lng) <= RADIUS_KM);

  console.log(`目标小区: ${target.length} 个`);

  // 断点续传：读已有数据
  let results = [];
  const doneIds = new Set();
  if (fs.existsSync(OUT_FILE)) {
    try {
      results = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8'));
      results.forEach(r => doneIds.add(r.xiaoqu_id));
      console.log(`断点续传：已有 ${results.length} 条，覆盖 ${doneIds.size} 个小区，跳过已完成`);
    } catch(e) {
      console.log('已有文件损坏，从头开始');
      results = [];
    }
  }

  const toFetch = testMode ? target.slice(0, 5) : target;
  let success = 0, empty = 0, blocked = 0, skipped = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const c = toFetch[i];
    const id = c.id || c.xiaoqu_id;

    if (doneIds.has(id)) {
      skipped++;
      if (i % 200 === 0) process.stderr.write(`[${i+1}/${toFetch.length}] 跳过已完成 ${skipped} 个...\n`);
      continue;
    }

    const result = await fetchListings(id, c.name);

    if (result.status === 'blocked') {
      blocked++;
      process.stderr.write(`[${i+1}/${toFetch.length}] BLOCKED - ${c.name}\n`);
    } else if (result.status === 'empty') {
      empty++;
    } else {
      success++;
      results.push(...result.listings);
    }
    doneIds.add(id);

    const fetched = success + empty + blocked;
    if (fetched % 10 === 0) {
      process.stderr.write(`[${i+1}/${toFetch.length}] 已抓: ${fetched} | 有房源: ${success} | 无售: ${empty} | 拦截: ${blocked} | 房源总计: ${results.length}\n`);
    }

    if (fetched % SAVE_EVERY === 0) {
      fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
      process.stderr.write(`--- 已保存 ${results.length} 条 ---\n`);
    }

    if (!testMode) await randomDelay(1200, 2800);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  const summary = { total_listings: results.length, success, empty, blocked, skipped, file: OUT_FILE };
  console.log(JSON.stringify(summary, null, 2));
  process.stderr.write(`\n完成！总房源: ${results.length} 条\n`);
}

main().catch(console.error);
