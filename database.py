"""
数据库模块 - SQLite操作
"""
import sqlite3
import json
from datetime import datetime
from config import DATABASE_PATH

def get_db_connection():
    """获取数据库连接"""
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_database():
    """初始化数据库表"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS community (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            district TEXT,
            sub_district TEXT,
            address TEXT,
            latitude REAL,
            longitude REAL,
            price_per_sqm INTEGER,
            total_price_avg INTEGER,
            completion_year INTEGER,
            building_count INTEGER,
            total_units INTEGER,
            polygon_coords TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    conn.commit()
    conn.close()

def insert_community(data):
    """插入小区数据"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute('''
        INSERT INTO community (
            name, district, sub_district, address,
            latitude, longitude, price_per_sqm, total_price_avg,
            completion_year, building_count, total_units, polygon_coords
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        data.get('name'),
        data.get('district'),
        data.get('sub_district'),
        data.get('address'),
        data.get('latitude'),
        data.get('longitude'),
        data.get('price_per_sqm'),
        data.get('total_price_avg'),
        data.get('completion_year'),
        data.get('building_count'),
        data.get('total_units'),
        json.dumps(data.get('polygon_coords', []))
    ))
    
    conn.commit()
    conn.close()
    return cursor.lastrowid

def get_communities(filters=None):
    """获取小区列表"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    sql = 'SELECT * FROM community WHERE 1=1'
    params = []
    
    if filters:
        if filters.get('district'):
            sql += ' AND district = ?'
            params.append(filters['district'])
        if filters.get('min_price'):
            sql += ' AND price_per_sqm >= ?'
            params.append(filters['min_price'])
        if filters.get('max_price'):
            sql += ' AND price_per_sqm <= ?'
            params.append(filters['max_price'])
        if filters.get('keyword'):
            sql += ' AND name LIKE ?'
            params.append(f'%' + filters['keyword'] + '%')
    
    cursor.execute(sql, params)
    rows = cursor.fetchall()
    conn.close()
    
    communities = []
    current_year = datetime.now().year
    
    for row in rows:
        community = dict(row)
        community['age'] = current_year - community['completion_year'] if community['completion_year'] else None
        if community['polygon_coords']:
            community['polygon_coords'] = json.loads(community['polygon_coords'])
        communities.append(community)
    
    return communities

def get_community_by_id(community_id):
    """获取小区详情"""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM community WHERE id = ?', (community_id,))
    row = cursor.fetchone()
    conn.close()
    
    if row:
        community = dict(row)
        current_year = datetime.now().year
        community['age'] = current_year - community['completion_year'] if community['completion_year'] else None
        if community['polygon_coords']:
            community['polygon_coords'] = json.loads(community['polygon_coords'])
        return community
    return None

def get_districts():
    """获取行政区列表"""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT DISTINCT district FROM community WHERE district IS NOT NULL')
    rows = cursor.fetchall()
    conn.close()
    return [row['district'] for row in rows]

def get_stats():
    """获取统计信息"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute('SELECT COUNT(*) as total FROM community')
    total = cursor.fetchone()['total']
    
    if total == 0:
        conn.close()
        return {
            'total_communities': 0,
            'avg_price': 0,
            'avg_age': 0,
            'price_range': {'min': 0, 'max': 0},
            'age_range': {'min': 0, 'max': 0}
        }
    
    cursor.execute('SELECT MIN(price_per_sqm) as min, MAX(price_per_sqm) as max, AVG(price_per_sqm) as avg FROM community')
    price_stats = cursor.fetchone()
    
    current_year = datetime.now().year
    cursor.execute(f'SELECT MIN({current_year} - completion_year) as min, MAX({current_year} - completion_year) as max, AVG({current_year} - completion_year) as avg FROM community WHERE completion_year IS NOT NULL')
    age_stats = cursor.fetchone()
    
    conn.close()
    
    return {
        'total_communities': total,
        'avg_price': int(price_stats['avg']) if price_stats['avg'] else 0,
        'avg_age': int(age_stats['avg']) if age_stats['avg'] else 0,
        'price_range': {
            'min': price_stats['min'] or 0,
            'max': price_stats['max'] or 0
        },
        'age_range': {
            'min': age_stats['min'] or 0,
            'max': age_stats['max'] or 0
        }
    }
