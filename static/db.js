// ========== IndexedDB Backend (replaces Flask/SQLite for standalone mobile) ==========
const DB_NAME = 'TimeTrackerDB';
const DB_VERSION = 1;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('event_types')) {
                const types = db.createObjectStore('event_types', { keyPath: 'id', autoIncrement: true });
                types.createIndex('name', 'name', { unique: true });
                // Seed defaults
                const defaults = [
                    { name: '工作', color: '#4A90D9' }, { name: '学习', color: '#7B68EE' },
                    { name: '运动', color: '#2ECC71' }, { name: '娱乐', color: '#E74C3C' },
                    { name: '睡眠', color: '#34495E' }, { name: '用餐', color: '#F39C12' },
                    { name: '通勤', color: '#1ABC9C' }, { name: '社交', color: '#E91E63' },
                    { name: '阅读', color: '#9B59B6' }, { name: '其他', color: '#95A5A6' },
                ];
                defaults.forEach(t => types.add(t));
            }
            if (!db.objectStoreNames.contains('events')) {
                const evts = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
                evts.createIndex('event_date', 'event_date', { unique: false });
                evts.createIndex('type_id', 'type_id', { unique: false });
            }
            if (!db.objectStoreNames.contains('llm_providers')) {
                db.createObjectStore('llm_providers', { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function dbAction(store, method, data, index) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(store, method === 'readonly' ? 'readonly' : 'readwrite');
        const os = tx.objectStore(store);
        let req;
        if (method === 'getAll') {
            req = os.getAll();
        } else if (method === 'get') {
            req = os.get(data);
        } else if (method === 'add') {
            req = os.add(data);
        } else if (method === 'put') {
            req = os.put(data);
        } else if (method === 'delete') {
            req = os.delete(data);
        } else if (method === 'getAllFromIndex') {
            const idx = os.index(index.name);
            req = index.range ? idx.getAll(index.range) : idx.getAll();
        } else if (method === 'clear') {
            req = os.clear();
        }
        tx.oncomplete = () => {
            resolve(req ? req.result : undefined);
            db.close();
        };
        tx.onerror = () => { reject(tx.error); db.close(); };
    }));
}

// ========== Event Types API ==========
async function dbGetTypes() {
    const types = await dbAction('event_types', 'getAll');
    return types.sort((a, b) => a.id - b.id);
}

async function dbAddType(data) {
    const id = await dbAction('event_types', 'add', { name: data.name, color: data.color || '#95A5A6' });
    return { id };
}

async function dbUpdateType(id, data) {
    const existing = await dbAction('event_types', 'get', id);
    if (!existing) return { ok: false };
    await dbAction('event_types', 'put', { ...existing, ...data, id });
    return { ok: true };
}

async function dbDeleteType(id) {
    await dbAction('event_types', 'delete', id);
    return { ok: true };
}

// ========== Events API ==========
async function dbGetEvents(params) {
    const all = await dbAction('events', 'getAll');
    let filtered = all.sort((a, b) => a.event_date + a.start_time > b.event_date + b.start_time ? 1 : -1);
    if (params.event_date) filtered = filtered.filter(e => e.event_date === params.event_date);
    if (params.start_date) filtered = filtered.filter(e => e.event_date >= params.start_date);
    if (params.end_date) filtered = filtered.filter(e => e.event_date <= params.end_date);
    // Join with types
    const types = await dbGetTypes();
    return filtered.map(e => {
        const t = types.find(t => t.id === e.type_id);
        return { ...e, type_name: t ? t.name : '未知', type_color: t ? t.color : '#999' };
    });
}

async function dbAddEvent(data) {
    const id = await dbAction('events', 'add', {
        type_id: data.type_id, event_date: data.event_date,
        start_time: data.start_time, end_time: data.end_time,
        detail: data.detail || '', created_at: new Date().toISOString()
    });
    return { id };
}

async function dbUpdateEvent(id, data) {
    const existing = await dbAction('events', 'get', id);
    if (!existing) return { ok: false };
    await dbAction('events', 'put', { ...existing, ...data, id });
    return { ok: true };
}

async function dbDeleteEvent(id) {
    await dbAction('events', 'delete', id);
    return { ok: true };
}

async function dbGetWeekEvents(dateStr) {
    const dt = new Date(dateStr + 'T00:00:00');
    const day = dt.getDay();
    const monday = new Date(dt);
    monday.setDate(dt.getDate() - (day === 0 ? 6 : day - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const mon = monday.toISOString().slice(0, 10);
    const sun = sunday.toISOString().slice(0, 10);
    const events = await dbGetEvents({ start_date: mon, end_date: sun });
    return { monday: mon, sunday: sun, events };
}

async function dbGetStats(mode, dateStr) {
    const dt = new Date(dateStr + 'T00:00:00');
    let start, end;
    if (mode === 'year') {
        start = `${dt.getFullYear()}-01-01`;
        end = `${dt.getFullYear()}-12-31`;
    } else {
        start = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-01`;
        const lastDay = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
        end = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${lastDay}`;
    }
    const all = await dbGetEvents({ start_date: start, end_date: end });
    // Aggregate by type
    const byType = {};
    for (const e of all) {
        if (!byType[e.type_id]) byType[e.type_id] = { name: e.type_name, color: e.type_color, total_minutes: 0 };
        const sh = parseInt(e.start_time.split(':')[0]) + parseInt(e.start_time.split(':')[1]) / 60;
        const eh = parseInt(e.end_time.split(':')[0]) + parseInt(e.end_time.split(':')[1]) / 60;
        byType[e.type_id].total_minutes += (eh - sh) * 60;
    }
    const data = Object.entries(byType).map(([id, d]) => ({
        id: parseInt(id), name: d.name, color: d.color,
        total_hours: Math.round(d.total_minutes / 60 * 100) / 100
    })).sort((a, b) => b.total_hours - a.total_hours);
    return { label: mode === 'year' ? String(dt.getFullYear()) : `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`, start_date: start, end_date: end, data };
}

// ========== Providers API ==========
async function dbGetProviders() {
    const providers = await dbAction('llm_providers', 'getAll');
    return providers.map(p => ({
        ...p, api_key: p.api_key ? p.api_key.slice(0, 6) + '****' + p.api_key.slice(-4) : ''
    })).sort((a, b) => a.id - b.id);
}

async function dbAddProvider(data) {
    const id = await dbAction('llm_providers', 'add', {
        name: data.name, api_base: data.api_base, api_key: data.api_key || '',
        model: data.model || '', provider_type: data.provider_type || 'openai', is_active: 0
    });
    return { id };
}

async function dbUpdateProvider(id, data) {
    const existing = await dbAction('llm_providers', 'get', id);
    if (!existing) return { ok: false };
    if (data.is_active) {
        // Deactivate all others
        const all = await dbAction('llm_providers', 'getAll');
        for (const p of all) {
            if (p.id !== id) await dbAction('llm_providers', 'put', { ...p, is_active: 0 });
        }
    }
    await dbAction('llm_providers', 'put', { ...existing, ...data, id });
    return { ok: true };
}

async function dbDeleteProvider(id) {
    await dbAction('llm_providers', 'delete', id);
    return { ok: true };
}

// ========== AI Analysis (browser-side) ==========
async function dbAnalyze(mode, dateStr) {
    const stats = await dbGetStats(mode, dateStr);
    const events = await dbGetEvents({ start_date: stats.start_date, end_date: stats.end_date });
    const providers = await dbAction('llm_providers', 'getAll');
    const active = providers.find(p => p.is_active);

    if (!active) {
        return { analysis: '💡 还没有配置大模型供应商。请前往「模型管理」页面添加并激活一个供应商。', stats };
    }

    const prompt = buildPrompt(stats, events);
    try {
        const analysis = await callLLM(active, prompt);
        return { analysis, stats };
    } catch (e) {
        return { analysis: `⚠️ 调用大模型失败：${e.message}`, stats };
    }
}

function buildPrompt(stats, events) {
    return `你是一个时间管理分析专家。以下是我的时间记录数据：

统计周期：${stats.label}（${stats.start_date} 至 ${stats.end_date}）

各类事件耗时（小时）：
${JSON.stringify(stats.data.map(d => ({ name: d.name, total_hours: d.total_hours })), null, 2)}

每日详细记录：
${JSON.stringify(events.map(e => ({ event_date: e.event_date, start_time: e.start_time, end_time: e.end_time, detail: e.detail, type_name: e.type_name })), null, 2)}

请分析：
1. 我的时间分配是否合理？有哪些问题？
2. 哪些方面的时间利用率可以提高？
3. 给出 3-5 条具体的改进建议。
请用中文回答，语气友好且有建设性。`;
}

async function callLLM(provider, prompt) {
    const apiBase = provider.api_base.replace(/\/+$/, '');
    if (provider.provider_type === 'anthropic') {
        const resp = await fetch(`${apiBase}/messages`, {
            method: 'POST', headers: {
                'Content-Type': 'application/json', 'x-api-key': provider.api_key,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: provider.model || 'claude-sonnet-4-20250514', max_tokens: 2000,
                system: '你是一位专业的时间管理顾问。回复简洁、有洞察力，用中文。',
                messages: [{ role: 'user', content: prompt }]
            })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        const data = await resp.json();
        return data.content[0].text;
    } else {
        const resp = await fetch(`${apiBase}/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.api_key}` },
            body: JSON.stringify({
                model: provider.model || 'gpt-4o', max_tokens: 2000,
                messages: [
                    { role: 'system', content: '你是一位专业的时间管理顾问。回复简洁、有洞察力，用中文。' },
                    { role: 'user', content: prompt }
                ]
            })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        const data = await resp.json();
        return data.choices[0].message.content;
    }
}

// ========== Router: maps API calls to IndexedDB ==========
async function dbRouter(url, opts = {}) {
    const u = new URL(url, location.origin);
    const path = u.pathname;
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};

    // Event types
    if (path === '/api/types' && method === 'GET') return dbGetTypes();
    if (path === '/api/types' && method === 'POST') return dbAddType(body);
    const typeMatch = path.match(/^\/api\/types\/(\d+)$/);
    if (typeMatch) {
        const id = parseInt(typeMatch[1]);
        if (method === 'PUT') return dbUpdateType(id, body);
        if (method === 'DELETE') return dbDeleteType(id);
    }

    // Events
    if (path === '/api/events' && method === 'GET') {
        const params = Object.fromEntries(u.searchParams);
        return dbGetEvents(params);
    }
    if (path === '/api/events' && method === 'POST') return dbAddEvent(body);
    const evMatch = path.match(/^\/api\/events\/(\d+)$/);
    if (evMatch) {
        const id = parseInt(evMatch[1]);
        if (method === 'PUT') return dbUpdateEvent(id, body);
        if (method === 'DELETE') return dbDeleteEvent(id);
    }

    // Week
    if (path === '/api/events/week') return dbGetWeekEvents(u.searchParams.get('date') || new Date().toISOString().slice(0, 10));

    // Stats
    if (path === '/api/events/stats') {
        const mode = u.searchParams.get('mode') || 'month';
        const date = u.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        return dbGetStats(mode, date);
    }

    // Providers
    if (path === '/api/providers' && method === 'GET') return dbGetProviders();
    if (path === '/api/providers' && method === 'POST') return dbAddProvider(body);
    const provMatch = path.match(/^\/api\/providers\/(\d+)$/);
    if (provMatch) {
        const id = parseInt(provMatch[1]);
        if (method === 'PUT') return dbUpdateProvider(id, body);
        if (method === 'DELETE') return dbDeleteProvider(id);
    }

    // Analyze
    if (path === '/api/analyze') return dbAnalyze(body.mode || 'month', body.date || new Date().toISOString().slice(0, 10));

    throw new Error(`No handler for ${method} ${path}`);
}