"""
截图验证修复后的华汇公寓坐标是否对齐地图背景。
"""
import sys
from playwright.sync_api import sync_playwright

# 华汇公寓 Geocoder 返回坐标
TARGET_LAT = 31.047314
TARGET_LNG = 121.753051
ZOOM = 17
BASE_URL = 'http://localhost:9500/src/'
SCREENSHOT_PATH = '/tmp/verify_fix.png'


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-proxy-server'],
        )
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        print(f'打开 {BASE_URL} ...')
        page.goto(BASE_URL, wait_until='networkidle', timeout=30000)
        page.wait_for_function('typeof AMap !== "undefined"', timeout=15000)
        print('AMap 就绪，导航到华汇公寓坐标...')

        # 导航地图到指定坐标并缩放
        page.evaluate(
            """([lat, lng, zoom]) => {
                const map = window.__map;
                if (!map) { throw new Error('window.__map not found'); }
                map.setCenter([lng, lat]);
                map.setZoom(zoom);
            }""",
            [TARGET_LAT, TARGET_LNG, ZOOM],
        )

        # 等待地图瓦片加载
        page.wait_for_timeout(3000)

        # 在地图中心放一个高亮标记
        page.evaluate(
            """([lat, lng]) => {
                const map = window.__map;
                const marker = new AMap.Marker({
                    position: [lng, lat],
                    title: '华汇公寓(修复后)',
                    content: '<div style="background:red;width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,0.8)"></div>',
                    offset: new AMap.Pixel(-8, -8),
                });
                marker.setMap(map);
            }""",
            [TARGET_LAT, TARGET_LNG],
        )

        # 再等一秒让标记渲染
        page.wait_for_timeout(1500)

        page.screenshot(path=SCREENSHOT_PATH, full_page=False)
        print(f'截图已保存到 {SCREENSHOT_PATH}')
        browser.close()


if __name__ == '__main__':
    run()
