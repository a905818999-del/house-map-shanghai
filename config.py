"""
配置文件
"""
import os

DATABASE_PATH = os.path.join(os.path.dirname(__file__), 'data', 'house.db')

# 确保data目录存在
os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)

# 高德地图API Key（需要用户配置）
AMAP_API_KEY = os.getenv('AMAP_API_KEY', '')

# Flask配置
HOST = '0.0.0.0'
PORT = 5000
DEBUG = True
