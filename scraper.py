"""
链家小区数据爬虫
从链家官网获取上海小区房价和楼龄数据
"""
import requests
from bs4 import BeautifulSoup
import json
import time
import random
from database import insert_community, init_database

# 链家小区列表API
LIANJIA_COMMUNITY_API = "https://sh.lianjia.com/xiaoqu/"

# 请求头
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://sh.lianjia.com/',
}

DISTRICTS = [
    'pudongxinqu',  # 浦东新区
    'minhang',      # 闵行
    'baoshan',      # 宝山
    'xuhui',        # 徐汇
    'putuo',        # 普陀
    'yangpu',       # 杨浦
    'changning',    # 长宁
    'songjiang',    # 松江
    'jiading',      # 嘉定
    'huangpu',      # 黄浦
    'hongkou',      # 虹口
    'zhujiajiao',   # 闵行
    'qingpu',       # 青浦
    'fengxian',     # 奉贤
    'jinshan',      # 金山
    'chongming'     # 崇明
]

def get_community_list_page(district, page=1):
    """获取单页小区列表"""
    url = f"https://sh.lianjia.com/xiaoqu/{district}/pg{page}/"
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        response.encoding = 'utf-8'
        return response.text
    except Exception as e:
        print(f"请求失败: {url}, 错误: {e}")
        return None

def parse_community_list(html):
    """解析小区列表页面"""
    if not html:
        return []
    
    soup = BeautifulSoup(html, 'html.parser')
    communities = []
    
    # 链家小区列表结构
    items = soup.select('ul.listContent li')
    
    for item in items:
        try:
            name_elem = item.select_one('.title a')
            if not name_elem:
                continue
            
            name = name_elem.get_text(strip=True)
            link = name_elem.get('href', '')
            
            # 获取行政区信息
            district_elem = item.select_one('.district a')
            district = district_elem.get_text(strip=True) if district_elem else ''
            
            sub_district_elem = item.select_one('.bizcircle a')
            sub_district = sub_district_elem.get_text(strip=True) if sub_district_elem else ''
            
            # 价格信息
            price_elem = item.select_one('.price .num')
            price = int(price_elem.get_text(strip=True)) if price_elem else 0
            
            # 小区信息
            info_elem = item.select_one('.info')
            address = info_elem.get_text(strip=True) if info_elem else ''
            
            communities.append({
                'name': name,
                'link': link,
                'district': district,
                'sub_district': sub_district,
                'address': address,
                'price_per_sqm': price
            })
        except Exception as e:
            print(f"解析小区失败: {e}")
            continue
    
    return communities

def get_total_pages(html):
    """获取总页数"""
    if not html:
        return 1
    
    soup = BeautifulSoup(html, 'html.parser')
    page_data = soup.select_one('.pageData')
    if page_data:
        text = page_data.get_text()
        try:
            total = int(text.split('/')[-1].replace('页', ''))
            return total
        except:
            pass
    return 1

def scrape_district(district):
    """爬取单个行政区"""
    print(f"\n{'='*50}")
    print(f"开始爬取: {district}")
    print(f"{'='*50}")
    
    # 先获取总页数
    html = get_community_list_page(district, 1)
    total_pages = get_total_pages(html)
    print(f"总页数: {total_pages}")
    
    all_communities = []
    
    for page in range(1, min(total_pages + 1, 100)):  # 限制最多100页
        print(f"  正在爬取第 {page}/{total_pages} 页...")
        
        html = get_community_list_page(district, page)
        communities = parse_community_list(html)
        all_communities.extend(communities)
        
        # 随机延时
        time.sleep(random.uniform(1, 3))
        
        if page >= 10:  # 每个区最多爬10页
            break
    
    print(f"爬取完成，共 {len(all_communities)} 个小区")
    return all_communities

def run_scraper():
    """运行爬虫主函数"""
    print("🚀 开始爬取链家上海小区数据...")
    print(f"目标: {len(DISTRICTS)} 个行政区")
    
    # 初始化数据库
    init_database()
    
    total_count = 0
    
    for district in DISTRICTS:
        communities = scrape_district(district)
        
        for comm in communities:
            try:
                insert_community(comm)
                total_count += 1
            except Exception as e:
                print(f"插入失败: {comm.get('name')}, 错误: {e}")
        
        # 行政区之间延时
        time.sleep(random.uniform(2, 5))
    
    print(f"\n✅ 爬取完成！共插入 {total_count} 个小区")
    return total_count

if __name__ == '__main__':
    run_scraper()
