"""
上海房龄+房价可视化地图 - Flask主应用
"""
from flask import Flask, jsonify, request, render_template
from flask_cors import CORS
from database import get_communities, get_community_by_id, get_districts, get_stats, init_database
from config import HOST, PORT, DEBUG

app = Flask(__name__)
CORS(app)

@app.route('/')
def index():
    """主页面"""
    return render_template('index.html')

@app.route('/api/communities', methods=['GET'])
def api_communities():
    """获取小区列表（支持筛选）"""
    filters = {}
    if request.args.get('district'):
        filters['district'] = request.args.get('district')
    if request.args.get('min_price'):
        filters['min_price'] = int(request.args.get('min_price'))
    if request.args.get('max_price'):
        filters['max_price'] = int(request.args.get('max_price'))
    if request.args.get('keyword'):
        filters['keyword'] = request.args.get('keyword')
    if request.args.get('min_age'):
        filters['min_age'] = int(request.args.get('min_age'))
    if request.args.get('max_age'):
        filters['max_age'] = int(request.args.get('max_age'))
    
    communities = get_communities(filters)
    return jsonify({'code': 0, 'data': communities, 'total': len(communities)})

@app.route('/api/communities/<int:community_id>', methods=['GET'])
def api_community_detail(community_id):
    """获取小区详情"""
    community = get_community_by_id(community_id)
    if community:
        return jsonify({'code': 0, 'data': community})
    return jsonify({'code': 404, 'message': '小区不存在'}), 404

@app.route('/api/districts', methods=['GET'])
def api_districts():
    """获取行政区列表"""
    districts = get_districts()
    return jsonify({'code': 0, 'data': districts})

@app.route('/api/stats', methods=['GET'])
def api_stats():
    """获取统计信息"""
    stats = get_stats()
    return jsonify({'code': 0, 'data': stats})

@app.route('/api/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    # 初始化数据库
    init_database()
    print(f"🚀 服务器启动: http://localhost:{PORT}")
    app.run(host=HOST, port=PORT, debug=DEBUG)
