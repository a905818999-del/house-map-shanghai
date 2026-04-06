/**
 * 工具函数模块
 */

// 格式化数字（添加千分位）
function formatNumber(num) {
    if (!num && num !== 0) return '-';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 格式化价格（万元）
function formatPrice(price) {
    if (!price) return '-';
    if (price >= 10000) {
        return (price / 10000).toFixed(1) + '万';
    }
    return price.toLocaleString() + '元';
}

// 格式化单价（元/㎡）
function formatPricePerSqM(price) {
    if (!price) return '-';
    return price.toLocaleString() + '元/㎡';
}

// 格式化日期
function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('zh-CN');
}

// 计算房龄
function calculateAge(completionYear) {
    if (!completionYear) return null;
    const currentYear = new Date().getFullYear();
    return currentYear - completionYear;
}

// 防抖函数
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// 节流函数
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// 显示加载状态
function showLoading(element) {
    element.innerHTML = '<div class="loading">加载中...</div>';
}

// 隐藏加载状态
function hideLoading(element) {
    const loading = element.querySelector('.loading');
    if (loading) {
        loading.remove();
    }
}

// 复制到剪贴板
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.error('复制失败:', err);
        return false;
    }
}

// 导出数据为CSV
function exportToCSV(data, filename) {
    if (!data || data.length === 0) return;
    
    const headers = Object.keys(data[0]);
    const csvContent = [
        headers.join(','),
        ...data.map(row => headers.map(h => {
            let cell = row[h];
            // 处理特殊字符
            if (cell === null || cell === undefined) cell = '';
            if (typeof cell === 'string' && (cell.includes(',') || cell.includes('"') || cell.includes('\n'))) {
                cell = '"' + cell.replace(/"/g, '""') + '"';
            }
            return cell;
        }).join(','))
    ].join('\n');
    
    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename + '.csv';
    link.click();
}

// 打印日志（调试用）
function debugLog(...args) {
    if (window.location.search.includes('debug')) {
        console.log('[DEBUG]', ...args);
    }
}

// 全局错误处理
window.addEventListener('error', (event) => {
    console.error('全局错误:', event.error);
});

// 全局未处理Promise拒绝
window.addEventListener('unhandledrejection', (event) => {
    console.error('未处理的Promise拒绝:', event.reason);
});
