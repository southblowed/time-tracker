// ========== State ==========
let types = [];
let statsChart = null;
let weekOffset = 0;
let statsDate = new Date();
let editingProviderId = null;

// ========== DOM Ready ==========
document.addEventListener('DOMContentLoaded', () => {
    const today = localDateStr(new Date());
    document.getElementById('eventDate').value = today;
    document.getElementById('recordDate').value = today;

    // Restore seamless toggle state
    const seamless = localStorage.getItem('seamlessMode') === 'true';
    document.getElementById('seamlessToggle').checked = seamless;
    if (seamless) applySeamlessTime();

    // Nav switching
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            tab.classList.add('active');
            const view = document.getElementById('view-' + tab.dataset.view);
            view.classList.add('active');
            if (tab.dataset.view === 'week') renderWeek();
            if (tab.dataset.view === 'stats') renderStats();
            if (tab.dataset.view === 'models') loadProviders();
        });
    });

    // Init
    loadTypes().then(() => {
        loadTodayEvents();
        renderWeek();
        renderStats();
    });

    // Event form
    document.getElementById('eventForm').addEventListener('submit', saveEvent);
    document.getElementById('recordDate').addEventListener('change', loadTodayEvents);

    // Week navigation
    document.getElementById('weekPrev').addEventListener('click', () => { weekOffset--; renderWeek(); });
    document.getElementById('weekNext').addEventListener('click', () => { weekOffset++; renderWeek(); });
    document.getElementById('weekToday').addEventListener('click', () => { weekOffset = 0; renderWeek(); });

    // Stats navigation
    document.getElementById('statsPrev').addEventListener('click', () => navigateStats(-1));
    document.getElementById('statsNext').addEventListener('click', () => navigateStats(1));
    document.getElementById('statsMode').addEventListener('change', renderStats);

    // Analyze
    document.getElementById('analyzeBtn').addEventListener('click', runAnalysis);

    // Provider form
    document.getElementById('providerForm').addEventListener('submit', saveProvider);

    // Seamless toggle
    document.getElementById('seamlessToggle').addEventListener('change', function() {
        localStorage.setItem('seamlessMode', this.checked);
        if (this.checked) applySeamlessTime();
    });

    // Edit event form
    document.getElementById('editForm').addEventListener('submit', saveEditEvent);
    document.getElementById('editDeleteBtn').addEventListener('click', deleteEditEvent);

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(el => {
        el.addEventListener('click', function(e) {
            if (e.target === this) this.classList.remove('show');
        });
    });

    // Type management button
    const recordCard = document.querySelector('#view-record .card:first-child .card-header h2');
    const typeBtn = document.createElement('button');
    typeBtn.className = 'btn btn-sm';
    typeBtn.textContent = '管理类型';
    typeBtn.style.cssFloat = 'right';
    typeBtn.onclick = openTypeModal;
    recordCard.appendChild(typeBtn);
});

// ========== Date Helpers ==========
function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function nowTimeStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

let useLocalDB = false;

// ========== API (Flask first, fallback to IndexedDB) ==========
async function api(url, opts = {}) {
    // If already using local DB, skip Flask
    if (useLocalDB) {
        return dbRouter(url, opts);
    }
    // Try Flask
    try {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...opts
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || 'Request failed');
        }
        return res.json();
    } catch (e) {
        // Flask unavailable, switch to local IndexedDB
        if (!useLocalDB) {
            console.log('Flask API unavailable, switching to local IndexedDB');
            useLocalDB = true;
        }
        return dbRouter(url, opts);
    }
}

function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
}

// ========== Seamless Time ==========
async function applySeamlessTime() {
    const date = document.getElementById('eventDate').value || localDateStr(new Date());
    try {
        const events = await api(`/api/events?date=${date}`);
        if (events.length > 0) {
            const last = events.reduce((a, b) => a.end_time > b.end_time ? a : b);
            document.getElementById('startTime').value = last.end_time.slice(0, 5);
        }
        document.getElementById('endTime').value = nowTimeStr();
    } catch {
        // If API fails, just set end time to now
        document.getElementById('endTime').value = nowTimeStr();
    }
}

// ========== Event Types ==========
async function loadTypes() {
    types = await api('/api/types');
    const selects = document.querySelectorAll('#eventType, #editEventType');
    selects.forEach(sel => {
        sel.innerHTML = types.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    });
    return types;
}

function getType(id) { return types.find(t => t.id === id); }

async function openTypeModal() {
    const body = document.getElementById('typeManagerBody');
    const fresh = await api('/api/types');
    body.innerHTML = fresh.map(t => `
        <div class="type-mgr-row" data-id="${t.id}">
            <input type="color" class="type-color-input" value="${t.color}" data-id="${t.id}">
            <input type="text" class="type-name-input" value="${t.name}" data-id="${t.id}">
            <button class="btn btn-sm type-save-btn" data-id="${t.id}">保存</button>
            <button class="btn btn-sm btn-del" data-id="${t.id}">删除</button>
        </div>
    `).join('') + `
        <div class="type-mgr-row type-mgr-add">
            <input type="color" id="newTypeColor" value="#7B68EE">
            <input type="text" id="newTypeName" placeholder="新类型名称">
            <button class="btn btn-sm btn-primary" id="addTypeBtn">添加</button>
        </div>
    `;
    document.getElementById('typeModal').classList.add('show');

    setTimeout(() => {
        body.querySelectorAll('.type-save-btn').forEach(btn => {
            btn.onclick = async () => {
                const id = parseInt(btn.dataset.id);
                const row = btn.closest('.type-mgr-row');
                const name = row.querySelector('.type-name-input').value.trim();
                const color = row.querySelector('.type-color-input').value;
                if (!name) return;
                await api(`/api/types/${id}`, { method: 'PUT', body: JSON.stringify({ name, color }) });
                await loadTypes();
                toast('类型已更新');
            };
        });
        body.querySelectorAll('.btn-del').forEach(btn => {
            btn.onclick = async () => {
                const id = parseInt(btn.dataset.id);
                if (!confirm('确定删除该类型？')) return;
                await api(`/api/types/${id}`, { method: 'DELETE' });
                await loadTypes();
                openTypeModal();
                toast('类型已删除');
            };
        });
        document.getElementById('addTypeBtn').onclick = async () => {
            const name = document.getElementById('newTypeName').value.trim();
            const color = document.getElementById('newTypeColor').value;
            if (!name) return;
            await api('/api/types', { method: 'POST', body: JSON.stringify({ name, color }) });
            await loadTypes();
            openTypeModal();
            toast('类型已添加');
        };
    }, 0);
}

function closeTypeModal() {
    document.getElementById('typeModal').classList.remove('show');
}

// ========== Events CRUD ==========
async function saveEvent(e) {
    e.preventDefault();
    const data = {
        type_id: parseInt(document.getElementById('eventType').value),
        event_date: document.getElementById('eventDate').value,
        start_time: document.getElementById('startTime').value,
        end_time: document.getElementById('endTime').value,
        detail: document.getElementById('eventDetail').value
    };

    if (data.start_time >= data.end_time) {
        toast('结束时间必须晚于开始时间');
        return;
    }

    try {
        await api('/api/events', { method: 'POST', body: JSON.stringify(data) });
        toast('事件已保存');
        document.getElementById('eventDetail').value = '';
        loadTodayEvents();
        // If seamless mode, auto-set next start time
        if (document.getElementById('seamlessToggle').checked) {
            document.getElementById('startTime').value = data.end_time.slice(0, 5);
            document.getElementById('endTime').value = nowTimeStr();
        }
    } catch (err) {
        toast('保存失败: ' + err.message);
    }
}

async function deleteEvent(id) {
    if (!confirm('确定删除这条记录？')) return;
    try {
        await api(`/api/events/${id}`, { method: 'DELETE' });
        toast('已删除');
        loadTodayEvents();
        renderWeek();
    } catch (err) {
        toast('删除失败');
    }
}

async function loadTodayEvents() {
    const date = document.getElementById('recordDate').value;
    const events = await api(`/api/events?date=${date}`);
    const container = document.getElementById('todayEvents');

    if (events.length === 0) {
        container.innerHTML = '<p class="empty-hint">今天还没有记录</p>';
        return;
    }

    container.innerHTML = events.map(ev => {
        const t = getType(ev.type_id);
        return `<div class="event-item" style="border-color:${t ? t.color : '#999'}" onclick="openEditModal(${ev.id})">
            <span class="type-tag" style="background:${t ? t.color : '#999'}">${ev.type_name}</span>
            <span class="time-range">${ev.start_time.slice(0,5)}-${ev.end_time.slice(0,5)}</span>
            <span class="detail">${escHtml(ev.detail)}</span>
            <span class="click-hint">✎</span>
        </div>`;
    }).join('');
}

// ========== Edit Event Modal ==========
async function openEditModal(eventId) {
    // Load event data from API
    const date = document.getElementById('recordDate').value;
    const events = await api(`/api/events?date=${date}`);
    // Also try the week data in case they're viewing a different day
    let ev = events.find(e => e.id === eventId);
    if (!ev) {
        const weekData = await api(`/api/events/week?date=${date}`);
        ev = weekData.events.find(e => e.id === eventId);
    }
    if (!ev) {
        // Try fetching by just getting from today
        const allToday = await api(`/api/events?date=${localDateStr(new Date())}`);
        ev = allToday.find(e => e.id === eventId);
    }
    if (!ev) {
        toast('找不到该事件');
        return;
    }

    document.getElementById('editEventId').value = ev.id;
    document.getElementById('editEventDate').value = ev.event_date;
    document.getElementById('editEventType').value = ev.type_id;
    document.getElementById('editStartTime').value = ev.start_time.slice(0, 5);
    document.getElementById('editEndTime').value = ev.end_time.slice(0, 5);
    document.getElementById('editDetail').value = ev.detail || '';

    // Populate type dropdown
    const sel = document.getElementById('editEventType');
    sel.innerHTML = types.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    sel.value = ev.type_id;

    document.getElementById('editModal').classList.add('show');
}

function closeEditModal() {
    document.getElementById('editModal').classList.remove('show');
}

async function saveEditEvent(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById('editEventId').value);
    const data = {
        type_id: parseInt(document.getElementById('editEventType').value),
        event_date: document.getElementById('editEventDate').value,
        start_time: document.getElementById('editStartTime').value,
        end_time: document.getElementById('editEndTime').value,
        detail: document.getElementById('editDetail').value
    };

    if (data.start_time >= data.end_time) {
        toast('结束时间必须晚于开始时间');
        return;
    }

    try {
        await api(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify(data) });
        toast('事件已更新');
        closeEditModal();
        loadTodayEvents();
        renderWeek();
    } catch (err) {
        toast('更新失败: ' + err.message);
    }
}

async function deleteEditEvent() {
    const id = parseInt(document.getElementById('editEventId').value);
    if (!confirm('确定删除这条记录？')) return;
    try {
        await api(`/api/events/${id}`, { method: 'DELETE' });
        toast('已删除');
        closeEditModal();
        loadTodayEvents();
        renderWeek();
    } catch (err) {
        toast('删除失败');
    }
}

// ========== Week View ==========
async function renderWeek() {
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() + weekOffset * 7 - today.getDay() + 1);
    const mondayStr = localDateStr(monday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const sundayStr = localDateStr(sunday);

    // Highlight today column
    const todayStr = localDateStr(today);

    document.getElementById('weekLabel').textContent = `${mondayStr} ~ ${sundayStr}`;

    const data = await api(`/api/events/week?date=${mondayStr}`);
    const events = data.events;

    // Legend
    const legendHtml = types.map(t =>
        `<span class="legend-item"><span class="legend-dot" style="background:${t.color}"></span>${t.name}</span>`
    ).join('');
    document.getElementById('weekLegend').innerHTML = legendHtml;

    const dayNames = ['时间', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const grid = document.getElementById('weekGrid');

    // 16 slots × 1.5h
    const slots = [];
    for (let h = 0; h < 24; h += 1.5) {
        const hh = Math.floor(h);
        const mm = Math.round((h % 1) * 60);
        slots.push(`${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`);
    }

    function parseTimeNum(t) {
        const [h, m] = t.split(':').map(Number);
        return h + m / 60;
    }

    function getDayDate(dayIndex) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + dayIndex);
        return localDateStr(d);
    }

    // Build blocks per day with proportional heights
    const dayBlocks = [];
    for (let d = 0; d < 7; d++) {
        const ds = getDayDate(d);
        const dayEvents = events.filter(e => e.event_date === ds);
        const blocks = dayEvents.map(ev => {
            const sh = parseTimeNum(ev.start_time);
            const eh = parseTimeNum(ev.end_time);
            const startSlot = Math.floor(sh / 1.5);
            const endSlot = Math.ceil(eh / 1.5);
            // Duration within this event's range
            const slotMin = startSlot * 1.5;
            const slotMax = endSlot * 1.5;
            const clampedStart = Math.max(sh, slotMin);
            const clampedEnd = Math.min(eh, slotMax);
            const durationInSlot = clampedEnd - clampedStart;
            return { ev, startSlot, endSlot, durationInSlot };
        });
        dayBlocks.push(blocks);
    }

    // Calculate row height: base 40px, scale by 1.5 for readability
    const BASE_SLOT_HOURS = 1.5;
    const BASE_HEIGHT = 44;
    const MIN_EVENT_PCT = 0.35; // minimum height proportion for an event in a slot

    // Pre-calculate row heights and event flex values for all slots
    const rowHeights = [];
    const rowEventFlex = []; // [slot][day] = array of flex values
    for (let s = 0; s < slots.length; s++) {
        let maxFill = 1;
        const flexMap = [];
        for (let d = 0; d < 7; d++) {
            const covering = dayBlocks[d].filter(b => b.startSlot <= s && b.endSlot > s);
            const flexes = covering.map(b =>
                Math.max(MIN_EVENT_PCT, b.durationInSlot / BASE_SLOT_HOURS)
            );
            flexMap.push(flexes);
            if (flexes.length > 0) {
                const totalFill = flexes.reduce((a, b) => a + b, 0);
                maxFill = Math.max(maxFill, totalFill);
            }
        }
        rowHeights.push(Math.round(BASE_HEIGHT * maxFill));
        rowEventFlex.push(flexMap);
    }

    // Header row
    let html = '';
    for (let d = 0; d < 8; d++) {
        html += `<div class="header-cell">${dayNames[d]}</div>`;
    }

    // Slot rows
    for (let s = 0; s < slots.length; s++) {
        const rowHeight = rowHeights[s];
        html += `<div class="time-label" style="min-height:${rowHeight}px">${slots[s]}</div>`;

        for (let d = 0; d < 7; d++) {
            const blocks = dayBlocks[d];
            const coveringBlocks = blocks.filter(b => b.startSlot <= s && b.endSlot > s);

            const ds = getDayDate(d);
            const isToday = ds === todayStr;

            let cellContent = '';
            if (coveringBlocks.length > 0) {
                const fragments = coveringBlocks.map((b, idx) => {
                    const t = getType(b.ev.type_id);
                    const flexVal = rowEventFlex[s][d][idx];
                    const isStart = b.startSlot === s;
                    const label = isStart ? (b.ev.detail || b.ev.type_name) : '';
                    return `<div class="event-block" style="background:${t ? t.color : '#999'};flex:${flexVal}" onclick="event.stopPropagation();openEditModal(${b.ev.id})" title="${escHtml(b.ev.detail || b.ev.type_name)}">${escHtml(label)}</div>`;
                }).join('');
                cellContent = fragments;
            }

            const cls = [
                'slot-cell',
                coveringBlocks.length > 0 ? 'has-event' : '',
                isToday ? 'is-today' : ''
            ].filter(Boolean).join(' ');

            html += `<div class="${cls}" style="min-height:${rowHeight}px">${cellContent}</div>`;
        }
    }

    grid.innerHTML = html;

    // Scroll to 6:00 by default (slot index 4), or to current time if later
    setTimeout(() => {
        const wrapper = document.getElementById('weekGridWrapper');
        if (wrapper) {
            const now = new Date();
            const hour = now.getHours() + now.getMinutes() / 60;
            // Show from 6:00 (slot 4) as default, or current time - 1 slot if after 6:00
            const targetSlot = Math.max(4, Math.floor(hour / 1.5) - 1);
            let scrollPos = 0;
            for (let i = 0; i < targetSlot; i++) {
                scrollPos += rowHeights[i];
            }
            wrapper.scrollTop = Math.max(0, scrollPos - 40);
        }
    }, 100);
}

// ========== Statistics ==========
function navigateStats(delta) {
    const mode = document.getElementById('statsMode').value;
    if (mode === 'month') {
        statsDate.setMonth(statsDate.getMonth() + delta);
    } else {
        statsDate.setFullYear(statsDate.getFullYear() + delta);
    }
    renderStats();
}

async function renderStats() {
    const mode = document.getElementById('statsMode').value;
    const ds = localDateStr(statsDate);
    const data = await api(`/api/events/stats?mode=${mode}&date=${ds}`);

    document.getElementById('statsLabel').textContent = data.label;

    const tbody = document.querySelector('#statsTable tbody');
    const total = data.data.reduce((sum, d) => sum + d.total_hours, 0);
    tbody.innerHTML = data.data.map(d => {
        const pct = total > 0 ? ((d.total_hours / total) * 100).toFixed(1) : 0;
        return `<tr>
            <td><span class="color-dot" style="background:${d.color}"></span>${d.name}</td>
            <td>${d.total_hours.toFixed(1)}</td>
            <td>${pct}%</td>
        </tr>`;
    }).join('');

    const ctx = document.getElementById('statsChart').getContext('2d');
    if (statsChart) statsChart.destroy();

    statsChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: data.data.map(d => d.name),
            datasets: [{
                data: data.data.map(d => d.total_hours),
                backgroundColor: data.data.map(d => d.color),
                borderWidth: 3,
                borderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { font: { size: 13 }, padding: 12 }
                    },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const val = ctx.parsed;
                                const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;
                                return ` ${ctx.label}: ${val.toFixed(1)} 小时 (${pct}%)`;
                            }
                        }
                    }
                },
                cutout: '60%'
        }
    });
}

// ========== Providers ==========
async function saveProvider(e) {
    e.preventDefault();
    const data = {
        name: document.getElementById('providerName').value.trim(),
        provider_type: document.getElementById('providerType').value,
        api_base: document.getElementById('providerBase').value.trim(),
        model: document.getElementById('providerModel').value.trim(),
        api_key: document.getElementById('providerKey').value.trim()
    };

    if (!data.name || !data.api_base || !data.api_key) {
        toast('请填写完整信息');
        return;
    }

    try {
        if (editingProviderId) {
            await api(`/api/providers/${editingProviderId}`, { method: 'PUT', body: JSON.stringify(data) });
            toast('供应商已更新');
            editingProviderId = null;
        } else {
            await api('/api/providers', { method: 'POST', body: JSON.stringify(data) });
            toast('供应商已添加');
        }
        document.getElementById('providerForm').reset();
        document.getElementById('providerForm').querySelector('button[type="submit"]').textContent = '添加';
        loadProviders();
    } catch (err) {
        toast('保存失败: ' + err.message);
    }
}

async function loadProviders() {
    const providers = await api('/api/providers');
    const container = document.getElementById('providerList');

    if (providers.length === 0) {
        container.innerHTML = '<p class="empty-hint">还没有配置任何供应商</p>';
        return;
    }

    container.innerHTML = providers.map(p => `
        <div class="provider-item ${p.is_active ? 'active' : ''}">
            <div class="provider-info">
                <span class="provider-name">${escHtml(p.name)}</span>
                <span class="provider-meta">
                    ${escHtml(p.provider_type === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容')}
                    ${p.model ? ' · ' + escHtml(p.model) : ''}
                </span>
                <span class="provider-key">${escHtml(p.api_key)}</span>
            </div>
            <div class="provider-actions">
                <button class="btn btn-sm ${p.is_active ? 'btn-active' : ''}"
                        onclick="setActiveProvider(${p.id})">
                    ${p.is_active ? '已激活' : '激活'}
                </button>
                <button class="btn btn-sm" onclick="editProvider(${p.id})">编辑</button>
                <button class="btn btn-sm btn-del" onclick="deleteProvider(${p.id})">删除</button>
            </div>
        </div>
    `).join('');
}

async function setActiveProvider(id) {
    await api(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
    toast('已切换激活供应商');
    loadProviders();
}

async function deleteProvider(id) {
    if (!confirm('确定删除此供应商？')) return;
    await api(`/api/providers/${id}`, { method: 'DELETE' });
    toast('供应商已删除');
    loadProviders();
}

async function editProvider(id) {
    const providers = await api('/api/providers');
    const p = providers.find(x => x.id === id);
    if (!p) return;
    document.getElementById('providerName').value = p.name;
    document.getElementById('providerType').value = p.provider_type;
    document.getElementById('providerBase').value = p.api_base;
    document.getElementById('providerModel').value = p.model;
    document.getElementById('providerKey').value = '';
    document.getElementById('providerKey').placeholder = '留空则不修改';
    editingProviderId = id;
    document.getElementById('providerForm').querySelector('button[type="submit"]').textContent = '更新';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ========== AI Analysis ==========
async function runAnalysis() {
    const mode = document.getElementById('analyzeMode').value;
    const ds = localDateStr(statsDate);
    const btn = document.getElementById('analyzeBtn');
    const resultDiv = document.getElementById('analyzeResult');

    btn.disabled = true;
    btn.textContent = '分析中...';
    resultDiv.innerHTML = '<div class="spinner"></div><p style="text-align:center;color:#999;">正在分析你的时间数据...</p>';

    try {
        const data = await api('/api/analyze', {
            method: 'POST',
            body: JSON.stringify({ mode, date: ds })
        });
        resultDiv.innerHTML = `<div class="analysis-content">${data.analysis.replace(/\n/g, '<br>')}</div>`;
    } catch (err) {
        resultDiv.innerHTML = `<p style="color:#E74C3C;">分析失败：${err.message}</p>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '开始分析';
    }
}

// ========== Utils ==========
function escHtml(s) {
    const div = document.createElement('div');
    div.textContent = s || '';
    return div.innerHTML;
}