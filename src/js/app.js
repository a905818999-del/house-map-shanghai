/**
 * 上海房源地图 v2 - 主应用
 * 高德地图 JS API v2 | 四象限洼地分析 + 环线 + 通勤
 *
 * LOD 分层策略:
 *   zoom < 10   → 热力图 + 环线/CAZ（无 marker）
 *   zoom 10-12  → 网格采样，彩色价格胶囊（约 150 个）
 *   zoom 12-14  → 四象限圆点 + 偏差%（视口内，约 300 个上限）
 *   zoom ≥ 14   → 详细白卡片（价格+楼龄+偏差+通勤）
 */

const App = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let map = null;
  let infoWindow = null;
  let markers = [];
  let heatmapLayer = null;
  let heatmapOn = false;
  let ringPolylines = [];
  let cazPolygon = null;
  let ringsVisible = true;
  let allData = [];
  let filteredData = [];
  let colorMode = 'quadrant'; // 'quadrant' | 'price' | 'year'
  let valleyMode = false;     // 洼地模式：只显示绿色
  let selectedDistricts = new Set();
  let dataLoadedManually = false;
  let lodTimer = null;

  // 楼龄图层
  let boundaries = null;       // 从 boundaries.json 加载的 {id: {rings, source}}
  let agePolygons = [];        // AMap.Polygon[] 当前渲染的楼龄色块
  const BOUNDARIES_PATHS = [
    '../data/processed/boundaries.json',
    './data/processed/boundaries.json',
  ];

  // 通勤状态
  let commuteTargets = [];    // [{lng,lat,name}] 最多2个
  let commuteCache = {};      // {communityId: {t1,t2,total}}
  let commuteMode = 'driving'; // 'driving' | 'transit'
  let drivingService = null;
  let transitService = null;
  let isochronePolygons = []; // 等时圈多边形

  // 板块均价（按行政区计算）
  let districtAvg = {};

  // ── 阈值 ──────────────────────────────────────────────────────────────────
  const ZOOM_HEATMAP_ONLY = 10;
  const ZOOM_SPARSE       = 12;
  const ZOOM_QUAD         = 14; // 12-14 四象限模式
  const LOD_CAPS = { sparse: 80, quad: 150 };

  const DATA_PATHS = [
    '../data/processed/communities.json',
    './data/processed/communities.json',
  ];
  const RINGS_PATHS = [
    '../data/rings.json',
    './data/rings.json',
  ];

  // ── 四象限配置 ─────────────────────────────────────────────────────────────
  const Q = {
    valley:  { color: '#27AE60', bg: '#E8F8E8', label: '洼地',  emoji: '🟢' },
    warning: { color: '#E74C3C', bg: '#FDE8E8', label: '贵旧',  emoji: '🔴' },
    premium: { color: '#8E44AD', bg: '#F3E8FD', label: '新贵',  emoji: '🟣' },
    normal:  { color: '#F39C12', bg: '#FEF3E8', label: '旧便宜',emoji: '🟡' },
    neutral: { color: '#7F8C8D', bg: '#F0F0F0', label: '中性',  emoji: '⚪' },
    unknown: { color: '#BDBDBD', bg: '#F5F5F5', label: '无数据',emoji: '—'  },
  };

  // ── 颜色工具 ───────────────────────────────────────────────────────────────
  const PRICE_TIERS = [
    { max: 40000,    color: '#27AE60' },
    { max: 60000,    color: '#82C341' },
    { max: 80000,    color: '#F1C40F' },
    { max: 100000,   color: '#F39C12' },
    { max: 130000,   color: '#E74C3C' },
    { max: Infinity, color: '#8E44AD' },
  ];

  // 楼龄 8 档颜色（绿→黄→橙→红，越老越红）
  // 档位：<1990, 1990-94, 1995-99, 2000-04, 2005-09, 2010-14, 2015-19, 2020+
  const AGE_TIERS = [
    { maxYear: 1989, color: '#8B0000', label: '90年前' },   // 深红
    { maxYear: 1994, color: '#C0392B', label: '90-94' },    // 红
    { maxYear: 1999, color: '#E67E22', label: '95-99' },    // 橙
    { maxYear: 2004, color: '#F1C40F', label: '2000-04' },  // 黄
    { maxYear: 2009, color: '#A8D08D', label: '05-09' },    // 浅绿
    { maxYear: 2014, color: '#52BE80', label: '10-14' },    // 中绿
    { maxYear: 2019, color: '#1E8449', label: '15-19' },    // 深绿
    { maxYear: Infinity, color: '#0B5394', label: '2020+' }, // 蓝（最新）
  ];

  function getAgeColor(buildYear) {
    if (!buildYear) return '#BDBDBD';
    for (const t of AGE_TIERS) if (buildYear <= t.maxYear) return t.color;
    return AGE_TIERS.at(-1).color;
  }

  function getPriceColor(p) {
    if (p == null) return '#BDBDBD';
    for (const t of PRICE_TIERS) if (p < t.max) return t.color;
    return PRICE_TIERS.at(-1).color;
  }

  function getQuadrant(c) {
    const avg = districtAvg[c.district];
    if (!avg || !c.ref_price) return 'unknown';
    const ratio = c.ref_price / avg;
    const isNew  = c.build_year >= 2009;   // ≤15年
    const isOld  = !c.build_year || c.build_year < 1999; // >25年
    if (ratio < 0.90 && isNew)  return 'valley';
    if (ratio > 1.10 && isOld)  return 'warning';
    if (ratio >= 0.95 && isNew) return 'premium';
    if (ratio <= 1.05 && isOld) return 'normal';
    return 'neutral';
  }

  function getDeviation(c) {
    const avg = districtAvg[c.district];
    if (!avg || !c.ref_price) return null;
    return Math.round((c.ref_price / avg - 1) * 100);
  }

  function getMarkerColor(c) {
    if (colorMode === 'quadrant') return Q[getQuadrant(c)].color;
    if (colorMode === 'price') return getPriceColor(c.ref_price);
    return '#4A90D9'; // year mode 用楼龄bar替代，marker颜色统一蓝
  }

  // ── 预计算板块均价 ─────────────────────────────────────────────────────────
  function computeDistrictAvg(data) {
    const acc = {};
    data.forEach(c => {
      if (!c.ref_price || !c.district) return;
      if (!acc[c.district]) acc[c.district] = { sum: 0, n: 0 };
      acc[c.district].sum += c.ref_price;
      acc[c.district].n++;
    });
    districtAvg = {};
    Object.keys(acc).forEach(d => {
      districtAvg[d] = acc[d].sum / acc[d].n;
    });
  }

  // ── AMap 加载 ──────────────────────────────────────────────────────────────
  function initMap() {
    const input = document.getElementById('api-key-input');
    // 自动补 Key（config.js 已加载时）
    if (!input.value.trim() && window.LOCAL_CONFIG?.amapKey) {
      input.value = window.LOCAL_CONFIG.amapKey;
    }
    const key = input.value.trim() || '1cf0650cf8cc24f862e1d3a1d023b93c';
    showLoading('正在加载高德地图 SDK...');

    // securityJsCode 已在 <head> 里预设，无需重复设置

    const old = document.getElementById('amap-script');
    if (old) old.remove();
    const s = document.createElement('script');
    s.id = 'amap-script';
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${key}&plugin=AMap.InfoWindow,AMap.HeatMap,AMap.Driving,AMap.Transfer,AMap.Geocoder,AMap.PlaceSearch`;
    s.onload = onAmapReady;
    s.onerror = () => hideLoading('❌ 加载失败，请检查 API Key');
    document.head.appendChild(s);
  }

  function onAmapReady() {
    map = new AMap.Map('map', {
      zoom: 11,
      center: [121.4737, 31.2304],
      mapStyle: (typeof LOCAL_CONFIG !== 'undefined' && LOCAL_CONFIG.mapStyle)
        ? LOCAL_CONFIG.mapStyle : 'amap://styles/light',
      resizeEnable: true,
    });
    setTimeout(() => map.resize(), 300);

    infoWindow = new AMap.InfoWindow({
      anchor: 'bottom-center',
      offset: new AMap.Pixel(0, -20),
      closeWhenClickMap: true,
    });

    document.addEventListener('keydown', e => { if (e.key === 'Escape') infoWindow?.close(); });
    map.on('zoomchange', scheduleLodRender);
    map.on('moveend',    scheduleLodRender);

    // 初始化路径规划服务
    drivingService = new AMap.Driving({ policy: AMap.DrivingPolicy.LEAST_TIME });
    transitService = new AMap.Transfer({ city: '上海', policy: AMap.TransferPolicy.LEAST_TIME });

    loadRings();

    if (dataLoadedManually && allData.length > 0) {
      buildDistrictFilter(); applyFilters(); hideLoading();
    } else {
      loadData();
    }
  }

  // ── 加载环线 + CAZ ─────────────────────────────────────────────────────────
  async function loadRings() {
    let json = null;
    for (const p of RINGS_PATHS) {
      try { const r = await fetch(p); if (r.ok) { json = await r.json(); break; } } catch (_) {}
    }
    if (!json) return;

    // 三条环线，统一红色实线，外环稍细
    const RING_STYLE = {
      inner:  { weight: 3.5, opacity: 0.9, style: 'solid', dash: null },
      middle: { weight: 2.5, opacity: 0.85, style: 'solid', dash: null },
      outer:  { weight: 2.0, opacity: 0.8, style: 'solid', dash: null },
    };
    const RING_COLOR = '#E74C3C';
    Object.entries(json.rings).forEach(([key, ring]) => {
      const s = RING_STYLE[key] || { weight: 2, opacity: 0.8, style: 'solid', dash: null };
      const pl = new AMap.Polyline({
        path: ring.path,
        strokeColor: RING_COLOR,
        strokeWeight: s.weight,
        strokeOpacity: s.opacity,
        strokeStyle: s.style,
        lineJoin: 'round',
        zIndex: 5,
      });
      pl.setMap(map);
      ringPolylines.push(pl);

      // 添加标签
      const mid = ring.path[Math.floor(ring.path.length / 4)];
      const label = new AMap.Text({
        text: ring.name,
        position: new AMap.LngLat(mid[0], mid[1]),
        style: {
          'font-size': '10px', 'color': RING_COLOR,
          'background': 'transparent', 'border': 'none',
          'font-weight': '600', 'pointer-events': 'none',
        },
        zIndex: 5,
      });
      label.setMap(map);
      ringPolylines.push(label);
    });
  }

  function toggleRings() {
    ringsVisible = !ringsVisible;
    ringPolylines.forEach(p => ringsVisible ? p.show() : p.hide());
    document.getElementById('btn-rings').classList.toggle('active', ringsVisible);
  }

  // ── 数据加载 ───────────────────────────────────────────────────────────────
  async function loadData() {
    showLoading('加载小区数据...');
    let json = null;
    for (const path of DATA_PATHS) {
      try { const r = await fetch(path); if (r.ok) { json = await r.json(); break; } } catch (_) {}
    }
    if (!json) { hideLoading('❌ 未找到数据文件'); return; }
    applyDataset(json, false);
  }

  function applyDataset(json, manual = true) {
    dataLoadedManually = manual;
    allData = (json.communities || []).filter(c => c.lat && c.lng);
    computeDistrictAvg(allData);
    if (map) { buildDistrictFilter(); applyFilters(); hideLoading(); }
    else { hideLoading(); setStatus(`数据已读取 ${allData.length} 个小区，请输入 API Key 加载地图`); }
    // 延迟加载边界数据（非阻塞）
    if (!boundaries) loadBoundaries();
  }

  async function loadBoundaries() {
    for (const p of BOUNDARIES_PATHS) {
      try {
        const r = await fetch(p);
        if (r.ok) {
          const json = await r.json();
          boundaries = json.boundaries || {};
          console.log(`[boundaries] 加载 ${Object.keys(boundaries).length} 条边界`);
          // 如果当前是 year 模式，立即重渲
          if (colorMode === 'year' && map) renderByLOD();
          return;
        }
      } catch (_) {}
    }
    console.warn('[boundaries] 未找到 boundaries.json，楼龄模式将跳过多边形');
    boundaries = {};
  }

  // ── 文件上传 ───────────────────────────────────────────────────────────────
  function initFileDrop() {
    const zone = document.getElementById('map-container');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (!file?.name.endsWith('.json')) { alert('请拖拽 .json 文件'); return; }
      readJsonFile(file);
    });
  }
  function openFilePicker() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = e => { if (e.target.files[0]) readJsonFile(e.target.files[0]); };
    inp.click();
  }
  function readJsonFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try { applyDataset(JSON.parse(e.target.result), true); }
      catch (err) { alert('JSON 解析失败：' + err.message); }
    };
    reader.readAsText(file);
  }

  // ── 行政区筛选 ─────────────────────────────────────────────────────────────
  function buildDistrictFilter() {
    const districts = [...new Set(allData.map(c => c.district).filter(Boolean))].sort();
    selectedDistricts = new Set(districts);
    const el = document.getElementById('district-list');
    el.innerHTML = '';
    districts.forEach(d => {
      const chip = document.createElement('label');
      chip.className = 'district-chip checked';
      chip.dataset.district = d;
      const avg = districtAvg[d];
      const avgText = avg ? `${(avg/10000).toFixed(1)}万` : '';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true;
      cb.addEventListener('change', () => {
        cb.checked ? selectedDistricts.add(d) : selectedDistricts.delete(d);
        chip.classList.toggle('checked', cb.checked);
        applyFilters();
      });
      chip.appendChild(cb);
      chip.appendChild(document.createTextNode(`${d}${avgText ? ' '+avgText : ''}`));
      el.appendChild(chip);
    });
  }

  // ── 筛选器 ────────────────────────────────────────────────────────────────
  function applyFilters() {
    if (!map) return;
    const search   = document.getElementById('search-input').value.trim().toLowerCase();
    const priceMin = +document.getElementById('price-min').value;
    const priceMax = +document.getElementById('price-max').value;
    const yearMin  = +document.getElementById('year-min').value;
    const yearMax  = +document.getElementById('year-max').value;

    filteredData = allData.filter(c => {
      if (c.district && !selectedDistricts.has(c.district)) return false;
      if (search && !c.name.toLowerCase().includes(search)) return false;
      if (c.ref_price != null && (c.ref_price < priceMin || c.ref_price > priceMax)) return false;
      if (c.build_year != null && (c.build_year < yearMin || c.build_year > yearMax)) return false;
      if (valleyMode && getQuadrant(c) !== 'valley') return false;
      return true;
    });

    renderByLOD();
    updateStats();
    updateLegend();
    updateResultsList();
    updateValleyList();
    document.getElementById('no-data-msg').classList.toggle('show', filteredData.length === 0);
  }

  function onPriceRangeChange() {
    const min = +document.getElementById('price-min').value;
    const max = +document.getElementById('price-max').value;
    document.getElementById('price-min-val').textContent = fmtPrice(min);
    document.getElementById('price-max-val').textContent = max >= 200000 ? '20万+' : fmtPrice(max);
    applyFilters();
  }
  function onYearRangeChange() {
    document.getElementById('year-min-val').textContent = document.getElementById('year-min').value;
    document.getElementById('year-max-val').textContent = document.getElementById('year-max').value;
    applyFilters();
  }
  function resetFilters() {
    document.getElementById('search-input').value = '';
    document.getElementById('price-min').value = 0;
    document.getElementById('price-max').value = 200000;
    document.getElementById('year-min').value = 1970;
    document.getElementById('year-max').value = 2024;
    onPriceRangeChange(); onYearRangeChange();
    document.querySelectorAll('.district-chip').forEach(chip => {
      chip.classList.add('checked');
      chip.querySelector('input').checked = true;
      selectedDistricts.add(chip.dataset.district);
    });
    applyFilters();
  }

  // ── 洼地模式 ───────────────────────────────────────────────────────────────
  function toggleValleyMode() {
    valleyMode = !valleyMode;
    const btn = document.getElementById('btn-valley');
    btn.classList.toggle('active', valleyMode);
    btn.textContent = valleyMode ? '🟢 洼地模式 ON' : '🟢 洼地模式';
    applyFilters();
  }

  // ── LOD 分层渲染 ───────────────────────────────────────────────────────────
  function scheduleLodRender() {
    clearTimeout(lodTimer);
    lodTimer = setTimeout(renderByLOD, 120);
  }

  function renderByLOD() {
    if (!map) return;
    const zoom = map.getZoom();

    // year 模式：多边形替代 marker
    if (colorMode === 'year') {
      clearMarkers();
      if (zoom < ZOOM_HEATMAP_ONLY) {
        clearAgePolygons();
        renderHeatmapAuto();
        setStatus(`🗺 热力图模式（共 ${filteredData.length} 个小区）`);
        return;
      }
      if (heatmapOn) renderHeatmap();
      renderAgeLayer(zoom);
      return;
    }

    // 其他模式：清除多边形，照旧走 marker 路径
    clearAgePolygons();

    if (zoom < ZOOM_HEATMAP_ONLY) {
      clearMarkers();
      renderHeatmapAuto();
      setStatus(`🗺 热力图模式（共 ${filteredData.length} 个小区）`);
      return;
    }

    if (heatmapOn) renderHeatmap();

    const bounds = map.getBounds();
    const viewport = filteredData.filter(c => bounds.contains(new AMap.LngLat(c.lng, c.lat)));

    let toRender;
    if (zoom < ZOOM_SPARSE) {
      toRender = gridSample(viewport, bounds, LOD_CAPS.sparse);
      setStatus(`🔭 ${toRender.length} 个（视口 ${viewport.length}，共 ${filteredData.length}）· 放大看洼地分析`);
    } else if (zoom < ZOOM_QUAD) {
      toRender = viewport.length > LOD_CAPS.quad
        ? gridSample(viewport, bounds, LOD_CAPS.quad) : viewport;
      setStatus(`◉ ${toRender.length} 个小区 · 四象限模式（放大看详情）`);
    } else {
      toRender = viewport;
      setStatus(`🔍 ${toRender.length} 个小区 · 详细模式`);
    }

    buildMarkers(toRender, zoom);
  }

  function gridSample(data, bounds, maxCount) {
    if (data.length <= maxCount) return data;
    const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
    const cols = Math.ceil(Math.sqrt(maxCount * 1.5));
    const rows = cols;
    const latStep = (ne.getLat() - sw.getLat()) / rows || 0.01;
    const lngStep = (ne.getLng() - sw.getLng()) / cols || 0.01;
    const grid = new Map();
    for (const c of data) {
      const row = Math.floor((c.lat - sw.getLat()) / latStep);
      const col = Math.floor((c.lng - sw.getLng()) / lngStep);
      const key = `${row},${col}`;
      if (!grid.has(key) || (c.ref_price ?? 0) > (grid.get(key).ref_price ?? 0)) {
        grid.set(key, c);
      }
    }
    return [...grid.values()];
  }

  function clearMarkers() {
    if (markers.length) { map.remove(markers); markers = []; }
    infoWindow?.close();
  }

  // ── 楼龄多边形图层 ──────────────────────────────────────────────────────────
  function clearAgePolygons() {
    if (agePolygons.length) { map.remove(agePolygons); agePolygons = []; }
  }

  // LOD cap for year mode: limit polygons in viewport to avoid browser jank
  const AGE_POLY_CAPS = { sparse: 120, detail: 300 };

  function renderAgeLayer(zoom) {
    clearMarkers();
    clearAgePolygons();

    if (!boundaries || Object.keys(boundaries).length === 0) {
      setStatus('⚠️ 边界数据未加载，请稍候…');
      return;
    }

    const bounds = map.getBounds();
    const viewport = filteredData.filter(c => bounds.contains(new AMap.LngLat(c.lng, c.lat)));

    let toRender;
    const cap = zoom < 13 ? AGE_POLY_CAPS.sparse : AGE_POLY_CAPS.detail;
    if (viewport.length > cap) {
      toRender = gridSample(viewport, bounds, cap);
    } else {
      toRender = viewport;
    }

    const polys = [];
    toRender.forEach(c => {
      const boundary = boundaries[c.id];
      if (!boundary?.rings?.length) return;

      const color = getAgeColor(c.build_year);
      const path = boundary.rings[0].map(([lng, lat]) => new AMap.LngLat(lng, lat));
      if (path.length < 3) return;

      const poly = new AMap.Polygon({
        path,
        fillColor: color,
        fillOpacity: 0.55,
        strokeColor: color,
        strokeWeight: 1,
        strokeOpacity: 0.7,
        zIndex: 8,
        extData: c,
      });
      poly.on('click', () => {
        const fakeMarker = { getPosition: () => new AMap.LngLat(c.lng, c.lat), getExtData: () => c };
        openInfoWindow(fakeMarker, c);
      });
      polys.push(poly);
    });

    if (polys.length) {
      map.add(polys);
      agePolygons = polys;
    }

    const missing = toRender.length - polys.length;
    setStatus(`🏗 楼龄图层：${polys.length} 个小区${missing > 0 ? `（${missing}个无边界数据）` : ''}（视口 ${viewport.length}，共 ${filteredData.length}）`);
  }

  // ── 楼龄进度条 ─────────────────────────────────────────────────────────────
  function buildAgeBar(buildYear, segs = 8) {
    if (!buildYear) return Array(segs).fill('<div class="mk-age-seg"></div>').join('');
    const age = 2026 - buildYear;
    const filled = Math.min(Math.round((age / 50) * segs), segs);
    const isOld = age > 30;
    return Array.from({ length: segs }, (_, i) => {
      const cls = i < filled ? (isOld ? 'mk-age-seg on old' : 'mk-age-seg on') : 'mk-age-seg';
      return `<div class="${cls}"></div>`;
    }).join('');
  }

  // ── Marker 构建 ────────────────────────────────────────────────────────────
  function buildMarkers(data, zoom) {
    clearMarkers();
    const sparse = zoom < ZOOM_SPARSE;
    const detail  = zoom >= ZOOM_QUAD;

    data.forEach(c => {
      const quad  = getQuadrant(c);
      const qConf = Q[quad];
      const color = getMarkerColor(c);
      const price = c.ref_price != null ? `${(c.ref_price/10000).toFixed(1)}万` : '—';
      const dev   = getDeviation(c);
      const devTxt = dev != null ? (dev >= 0 ? `+${dev}%` : `${dev}%`) : '';
      const devColor = dev == null ? '#aaa' : dev <= -10 ? '#27AE60' : dev >= 10 ? '#E74C3C' : '#7F8C8D';
      const year  = c.build_year;
      const age   = year ? 2026 - year : null;
      const commute = commuteCache[c.id];

      const el = document.createElement('div');
      el.className = 'mk-wrap';

      if (sparse) {
        // 紧凑胶囊：仅价格，颜色=四象限
        el.innerHTML =
          `<div class="mk-pill" style="background:${qConf.color}">${escHtml(price)}</div>` +
          `<div class="mk-tip" style="border-top-color:${qConf.color}"></div>`;

      } else if (!detail) {
        // 四象限圆点模式（zoom 12-14）：紧凑单行
        el.innerHTML =
          `<div class="mk-quad-row">` +
            `<div class="mk-quad-dot" style="background:${qConf.color}"></div>` +
            `<span class="mk-quad-price" style="color:${color}">${escHtml(price)}</span>` +
            (devTxt ? `<span class="mk-quad-dev" style="color:${devColor}">${devTxt}</span>` : '') +
          `</div>` +
          `<div class="mk-tip" style="border-top-color:rgba(255,255,255,0.9)"></div>`;

      } else {
        // 详细卡片（zoom ≥ 14）
        const ageBar = buildAgeBar(year);
        const ageText = year ? `${year}年·${age}年房龄` : '年份未知';
        const nameRow = `<div class="mk-name" style="border-bottom:2px solid ${qConf.color}">${escHtml(c.name)}</div>`;
        const commuteRow = commute
          ? `<div class="mk-commute">🚗 ${commute.t1}+${commute.t2}=${commute.total}分</div>`
          : '';
        el.innerHTML =
          `<div class="mk-card" style="border-top:3px solid ${qConf.color}">` +
            nameRow +
            `<div class="mk-price-row">` +
              `<span class="mk-price" style="color:${color}">${escHtml(price)}</span>` +
              (devTxt ? `<span class="mk-dev" style="color:${devColor}">${devTxt}</span>` : '') +
              `<span class="mk-q-badge" style="background:${qConf.bg};color:${qConf.color}">${qConf.label}</span>` +
            `</div>` +
            `<div class="mk-age-row">` +
              `<div class="mk-age-bar">${ageBar}</div>` +
              `<span class="mk-age-txt">${escHtml(ageText)}</span>` +
            `</div>` +
            commuteRow +
          `</div>` +
          `<div class="mk-tip" style="border-top-color:#fff"></div>`;
      }

      const m = new AMap.Marker({
        position: [c.lng, c.lat],
        content: el,
        anchor: 'bottom-center',
        title: c.name,
        extData: c,
        zIndex: quad === 'valley' ? 20 : 10,
      });
      m.on('click', () => openInfoWindow(m, c));
      markers.push(m);
    });

    map.add(markers);
  }

  // ── 热力图 ────────────────────────────────────────────────────────────────
  function renderHeatmap() {
    if (!map || typeof AMap.HeatMap === 'undefined') return;
    const points = filteredData.filter(c => c.ref_price != null).map(c => ({
      lng: c.lng, lat: c.lat, count: c.ref_price / 10000,
    }));
    const maxVal = points.reduce((m, p) => Math.max(m, p.count), 1);
    if (!heatmapLayer) {
      heatmapLayer = new AMap.HeatMap(map, {
        radius: 30, opacity: [0, 0.72],
        gradient: { 0.2: '#2ecc71', 0.5: '#f1c40f', 0.75: '#e67e22', 1: '#c0392b' },
        blur: 0.85,
      });
    }
    heatmapLayer.setDataSet({ data: points, max: maxVal });
    heatmapLayer.show();
  }
  let autoHeatmap = false;
  function renderHeatmapAuto() { autoHeatmap = true; renderHeatmap(); }
  function toggleHeatmap() {
    if (!map) return;
    heatmapOn = !heatmapOn;
    const btn = document.getElementById('btn-heatmap');
    btn.classList.toggle('active', heatmapOn);
    btn.textContent = heatmapOn ? '🔥 热力图 ON' : '🔥 热力图';
    if (heatmapOn) renderHeatmap();
    else { heatmapLayer?.hide(); autoHeatmap = false; }
  }

  // ── InfoWindow ────────────────────────────────────────────────────────────
  function openInfoWindow(marker, c) {
    const quad = getQuadrant(c);
    const qConf = Q[quad];
    const dev = getDeviation(c);
    const devTxt = dev != null ? `${dev >= 0 ? '+' : ''}${dev}%` : '—';
    const avg = districtAvg[c.district];
    const commute = commuteCache[c.id];
    const age = c.build_year ? 2026 - c.build_year : null;
    const favored = isFavorite(c.id);

    infoWindow.setContent(`
      <div class="info-window">
        <div class="info-title">
          ${escHtml(c.name)}
          <span class="info-badge" style="background:${qConf.bg};color:${qConf.color}">${qConf.emoji} ${qConf.label}</span>
        </div>
        <div class="info-row">
          <span class="info-key">💰 挂牌均价</span>
          <span class="info-val" style="color:${getPriceColor(c.ref_price)}">${c.ref_price != null ? fmtPrice(c.ref_price)+' 元/㎡' : '暂无数据'}</span>
        </div>
        ${c.ref_price != null ? `<div class="info-row">
          <span class="info-key">✅ 参考均价</span>
          <span class="info-val" style="color:${getPriceColor(c.ref_price)};font-weight:600">${fmtPrice(c.ref_price)} 元/㎡<span style="color:#888;font-size:11px;font-weight:400"> 链家近期成交</span></span>
        </div>` : ''}
        <div class="info-row">
          <span class="info-key">📊 vs ${c.district}均价</span>
          <span class="info-val" style="color:${dev==null?'#aaa':dev<=0?'#27AE60':'#E74C3C'}">${devTxt}（${avg ? fmtPrice(Math.round(avg))+'元' : '—'}）</span>
        </div>
        <div class="info-row">
          <span class="info-key">🏗 建成年份</span>
          <span class="info-val" style="color:#1565c0">${c.build_year ?? '暂无'}${age != null ? `（房龄 ${age} 年）` : ''}</span>
        </div>
        ${c.subdistrict ? `<div class="info-row"><span class="info-key">📍 街道</span><span class="info-val">${escHtml(c.subdistrict)}</span></div>` : ''}
        ${commute ? `<div class="info-row"><span class="info-key">🚗 通勤</span><span class="info-val">目的地1: ${commute.t1}分 · 目的地2: ${commute.t2}分</span></div>` : ''}
        <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center">
          ${c.source_url ? `<a href="${c.source_url}" target="_blank" style="font-size:11px;color:#1a73e8">链家详情 →</a>` : '<span></span>'}
          <button onclick="App.toggleFavorite('${c.id}')" style="border:none;background:${favored?'#FFF3E0':'#f5f5f5'};color:${favored?'#E65100':'#555'};padding:4px 10px;border-radius:12px;cursor:pointer;font-size:12px">
            ${favored ? '★ 已收藏' : '☆ 收藏'}
          </button>
        </div>
      </div>`);
    infoWindow.open(map, marker.getPosition());
  }

  // ── 颜色模式切换 ───────────────────────────────────────────────────────────
  function setMode(mode) {
    colorMode = mode;
    ['quadrant','price','year'].forEach(m => {
      document.getElementById(`mode-${m}`)?.classList.toggle('active', m === mode);
    });
    if (mode !== 'year') clearAgePolygons();
    renderByLOD();
    updateLegend();
    updateResultsList();
  }

  // ── 洼地榜单 ───────────────────────────────────────────────────────────────
  function updateValleyList() {
    const el = document.getElementById('valley-list');
    if (!el) return;
    const valleys = allData
      .filter(c => getQuadrant(c) === 'valley')
      .sort((a, b) => getDeviation(a) - getDeviation(b))
      .slice(0, 50);

    if (!valleys.length) {
      el.innerHTML = '<div class="list-empty">暂无洼地小区</div>';
      document.getElementById('valley-count').textContent = '0';
      return;
    }
    document.getElementById('valley-count').textContent = allData.filter(c => getQuadrant(c) === 'valley').length;
    const commuteSorted = commuteCache && Object.keys(commuteCache).length > 0;
    const list = commuteSorted
      ? valleys.sort((a, b) => (commuteCache[a.id]?.total ?? 999) - (commuteCache[b.id]?.total ?? 999))
      : valleys;

    el.innerHTML = list.map((c, i) => {
      const dev = getDeviation(c);
      const devTxt = dev != null ? `${dev}%` : '';
      const commute = commuteCache[c.id];
      const commuteText = commute ? `🚗${commute.total}分` : '';
      return `<div class="result-item" onclick="App.flyTo(${c.lng},${c.lat},'${c.id}')">
        <div class="valley-rank">${i+1}</div>
        <div class="result-info">
          <div class="result-name">${escHtml(c.name)}</div>
          <div class="result-meta">
            <b style="color:#27AE60">${(c.ref_price/10000).toFixed(1)}万</b>
            <span style="color:#27AE60;font-size:10px"> ${devTxt}</span>
            · ${c.build_year ?? '—'}年
            · ${c.district ?? ''}
            ${commuteText ? `· <span style="color:#4A90D9">${commuteText}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // ── 结果列表 ──────────────────────────────────────────────────────────────
  const LIST_MAX = 30;
  function updateResultsList() {
    const sorted = [...filteredData].sort((a, b) => (b.ref_price ?? 0) - (a.ref_price ?? 0));
    document.getElementById('list-count').textContent =
      `${filteredData.length} 个${filteredData.length > LIST_MAX ? `，显示前${LIST_MAX}` : ''}`;
    const list = document.getElementById('results-list');
    if (!filteredData.length) { list.innerHTML = '<div class="list-empty">无匹配小区</div>'; return; }
    list.innerHTML = sorted.slice(0, LIST_MAX).map(c => {
      const quad = getQuadrant(c);
      const color = Q[quad].color;
      const dev = getDeviation(c);
      const devTxt = dev != null ? `<span style="color:${dev<=0?'#27AE60':'#E74C3C'};font-size:10px">${dev>=0?'+':''}${dev}%</span>` : '';
      return `<div class="result-item" onclick="App.flyTo(${c.lng},${c.lat},'${c.id}')">
        <div class="result-dot" style="background:${color}"></div>
        <div class="result-info">
          <div class="result-name">${escHtml(c.name)}</div>
          <div class="result-meta">
            <b style="color:${getPriceColor(c.ref_price)}">${c.ref_price != null ? (c.ref_price/10000).toFixed(1)+'万' : '均价未知'}</b>
            ${devTxt} · ${c.build_year ?? '—'}年 · ${c.district ?? ''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function flyTo(lng, lat, id) {
    if (!map) return;
    map.setZoomAndCenter(15, [lng, lat], false, 400);
    setTimeout(() => {
      const target = allData.find(c => c.id === id);
      if (!target) return;
      const m = markers.find(mk => mk.getExtData()?.id === id);
      if (m) { openInfoWindow(m, target); return; }
      const age = target.build_year ? 2026 - target.build_year : null;
      infoWindow.setContent(`<div class="info-window">
        <div class="info-title">${escHtml(target.name)}</div>
        <div class="info-row"><span class="info-key">💰 均价</span><span class="info-val">${target.ref_price != null ? fmtPrice(target.ref_price)+' 元/㎡' : '暂无'}</span></div>
        <div class="info-row"><span class="info-key">🏗 建成</span><span class="info-val">${target.build_year ?? '—'}${age ? `（${age}年）` : ''}</span></div>
      </div>`);
      infoWindow.open(map, new AMap.LngLat(lng, lat));
    }, 450);
  }

  // ── 通勤计算 ───────────────────────────────────────────────────────────────
  let geocoder = null;

  function initGeocoder() {
    if (!geocoder && typeof AMap !== 'undefined') {
      geocoder = new AMap.Geocoder({ city: '上海', limit: 1 });
    }
  }

  function addCommuteTarget(index) {
    initGeocoder();
    const inputId = `commute-addr-${index}`;
    const addr = document.getElementById(inputId)?.value.trim();
    if (!addr) return;
    showLoading('定位目的地...');
    geocoder.getLocation(addr, (status, result) => {
      hideLoading();
      if (status !== 'complete' || !result.geocodes.length) {
        alert(`地址 "${addr}" 未找到`); return;
      }
      const loc = result.geocodes[0].location;
      commuteTargets[index] = { lng: loc.lng, lat: loc.lat, name: addr };
      document.getElementById(`commute-tag-${index}`).textContent = `📍 ${addr}`;
      document.getElementById(`commute-tag-${index}`).style.display = 'block';
    });
  }

  let commuteQueue = [];
  let commuteRunning = false;

  function calcCommute() {
    if (!commuteTargets.filter(Boolean).length) { alert('请至少设置一个目的地'); return; }
    if (!drivingService && !transitService) { alert('路径规划服务未加载'); return; }

    const bounds = map.getBounds();
    const viewport = filteredData.filter(c => bounds.contains(new AMap.LngLat(c.lng, c.lat))).slice(0, 100);

    commuteQueue = viewport.map(c => c);
    commuteRunning = true;
    setStatus(`🚗 计算 ${viewport.length} 个小区通勤...`);
    document.getElementById('btn-calc-commute').disabled = true;
    processCommuteQueue();
  }

  function processCommuteQueue() {
    if (!commuteQueue.length) {
      commuteRunning = false;
      document.getElementById('btn-calc-commute').disabled = false;
      setStatus(`✅ 通勤计算完成（${Object.keys(commuteCache).length} 个）`);
      renderByLOD();
      updateValleyList();
      return;
    }
    const c = commuteQueue.shift();
    const origin = new AMap.LngLat(c.lng, c.lat);
    const targets = commuteTargets.filter(Boolean);
    let results = [];
    let done = 0;

    targets.forEach((t, i) => {
      const dest = new AMap.LngLat(t.lng, t.lat);
      const svc = commuteMode === 'driving' ? drivingService : transitService;
      svc.search(origin, dest, (status, res) => {
        if (status === 'complete') {
          const mins = commuteMode === 'driving'
            ? Math.round(res.routes[0].time / 60)
            : Math.round(res.plans[0].time / 60);
          results[i] = mins;
        } else {
          results[i] = null;
        }
        done++;
        if (done === targets.length) {
          commuteCache[c.id] = {
            t1: results[0] ?? '—',
            t2: results[1] ?? '—',
            total: (results[0] ?? 0) + (results[1] ?? 0),
          };
          setTimeout(processCommuteQueue, 120); // 限流：约8req/s
        }
      });
    });
  }

  function openIsochroneMap() {
    // 将当前工作地点同步到 localStorage，供 commute_iso.html 读取
    localStorage.setItem('commuteTargets', JSON.stringify(commuteTargets));
    const target = commuteTargets.filter(Boolean)[0];
    let url = 'commute_iso.html';
    if (target) {
      url += `?lng=${target.lng}&lat=${target.lat}&name=${encodeURIComponent(target.name || '工作地点')}`;
    }
    window.open(url, '_blank');
  }

  function clearCommute() {
    commuteTargets = [];
    commuteCache = {};
    commuteQueue = [];
    commuteRunning = false;
    // 清除等时圈多边形
    isochronePolygons.forEach(p => map && p.setMap(null));
    isochronePolygons = [];
    [0, 1].forEach(i => {
      const el = document.getElementById(`commute-tag-${i}`);
      if (el) el.style.display = 'none';
      const inp = document.getElementById(`commute-addr-${i}`);
      if (inp) inp.value = '';
    });
    renderByLOD();
    setStatus('通勤已清空');
  }

  // ── 等时圈 ─────────────────────────────────────────────────────────────────
  // 用法：在「定位」目的地后点「画等时圈」
  // 原理：从目标点向 16 个方向各查一次驾车/公交路径，
  //       取每条路径 25min（驾车）/ 35min（公交）可达的点，连成多边形。
  function drawIsochrone() {
    const validTargets = commuteTargets.filter(Boolean);
    if (!validTargets.length) {
      alert('请先在「目的地」中输入地址并点击「定位」');
      return;
    }
    if (!drivingService && !transitService) {
      alert('路径规划服务未加载，请先加载地图');
      return;
    }

    // 清除旧等时圈
    isochronePolygons.forEach(p => p.setMap(null));
    isochronePolygons = [];

    const btn = document.getElementById('btn-draw-isochrone');
    if (btn) btn.disabled = true;
    setStatus('⏳ 计算等时圈...');

    const DIRECTIONS = 16; // 采样方向数
    const MAX_MIN_DRIVING = 25;  // 驾车 25 分钟
    const MAX_MIN_TRANSIT = 35;  // 公交 35 分钟
    const EARTH_R = 6371000;     // 地球半径（米）

    // 根据通勤时间估算初始探测距离（米）
    // 上海市区平均车速约 20km/h，公交约 15km/h
    function estimateDist(mode) {
      if (mode === 'driving') return (MAX_MIN_DRIVING / 60) * 20000; // ~8333m
      return (MAX_MIN_TRANSIT / 60) * 15000; // ~8750m
    }

    // 从中心点出发，沿方位角 bearing（度），移动 dist（米），返回新坐标
    function destPoint(lat, lng, bearing, dist) {
      const rad = bearing * Math.PI / 180;
      const dLat = (dist * Math.cos(rad)) / EARTH_R;
      const dLng = (dist * Math.sin(rad)) / (EARTH_R * Math.cos(lat * Math.PI / 180));
      return [lat + dLat * 180 / Math.PI, lng + dLng * 180 / Math.PI];
    }

    async function calcOneIsochrone(target, mode) {
      const maxMins = mode === 'driving' ? MAX_MIN_DRIVING : MAX_MIN_TRANSIT;
      const svc = mode === 'driving' ? drivingService : transitService;
      const estimatedDist = estimateDist(mode);

      const points = []; // 各方向的可达点

      for (let i = 0; i < DIRECTIONS; i++) {
        const bearing = (360 / DIRECTIONS) * i;
        const [destLat, destLng] = destPoint(target.lat, target.lng, bearing, estimatedDist);
        const dest = new AMap.LngLat(destLng, destLat);
        const origin = new AMap.LngLat(target.lng, target.lat);

        await new Promise(resolve => {
          svc.search(origin, dest, (status, res) => {
            if (status === 'complete') {
              let mins;
              if (mode === 'driving') {
                mins = (res.routes?.[0]?.time ?? 0) / 60;
              } else {
                mins = (res.plans?.[0]?.time ?? 0) / 60;
              }

              if (mins > 0 && mins <= maxMins * 1.5) {
                // 按比例缩放：如果实际 N 分钟到了 D 米，则 maxMins 分钟能到 D * maxMins/N 米
                const ratio = maxMins / mins;
                const scaledDist = estimatedDist * Math.min(ratio, 2.0); // 防止过度外推
                const [adjLat, adjLng] = destPoint(target.lat, target.lng, bearing, scaledDist);
                points.push(new AMap.LngLat(adjLng, adjLat));
              } else {
                // 路径失败，用估算点
                points.push(dest);
              }
            } else {
              points.push(new AMap.LngLat(destLng, destLat));
            }
            resolve();
          });
          // 限流
          setTimeout(resolve, 800);
        });
        await new Promise(r => setTimeout(r, 200)); // 每个方向之间小延迟
      }

      if (points.length < 3) return;

      // 绘制多边形
      const color = mode === 'driving' ? '#2980B9' : '#27AE60';
      const polygon = new AMap.Polygon({
        path: points,
        strokeColor: color,
        strokeWeight: 2,
        strokeOpacity: 0.8,
        fillColor: color,
        fillOpacity: 0.08,
        zIndex: 50,
      });
      polygon.setMap(map);
      isochronePolygons.push(polygon);

      // 图例标签
      const label = new AMap.Text({
        text: mode === 'driving' ? `🚗 驾车${MAX_MIN_DRIVING}min` : `🚇 公交${MAX_MIN_TRANSIT}min`,
        position: new AMap.LngLat(target.lng, target.lat),
        offset: new AMap.Pixel(0, mode === 'driving' ? -15 : 15),
        style: {
          fontSize: '12px',
          color: color,
          background: 'rgba(255,255,255,0.8)',
          padding: '2px 6px',
          borderRadius: '4px',
          border: `1px solid ${color}`,
        },
      });
      label.setMap(map);
      isochronePolygons.push(label);
    }

    // 对每个目的地、每种模式各画一个等时圈
    async function runAll() {
      try {
        for (const target of validTargets) {
          if (drivingService) await calcOneIsochrone(target, 'driving');
          if (transitService) await calcOneIsochrone(target, 'transit');
        }
        setStatus(`✅ 等时圈已绘制（蓝色=驾车${MAX_MIN_DRIVING}min，绿色=公交${MAX_MIN_TRANSIT}min）`);
      } catch (e) {
        setStatus('等时圈计算出错');
        console.error(e);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    runAll();
  }

  // ── 收藏功能 ───────────────────────────────────────────────────────────────
  function loadFavorites() {
    try { return new Set(JSON.parse(localStorage.getItem('house_map_favorites') || '[]')); }
    catch (_) { return new Set(); }
  }

  function saveFavorites(favSet) {
    localStorage.setItem('house_map_favorites', JSON.stringify([...favSet]));
  }

  function isFavorite(id) {
    return loadFavorites().has(id);
  }

  function toggleFavorite(id) {
    const favs = loadFavorites();
    if (favs.has(id)) favs.delete(id);
    else favs.add(id);
    saveFavorites(favs);
    updateFavoritesPanel();
    // 刷新 InfoWindow（如果还开着，重新打开当前小区）
    const target = allData.find(c => c.id === id);
    if (target) {
      const m = markers.find(mk => mk.getExtData()?.id === id);
      if (m) openInfoWindow(m, target);
    }
  }

  function updateFavoritesPanel() {
    const el = document.getElementById('favorites-list');
    if (!el) return;
    const favs = loadFavorites();
    // 更新 tab 角标 和 面板标题数字
    const badge = document.getElementById('fav-count');
    if (badge) badge.textContent = favs.size || '';
    const panelCount = document.getElementById('fav-count-panel');
    if (panelCount) panelCount.textContent = favs.size;
    if (!favs.size) {
      el.innerHTML = '<div class="list-empty">尚未收藏任何小区</div>';
      return;
    }
    const favCommunities = allData.filter(c => favs.has(c.id));
    el.innerHTML = favCommunities.map(c => {
      const quad = getQuadrant(c);
      const color = Q[quad].color;
      const dev = getDeviation(c);
      const devTxt = dev != null ? `<span style="color:${dev<=0?'#27AE60':'#E74C3C'};font-size:10px">${dev>=0?'+':''}${dev}%</span>` : '';
      return `<div class="result-item">
        <div class="result-dot" style="background:${color}"></div>
        <div class="result-info" onclick="App.flyTo(${c.lng},${c.lat},'${c.id}')" style="cursor:pointer">
          <div class="result-name">${escHtml(c.name)}</div>
          <div class="result-meta">
            <b style="color:${color}">${c.ref_price != null ? (c.ref_price/10000).toFixed(1)+'万' : '均价未知'}</b>
            ${devTxt} · ${c.build_year ?? '—'}年 · ${c.district ?? ''}
          </div>
        </div>
        <button class="fav-remove-btn" onclick="App.toggleFavorite('${c.id}')" title="取消收藏">✕</button>
      </div>`;
    }).join('');
  }

  // ── Tab 切换 ───────────────────────────────────────────────────────────────
  function switchTab(tab) {
    ['filter','valley','commute','favorites'].forEach(t => {
      document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
      document.getElementById(`panel-${t}`)?.classList.toggle('active', t === tab);
    });
    if (tab === 'favorites') updateFavoritesPanel();
  }

  // ── 导出 CSV ──────────────────────────────────────────────────────────────
  function exportCsv() {
    if (!filteredData.length) { alert('当前无数据可导出'); return; }
    const header = ['小区名','行政区','街道','均价(元/m²)','建成年份','房龄','偏差%','四象限','楼栋数','总套数','纬度','经度'];
    const rows = filteredData.map(c => {
      const dev = getDeviation(c);
      return [
        c.name, c.district??'', c.subdistrict??'',
        c.ref_price??'', c.build_year??'',
        c.build_year ? 2026-c.build_year : '',
        dev != null ? dev+'%' : '',
        Q[getQuadrant(c)].label,
        c.total_buildings??'', c.total_units??'',
        c.lat, c.lng,
      ];
    });
    const csv = [header,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'}));
    a.download = `上海房源洼地分析_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  }

  // ── 图例 ──────────────────────────────────────────────────────────────────
  function updateLegend() {
    const el = document.getElementById('legend-content');
    if (colorMode === 'quadrant') {
      el.innerHTML = `<div class="legend-steps">${
        Object.entries(Q).filter(([k]) => k !== 'unknown' && k !== 'neutral').map(([, v]) =>
          `<div class="legend-step"><div class="legend-dot" style="background:${v.color}"></div><span>${v.label}</span></div>`
        ).join('')
      }<div class="legend-step"><div class="legend-dot" style="background:#BDBDBD"></div><span>无数据</span></div></div>`;
    } else if (colorMode === 'year') {
      el.innerHTML = `<div class="legend-steps">${
        AGE_TIERS.map(t =>
          `<div class="legend-step"><div class="legend-dot" style="background:${t.color};border-radius:2px"></div><span>${t.label}</span></div>`
        ).join('')
      }</div>`;
    } else {
      el.innerHTML = `<div class="legend-steps">${
        PRICE_TIERS.map((t, i) => {
          const labels = ['<4万','4–6万','6–8万','8–10万','10–13万','>13万'];
          return `<div class="legend-step"><div class="legend-dot" style="background:${t.color}"></div><span>${labels[i]}</span></div>`;
        }).join('')
      }</div>`;
    }
  }

  // ── 统计 ──────────────────────────────────────────────────────────────────
  function updateStats() {
    document.getElementById('stat-total').textContent = filteredData.length;
    const wp = filteredData.filter(c => c.ref_price != null);
    document.getElementById('stat-avg-price').textContent =
      wp.length ? (wp.reduce((s,c)=>s+c.ref_price,0)/wp.length/10000).toFixed(1)+'万' : '—';
    const valleys = allData.filter(c => getQuadrant(c) === 'valley');
    document.getElementById('stat-valley').textContent = valleys.length;
  }

  // ── UI 工具 ───────────────────────────────────────────────────────────────
  function showLoading(msg) {
    const el = document.getElementById('map-loading');
    el.innerHTML = `<div class="spinner"></div><div>${msg}</div>`;
    el.classList.remove('hidden');
  }
  function hideLoading(errMsg) {
    const el = document.getElementById('map-loading');
    if (errMsg) el.innerHTML = `<div style="color:#d32f2f;font-size:14px">${errMsg}</div>`;
    else el.classList.add('hidden');
  }
  function setStatus(msg) { document.getElementById('status-bar').textContent = msg; }
  function fmtPrice(n) {
    if (n == null) return '—';
    return n >= 10000 ? (n/10000).toFixed(1)+'万' : n.toLocaleString();
  }
  function escHtml(s) {
    return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    updateLegend();
    initFileDrop();
    switchTab('filter');

    // 直接用 config.js 里的 Key 自动加载，无需用户操作
    const key = (window.LOCAL_CONFIG && LOCAL_CONFIG.amapKey)
      ? LOCAL_CONFIG.amapKey
      : '1cf0650cf8cc24f862e1d3a1d023b93c';
    const input = document.getElementById('api-key-input');
    input.value = key;
    input.style.background = '#f0faf4';
    input.style.borderColor = '#27ae60';
    setTimeout(() => initMap(), 300);
  });

  return {
    initMap, setMode, switchTab,
    applyFilters, onPriceRangeChange, onYearRangeChange, resetFilters,
    openFilePicker, flyTo, exportCsv,
    toggleHeatmap, toggleRings, toggleValleyMode,
    addCommuteTarget, calcCommute, clearCommute, drawIsochrone, openIsochroneMap,
    toggleFavorite,
  };

})();
