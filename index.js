/**
 * 酒馆用量记账（极简版）
 *
 * 统计口径：按「接口 + 模型」分开记，同时留逐日流水，所以能看今日 / 本周 / 全部。
 * 单价由你自己填，面板上算个大概的钱。
 *
 * 数据来源：
 *  - 输入 token：CHAT_COMPLETION_PROMPT_READY 给出的最终 messages 数组，用酒馆自带分词器数
 *  - 输出 token：MESSAGE_RECEIVED 拿到的回复正文（含思维链），同样用自带分词器数
 *  - 次数：每收到一条模型回复 +1（换 swipe 也算一次）
 *
 * 注意：这是估算，不是账单。上游缓存命中的折扣价这里算不出来。
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_KEY = 'st_simple_usage';
const RANGES = ['day', 'week', 'all'];
const RANGE_LABEL = { day: '今日', week: '本周', all: '全部' };
const KEEP_DAYS = 400;

const api = () => getContext();

let lastPrompt = null;        // { api, model, key, tokens } 由 PROMPT_READY 写入，下一条回复消费
let costEls = new Map();      // key -> jQuery 元素
let currentRows = new Map();  // key -> { calls, pin, pout } 当前区间
let activeRange = 'all';

/* ------------------------------------------------------------------ 数据 */

function store() {
    if (!extension_settings[MODULE_KEY] || typeof extension_settings[MODULE_KEY] !== 'object') {
        extension_settings[MODULE_KEY] = { currency: '¥', models: {}, days: {} };
    }
    const s = extension_settings[MODULE_KEY];
    if (typeof s.currency !== 'string' || !s.currency) s.currency = '¥';
    if (!s.models || typeof s.models !== 'object') s.models = {};
    if (!s.days || typeof s.days !== 'object') s.days = {};
    return s;
}

function dayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

/** 本周一 00:00（本地时区） */
function startOfWeek(d = new Date()) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const offset = (t.getDay() + 6) % 7; // 周一 = 0
    t.setDate(t.getDate() - offset);
    return t;
}

/** 丢掉太老的逐日流水，避免 settings.json 无限膨胀（累计数字不受影响） */
function prune() {
    const s = store();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const limit = dayKey(cutoff);
    let changed = false;
    for (const dk of Object.keys(s.days)) {
        if (dk < limit) {
            delete s.days[dk];
            changed = true;
        }
    }
    if (changed) saveSettingsDebounced();
}

/**
 * 当前走的是哪套接口：连接配置的名字，或内置来源（openai / claude / custom / deepseek…）。
 * 用来把「同名模型、不同站点」分开记账。
 */
function apiLabel() {
    try {
        const ctx = api();
        const cm = ctx.extensionSettings?.connectionManager;
        if (cm?.selectedProfile) {
            const p = (cm.profiles || []).find(x => x.id === cm.selectedProfile);
            return p?.name ? String(p.name) : '连接配置';
        }
        if (ctx.mainApi === 'textgenerationwebui') return '文字补全';
        const s = ctx.chatCompletionSettings || {};
        const src = s.chat_completion_source || 'openai';
        if (src === 'custom' && s.custom_url) {
            try {
                return '自定义 · ' + new URL(s.custom_url).host;
            } catch {
                return '自定义接口';
            }
        }
        return String(src);
    } catch {
        return '未知接口';
    }
}

function makeKey(apiName, model) {
    return `${apiName} :: ${model}`;
}

function recordFor(key, apiName, model) {
    const s = store();
    if (!s.models[key]) {
        s.models[key] = { api: apiName, model, calls: 0, pin: 0, pout: 0, mode: 'token', perCall: 0, perIn: 0, perOut: 0 };
    }
    const r = s.models[key];
    if (apiName) r.api = apiName;
    if (model) r.model = model;
    return r;
}

function costFrom(r, stats) {
    r = r || {};
    stats = stats || {};
    if (r.mode === 'call') return (stats.calls || 0) * (r.perCall || 0);
    return (stats.pin || 0) / 1e6 * (r.perIn || 0) + (stats.pout || 0) / 1e6 * (r.perOut || 0);
}

/** 把一条回复的用量同时写进累计和当天流水 */
function addUsage(key, calls, pin, pout) {
    const s = store();
    const r = s.models[key];
    if (r) {
        r.calls = (r.calls || 0) + calls;
        r.pin = (r.pin || 0) + pin;
        r.pout = (r.pout || 0) + pout;
    }
    const dk = dayKey();
    if (!s.days[dk]) s.days[dk] = {};
    const d = s.days[dk][key] || (s.days[dk][key] = { calls: 0, pin: 0, pout: 0 });
    d.calls += calls;
    d.pin += pin;
    d.pout += pout;
}

/** 取某个区间的数据：key -> { calls, pin, pout } */
function rangeData(range) {
    const s = store();
    const out = new Map();

    if (range === 'all') {
        for (const [key, r] of Object.entries(s.models)) {
            out.set(key, { calls: r.calls || 0, pin: r.pin || 0, pout: r.pout || 0 });
        }
        return out;
    }

    let dayKeys;
    if (range === 'day') {
        dayKeys = [dayKey()];
    } else {
        const start = startOfWeek();
        const now = new Date();
        dayKeys = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            if (d > now) break;
            dayKeys.push(dayKey(d));
        }
    }

    for (const dk of dayKeys) {
        const bucket = s.days[dk];
        if (!bucket) continue;
        for (const [key, v] of Object.entries(bucket)) {
            const e = out.get(key) || { calls: 0, pin: 0, pout: 0 };
            e.calls += v.calls || 0;
            e.pin += v.pin || 0;
            e.pout += v.pout || 0;
            out.set(key, e);
        }
    }
    return out;
}

/** 某区间的合计 + 明细（按花费从高到低） */
function summarize(range) {
    const s = store();
    const rows = rangeData(range);
    const t = { calls: 0, pin: 0, pout: 0, cost: 0, keys: [] };
    for (const [key, agg] of rows) {
        t.calls += agg.calls;
        t.pin += agg.pin;
        t.pout += agg.pout;
        t.cost += costFrom(s.models[key], agg);
        t.keys.push([key, agg]);
    }
    t.keys.sort((a, b) => costFrom(s.models[b[0]], b[1]) - costFrom(s.models[a[0]], a[1]));
    return t;
}

/* --------------------------------------------------------------- 格式化 */

function fmtTokens(n) {
    n = Math.round(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
}

function fmtMoney(n) {
    return (n || 0).toFixed(2);
}

function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

function usageText(agg) {
    return `${agg.calls || 0} 次 · 入 ${fmtTokens(agg.pin)} · 出 ${fmtTokens(agg.pout)}`;
}

/* ----------------------------------------------------------- 采集（核心） */

async function countPrompt(tokensApi, chat) {
    if (!Array.isArray(chat)) return 0;
    let total = 3;
    for (const m of chat) {
        let text = '';
        const c = m?.content;
        if (typeof c === 'string') {
            text = c;
        } else if (Array.isArray(c)) {
            text = c.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
        }
        if (m?.name) text = String(m.name) + '\n' + text;
        try {
            total += 4 + await tokensApi.getTokenCountAsync(text);
        } catch {
            total += 4;
        }
    }
    return total;
}

async function countText(tokensApi, text) {
    if (!text) return 0;
    try {
        return await tokensApi.getTokenCountAsync(text);
    } catch {
        return 0;
    }
}

function currentModel() {
    try {
        const m = api().getChatCompletionModel?.();
        return m ? String(m) : '';
    } catch {
        return '';
    }
}

async function onPromptReady(data) {
    if (!data || data.dryRun === true) return;
    const apiName = apiLabel();
    const model = currentModel();
    const tokens = await countPrompt(api(), data.chat);
    lastPrompt = { api: apiName, model, key: makeKey(apiName, model), tokens };
}

async function onMessageReceived(messageId, type) {
    // 用户消息、角色卡首句问候都不算钱
    if (type === 'user' || type === 'first_message') return;

    const ctx = api();
    const msg = ctx.chat?.[messageId];
    if (!msg) return;

    const apiName = apiLabel();
    const model = msg.extra?.model || lastPrompt?.model || currentModel() || '未知模型';
    const key = makeKey(apiName, model);
    recordFor(key, apiName, model);

    let pin = 0;
    if (lastPrompt) {
        if (lastPrompt.model === model || lastPrompt.key === key) pin = lastPrompt.tokens || 0;
        lastPrompt = null;
    }

    const parts = [];
    if (typeof msg.mes === 'string') parts.push(msg.mes);
    const reasoning = msg.extra?.reasoning || msg.reasoning;
    if (typeof reasoning === 'string') parts.push(reasoning);
    const pout = await countText(ctx, parts.join('\n'));

    addUsage(key, 1, pin, pout);
    saveSettingsDebounced();
    renderAll();
}

function bindEvents() {
    const ctx = api();
    ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, data => {
        onPromptReady(data).catch(e => console.warn('[用量记账] 统计输入失败', e));
    });
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (messageId, type) => {
        onMessageReceived(messageId, type).catch(e => console.warn('[用量记账] 统计输出失败', e));
    });
}

/* ------------------------------------------------------------------ 界面 */

function buildSettingsHtml() {
    const tabs = RANGES.map(r => `<div class="susage-tab" data-range="${r}">${RANGE_LABEL[r]}</div>`).join('');
    return `
    <div id="susage_container" class="susage-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>用量记账</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="susage-toolbar">
                    <div class="susage-tabs">${tabs}</div>
                    <span id="susage_reset_all" class="susage-mini fa-solid fa-trash-can" title="全部清零"></span>
                </div>
                <div class="susage-hint">单价自己填，数字是估算。按量与按次可逐行切换，单位：元。</div>
                <div id="susage_body" class="susage-body"></div>
                <div id="susage_total" class="susage-total"></div>
            </div>
        </div>
    </div>`;
}

function buildRow(key, agg, currency) {
    const s = store();
    const r = s.models[key] || recordFor(key, '', key);

    const $row = $('<div class="susage-row"></div>');

    const $head = $('<div class="susage-head"></div>').appendTo($row);
    const $nameWrap = $('<span class="susage-name-wrap"></span>').appendTo($head);
    if (r.api) $('<span class="susage-api"></span>').text(r.api).appendTo($nameWrap);
    $('<span class="susage-model"></span>').text(r.model || key).appendTo($nameWrap);
    $('<span class="susage-usage"></span>').text(usageText(agg)).appendTo($head);

    const $ctrl = $('<div class="susage-ctrl"></div>').appendTo($row);

    const $mode = $('<select class="susage-mode text_pole"></select>')
        .append('<option value="token">按量</option>')
        .append('<option value="call">按次</option>')
        .val(r.mode === 'call' ? 'call' : 'token')
        .on('change', function () {
            r.mode = $(this).val();
            saveSettingsDebounced();
            renderAll();
        });
    $ctrl.append($mode);

    const input = (value, step, width) => $('<input type="number" min="0" step="' + step + '" class="text_pole susage-price">')
        .css('width', width + 'px')
        .val(value || 0);

    if (r.mode === 'call') {
        const $in = input(r.perCall, '0.01', 64).on('input', function () {
            r.perCall = num(this.value);
            saveSettingsDebounced();
            refreshCosts();
        });
        $ctrl.append('<span class="susage-label">每次</span>').append($in);
        $ctrl.append($('<span class="susage-unit"></span>').text(currency));
    } else {
        const $in = input(r.perIn, '0.01', 64).attr('title', '每百万输入 token 的价格').on('input', function () {
            r.perIn = num(this.value);
            saveSettingsDebounced();
            refreshCosts();
        });
        const $out = input(r.perOut, '0.01', 64).attr('title', '每百万输出 token 的价格').on('input', function () {
            r.perOut = num(this.value);
            saveSettingsDebounced();
            refreshCosts();
        });
        $ctrl.append('<span class="susage-label">入</span>').append($in)
            .append('<span class="susage-label">出</span>').append($out);
        $ctrl.append($('<span class="susage-unit"></span>').text(currency + '/百万'));
    }

    const $tail = $('<div class="susage-tail"></div>').appendTo($row);
    const $cost = $('<span class="susage-cost"></span>').text(currency + fmtMoney(costFrom(r, agg))).appendTo($tail);
    costEls.set(key, $cost);

    $('<span class="susage-mini fa-solid fa-rotate-left" title="清零这一项"></span>')
        .on('click', e => {
            e.stopPropagation();
            const st = store();
            const rec = st.models[key];
            if (rec) {
                rec.calls = 0;
                rec.pin = 0;
                rec.pout = 0;
            }
            for (const bucket of Object.values(st.days)) delete bucket[key];
            saveSettingsDebounced();
            renderAll();
        })
        .appendTo($tail);

    return $row;
}

function renderTotal(rows, currency) {
    const $total = $('#susage_total');
    if (!$total.length) return;

    let calls = 0;
    let pin = 0;
    let pout = 0;
    let cost = 0;
    const s = store();
    for (const [key, agg] of rows) {
        calls += agg.calls;
        pin += agg.pin;
        pout += agg.pout;
        cost += costFrom(s.models[key], agg);
    }

    $total.empty();
    $('<div class="susage-total-line"></div>').text(RANGE_LABEL[activeRange] + '：' + usageText({ calls, pin, pout })).appendTo($total);
    $('<div class="susage-total-cost"></div>').text(`${currency}${fmtMoney(cost)}`).appendTo($total);
    $('<div class="susage-total-note"></div>').text(rows.size ? `共 ${rows.size} 项` : '').appendTo($total);
}

function renderAll() {
    const s = store();
    const $body = $('#susage_body');
    if (!$body.length) return;

    // 正在输入单价时不要重绘，否则输入框会失焦
    if ($body.find('input:focus').length) return;

    const data = summarize(activeRange);
    currentRows = new Map(data.keys);
    costEls = new Map();
    $body.empty();

    if (!data.keys.length) {
        $body.append($('<div class="susage-empty"></div>').text(`${RANGE_LABEL[activeRange]}还没有记录。随便聊一句，这里就会出现模型和数字。`));
    } else {
        for (const [key, agg] of data.keys) {
            $body.append(buildRow(key, agg, s.currency));
        }
    }

    $('.susage-tab').removeClass('active');
    $(`.susage-tab[data-range="${activeRange}"]`).addClass('active');

    renderTotal(currentRows, s.currency);
    refreshMenuLabel();
}

function refreshCosts() {
    const s = store();
    for (const [key, $el] of costEls.entries()) {
        const agg = currentRows.get(key);
        const r = s.models[key];
        if (r && agg && $el) $el.text(s.currency + fmtMoney(costFrom(r, agg)));
    }
    renderTotal(currentRows, s.currency);
    refreshMenuLabel();
}

/* -------------------------------------------------------------- 魔法棒菜单 */

function ensureMenu() {
    const tryAdd = () => {
        if ($('#susage_menu').length) return true;
        if (!$('#extensionsMenu').length) return false;
        $('#extensionsMenu').append(`
            <div id="susage_menu" class="list-group-item flex-container flexGap5">
                <div class="fa-solid fa-calculator extensionsMenuExtensionButton"></div>
                <span>用量记账</span>
                <span id="susage_menu_cost" class="susage-menu-cost"></span>
            </div>`);
        $('#susage_menu').on('click', openSummary);
        return true;
    };

    if (tryAdd()) return;
    let tries = 0;
    const timer = setInterval(() => {
        if (tryAdd() || ++tries > 40) clearInterval(timer);
    }, 250);
}

function buildSummary() {
    const s = store();
    const $wrap = $('<div class="susage-popup"></div>');
    const $ranges = $('<div class="susage-popup-ranges"></div>').appendTo($wrap);

    for (const range of RANGES) {
        const t = summarize(range);
        const $line = $('<div class="susage-popup-range"></div>').appendTo($ranges);
        $('<span class="susage-popup-range-label"></span>').text(RANGE_LABEL[range]).appendTo($line);
        $('<span class="susage-popup-num"></span>').text(usageText(t)).appendTo($line);
        $('<span class="susage-popup-cost"></span>').text(s.currency + fmtMoney(t.cost)).appendTo($line);
    }

    const all = summarize('all');
    if (!all.keys.length) {
        $('<div class="susage-popup-empty"></div>').text('还没有记录。').appendTo($wrap);
        return $wrap;
    }

    const $list = $('<div class="susage-popup-list"></div>').appendTo($wrap);
    for (const [key, agg] of all.keys) {
        const r = s.models[key] || {};
        const $line = $('<div class="susage-popup-line"></div>').appendTo($list);
        const $nameWrap = $('<span class="susage-popup-name"></span>').appendTo($line);
        if (r.api) $('<span class="susage-api"></span>').text(r.api).appendTo($nameWrap);
        $('<span class="susage-popup-model"></span>').text(r.model || key).appendTo($nameWrap);
        $('<span class="susage-popup-num"></span>').text(usageText(agg)).appendTo($line);
        $('<span class="susage-popup-cost"></span>').text(s.currency + fmtMoney(costFrom(r, agg))).appendTo($line);
    }

    return $wrap;
}

function refreshMenuLabel() {
    const s = store();
    const day = summarize('day');
    const all = summarize('all');
    $('#susage_menu').attr('title', `今日 ${s.currency}${fmtMoney(day.cost)} · 全部 ${s.currency}${fmtMoney(all.cost)}`);
    $('#susage_menu_cost').text(`${s.currency}${fmtMoney(day.cost)}`);
}

function openSummary() {
    const ctx = api();
    const content = buildSummary();
    try {
        ctx.callGenericPopup(content, 1, '', { allowVerticalScrolling: true }); // 1 = POPUP_TYPE.TEXT
    } catch (e) {
        console.warn('[用量记账] 打开面板失败', e);
    }
}

/* ------------------------------------------------------------------ 启动 */

async function init() {
    store();
    if ($('#susage_container').length) return;

    $('#extensions_settings').append(buildSettingsHtml());

    $('.susage-tab').on('click', function () {
        const range = $(this).data('range');
        if (!RANGES.includes(range) || range === activeRange) return;
        activeRange = range;
        renderAll();
    });

    $('#susage_reset_all').on('click', () => {
        const s = store();
        for (const r of Object.values(s.models)) {
            r.calls = 0;
            r.pin = 0;
            r.pout = 0;
        }
        s.days = {};
        saveSettingsDebounced();
        renderAll();
    });

    prune();
    bindEvents();
    renderAll();
    ensureMenu();

    // 输入单价时表头不刷新，离开输入框后补一次，避免数字停在旧值上
    $('#susage_body').on('focusout', () => {
        setTimeout(() => {
            if (!$('#susage_body').find('input:focus, select:focus').length) renderAll();
        }, 150);
    });
}

jQuery(() => {
    init().catch(e => console.error('[用量记账] 初始化失败', e));
});
