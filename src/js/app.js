/**
 * 上海房源地图 - 主应用
 * 高德地图 JS API v2 | 小区房价+楼龄可视化
 *
 * LOD 分层策略：
 *   zoom < 10   → 仅热力图，不画 marker
 *   zoom 10-12  → 网格采样，每格最多 1 个 marker（全市约 200-300 个）
 *   zoom 12-14  → 视口内 marker，紧凑样式（只显示价格/年份数字）
 *   zoom ≥ 14   → 视口内 marker，详细样式（含小区名 label）
 */

const App = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let map = null;
  let infoWindow = null;
  let markers = [];
  let heatmapLayer = null;
  let heatmapOn = false;
  let allData = [];
  let filteredData = [];
  let colorMode = 'price';
  let selectedDistricts = new Set();
  let dataLoadedManually = false;
  let lodTimer = null;          // debounce handle

  // ── LOD 阈值 ───────────────────────────────────────────────────────────────
  const ZOOM_HEATMAP_ONLY = 10; // 低于此值：只显示热力图
  const ZOOM_SPARSE       = 12; // 低于此值：网格采样，稀疏 marker
  const ZOOM_DETAIL       = 14; // 高于此值：显示小区名 label

  const DATA_PATHS = [
    '../data/processed/communities.json',
    './data/processed/communities.json',
  ];

  // ── Color ──────────────────────────────────────────────────────────────────
  const PRICE_TIERS = [
    { max: 40000,    color: '#27AE60', label: '<4万' },
    { max: 60000,    color: '#82C341', label: '4–6万' },
    { max: 80000,    color: '#F1C40F', label: '6–8万' },
    { max: 100000,   color: '#F39C12', label: '8–10万' },
    { max: 130000,   color: '#E74C3C', label: '10–13万' },
    { max: Infinity, color: '#8E44AD', label: '>13万' },
  ];
  const YEAR_TIERS = [
    { min: 2015, color: '#00BCD4', label: '2015年后' },
    { min: 2005, color: '#4CAF50', label: '2005–2015' },
    { min: 1995, color: '#F1C40F', label: '1995–2005' },
    { min: 1985, color: '#FF9800', label: '1985–1995' },
    { min: 0,    color: '#F44336', label: '1985年前' },
  ];

  function getPriceColor(p) {
    if (p == null) return '#BDBDBD';
    for (const t of PRICE_TIERS) if (p < t.max) return t.color;
    return PRICE_TIERS.at(-1).color;
  }
  function getYearColor(y) {
    if (y == null) return '#BDBDBD';
    for (const t of YEAR_TIERS) if (y >= t.min) return t.color;
    return YEAR_TIERS.at(-1).color;
  }
  function getColor(c) {
    return colorMode === 'price' ? getPriceColor(c.avg_price) : getYearColor(c.build_year);
  }

  // ── AMap 加载 ──────────────────────────────────────────────────────────────
  function initMap() {
    const key = document.getElementById('api-key-input').value.trim();
    if (!key) { alert('请先输入高德地图 API Key'); return; }
    showLoading('正在加载高德地图 SDK...');

    // AMap JS API v2.0 安全密钥（2021-12-02起强制要求）
    // 没有安全密钥会导致地图瓦片白色不显示
    const secCode = window.LOCAL_CONFIG?.securityJsCode;
    if (secCode) {
      window._AMapSecurityConfig = { securityJsCode: secCode };
    }

    const old = document.getElementById('amap-script');
    if (old) old.remove();
    const s = document.createElement('script');
    s.id = 'amap-script';
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${key}&plugin=AMap.InfoWindow,AMap.HeatMap`;
    s.onload = onAmapReady;
    s.onerror = () => {
      hideLoading('❌ 加载失败，请检查 API Key');
      setStatus('❌ Key 无效或网络错误');
    };
    document.head.appendChild(s);
  }

  function onAmapReady() {
    map = new AMap.Map('map', {
      zoom: 11,
      center: [121.4737, 31.2304],
      mapStyle: (typeof LOCAL_CONFIG !== 'undefined' && LOCAL_CONFIG.mapStyle) ? LOCAL_CONFIG.mapStyle : 'amap://styles/light',
      resizeEnable: true,
    });

    // 强制 resize，解决 tile 不显示问题（容器尺寸在 SDK 加载前可能未稳定）
    setTimeout(() => map.resize(), 300);

    infoWindow = new AMap.InfoWindow({
      anchor: 'bottom-center',
      offset: new AMap.Pixel(0, -20),
      closeWhenClickMap: true,
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') infoWindow?.close();
    });

    map.on('zoomchange', scheduleLodRender);
    map.on('moveend',    scheduleLodRender);

    if (dataLoadedManually && allData.length > 0) {
      buildDistrictFilter();
      applyFilters();
      hideLoading();
    } else {
      loadData();
    }
  }

  // ── 数据加载 ───────────────────────────────────────────────────────────────
  async function loadData() {
    showLoading('加载小区数据...');
    let json = null;
    for (const path of DATA_PATHS) {
      try { const r = await fetch(path); if (r.ok) { json = await r.json(); break; } }
      catch (_) {}
    }
    if (!json) {
      hideLoading('❌ 未找到数据文件');
      setStatus('❌ 请拖拽 communities.json 或点击「本地打开」');
      return;
    }
    applyDataset(json, false);
  }

  function applyDataset(json, manual = true) {
    dataLoadedManually = manual;
    allData = (json.communities || []).filter(c => c.lat && c.lng);
    if (map) {
      buildDistrictFilter();
      applyFilters();
      hideLoading();
    } else {
      hideLoading();
      setStatus(`数据已读取 ${allData.length} 个小区，请输入 API Key 加载地图`);
    }
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

  // ── 行政区筛选 ────────────────────────────────────────────────────────────
  function buildDistrictFilter() {
    const districts = [...new Set(allData.map(c => c.district).filter(Boolean))].sort();
    selectedDistricts = new Set(districts);
    const el = document.getElementById('district-list');
    el.innerHTML = '';
    districts.forEach(d => {
      const chip = document.createElement('label');
      chip.className = 'district-chip checked';
      chip.dataset.district = d;
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true;
      cb.addEventListener('change', () => {
        cb.checked ? selectedDistricts.add(d) : selectedDistricts.delete(d);
        chip.classList.toggle('checked', cb.checked);
        applyFilters();
      });
      chip.appendChild(cb);
      chip.appendChild(document.createTextNode(d));
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
      return true;
    });

    renderByLOD();
    updateStats();
    updateLegend();
    updateResultsList();
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

  // ── LOD 分层渲染核心 ───────────────────────────────────────────────────────

  function scheduleLodRender() {
    clearTimeout(lodTimer);
    lodTimer = setTimeout(renderByLOD, 120);
  }

  // ── LOD 每层 marker 上限 ───────────────────────────────────────────────────
  const LOD_CAPS = {
    sparse: 150,  // zoom 10-12
    normal: 200,  // zoom 12-14（超出继续网格采样）
  };

  function renderByLOD() {
    if (!map) return;
    const zoom = map.getZoom();

    if (zoom < ZOOM_HEATMAP_ONLY) {
      clearMarkers();
      renderHeatmapAuto();
      setStatus(`🗺 缩小视图中，显示热力图（共 ${filteredData.length} 个小区）`);
      return;
    }

    if (heatmapOn) renderHeatmap();

    const bounds = map.getBounds();
    const viewport = filteredData.filter(c =>
      bounds.contains(new AMap.LngLat(c.lng, c.lat))
    );

    let toRender;
    if (zoom < ZOOM_SPARSE) {
      // 层级 1：网格采样，最多 300 个
      toRender = gridSample(viewport, bounds, LOD_CAPS.sparse);
      setStatus(`🔭 显示 ${toRender.length} 个（视口 ${viewport.length}，共 ${filteredData.length}）· 放大看更多`);
    } else if (zoom < ZOOM_DETAIL) {
      // 层级 2：视口内，超出 400 时网格采样
      toRender = viewport.length > LOD_CAPS.normal
        ? gridSample(viewport, bounds, LOD_CAPS.normal)
        : viewport;
      const sampled = toRender.length < viewport.length ? `（已采样）` : '';
      setStatus(`显示 ${toRender.length} 个小区${sampled}（共 ${filteredData.length}）`);
    } else {
      // 层级 3：zoom≥14，视口极小，直接全量
      toRender = viewport;
      setStatus(`🔍 显示 ${toRender.length} 个小区（含小区名）`);
    }

    buildMarkers(toRender, zoom);
  }

  /** 按经纬度网格采样，保证空间均匀分布 */
  function gridSample(data, bounds, maxCount) {
    if (data.length <= maxCount) return data;
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const cols = Math.ceil(Math.sqrt(maxCount * 1.5));
    const rows = cols;
    const latStep = (ne.getLat() - sw.getLat()) / rows || 0.01;
    const lngStep = (ne.getLng() - sw.getLng()) / cols || 0.01;
    const grid = new Map();
    for (const c of data) {
      const row = Math.floor((c.lat - sw.getLat()) / latStep);
      const col = Math.floor((c.lng - sw.getLng()) / lngStep);
      const key = `${row},${col}`;
      // 同格内保留均价更高的（更有参考价值）
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

  function buildMarkers(data, zoom) {
    clearMarkers();
    const showName = zoom >= ZOOM_SPARSE;   // zoom≥12 显示小区名
    const compact  = zoom < ZOOM_SPARSE;    // zoom<12 仅显示数值

    data.forEach(c => {
      const color = getColor(c);

      const priceVal = c.avg_price != null
        ? `${(c.avg_price / 10000).toFixed(1)}万`
        : '暂无';
      const yearVal  = c.build_year != null ? `${c.build_year}年` : '暂无';
      const mainVal  = colorMode === 'price' ? priceVal : yearVal;
      const subVal   = colorMode === 'price' ? yearVal  : priceVal;

      const el = document.createElement('div');
      el.className = 'badge-wrap';

      if (compact) {
        el.innerHTML =
          `<div class="badge-box compact" style="background:${color}">${escHtml(mainVal)}</div>` +
          `<div class="badge-tip" style="border-top-color:${color}"></div>`;
      } else {
        const sub = zoom >= ZOOM_DETAIL ? `<span class="badge-sub"> ${escHtml(subVal)}</span>` : '';
        el.innerHTML =
          `<div class="badge-box" style="background:${color}">` +
            `<span class="badge-name">${escHtml(c.name)}</span>` +
            `<span class="badge-main"> ${escHtml(mainVal)}</span>${sub}` +
          `</div>` +
          `<div class="badge-tip" style="border-top-color:${color}"></div>`;
      }

      const m = new AMap.Marker({
        position: [c.lng, c.lat],
        content: el,
        anchor: 'bottom-center',
        title: c.name,
        extData: c,
        zIndex: 10,
      });
      m.on('click', () => openInfoWindow(m, c));
      markers.push(m);
    });

    map.add(markers);
  }

  // ── 热力图 ────────────────────────────────────────────────────────────────
  const HEATMAP_GRADIENTS = {
    price: { 0.2: '#2ecc71', 0.5: '#f1c40f', 0.75: '#e67e22', 1: '#c0392b' },
    year:  { 0.2: '#c0392b', 0.5: '#e67e22', 0.75: '#2ecc71', 1: '#00bcd4' },
  };

  function renderHeatmap() {
    if (!map || typeof AMap.HeatMap === 'undefined') return;
    const points = filteredData
      .filter(c => colorMode === 'price' ? c.avg_price != null : c.build_year != null)
      .map(c => ({
        lng: c.lng, lat: c.lat,
        count: colorMode === 'price' ? c.avg_price / 10000 : (2024 - c.build_year),
      }));
    const maxVal = points.reduce((m, p) => Math.max(m, p.count), 1);
    if (!heatmapLayer) {
      heatmapLayer = new AMap.HeatMap(map, {
        radius: 30, opacity: [0, 0.75],
        gradient: HEATMAP_GRADIENTS[colorMode], blur: 0.85,
      });
    } else {
      heatmapLayer.setOptions({ gradient: HEATMAP_GRADIENTS[colorMode] });
    }
    heatmapLayer.setDataSet({ data: points, max: maxVal });
    heatmapLayer.show();
  }

  // 低缩放自动热力图（不改变用户的 heatmapOn 开关状态）
  let autoHeatmap = false;
  function renderHeatmapAuto() {
    autoHeatmap = true;
    renderHeatmap();
  }

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
    const age = c.build_year ? 2024 - c.build_year : null;
    infoWindow.setContent(`
      <div class="info-window">
        <div class="info-title">
          ${escHtml(c.name)}
          ${c.district ? `<span class="info-badge">${escHtml(c.district)}</span>` : ''}
        </div>
        <div class="info-row">
          <span class="info-key">💰 均价</span>
          <span class="info-val price">${c.avg_price != null ? fmtPrice(c.avg_price) + ' 元/㎡' : '暂无数据'}</span>
        </div>
        <div class="info-color-bar" style="background:${getPriceColor(c.avg_price)}"></div>
        <div class="info-row" style="margin-top:5px">
          <span class="info-key">🏗 建成年份</span>
          <span class="info-val year">${c.build_year ?? '暂无'}${age != null ? `（房龄 ${age} 年）` : ''}</span>
        </div>
        <div class="info-color-bar" style="background:${getYearColor(c.build_year)}"></div>
        ${c.subdistrict ? `<div class="info-row" style="margin-top:5px"><span class="info-key">📍 街道</span><span class="info-val">${escHtml(c.subdistrict)}</span></div>` : ''}
        ${c.total_buildings ? `<div class="info-row"><span class="info-key">🏢 楼栋/套</span><span class="info-val">${c.total_buildings} 栋 · ${c.total_units?.toLocaleString() ?? '?'} 套</span></div>` : ''}
        ${c.source_url ? `<div style="margin-top:8px;text-align:right"><a href="${c.source_url}" target="_blank" style="font-size:11px;color:#1a73e8">链家详情 →</a></div>` : ''}
      </div>`);
    infoWindow.open(map, marker.getPosition());
  }

  // ── 颜色模式 ──────────────────────────────────────────────────────────────
  function setMode(mode) {
    colorMode = mode;
    document.getElementById('mode-price').classList.toggle('active', mode === 'price');
    document.getElementById('mode-year').classList.toggle('active', mode === 'year');
    document.getElementById('list-sort-label').textContent =
      mode === 'price' ? '均价从高到低' : '建成年份从新到旧';
    renderByLOD();
    updateLegend();
    updateResultsList();
  }

  // ── 结果列表 ──────────────────────────────────────────────────────────────
  const LIST_MAX = 30;
  function updateResultsList() {
    const sorted = [...filteredData].sort((a, b) =>
      colorMode === 'price'
        ? (b.avg_price ?? 0) - (a.avg_price ?? 0)
        : (b.build_year ?? 0) - (a.build_year ?? 0)
    );
    document.getElementById('list-count').textContent =
      `${filteredData.length} 个${filteredData.length > LIST_MAX ? `，显示前 ${LIST_MAX}` : ''}`;
    const list = document.getElementById('results-list');
    if (!filteredData.length) { list.innerHTML = '<div class="list-empty">无匹配小区</div>'; return; }
    list.innerHTML = sorted.slice(0, LIST_MAX).map(c => `
      <div class="result-item" onclick="App.flyTo(${c.lng},${c.lat},'${c.id}')">
        <div class="result-dot" style="background:${getColor(c)}"></div>
        <div class="result-info">
          <div class="result-name">${escHtml(c.name)}</div>
          <div class="result-meta">
            ${c.avg_price != null ? `<b style="color:${getPriceColor(c.avg_price)}">${(c.avg_price/10000).toFixed(1)}万</b>` : '<span style="color:#bbb">均价未知</span>'}
            · ${c.build_year ? `<span style="color:${getYearColor(c.build_year)}">${c.build_year}年</span>` : '<span style="color:#bbb">年份未知</span>'}
            · <span style="color:#999">${c.district ?? ''}</span>
          </div>
        </div>
      </div>`).join('');
  }

  function flyTo(lng, lat, id) {
    if (!map) return;
    map.setZoomAndCenter(15, [lng, lat], false, 400);
    setTimeout(() => {
      const target = allData.find(c => c.id === id);
      if (!target) return;
      const m = markers.find(mk => mk.getExtData()?.id === id);
      if (m) { openInfoWindow(m, target); return; }
      // marker 不在视口，直接弹窗
      const age = target.build_year ? 2024 - target.build_year : null;
      infoWindow.setContent(`<div class="info-window">
        <div class="info-title">${escHtml(target.name)}</div>
        <div class="info-row"><span class="info-key">💰 均价</span><span class="info-val price">${target.avg_price != null ? fmtPrice(target.avg_price)+' 元/㎡' : '暂无'}</span></div>
        <div class="info-row"><span class="info-key">🏗 建成</span><span class="info-val year">${target.build_year ?? '—'}${age ? `（${age}年）` : ''}</span></div>
      </div>`);
      infoWindow.open(map, new AMap.LngLat(lng, lat));
    }, 450);
  }

  // ── 导出 CSV ──────────────────────────────────────────────────────────────
  function exportCsv() {
    if (!filteredData.length) { alert('当前无数据可导出'); return; }
    const header = ['小区名','行政区','街道','均价(元/m²)','建成年份','房龄','楼栋数','总套数','纬度','经度','来源链接'];
    const rows = filteredData.map(c => [
      c.name, c.district??'', c.subdistrict??'',
      c.avg_price??'', c.build_year??'',
      c.build_year ? 2024-c.build_year : '',
      c.total_buildings??'', c.total_units??'',
      c.lat, c.lng, c.source_url??'',
    ]);
    const csv = [header,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'}));
    a.download = `上海房源_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  }

  // ── 图例 ──────────────────────────────────────────────────────────────────
  function updateLegend() {
    const tiers = colorMode === 'price' ? PRICE_TIERS : [...YEAR_TIERS].reverse();
    document.getElementById('legend-content').innerHTML = `<div class="legend-steps">${
      tiers.map(t=>`<div class="legend-step"><div class="legend-dot" style="background:${t.color}"></div><span>${t.label}</span></div>`).join('')
    }<div class="legend-step"><div class="legend-dot" style="background:#BDBDBD"></div><span>无数据</span></div></div>`;
  }

  // ── 统计 ──────────────────────────────────────────────────────────────────
  function updateStats() {
    document.getElementById('stat-total').textContent = filteredData.length;
    const wp = filteredData.filter(c=>c.avg_price!=null);
    document.getElementById('stat-avg-price').textContent =
      wp.length ? (wp.reduce((s,c)=>s+c.avg_price,0)/wp.length/10000).toFixed(1)+'万' : '—';
    const wy = filteredData.filter(c=>c.build_year!=null);
    document.getElementById('stat-avg-year').textContent =
      wy.length ? Math.round(wy.reduce((s,c)=>s+c.build_year,0)/wy.length)+'年' : '—';
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
    if (n==null) return '—';
    return n>=10000 ? (n/10000).toFixed(1)+'万' : n.toLocaleString();
  }
  function escHtml(s) {
    return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    updateLegend();
    initFileDrop();
    document.getElementById('list-sort-label').textContent = '均价从高到低';

    // 自动填入本地配置的 Key 并加载地图
    const savedKey = window.LOCAL_CONFIG?.amapKey;
    if (savedKey) {
      document.getElementById('api-key-input').value = savedKey;
      // 延迟 200ms 确保页面布局完全稳定后再初始化地图
      setTimeout(() => initMap(), 200);
    }
  });

  return {
    initMap, setMode,
    applyFilters, onPriceRangeChange, onYearRangeChange, resetFilters,
    openFilePicker, flyTo, exportCsv, toggleHeatmap,
  };

})();
