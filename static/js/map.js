/**
 * 地图模块
 */

// 全局变量
let map = null;
let markers = [];
let currentViewMode = 'price'; // 'price' or 'age'

// 地图初始化
function initMap() {
    // 创建地图，中心点设为上海
    map = L.map('map').setView([31.2304, 121.4737], 11);
    
    // 添加OpenStreetMap图层
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(map);
    
    // 加载数据
    loadCommunities();
}

// 颜色映射函数
function getPriceColor(price) {
    if (!price) return '#94a3b8'; // 灰色表示无数据
    if (price < 40000) return '#22c55e';      // 绿色 - 低价
    if (price < 60000) return '#84cc16';      // 黄绿 - 较低价
    if (price < 80000) return '#eab308';      // 黄色 - 中价
    if (price < 100000) return '#f97316';     // 橙色 - 较高价
    return '#ef4444';                          // 红色 - 高价
}

function getAgeColor(age) {
    if (!age && age !== 0) return '#94a3b8'; // 灰色表示无数据
    if (age <= 5) return '#22c55e';          // 绿色 - 新房
    if (age <= 10) return '#84cc16';         // 黄绿 - 次新房
    if (age <= 15) return '#eab308';         // 黄色 - 中房
    if (age <= 20) return '#f97316';         // 橙色 - 老房
    return '#ef4444';                         // 红色 - 老旧房
}

// 创建标记
function createMarker(community) {
    if (!community.latitude || !community.longitude) return null;
    
    const color = currentViewMode === 'price' 
        ? getPriceColor(community.price_per_sqm)
        : getAgeColor(community.age);
    
    const marker = L.circleMarker([community.latitude, community.longitude], {
        radius: 8,
        fillColor: color,
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8
    });
    
    // 绑定弹出信息
    const popupContent = `
        <div style="min-width: 200px;">
            <h4 style="margin: 0 0 8px 0;">${community.name}</h4>
            <p style="margin: 4px 0; font-size: 12px;">
                <strong>行政区：</strong>${community.district || '-'}
            </p>
            <p style="margin: 4px 0; font-size: 12px;">
                <strong>单价：</strong>${community.price_per_sqm ? community.price_per_sqm.toLocaleString() + '元/㎡' : '-'}
            </p>
            <p style="margin: 4px 0; font-size: 12px;">
                <strong>房龄：</strong>${community.age ? community.age + '年' : '-'}
            </p>
            <p style="margin: 4px 0; font-size: 12px;">
                <strong>竣工年份：</strong>${community.completion_year || '-'}
            </p>
            <button onclick="showCommunityDetail(${community.id})" 
                    style="margin-top: 8px; padding: 4px 12px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer;">
                查看详情
            </button>
        </div>
    `;
    
    marker.bindPopup(popupContent);
    marker.communityId = community.id;
    
    return marker;
}

// 加载小区数据
async function loadCommunities(filters = {}) {
    try {
        // 构建查询参数
        const params = new URLSearchParams();
        Object.keys(filters).forEach(key => {
            if (filters[key]) params.append(key, filters[key]);
        });
        
        const response = await fetch(`/api/communities?${params.toString()}`);
        const result = await response.json();
        
        if (result.code === 0) {
            updateMarkers(result.data);
            updateStats();
        }
    } catch (error) {
        console.error('加载数据失败:', error);
    }
}

// 更新地图标记
function updateMarkers(communities) {
    // 清除旧标记
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
    
    // 添加新标记
    communities.forEach(community => {
        const marker = createMarker(community);
        if (marker) {
            marker.addTo(map);
            markers.push(marker);
        }
    });
    
    // 更新统计
    document.getElementById('total-communities').textContent = communities.length;
}

// 更新统计信息
async function updateStats() {
    try {
        const response = await fetch('/api/stats');
        const result = await response.json();
        
        if (result.code === 0) {
            const stats = result.data;
            document.getElementById('total-communities').textContent = stats.total_communities;
            document.getElementById('avg-price').textContent = stats.avg_price 
                ? (stats.avg_price / 10000).toFixed(1) + '万/㎡' 
                : '-';
            document.getElementById('avg-age').textContent = stats.avg_age 
                ? stats.avg_age + '年' 
                : '-';
        }
    } catch (error) {
        console.error('获取统计失败:', error);
    }
}

// 切换视图模式
function switchViewMode(mode) {
    currentViewMode = mode;
    
    // 更新按钮状态
    document.querySelectorAll('.btn-view').forEach(btn => btn.classList.remove('active'));
    document.getElementById(mode === 'price' ? 'view-price' : 'view-age').classList.add('active');
    
    // 重新渲染标记
    markers.forEach(marker => {
        const community = window.communityData?.find(c => c.id === marker.communityId);
        if (community) {
            const color = currentViewMode === 'price' 
                ? getPriceColor(community.price_per_sqm)
                : getAgeColor(community.age);
            marker.setStyle({ fillColor: color });
        }
    });
}

// 显示小区详情
async function showCommunityDetail(communityId) {
    try {
        const response = await fetch(`/api/communities/${communityId}`);
        const result = await response.json();
        
        if (result.code === 0) {
            const c = result.data;
            const modalBody = document.getElementById('modal-body');
            
            modalBody.innerHTML = `
                <h2 style="margin-bottom: 16px;">${c.name}</h2>
                <div style="display: grid; gap: 12px;">
                    <div>
                        <label style="color: #64748b; font-size: 12px;">行政区</label>
                        <p style="font-weight: 500;">${c.district || '-'} ${c.sub_district || ''}</p>
                    </div>
                    <div>
                        <label style="color: #64748b; font-size: 12px;">地址</label>
                        <p style="font-weight: 500;">${c.address || '-'}</p>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                        <div>
                            <label style="color: #64748b; font-size: 12px;">单价</label>
                            <p style="font-weight: 600; color: #ef4444;">
                                ${c.price_per_sqm ? c.price_per_sqm.toLocaleString() + '元/㎡' : '-'}
                            </p>
                        </div>
                        <div>
                            <label style="color: #64748b; font-size: 12px;">总价(均)</label>
                            <p style="font-weight: 600;">
                                ${c.total_price_avg ? c.total_price_avg.toLocaleString() + '万' : '-'}
                            </p>
                        </div>
                        <div>
                            <label style="color: #64748b; font-size: 12px;">竣工年份</label>
                            <p style="font-weight: 500;">${c.completion_year || '-'}</p>
                        </div>
                        <div>
                            <label style="color: #64748b; font-size: 12px;">房龄</label>
                            <p style="font-weight: 500;">${c.age ? c.age + '年' : '-'}</p>
                        </div>
                        <div>
                            <label style="color: #64748b; font-size: 12px;">楼栋数</label>
                            <p style="font-weight: 500;">${c.building_count || '-'}</p>
                        </div>
                        <div>
                            <label style="color: #64748b; font-size: 12px;">总户数</label>
                            <p style="font-weight: 500;">${c.total_units || '-'}</p>
                        </div>
                    </div>
                </div>
            `;
            
            document.getElementById('community-modal').style.display = 'block';
        }
    } catch (error) {
        console.error('获取详情失败:', error);
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    
    // 视图切换
    document.getElementById('view-price').addEventListener('click', () => switchViewMode('price'));
    document.getElementById('view-age').addEventListener('click', () => switchViewMode('age'));
    
    // 弹窗关闭
    document.querySelector('.modal-close').addEventListener('click', () => {
        document.getElementById('community-modal').style.display = 'none';
    });
    
    // 点击背景关闭
    document.getElementById('community-modal').addEventListener('click', (e) => {
        if (e.target.id === 'community-modal') {
            document.getElementById('community-modal').style.display = 'none';
        }
    });
});
