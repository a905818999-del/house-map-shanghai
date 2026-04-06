/**
 * 筛选器模块
 */

// 获取筛选条件
function getFilters() {
    return {
        district: document.getElementById('district-filter').value,
        min_price: document.getElementById('min-price').value,
        max_price: document.getElementById('max-price').value,
        min_age: document.getElementById('min-age').value,
        max_age: document.getElementById('max-age').value,
        keyword: document.getElementById('keyword').value
    };
}

// 重置筛选条件
function resetFilters() {
    document.getElementById('district-filter').value = '';
    document.getElementById('min-price').value = '';
    document.getElementById('max-price').value = '';
    document.getElementById('min-age').value = '';
    document.getElementById('max-age').value = '';
    document.getElementById('keyword').value = '';
    
    // 重新加载数据
    loadCommunities();
}

// 加载行政区列表
async function loadDistricts() {
    try {
        const response = await fetch('/api/districts');
        const result = await response.json();
        
        if (result.code === 0) {
            const select = document.getElementById('district-filter');
            result.data.forEach(district => {
                const option = document.createElement('option');
                option.value = district;
                option.textContent = district;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('加载行政区失败:', error);
    }
}

// 应用筛选
function applyFilters() {
    const filters = getFilters();
    loadCommunities(filters);
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    // 加载行政区
    loadDistricts();
    
    // 绑定按钮事件
    document.getElementById('apply-filters').addEventListener('click', applyFilters);
    document.getElementById('reset-filters').addEventListener('click', resetFilters);
    
    // 回车键触发搜索
    document.getElementById('keyword').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            applyFilters();
        }
    });
});
