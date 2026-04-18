/**
 * 链家参考均价批量抓取脚本（Playwright）
 * 支持：断点续传 / 随机延迟 / 失败重试 / --input 指定目标文件
 *
 * 用法：
 *   node scripts/fetch_lianjia_ref_price.mjs                          # 默认 communities.json，前10条
 *   node scripts/fetch_lianjia_ref_price.mjs --input commute_targets  # 读 data/processed/commute_targets.json
 *   node scripts/fetch_lianjia_ref_price.mjs --input commute_targets --limit 0  # 跑全量
 *   node scripts/fetch_lianjia_ref_price.mjs --resume                 # 断点续传（自动跳过已抓）
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── 参数解析 ──────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : def;
};
const hasFlag = (flag) => args.includes(flag);

const INPUT_KEY  = getArg('--input', null);   // null = 默认 communities.json
const LIMIT      = parseInt(getArg('--limit', '10')); // 0 = 全量
const RESUME     = hasFlag('--resume');
const DELAY_MIN  = 3000;  // 最小延迟 ms
const DELAY_MAX  = 6000;  // 最大延迟 ms
const SAVE_EVERY = 50;    // 每 N 条保存一次
const MAX_RETRY  = 2;     // 最大重试次数

// ── 输入文件 ──────────────────────────────────────────
let commFile, outTag;
if (INPUT_KEY) {
  commFile = join(ROOT, `data/processed/${INPUT_KEY}.json`);
  outTag   = INPUT_KEY;
} else {
  commFile = join(ROOT, 'data/processed/communities.json');
  outTag   = 'all';
}

const rawData = JSON.parse(readFileSync(commFile, 'utf-8'));
const allCommunities = (rawData.communities || rawData).filter(c => c.source_url);
console.log(`读取 ${commFile}`);
console.log(`有 source_url 的小区: ${allCommunities.length} 个`);

// ── 断点续传：读取已有结果 ────────────────────────────
const outDir  = join(ROOT, 'data/raw');
mkdirSync(outDir, { recursive: true });
// 固定文件名，不含日期，避免续传时找不到
const outFile = join(outDir, `lianjia_ref_price_${outTag}.json`);

let existingResults = [];
if (RESUME && existsSync(outFile)) {
  const prev = JSON.parse(readFileSync(outFile, 'utf-8'));
  existingResults = prev.ref_prices || [];
  console.log(`断点续传：已有 ${existingResults.length} 条结果`);
}
const doneUrls = new Set(existingResults.map(r => r.source_url));

// ── 目标列表 ──────────────────────────────────────────
let targets = allCommunities.filter(c => !doneUrls.has(c.source_url));
if (LIMIT > 0) targets = targets.slice(0, LIMIT);
console.log(`本次抓取: ${targets.length} 条${RESUME ? '（跳过已有）' : ''}`);
if (targets.length === 0) { console.log('无需抓取，退出。'); process.exit(0); }

// ── Cookie ────────────────────────────────────────────
const COOKIES = [
  { name: '_ga', value: 'GA1.2.293870317.1765633686', domain: '.lianjia.com', path: '/' },
  { name: 'crosSdkDT2019DeviceId', value: 'bz9me1--1vlpj0-kxh3tsc3ped9f5r-ttv4wsge7', domain: '.lianjia.com', path: '/' },
  { name: 'lianjia_uuid', value: 'f5513861-34b1-4f99-97df-ee02ab7c637d', domain: '.lianjia.com', path: '/' },
  { name: 'lianjia_token', value: '2.001403b4636a95602e05ae9d5245de2427', domain: '.lianjia.com', path: '/' },
  { name: 'lianjia_token_secure', value: '2.001403b4636a95602e05ae9d5245de2427', domain: '.lianjia.com', path: '/', secure: true, sameSite: 'None' },
  { name: 'login_ucid', value: '2000000066304417', domain: '.lianjia.com', path: '/', httpOnly: true },
  { name: 'security_ticket', value: 'c35Xxaqz/6Y6C6YIkk4kOklIcrFSzwna1VTsyHCY1hZ6EQqIxz6o1lODL1E5ycIO2w6P0pU9C3UFBw1uGk8DAK50EKtbhu7EQGi3P4n4Fz4BFhRMVckkRAcM7mCqPzkNEbRGAZi47RBnzVcVItxMlFnRtLw+eB9k2rXkSN7bk2g=', domain: '.lianjia.com', path: '/' },
  { name: 'ftkrc_', value: 'ee63d70a-3351-4137-80b9-470d8d4e90f1', domain: '.lianjia.com', path: '/', httpOnly: true, secure: true },
  { name: 'lfrc_', value: '4fd35644-c847-4381-be3d-9e932b15c5a5', domain: '.lianjia.com', path: '/', httpOnly: true, secure: true },
  { name: 'select_city', value: '310000', domain: '.lianjia.com', path: '/' },
  { name: 'lianjia_ssid', value: '66221d23-ff97-4482-bf78-60394b108b19', domain: '.lianjia.com', path: '/' },
  { name: 'HMACCOUNT', value: 'AB41D70375C4B3C6', domain: '.lianjia.com', path: '/' },
  { name: 'Hm_lpvt_46bf127ac9b856df503ec2dbf942b67e', value: '1776356513', domain: '.lianjia.com', path: '/' },
  { name: 'Hm_lvt_46bf127ac9b856df503ec2dbf942b67e', value: '1776356428', domain: '.lianjia.com', path: '/' },
];

// ── 抓取函数 ──────────────────────────────────────────
async function fetchRefPrice(page, url, retries = 0) {
  try {
    await page.goto(url, { timeout: 25000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const html = await page.content();

    // 检查是否跳到登录页
    if (html.includes('请登录') && html.includes('login') && !html.includes('参考均价')) {
      return { ref_price: null, method: 'login_required' };
    }

    // 方案1：正则匹配「参考均价 XX,XXX」
    const m1 = html.match(/参考均价[^\d]*?([\d,]+)\s*元/);
    if (m1) return { ref_price: parseInt(m1[1].replace(/,/g, '')), method: 'regex' };

    // 方案2：unitPrice JSON 字段
    const m2 = html.match(/"unitPrice"\s*:\s*"?([\d]+)"?/);
    if (m2) return { ref_price: parseInt(m2[1]), method: 'json_unitPrice' };

    // 方案3：DOM 查询
    const domPrice = await page.evaluate(() => {
      const el = document.querySelector('.xiaoquDetailPrice .price') ||
                 document.querySelector('[class*="unitPrice"]') ||
                 document.querySelector('[class*="refPrice"]');
      return el ? el.innerText.trim() : null;
    });
    if (domPrice) {
      const m3 = domPrice.match(/[\d,]+/);
      if (m3) return { ref_price: parseInt(m3[0].replace(/,/g, '')), method: 'dom' };
    }

    return { ref_price: null, method: 'not_found' };
  } catch (e) {
    if (retries < MAX_RETRY) {
      await new Promise(r => setTimeout(r, 3000));
      return fetchRefPrice(page, url, retries + 1);
    }
    return { ref_price: null, method: 'error', error: e.message };
  }
}

function saveResults(results) {
  const all = [...existingResults, ...results];
  const output = {
    _meta: {
      source: 'lianjia_ref_price',
      input: outTag,
      crawled_at: new Date().toISOString(),
      total: all.length,
      success: all.filter(r => r.ref_price !== null).length,
    },
    ref_prices: all,
  };
  writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf-8');
}

// ── 主流程 ────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
  locale: 'zh-CN',
});
await context.addCookies(COOKIES);
const page = await context.newPage();

const results = [];
let loginFailed = 0;

for (let i = 0; i < targets.length; i++) {
  const c = targets[i];
  const progress = `[${i + 1}/${targets.length}]`;
  process.stdout.write(`${progress} ${c.name} (${c.district}) ... `);

  const result = await fetchRefPrice(page, c.source_url);

  if (result.method === 'login_required') {
    loginFailed++;
    console.log('⚠️  需要登录');
    if (loginFailed >= 3) {
      console.log('\nCookie 已失效，停止抓取。请重新导出 Cookie。');
      break;
    }
  } else {
    loginFailed = 0; // 重置连续失败计数
  }

  const entry = {
    source_url: c.source_url,
    name: c.name,
    district: c.district,
    ref_price: result.ref_price,
    method: result.method,
  };
  if (result.error) entry.error = result.error;
  results.push(entry);

  const status = result.ref_price
    ? `✓ ${result.ref_price.toLocaleString()}元/㎡`
    : `— ${result.method}`;
  console.log(status);

  // 定期保存
  if ((i + 1) % SAVE_EVERY === 0) {
    saveResults(results);
    const successRate = results.filter(r => r.ref_price !== null).length / results.length;
    console.log(`  💾 已保存 ${results.length} 条，成功率 ${(successRate * 100).toFixed(1)}%`);
  }

  // 随机延迟
  if (i < targets.length - 1) {
    const delay = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
    await page.waitForTimeout(delay);
  }
}

await browser.close();
saveResults(results);

const total = existingResults.length + results.length;
const success = [...existingResults, ...results].filter(r => r.ref_price !== null).length;
console.log(`\n输出: ${outFile}`);
console.log(`总计: ${total} 条，成功: ${success} (${(success/total*100).toFixed(1)}%)`);
