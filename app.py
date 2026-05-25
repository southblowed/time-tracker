import os
import json
from datetime import datetime, timedelta, date
from flask import Flask, request, jsonify, render_template
import sqlite3

app = Flask(__name__)
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'time_tracker.db')

# ---------- Database Init ----------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS event_types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type_id INTEGER NOT NULL,
            event_date TEXT NOT NULL,
            detail TEXT DEFAULT '',
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (type_id) REFERENCES event_types(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS llm_providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            api_base TEXT NOT NULL,
            api_key TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            provider_type TEXT NOT NULL DEFAULT 'openai',
            is_active INTEGER NOT NULL DEFAULT 0
        );
    """)
    # Seed default types
    defaults = [
        ('工作', '#4A90D9'), ('学习', '#7B68EE'), ('运动', '#2ECC71'),
        ('娱乐', '#E74C3C'), ('睡眠', '#34495E'), ('用餐', '#F39C12'),
        ('通勤', '#1ABC9C'), ('社交', '#E91E63'), ('阅读', '#9B59B6'),
        ('其他', '#95A5A6'),
    ]
    for name, color in defaults:
        conn.execute("INSERT OR IGNORE INTO event_types (name, color) VALUES (?, ?)", (name, color))
    conn.commit()
    conn.close()

init_db()

# ---------- Helpers ----------
def row_to_dict(row):
    return dict(row) if row else None

def rows_to_list(rows):
    return [dict(r) for r in rows]

def parse_time(t_str):
    """Parse HH:MM string to datetime.time"""
    from datetime import time
    parts = t_str.strip().split(':')
    return time(int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)

def get_week_range(dt=None):
    """Return (monday, sunday) for the week containing dt"""
    if dt is None:
        dt = date.today()
    if isinstance(dt, str):
        dt = datetime.strptime(dt, '%Y-%m-%d').date()
    monday = dt - timedelta(days=dt.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday

# ---------- Routes ----------
@app.route('/')
def index():
    return render_template('index.html')

# --- Event Types ---
@app.route('/api/types', methods=['GET', 'POST'])
def handle_types():
    conn = get_db()
    if request.method == 'POST':
        data = request.get_json()
        if not data or 'name' not in data:
            return jsonify({'error': 'Missing name'}), 400
        name = data['name'].strip()
        color = data.get('color', '#95A5A6')
        try:
            conn.execute("INSERT INTO event_types (name, color) VALUES (?, ?)", (name, color))
            conn.commit()
            type_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            return jsonify({'id': type_id, 'name': name, 'color': color}), 201
        except sqlite3.IntegrityError:
            return jsonify({'error': 'Type already exists'}), 409
        finally:
            conn.close()
    else:
        rows = conn.execute("SELECT * FROM event_types ORDER BY id").fetchall()
        conn.close()
        return jsonify(rows_to_list(rows))

@app.route('/api/types/<int:type_id>', methods=['PUT', 'DELETE'])
def update_type(type_id):
    conn = get_db()
    if request.method == 'DELETE':
        conn.execute("DELETE FROM event_types WHERE id=?", (type_id,))
        conn.commit()
        conn.close()
        return jsonify({'ok': True})
    else:
        data = request.get_json()
        name = data.get('name', '').strip()
        color = data.get('color', '').strip()
        if name:
            conn.execute("UPDATE event_types SET name=?, color=? WHERE id=?", (name, color, type_id))
        elif color:
            conn.execute("UPDATE event_types SET color=? WHERE id=?", (color, type_id))
        conn.commit()
        conn.close()
        return jsonify({'ok': True})

# --- LLM Providers ---
@app.route('/api/providers', methods=['GET', 'POST'])
def handle_providers():
    conn = get_db()
    if request.method == 'POST':
        data = request.get_json()
        if not data or 'name' not in data or 'api_base' not in data:
            return jsonify({'error': 'Missing required fields'}), 400
        try:
            conn.execute(
                "INSERT INTO llm_providers (name, api_base, api_key, model, provider_type) VALUES (?, ?, ?, ?, ?)",
                (data['name'].strip(), data['api_base'].strip(),
                 data.get('api_key', ''), data.get('model', ''), data.get('provider_type', 'openai'))
            )
            conn.commit()
            pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            return jsonify({'id': pid}), 201
        except sqlite3.IntegrityError:
            return jsonify({'error': 'Provider name already exists'}), 409
        finally:
            conn.close()
    else:
        rows = conn.execute("SELECT * FROM llm_providers ORDER BY id").fetchall()
        conn.close()
        result = []
        for r in rows:
            d = dict(r)
            if d['api_key']:
                d['api_key'] = mask_key(d['api_key'])
            result.append(d)
        return jsonify(result)

@app.route('/api/providers/<int:pid>', methods=['PUT', 'DELETE'])
def update_provider(pid):
    conn = get_db()
    if request.method == 'DELETE':
        conn.execute("DELETE FROM llm_providers WHERE id=?", (pid,))
        conn.commit()
        conn.close()
        return jsonify({'ok': True})
    else:
        data = request.get_json()
        sets = []
        vals = []
        for k in ['name', 'api_base', 'api_key', 'model', 'provider_type']:
            if k in data:
                sets.append(f"{k}=?")
                vals.append(data[k])
        # Handle is_active toggle (deactivate others)
        if 'is_active' in data:
            conn.execute("UPDATE llm_providers SET is_active=0")
            sets.append("is_active=?")
            vals.append(1 if data['is_active'] else 0)
        if sets:
            vals.append(pid)
            conn.execute(f"UPDATE llm_providers SET {', '.join(sets)} WHERE id=?", vals)
            conn.commit()
        conn.close()
        return jsonify({'ok': True})

def mask_key(key):
    if len(key) <= 8:
        return key[:2] + '****' + key[-2:]
    return key[:6] + '****' + key[-4:]
@app.route('/api/events', methods=['GET', 'POST'])
def handle_events():
    conn = get_db()
    if request.method == 'POST':
        data = request.get_json()
        required = ['type_id', 'event_date', 'start_time', 'end_time']
        if not data or any(k not in data for k in required):
            return jsonify({'error': 'Missing required fields'}), 400
        detail = data.get('detail', '').strip()
        conn.execute(
            "INSERT INTO events (type_id, event_date, detail, start_time, end_time) VALUES (?, ?, ?, ?, ?)",
            (data['type_id'], data['event_date'], detail, data['start_time'], data['end_time'])
        )
        conn.commit()
        event_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.close()
        return jsonify({'id': event_id}), 201
    else:
        # Query params: date, start_date, end_date
        event_date = request.args.get('date')
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        query = """SELECT e.*, t.name as type_name, t.color as type_color
                   FROM events e JOIN event_types t ON e.type_id = t.id WHERE 1=1"""
        params = []
        if event_date:
            query += " AND e.event_date = ?"
            params.append(event_date)
        if start_date:
            query += " AND e.event_date >= ?"
            params.append(start_date)
        if end_date:
            query += " AND e.event_date <= ?"
            params.append(end_date)
        query += " ORDER BY e.event_date, e.start_time"
        rows = conn.execute(query, params).fetchall()
        conn.close()
        return jsonify(rows_to_list(rows))

@app.route('/api/events/<int:event_id>', methods=['PUT', 'DELETE'])
def update_event(event_id):
    conn = get_db()
    if request.method == 'DELETE':
        conn.execute("DELETE FROM events WHERE id=?", (event_id,))
        conn.commit()
        conn.close()
        return jsonify({'ok': True})
    else:
        data = request.get_json()
        fields = []
        vals = []
        for k in ['type_id', 'event_date', 'detail', 'start_time', 'end_time']:
            if k in data:
                fields.append(f"{k}=?")
                vals.append(data[k])
        if fields:
            vals.append(event_id)
            conn.execute(f"UPDATE events SET {', '.join(fields)} WHERE id=?", vals)
            conn.commit()
        conn.close()
        return jsonify({'ok': True})

# --- Weekly View ---
@app.route('/api/events/week')
def get_week_events():
    date_str = request.args.get('date', str(date.today()))
    monday, sunday = get_week_range(date_str)
    conn = get_db()
    rows = conn.execute(
        """SELECT e.*, t.name as type_name, t.color as type_color
           FROM events e JOIN event_types t ON e.type_id = t.id
           WHERE e.event_date >= ? AND e.event_date <= ?
           ORDER BY e.event_date, e.start_time""",
        (monday.isoformat(), sunday.isoformat())
    ).fetchall()
    conn.close()
    return jsonify({
        'monday': monday.isoformat(),
        'sunday': sunday.isoformat(),
        'events': rows_to_list(rows)
    })

# --- Statistics ---
@app.route('/api/events/stats')
def get_stats():
    mode = request.args.get('mode', 'month')  # month or year
    ref = request.args.get('date', str(date.today()))
    dt = datetime.strptime(ref, '%Y-%m-%d').date()

    conn = get_db()
    if mode == 'year':
        start_date = date(dt.year, 1, 1).isoformat()
        end_date = date(dt.year, 12, 31).isoformat()
        label = str(dt.year)
    else:  # month
        start_date = date(dt.year, dt.month, 1).isoformat()
        if dt.month == 12:
            end_date = date(dt.year + 1, 1, 1) - timedelta(days=1)
        else:
            end_date = date(dt.year, dt.month + 1, 1) - timedelta(days=1)
        end_date = end_date.isoformat()
        label = f"{dt.year}-{dt.month:02d}"

    rows = conn.execute(
        """SELECT t.id, t.name, t.color,
                  SUM(
                      (julianday('2000-01-01T' || e.end_time || ':00') -
                       julianday('2000-01-01T' || e.start_time || ':00')) * 24
                  ) as total_hours
           FROM events e JOIN event_types t ON e.type_id = t.id
           WHERE e.event_date >= ? AND e.event_date <= ?
           GROUP BY t.id ORDER BY total_hours DESC""",
        (start_date, end_date)
    ).fetchall()
    conn.close()

    result = []
    for r in rows:
        d = dict(r)
        d['total_hours'] = round(d['total_hours'], 2) if d['total_hours'] is not None else 0
        result.append(d)
    return jsonify({'label': label, 'start_date': start_date, 'end_date': end_date, 'data': result})

# --- LLM Analysis ---
@app.route('/api/analyze', methods=['POST'])
def analyze():
    data = request.get_json() or {}
    mode = data.get('mode', 'month')
    ref = data.get('date', str(date.today()))

    with app.test_request_context():
        stats_resp = get_stats()
    stats_data = stats_resp.get_json()

    conn = get_db()
    rows = conn.execute(
        """SELECT e.event_date, e.start_time, e.end_time, e.detail,
                  t.name as type_name, t.color as type_color
           FROM events e JOIN event_types t ON e.type_id = t.id
           WHERE e.event_date >= ? AND e.event_date <= ?
           ORDER BY e.event_date, e.start_time""",
        (stats_data['start_date'], stats_data['end_date'])
    ).fetchall()
    conn.close()
    events = rows_to_list(rows)

    prompt = f"""你是一个时间管理分析专家。以下是我的时间记录数据：

统计周期：{stats_data['label']}（{stats_data['start_date']} 至 {stats_data['end_date']}）

各类事件耗时（小时）：
{json.dumps([{'name': d['name'], 'total_hours': d['total_hours']} for d in stats_data['data']], ensure_ascii=False, indent=2)}

每日详细记录：
{json.dumps(events, ensure_ascii=False, indent=2, default=str)}

请分析：
1. 我的时间分配是否合理？有哪些问题？
2. 哪些方面的时间利用率可以提高？
3. 给出 3-5 条具体的改进建议。
请用中文回答，语气友好且有建设性。"""

    conn = get_db()
    provider = conn.execute("SELECT * FROM llm_providers WHERE is_active=1").fetchone()
    conn.close()

    if provider:
        try:
            analysis = call_llm(provider, prompt)
        except Exception as e:
            analysis = f"⚠️ 调用大模型失败：{str(e)}\n\n请检查 API 配置是否正确。"
    else:
        analysis = ("💡 还没有配置大模型供应商。\n\n"
                    "请前往「模型管理」页面添加一个 LLM 供应商（支持 OpenAI 兼容接口），"
                    "并将其设为激活状态，即可使用 AI 分析功能。")

    return jsonify({'analysis': analysis, 'stats': stats_data})


def call_llm(provider, prompt):
    provider = dict(provider)
    api_base = provider['api_base'].rstrip('/')
    api_key = provider['api_key']

    if provider.get('provider_type') == 'anthropic':
        import anthropic
        client = anthropic.Anthropic(api_key=api_key, base_url=api_base)
        model = provider['model'] or 'claude-sonnet-4-20250514'
        msg = client.messages.create(
            model=model, max_tokens=2000,
            system="你是一位专业的时间管理顾问。回复简洁、有洞察力，用中文。",
            messages=[{"role": "user", "content": prompt}]
        )
        return msg.content[0].text
    else:
        import requests as http_req
        model = provider['model'] or 'gpt-4o'
        resp = http_req.post(f"{api_base}/chat/completions", json={
            "model": model,
            "messages": [
                {"role": "system", "content": "你是一位专业的时间管理顾问。回复简洁、有洞察力，用中文。"},
                {"role": "user", "content": prompt}
            ],
            "max_tokens": 2000
        }, headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }, timeout=60)
        resp.raise_for_status()
        return resp.json()['choices'][0]['message']['content']

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)