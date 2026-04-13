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

  // 通勤状态
  let commuteTargets = [];    // [{lng,lat,name}] 最多2个
  let commuteCache = {};      // {communityId: {t1,t2,total}}
  let commuteMode = 'driving'; // 'driving' | 'transit'
  let drivingService = null;
  let transitService = null;

  // 板块均价（按行政区计算）
  let districtAvg = {};

  // ── 阈值 ──────────────────────────────────────────────────────────────────
  const ZOOM_HEATMAP_ONLY = 10;
  const ZOOM_SPARSE       = 12;
  const ZOOM_QUAD         = 14; // 12-14 四象限模式
  const LOD_CAPS = { sparse: 150, quad: 300 };

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

  function getPriceColor(p) {
    if (p == null) return '#BDBDBD';
    for (const t of PRICE_TIERS) if (p < t.max) return t.color;
    return PRICE_TIERS.at(-1).color;
  }

  function getQuadrant(c) {
    const avg = districtAvg[c.district];
    if (!avg || !c.avg_price) return 'unknown';
    const ratio = c.avg_price / avg;
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
    if (!avg || !c.avg_price) return null;
    return Math.round((c.avg_price / avg - 1) * 100);
  }

  function getMarkerColor(c) {
    if (colorMode === 'quadrant') return Q[getQuadrant(c)].color;
    if (colorMode === 'price') return getPriceColor(c.avg_price);
    return '#4A90D9'; // year mode 用楼龄bar替代，marker颜色统一蓝
  }

  // ── 预计算板块均价 ─────────────────────────────────────────────────────────
  function computeDistrictAvg(data) {
    const acc = {};
    data.forEach(c => {
      if (!c.avg_price || !c.district) return;
      if (!acc[c.district]) acc[c.district] = { sum: 0, n: 0 };
      acc[c.district].sum += c.avg_price;
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

    // 三条环线
    Object.values(json.rings).forEach(ring => {
      const pl = new AMap.Polyline({
        path: ring.path,
        strokeColor: ring.color,
        strokeWeight: 2,
        strokeOpacity: 0.7,
        strokeStyle: 'dashed',
        strokeDasharray: ring.dash,
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
          'font-size': '10px', 'color': ring.color,
          'background': 'transparent', 'border': 'none',
          'font-weight': '600', 'pointer-events': 'none',
        },
        zIndex: 5,
      });
      label.setMap(map);
      ringPolylines.push(label);
    });

    // CAZ 多边形
    cazPolygon = new AMap.Polygon({
      path: json.caz.path,
      fillColor: '#3498DB',
      fillOpacity: 0.06,
      strokeColor: '#3498DB',
      strokeWeight: 1.5,
      strokeOpacity: 0.4,
      strokeStyle: 'dashed',
      zIndex: 4,
    });
    cazPolygon.setMap(map);

    // CAZ 标签
    const cazLabel = new AMap.Text({
      text: 'CAZ 核心活动区',
      position: new AMap.LngLat(121.478, 31.233),
      style: {
        'font-size': '10px', 'color': '#2980B9',
        'background': 'rgba(52,152,219,0.08)',
        'border': '1px solid rgba(52,152,219,0.3)',
        'padding': '2px 6px', 'border-radius': '4px',
        'font-weight': '600', 'pointer-events': 'none',
      },
      zIndex: 5,
    });
    cazLabel.setMap(map);
    ringPolylines.push(cazLabel);
  }

  function toggleRings() {
    ringsVisible = !ringsVisible;
    ringPolylines.forEach(p => ringsVisible ? p.show() : p.hide());
    cazPolygon && (ringsVisible ? cazPolygon.show() : cazPolygon.hide());
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
      if (c.avg_price != null && (c.avg_price < priceMin || c.avg_price > priceMax)) return false;
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
      if (!grid.has(key) || (c.avg_price ?? 0) > (grid.get(key).avg_price ?? 0)) {
        grid.set(key, c);
      }
    }
    return [...grid.values()];
  }

  function clearMarkers() {
    if (markers.length) { map.remove(markers); markers = []; }
    infoWindow?.close();
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
      const price = c.avg_price != null ? `${(c.avg_price/10000).toFixed(1)}万` : '—';
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
    const points = filteredData.filter(c => c.avg_price != null).map(c => ({
      lng: c.lng, lat: c.lat, count: c.avg_price / 10000,
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

    infoWindow.setContent(`
      <div class="info-window">
        <div class="info-title">
          ${escHtml(c.name)}
          <span class="info-badge" style="background:${qConf.bg};color:${qConf.color}">${qConf.emoji} ${qConf.label}</span>
        </div>
        <div class="info-row">
          <span class="info-key">💰 均价</span>
          <span class="info-val" style="color:${getPriceColor(c.avg_price)}">${c.avg_price != null ? fmtPrice(c.avg_price)+' 元/㎡' : '暂无数据'}</span>
        </div>
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
        ${c.source_url ? `<div style="margin-top:8px;text-align:right"><a href="${c.source_url}" target="_blank" style="font-size:11px;color:#1a73e8">链家详情 →</a></div>` : ''}
      </div>`);
    infoWindow.open(map, marker.getPosition());
  }

  // ── 颜色模式切换 ───────────────────────────────────────────────────────────
  function setMode(mode) {
    colorMode = mode;
    ['quadrant','price','year'].forEach(m => {
      document.getElementById(`mode-${m}`)?.classList.toggle('active', m === mode);
    });
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
            <b style="color:#27AE60">${(c.avg_price/10000).toFixed(1)}万</b>
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
    const sorted = [...filteredData].sort((a, b) => (b.avg_price ?? 0) - (a.avg_price ?? 0));
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
            <b style="color:${getPriceColor(c.avg_price)}">${c.avg_price != null ? (c.avg_price/10000).toFixed(1)+'万' : '均价未知'}</b>
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
        <div class="info-row"><span class="info-key">💰 均价</span><span class="info-val">${target.avg_price != null ? fmtPrice(target.avg_price)+' 元/㎡' : '暂无'}</span></div>
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

  function clearCommute() {
    commuteTargets = [];
    commuteCache = {};
    commuteQueue = [];
    commuteRunning = false;
    [0, 1].forEach(i => {
      const el = document.getElementById(`commute-tag-${i}`);
      if (el) el.style.display = 'none';
      const inp = document.getElementById(`commute-addr-${i}`);
      if (inp) inp.value = '';
    });
    renderByLOD();
    setStatus('通勤已清空');
  }

  // ── Tab 切换 ───────────────────────────────────────────────────────────────
  function switchTab(tab) {
    ['filter','valley','commute'].forEach(t => {
      document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
      document.getElementById(`panel-${t}`)?.classList.toggle('active', t === tab);
    });
  }

  // ── 导出 CSV ──────────────────────────────────────────────────────────────
  function exportCsv() {
    if (!filteredData.length) { alert('当前无数据可导出'); return; }
    const header = ['小区名','行政区','街道','均价(元/m²)','建成年份','房龄','偏差%','四象限','楼栋数','总套数','纬度','经度'];
    const rows = filteredData.map(c => {
      const dev = getDeviation(c);
      return [
        c.name, c.district??'', c.subdistrict??'',
        c.avg_price??'', c.build_year??'',
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
    const wp = filteredData.filter(c => c.avg_price != null);
    document.getElementById('stat-avg-price').textContent =
      wp.length ? (wp.reduce((s,c)=>s+c.avg_price,0)/wp.length/10000).toFixed(1)+'万' : '—';
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
    addCommuteTarget, calcCommute, clearCommute,
  };

})();
