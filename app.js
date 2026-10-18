/* ============================================================
   私账 · PRIVATE LEDGER
   Static PWA. All holdings stay in localStorage.
   Quotes: Tencent public endpoints (CORS enabled).
   ============================================================ */

'use strict';

/* ------------------------------ Constants ------------------------------ */

const LS = {
  portfolio: 'sz.portfolio.v1',
  settings: 'sz.settings.v1',
  history: 'sz.history.v1',
  quotes: 'sz.quotes.v1',
  minute: 'sz.minute.v1',
  onboarded: 'sz.onboarded.v1',
  ai: 'sz.ai.v1',
};

const DEFAULT_SETTINGS = {
  refresh: 10,
  theme: 'light',
  privacy: false,
};

const QUOTE_ENDPOINT = 'https://qt.gtimg.cn/q=';
const MINUTE_ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';

const AI_ENDPOINT = 'https://bigmodel.cn/api/paas/v4/chat/completions';
const AI_DEFAULT_MODEL = 'glm-4.6v-flash';
const AI_MODELS = [
  { id: 'glm-4.6v-flash', label: 'GLM-4.6V-Flash · 免费', note: '推荐，免费额度' },
  { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash · 最新', note: '更新模型，可能计费' },
  { id: 'glm-4.6v', label: 'GLM-4.6V · 更准', note: '付费，复杂截图更稳' },
  { id: 'glm-4.6v-flashx', label: 'GLM-4.6V-FlashX · 快速', note: '付费，速度优先' },
  { id: 'glm-4v-flash', label: 'GLM-4V-Flash · 旧版免费', note: '兼容旧 Key' },
  { id: 'glm-4v-plus', label: 'GLM-4V-Plus · 旧版增强', note: '付费' },
];

const AI_PROMPT = `请从这张持仓截图中提取所有资产，严格只输出一个 JSON 对象，不要输出 Markdown 代码块、解释或前后缀。

截图可能来自券商持仓页、支付宝基金页或天天基金页。忽略总资产、收益汇总、按钮、广告、推荐、指数行情等非持仓内容。

输出格式：
{"items":[{"kind":"stock|fund|cash","code":"6位数字或空字符串","name":"资产名称","qty":数字或null,"cost":数字或null,"marketValue":数字或null,"profit":数字或null,"confidence":0到1}],"warnings":["需要提醒用户的事项"]}

规则：
1. 股票、场内 ETF、LOF 的 kind 为 stock；场外基金、ETF 联接基金的 kind 为 fund；余额宝、现金、活期的 kind 为 cash。
2. code 只填截图中明确出现的 6 位数字代码；没有就填空字符串，不要猜。
3. qty：股票是持仓股数，基金是持有份额；如果同一行还有“可用数量 / 可用份额 / 冻结”，取“持仓数量 / 持有份额”，不要取可用数量；如果截图只有金额没有份额，qty 填 null。
4. cost：股票取每股持仓成本（摊薄成本），基金取每份成本净值；不要取现价；没有就填 null。
5. profit：该资产的累计持有收益（不是昨日收益、今日收益）；没有就填 null。
6. marketValue：这一行的持仓市值 / 持有金额，单位元；没有就填 null。
7. 数字去掉 ￥、¥、逗号、加号和百分号；“1.2万”写成 12000，“3.5亿”写成 350000000。
8. 不要输出合计行、总资产行、收益汇总行；同一只资产只输出一次。
9. 不确定的字段填 null，并在 warnings 里说明，不要编造代码、数量或成本。
10. confidence 表示你对这一行提取准确度的估计，0 到 1。`;


const COLORS = {
  stock: 'var(--ink)',
  fund: 'var(--brass)',
  cash: 'var(--muted)',
};

/* ------------------------------ State ------------------------------ */

const state = {
  portfolio: { cash: [], holdings: [], demo: false, updatedAt: 0 },
  settings: { ...DEFAULT_SETTINGS },
  quotes: {},
  quotesAt: 0,
  history: [],
  minute: {},
  expanded: new Set(),
  currentTotals: null,
  displayedTotal: null,
  loading: false,
  hasLoadedOnce: false,
  lastError: '',
  networkError: false,
  preview: '',
  deferredPrompt: null,
  form: null,
  aiConfig: { apiKey: '', model: AI_DEFAULT_MODEL },
  ai: {
    step: 'upload',
    files: [],
    results: [],
    warnings: [],
    error: '',
    busy: false,
    progress: '',
    progressPct: 0,
    mode: 'merge',
    abort: null,
    runId: 0,
    editingKey: false,
  },
  refreshTimer: null,
  toastTimer: null,
  amountRAF: 0,
};

const canStore = (() => {
  try {
    localStorage.setItem('__sz_test__', '1');
    localStorage.removeItem('__sz_test__');
    return true;
  } catch (err) {
    return false;
  }
})();

/* ------------------------------ DOM ------------------------------ */

const el = {
  app: document.getElementById('app'),
  themeColor: document.getElementById('themeColor'),
  refreshBtn: document.getElementById('refreshBtn'),
  privacyBtn: document.getElementById('privacyBtn'),
  themeBtn: document.getElementById('themeBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  demoBanner: document.getElementById('demoBanner'),
  demoReplaceBtn: document.getElementById('demoReplaceBtn'),
  offlineBanner: document.getElementById('offlineBanner'),
  offlineText: document.getElementById('offlineText'),
  offlineRetryBtn: document.getElementById('offlineRetryBtn'),
  marketPill: document.getElementById('marketPill'),
  marketText: document.getElementById('marketText'),
  totalAmount: document.getElementById('totalAmount'),
  amountInt: document.getElementById('amountInt'),
  amountDec: document.getElementById('amountDec'),
  dayPnl: document.getElementById('dayPnl'),
  dayPct: document.getElementById('dayPct'),
  deltaLabel: document.getElementById('deltaLabel'),
  totalPnl: document.getElementById('totalPnl'),
  cashMeta: document.getElementById('cashMeta'),
  updatedAt: document.getElementById('updatedAt'),
  liveSeal: document.getElementById('liveSeal'),
  chartWrap: document.getElementById('chartWrap'),
  chartSvg: document.getElementById('chartSvg'),
  chartTip: document.getElementById('chartTip'),
  chartEmpty: document.getElementById('chartEmpty'),
  chartDate: document.getElementById('chartDate'),
  chartBaseline: document.getElementById('chartBaseline'),
  chartAxis: document.getElementById('chartAxis'),
  allocTotal: document.getElementById('allocTotal'),
  allocBar: document.getElementById('allocBar'),
  allocLegend: document.getElementById('allocLegend'),
  holdingCount: document.getElementById('holdingCount'),
  holdingGroups: document.getElementById('holdingGroups'),
  emptyHoldings: document.getElementById('emptyHoldings'),
  emptyAddBtn: document.getElementById('emptyAddBtn'),
  editBtn: document.getElementById('editBtn'),
  dockAdd: document.getElementById('dockAdd'),
  holdings: document.getElementById('holdings'),
  addModal: document.getElementById('addModal'),
  editorModal: document.getElementById('editorModal'),
  formModal: document.getElementById('formModal'),
  batchModal: document.getElementById('batchModal'),
  settingsModal: document.getElementById('settingsModal'),
  infoModal: document.getElementById('infoModal'),
  editorTotal: document.getElementById('editorTotal'),
  editorCount: document.getElementById('editorCount'),
  editorBody: document.getElementById('editorBody'),
  editorBatchBtn: document.getElementById('editorBatchBtn'),
  editorExportBtn: document.getElementById('editorExportBtn'),
  editorAIBtn: document.getElementById('editorAIBtn'),
  aiBody: document.getElementById('aiBody'),
  aiFoot: document.getElementById('aiFoot'),
  aiSettingHint: document.getElementById('aiSettingHint'),
  aiSettingBtn: document.getElementById('aiSettingBtn'),
  formTitle: document.getElementById('formTitle'),
  formKicker: document.getElementById('formKicker'),
  formFields: document.getElementById('formFields'),
  formNote: document.getElementById('formNote'),
  formError: document.getElementById('formError'),
  assetForm: document.getElementById('assetForm'),
  lookupCard: document.getElementById('lookupCard'),
  lookupName: document.getElementById('lookupName'),
  lookupMeta: document.getElementById('lookupMeta'),
  saveAssetBtn: document.getElementById('saveAssetBtn'),
  deleteAssetBtn: document.getElementById('deleteAssetBtn'),
  batchInput: document.getElementById('batchInput'),
  batchError: document.getElementById('batchError'),
  batchSaveBtn: document.getElementById('batchSaveBtn'),
  batchBtn: document.getElementById('batchBtn'),
  importFile: document.getElementById('importFile'),
  refreshSeg: document.getElementById('refreshSeg'),
  themeSeg: document.getElementById('themeSeg'),
  privacySwitch: document.getElementById('privacySwitch'),
  installBtn: document.getElementById('installBtn'),
  installHint: document.getElementById('installHint'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  aboutBtn: document.getElementById('aboutBtn'),
  clearBtn: document.getElementById('clearBtn'),
  onboarding: document.getElementById('onboarding'),
  startBtn: document.getElementById('startBtn'),
  demoBtn: document.getElementById('demoBtn'),
  toast: document.getElementById('toast'),
};

/* ------------------------------ Utilities ------------------------------ */

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value) {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function uid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

const numberFormats = new Map();
function nf(digits = 2) {
  if (!numberFormats.has(digits)) {
    numberFormats.set(digits, new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }));
  }
  return numberFormats.get(digits);
}

function money(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return '¥' + nf(digits).format(Number(value));
}

function signedMoney(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return sign + '¥' + nf(digits).format(Math.abs(n));
}

function pctText(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

function compactMoney(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return nf(0).format(n);
}

function qtyText(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(Number(value) || 0);
}

function priceDigits(kind, price) {
  if (kind === 'fund') return 4;
  return Number(price) < 10 ? 3 : 2;
}

function priceText(quote) {
  if (!quote) return '—';
  return money(quote.price, priceDigits(quote.kind, quote.price));
}

function toneClass(value) {
  if (!Number.isFinite(Number(value)) || Number(value) === 0) return 'flat';
  return Number(value) > 0 ? 'up' : 'down';
}

function qkey(kind, code) {
  return kind + ':' + code;
}

/* ------------------------------ Time (Asia/Shanghai) ------------------------------ */

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const hmFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const shPartsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function todayStr() {
  return dateOf(Date.now());
}

function dateOf(timestamp) {
  const parts = dateFmt.formatToParts(new Date(timestamp));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function hmOf(timestamp) {
  return hmFmt.format(new Date(timestamp));
}

function hmNow() {
  return hmFmt.format(new Date());
}

function timeOf(timestamp) {
  return timeFmt.format(new Date(timestamp));
}

function dateStamp(dateString) {
  if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return '—';
  return dateString.slice(5);
}

function dateTimeLabel(timestamp) {
  if (!timestamp) return '—';
  if (dateOf(timestamp) === todayStr()) return timeOf(timestamp);
  return dateStamp(dateOf(timestamp)) + ' ' + hmOf(timestamp);
}

function shNow() {
  const parts = shPartsFmt.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[get('weekday')] ?? new Date().getDay();
  const hour = parseInt(get('hour'), 10) || 0;
  const minute = parseInt(get('minute'), 10) || 0;
  return { weekday, minutes: hour * 60 + minute, hour, minute };
}

function isTradingNow() {
  const { weekday, minutes } = shNow();
  if (weekday === 0 || weekday === 6) return false;
  return (minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900);
}

function marketStatus() {
  const { weekday, minutes } = shNow();
  if (weekday === 0 || weekday === 6) return { text: 'A股 休市', live: false, key: 'closed' };
  if (minutes < 555) return { text: 'A股 未开盘', live: false, key: 'pre' };
  if (minutes < 570) return { text: 'A股 集合竞价', live: false, key: 'auction' };
  if (minutes < 690) return { text: 'A股 交易中', live: true, key: 'open' };
  if (minutes < 780) return { text: 'A股 午间休市', live: false, key: 'lunch' };
  if (minutes < 900) return { text: 'A股 交易中', live: true, key: 'open' };
  return { text: 'A股 已收盘', live: false, key: 'closed' };
}

/* ------------------------------ Local storage ------------------------------ */

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function writeLS(key, value) {
  if (!canStore) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    toast('本地存储空间不足');
  }
}

function sanitizePortfolio(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {
    cash: [],
    holdings: [],
    demo: Boolean(source.demo),
    updatedAt: Number(source.updatedAt) || 0,
  };

  const cashList = Array.isArray(source.cash) ? source.cash : [];
  cashList.forEach((item) => {
    const amount = num(item?.amount);
    if (!Number.isFinite(amount) || amount < 0) return;
    out.cash.push({
      id: String(item.id || uid()),
      name: String(item.name || '现金').slice(0, 30),
      amount,
    });
  });

  const holdingList = Array.isArray(source.holdings) ? source.holdings : [];
  holdingList.forEach((item) => {
    const kind = item?.kind === 'fund' ? 'fund' : item?.kind === 'stock' ? 'stock' : '';
    const code = String(item?.code || '').replace(/\D/g, '').slice(0, 6);
    const qty = num(item?.qty);
    const cost = num(item?.cost);
    if (!kind || code.length !== 6 || !Number.isFinite(qty) || qty <= 0) return;
    out.holdings.push({
      id: String(item.id || uid()),
      kind,
      code,
      name: String(item.name || (kind === 'fund' ? '基金 ' : '股票 ') + code).slice(0, 40),
      qty,
      cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
    });
  });

  return out;
}

function loadState() {
  const portfolio = readLS(LS.portfolio, null);
  if (portfolio) state.portfolio = sanitizePortfolio(portfolio);

  const settings = readLS(LS.settings, null);
  if (settings && typeof settings === 'object') {
    state.settings = {
      refresh: [5, 10, 30, 60].includes(Number(settings.refresh)) ? Number(settings.refresh) : DEFAULT_SETTINGS.refresh,
      theme: ['light', 'dark', 'system'].includes(settings.theme) ? settings.theme : DEFAULT_SETTINGS.theme,
      privacy: Boolean(settings.privacy),
    };
  }

  const history = readLS(LS.history, []);
  if (Array.isArray(history)) {
    state.history = history.filter((point) => Number.isFinite(point?.t) && Number.isFinite(point?.v)).slice(-8000);
  }

  const minute = readLS(LS.minute, {});
  if (minute && typeof minute === 'object') state.minute = minute;

  const ai = readLS(LS.ai, null);
  if (ai && typeof ai === 'object') {
    state.aiConfig = {
      apiKey: typeof ai.apiKey === 'string' ? ai.apiKey : '',
      model: AI_MODELS.some((item) => item.id === ai.model) ? ai.model : AI_DEFAULT_MODEL,
    };
  }

  const quotes = readLS(LS.quotes, null);
  if (quotes && quotes.quotes && typeof quotes.quotes === 'object') {
    state.quotes = quotes.quotes;
    state.quotesAt = Number(quotes.at) || 0;
  }
}

function savePortfolio() {
  state.portfolio.updatedAt = Date.now();
  if (state.preview) return;
  writeLS(LS.portfolio, state.portfolio);
}

function saveSettings() {
  writeLS(LS.settings, state.settings);
}

function saveHistory() {
  if (state.preview) return;
  writeLS(LS.history, state.history);
}

/* ------------------------------ Theme & privacy ------------------------------ */

const darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function effectiveTheme() {
  if (state.settings.theme === 'system') return darkMedia?.matches ? 'dark' : 'light';
  return state.settings.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme() {
  const theme = effectiveTheme();
  document.documentElement.dataset.theme = theme;
  el.themeColor.setAttribute('content', theme === 'dark' ? '#0D1411' : '#F2ECDF');
}

function applyPrivacy() {
  document.body.classList.toggle('privacy', Boolean(state.settings.privacy));
  el.privacyBtn.setAttribute('aria-label', state.settings.privacy ? '显示金额' : '隐藏金额');
  el.privacySwitch.classList.toggle('on', Boolean(state.settings.privacy));
  el.privacySwitch.setAttribute('aria-checked', String(Boolean(state.settings.privacy)));
  if (state.currentTotals) renderAmount(state.currentTotals.total, false);
}

/* ------------------------------ Quote fetching ------------------------------ */

function isETF(code) {
  return /^(5|1[5-8])/.test(code);
}

function stockPrefix(code) {
  if (/^[48]/.test(code)) return 'bj';
  return /^[659]/.test(code) ? 'sh' : 'sz';
}

function stockMarket(code) {
  if (/^[48]/.test(code)) return 'BJ';
  return /^[659]/.test(code) ? 'SH' : 'SZ';
}

function stockId(code) {
  return stockPrefix(code) + code;
}

function fundId(code) {
  return 'jj' + code;
}

async function fetchTencent(ids) {
  if (!ids.length) return {};
  if (!navigator.onLine) throw new Error('offline');

  const unique = Array.from(new Set(ids));
  const chunks = [];
  for (let i = 0; i < unique.length; i += 40) chunks.push(unique.slice(i, i + 40));
  const results = await Promise.all(chunks.map((chunk) => fetchTencentChunk(chunk)));
  return Object.assign({}, ...results);
}

async function fetchTencentChunk(ids) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const url = QUOTE_ENDPOINT + ids.join(',') + '&_=' + Date.now();
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const buffer = await response.arrayBuffer();
    return parseTencentQuotes(decodeGBK(buffer));
  } finally {
    clearTimeout(timer);
  }
}

function decodeGBK(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch (err) {
    try {
      return new TextDecoder('gb18030').decode(buffer);
    } catch (err2) {
      return new TextDecoder().decode(buffer);
    }
  }
}

function parseTencentQuotes(text) {
  const result = {};
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const id = match[1];
    const fields = match[2].split('~');
    if (!fields.length) continue;

    if (id.startsWith('jj')) {
      const code = fields[0] || id.slice(2);
      const name = fields[1] || '';
      const nav = num(fields[5]);
      const pct = num(fields[7]);
      const date = fields[8] || '';
      if (!code || !name || !Number.isFinite(nav) || nav <= 0) continue;
      const prevNav = Number.isFinite(pct) && pct > -100 ? nav / (1 + pct / 100) : nav;
      result[qkey('fund', code)] = {
        kind: 'fund',
        code,
        name,
        price: nav,
        prevClose: prevNav,
        pct: Number.isFinite(pct) ? pct : 0,
        date,
        accNav: num(fields[6]) || nav,
      };
    } else {
      const code = fields[2] || id.slice(2);
      const name = fields[1] || '';
      const price = num(fields[3]);
      const prevClose = num(fields[4]);
      const pct = num(fields[32]);
      const change = num(fields[31]);
      const stamp = fields[30] || '';
      if (!code || !name || !Number.isFinite(price) || price <= 0) continue;
      let date = '';
      let clock = '';
      if (/^\d{14}$/.test(stamp)) {
        date = stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8);
        clock = stamp.slice(8, 10) + ':' + stamp.slice(10, 12) + ':' + stamp.slice(12, 14);
      }
      result[qkey('stock', code)] = {
        kind: 'stock',
        code,
        name,
        price,
        prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : price,
        pct: Number.isFinite(pct) ? pct : (Number.isFinite(change) && price ? (change / price) * 100 : 0),
        change: Number.isFinite(change) ? change : 0,
        date,
        time: clock,
      };
    }
  }
  return result;
}

function parseMinutePoints(rows) {
  const points = [];
  for (const row of rows) {
    const parts = String(row || '').split(' ');
    const stamp = parts[0] || '';
    const price = num(parts[1]);
    if (!/^\d{4}$/.test(stamp) || !Number.isFinite(price) || price <= 0) continue;
    const minutes = parseInt(stamp.slice(0, 2), 10) * 60 + parseInt(stamp.slice(2), 10);
    if (minutes < 570 || minutes > 900) continue;
    if (minutes > 690 && minutes < 780) continue;
    points.push({
      m: minutes,
      t: stamp.slice(0, 2) + ':' + stamp.slice(2),
      p: price,
    });
  }
  const byMinute = new Map();
  points.forEach((point) => byMinute.set(point.m, point));
  return Array.from(byMinute.values()).sort((a, b) => a.m - b.m);
}

async function fetchMinuteForStock(code) {
  const id = stockId(code);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(MINUTE_ENDPOINT + id + '&_=' + Date.now(), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const json = await response.json();
    const node = json?.data?.[id];
    const rows = node?.data?.data;
    const dateRaw = node?.data?.date;
    if (!Array.isArray(rows) || !rows.length) return null;
    const date = /^\d{8}$/.test(String(dateRaw))
      ? String(dateRaw).slice(0, 4) + '-' + String(dateRaw).slice(4, 6) + '-' + String(dateRaw).slice(6, 8)
      : '';
    const points = parseMinutePoints(rows);
    if (!date || points.length < 2) return null;
    return { date, points, fetchedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function refreshMinute(stockHoldings) {
  if (!stockHoldings.length) {
    state.minute = {};
    return;
  }

  const codes = new Set(stockHoldings.map((item) => item.code));
  const now = Date.now();
  const latest = latestQuoteDate();
  const needs = stockHoldings.filter((item) => {
    const cached = state.minute[item.code];
    if (!cached || !Array.isArray(cached.points) || cached.points.length < 2) return true;
    if (isTradingNow()) return now - (cached.fetchedAt || 0) > 90 * 1000;
    return cached.date !== latest || now - (cached.fetchedAt || 0) > 6 * 60 * 60 * 1000;
  });

  await mapLimit(needs, 4, async (item) => {
    try {
      const result = await fetchMinuteForStock(item.code);
      if (result) state.minute[item.code] = result;
    } catch (err) {
      /* Chart falls back to stored snapshots. */
    }
  });

  Object.keys(state.minute).forEach((code) => {
    if (!codes.has(code)) delete state.minute[code];
  });
  writeLS(LS.minute, state.minute);
}

/* ------------------------------ Totals ------------------------------ */

function latestStockDate() {
  let latest = '';
  for (const item of state.portfolio.holdings) {
    if (item.kind !== 'stock') continue;
    const quote = state.quotes[qkey('stock', item.code)];
    if (quote?.date && quote.date > latest) latest = quote.date;
  }
  return latest;
}

function latestQuoteDate() {
  let latest = '';
  for (const item of state.portfolio.holdings) {
    const quote = state.quotes[qkey(item.kind, item.code)];
    if (quote?.date && quote.date > latest) latest = quote.date;
  }
  return latest || todayStr();
}

function computeTotals() {
  const cash = state.portfolio.cash.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  let stock = 0;
  let fund = 0;
  let totalPnl = 0;
  let costBasis = 0;
  let dayPnl = 0;
  let hasCost = true;
  const missing = [];
  const latest = latestQuoteDate();

  for (const item of state.portfolio.holdings) {
    const quote = state.quotes[qkey(item.kind, item.code)];
    if (!quote) {
      missing.push(item);
      continue;
    }
    const marketValue = quote.price * item.qty;
    if (item.kind === 'stock') stock += marketValue;
    else fund += marketValue;

    if (quote.date === latest) {
      dayPnl += (quote.price - quote.prevClose) * item.qty;
    }

    if (item.cost > 0) {
      costBasis += item.cost * item.qty;
      totalPnl += (quote.price - item.cost) * item.qty;
    } else {
      hasCost = false;
    }
  }

  const total = cash + stock + fund;
  const prevTotal = total - dayPnl;
  const dayPct = prevTotal > 0 ? (dayPnl / prevTotal) * 100 : 0;

  return {
    cash,
    stock,
    fund,
    total,
    prevTotal,
    dayPnl,
    dayPct,
    totalPnl,
    costBasis,
    hasCost,
    missing,
    partial: missing.length > 0,
    latest,
  };
}

function recordHistory(total) {
  if (state.preview || !Number.isFinite(total)) return;
  const now = Date.now();
  const today = todayStr();
  const last = state.history[state.history.length - 1];
  if (last && now - last.t < 55 * 1000 && dateOf(last.t) === today) {
    last.v = total;
  } else {
    state.history.push({ t: now, v: total });
  }
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  state.history = state.history.filter((point) => point.t >= cutoff).slice(-8000);
  saveHistory();
}

/* ------------------------------ Refresh loop ------------------------------ */

function scheduleNext() {
  clearTimeout(state.refreshTimer);
  if (document.hidden) return;
  const interval = isTradingNow()
    ? state.settings.refresh * 1000
    : 5 * 60 * 1000;
  state.refreshTimer = setTimeout(() => refreshAll(false), interval);
}

function setLoading(isLoading) {
  el.refreshBtn.classList.toggle('loading', isLoading);
  el.refreshBtn.setAttribute('aria-busy', String(isLoading));
}

async function refreshAll(manual = false) {
  if (state.loading) return;
  state.loading = true;
  setLoading(true);

  const holdings = state.portfolio.holdings;
  const stocks = holdings.filter((item) => item.kind === 'stock');
  const funds = holdings.filter((item) => item.kind === 'fund');
  let problem = '';

  try {
    if (holdings.length) {
      const ids = [
        ...stocks.map((item) => stockId(item.code)),
        ...funds.map((item) => fundId(item.code)),
      ];
      const map = await fetchTencent(ids);
      let missingCount = 0;

      holdings.forEach((item) => {
        const quote = map[qkey(item.kind, item.code)];
        if (quote) {
          state.quotes[qkey(item.kind, item.code)] = { ...quote, fetchedAt: Date.now() };
        } else {
          missingCount += 1;
        }
      });

      state.quotesAt = Date.now();
      state.hasLoadedOnce = true;
      state.networkError = false;
      if (missingCount) {
        problem = `有 ${missingCount} 项行情未获取`;
        state.lastError = problem;
      } else {
        state.lastError = '';
      }
      writeLS(LS.quotes, { at: state.quotesAt, quotes: state.quotes });

      if (stocks.length) await refreshMinute(stocks);
    } else {
      state.quotesAt = Date.now();
      state.hasLoadedOnce = true;
      state.lastError = '';
      state.networkError = false;
    }
  } catch (err) {
    state.hasLoadedOnce = true;
    state.networkError = true;
    state.lastError = '行情连接失败，请检查网络';
    problem = state.lastError;
  } finally {
    state.loading = false;
    setLoading(false);
    const totals = computeTotals();
    state.currentTotals = totals;
    recordHistory(totals.total);
    renderAll();
    scheduleNext();

    if (manual) {
      if (problem) toast(problem);
      else toast('行情已更新');
    }
  }
}

/* ------------------------------ Amount animation ------------------------------ */

function setAmountParts(value) {
  if (!Number.isFinite(value)) {
    el.amountInt.textContent = '—';
    el.amountDec.textContent = '';
    return;
  }
  const parts = nf(2).format(Math.abs(value)).split('.');
  el.amountInt.textContent = (value < 0 ? '-' : '') + parts[0];
  el.amountDec.textContent = '.' + (parts[1] || '00');
}

function renderAmount(total, animate = true) {
  if (state.settings.privacy) {
    cancelAnimationFrame(state.amountRAF);
    el.totalAmount.classList.remove('placeholder');
    el.amountInt.textContent = '••••••';
    el.amountDec.textContent = '';
    el.totalAmount.setAttribute('aria-label', '资产总额已隐藏');
    el.totalAmount.classList.remove('flash-up', 'flash-down');
    return;
  }

  if (total === null || !Number.isFinite(total)) {
    cancelAnimationFrame(state.amountRAF);
    el.totalAmount.classList.add('placeholder');
    el.amountInt.textContent = '—';
    el.amountDec.textContent = '';
    el.totalAmount.setAttribute('aria-label', '资产总额加载中');
    return;
  }

  el.totalAmount.classList.remove('placeholder');
  const from = Number.isFinite(state.displayedTotal) ? state.displayedTotal : 0;
  const to = Number(total);
  const previous = state.displayedTotal;

  el.totalAmount.classList.toggle('long', Math.trunc(Math.abs(to)).toString().length >= 10);

  cancelAnimationFrame(state.amountRAF);

  if (!animate || Math.abs(to - from) < 0.005 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setAmountParts(to);
    state.displayedTotal = to;
  } else {
    const started = performance.now();
    const duration = 620;
    const tick = (now) => {
      const progress = clamp((now - started) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = from + (to - from) * eased;
      setAmountParts(value);
      state.displayedTotal = value;
      if (progress < 1) state.amountRAF = requestAnimationFrame(tick);
      else {
        setAmountParts(to);
        state.displayedTotal = to;
      }
    };
    state.amountRAF = requestAnimationFrame(tick);
  }

  el.totalAmount.setAttribute('aria-label', '资产总额 ' + money(to));

  if (Number.isFinite(previous) && Math.abs(to - previous) > 0.005) {
    el.totalAmount.classList.remove('flash-up', 'flash-down');
    void el.totalAmount.offsetWidth;
    el.totalAmount.classList.add(to > previous ? 'flash-up' : 'flash-down');
    setTimeout(() => el.totalAmount.classList.remove('flash-up', 'flash-down'), 760);
  }
}

/* ------------------------------ Rendering: hero ------------------------------ */

function renderHero(totals) {
  const allQuotesMissing = totals.missing.length > 0
    && totals.missing.length === state.portfolio.holdings.length
    && state.portfolio.holdings.length > 0;
  const displayTotal = allQuotesMissing ? null : totals.total;

  renderAmount(displayTotal, true);

  const hasHoldings = state.portfolio.holdings.length > 0;
  const tone = toneClass(totals.dayPnl);

  if (!hasHoldings && totals.cash === 0) {
    el.dayPnl.textContent = '还没有资产';
    el.dayPnl.className = 'delta flat';
    el.dayPct.hidden = true;
    el.deltaLabel.textContent = '';
  } else if (!state.hasLoadedOnce && !state.quotesAt) {
    el.dayPnl.textContent = '正在获取行情…';
    el.dayPnl.className = 'delta flat';
    el.dayPct.hidden = true;
    el.deltaLabel.textContent = '';
  } else if (allQuotesMissing) {
    el.dayPnl.textContent = '行情缺失';
    el.dayPnl.className = 'delta flat';
    el.dayPct.hidden = true;
    el.deltaLabel.textContent = totals.latest === todayStr() ? '今日' : dateStamp(totals.latest) + ' 收盘';
  } else {
    el.dayPnl.textContent = signedMoney(totals.dayPnl);
    el.dayPnl.className = 'delta ' + tone;
    if (totals.prevTotal > 0) {
      el.dayPct.hidden = false;
      el.dayPct.textContent = pctText(totals.dayPct);
      el.dayPct.className = 'pct ' + tone;
    } else {
      el.dayPct.hidden = true;
    }
    if (totals.latest === todayStr()) el.deltaLabel.textContent = '今日';
    else if (!hasHoldings) el.deltaLabel.textContent = '现金账本';
    else if (state.portfolio.holdings.every((item) => item.kind === 'fund')) {
      el.deltaLabel.textContent = dateStamp(totals.latest) + ' 净值';
    } else {
      el.deltaLabel.textContent = dateStamp(totals.latest) + ' 收盘';
    }
  }

  if (totals.costBasis > 0) {
    el.totalPnl.textContent = signedMoney(totals.totalPnl) + (totals.hasCost ? '' : '*');
    el.totalPnl.className = 'money ' + toneClass(totals.totalPnl);
    el.totalPnl.title = totals.hasCost ? '按已填写成本计算' : '部分持仓未填写成本，此数字不含它们';
  } else {
    el.totalPnl.textContent = '—';
    el.totalPnl.className = 'money';
    el.totalPnl.title = '填写成本价后可看累计盈亏';
  }

  el.cashMeta.textContent = money(totals.cash);
  el.updatedAt.textContent = state.quotesAt ? dateTimeLabel(state.quotesAt) : '—';

  renderMarketStatus(totals);
}

function renderMarketStatus(totals) {
  const status = marketStatus();
  const hasStocks = state.portfolio.holdings.some((item) => item.kind === 'stock');
  const hasHoldings = state.portfolio.holdings.length > 0;
  const stockLatest = latestStockDate();
  const stale = hasStocks && status.live && stockLatest && stockLatest !== todayStr();
  const live = status.live && !stale && !state.networkError;

  el.marketText.textContent = stale ? 'A股 休市' : status.text;
  el.marketPill.classList.toggle('live', live);
  el.marketPill.classList.toggle('offline', Boolean(state.networkError));

  if (live) {
    el.liveSeal.textContent = hasStocks ? '实时' : hasHoldings ? '净值' : '休市';
    el.liveSeal.classList.toggle('closed', !hasStocks && !hasHoldings);
  } else {
    el.liveSeal.textContent = status.key === 'lunch' ? '午休' : '休市';
    el.liveSeal.classList.add('closed');
  }
}

/* ------------------------------ Rendering: chart ------------------------------ */

function buildChartSeries(totals) {
  const stocks = state.portfolio.holdings.filter((item) => item.kind === 'stock');
  const lists = stocks.map((item) => state.minute[item.code]?.points || []);
  const times = new Map();
  lists.forEach((points) => points.forEach((point) => times.set(point.m, point.t)));

  let series = [];

  if (times.size >= 2) {
    const sorted = Array.from(times.entries()).sort((a, b) => a[0] - b[0]);
    const pointers = stocks.map(() => 0);
    const lastPrices = stocks.map((item) => state.quotes[qkey('stock', item.code)]?.price || 0);

    for (const [minute, label] of sorted) {
      stocks.forEach((item, index) => {
        const points = lists[index];
        while (pointers[index] < points.length && points[pointers[index]].m <= minute) {
          lastPrices[index] = points[pointers[index]].p;
          pointers[index] += 1;
        }
      });
      const stockValue = stocks.reduce((sum, item, index) => sum + item.qty * lastPrices[index], 0);
      series.push({ t: label, v: totals.cash + totals.fund + stockValue });
    }
  }

  if (!series.length) {
    series = state.history
      .filter((point) => dateOf(point.t) === totals.latest)
      .map((point) => ({ t: hmOf(point.t), v: point.v }));
  }

  if (!series.length && Number.isFinite(totals.total)) {
    series = [{ t: hmNow(), v: totals.total }];
  }

  if (series.length && totals.latest === todayStr() && isTradingNow()) {
    const now = hmNow();
    const last = series[series.length - 1];
    if (now > last.t) series.push({ t: now, v: totals.total });
  }

  return series;
}

function smoothPath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  let d = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

function renderChart(totals) {
  const series = buildChartSeries(totals);
  const width = Math.max(300, el.chartWrap.clientWidth || 560);
  const height = Math.max(150, el.chartWrap.clientHeight || 184);
  el.chartSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const values = series.map((point) => point.v);
  values.push(totals.prevTotal);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  const padding = Math.max((max - min) * 0.14, Math.abs(totals.total) * 0.0006, 1);
  min -= padding;
  max += padding;
  const range = max - min || 1;

  const top = 10;
  const bottom = height - 9;
  const left = 2;
  const right = width - 8;
  const xFor = (index) => left + (series.length <= 1 ? 0.5 : index / (series.length - 1)) * (right - left);
  const yFor = (value) => top + ((max - value) / range) * (bottom - top);

  const pixels = series.map((point, index) => ({
    ...point,
    x: xFor(index),
    y: yFor(point.v),
  }));

  const baselineY = yFor(totals.prevTotal);
  const line = smoothPath(pixels);
  const last = pixels[pixels.length - 1];
  const direction = series.length && last.v >= totals.prevTotal ? 'up' : 'down';
  el.chartWrap.classList.remove('up', 'down');
  el.chartWrap.classList.add(direction);

  const grid = [0.22, 0.5, 0.78].map((ratio) => {
    const y = top + ratio * (bottom - top);
    return `<line class="grid-line" x1="${left}" y1="${y.toFixed(2)}" x2="${right}" y2="${y.toFixed(2)}"/>`;
  }).join('');

  const area = pixels.length > 1
    ? `<path class="area" d="${line} L${last.x.toFixed(2)},${bottom} L${pixels[0].x.toFixed(2)},${bottom} Z"/>`
    : '';

  const endDot = last
    ? `<circle class="end-halo" cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="5"/>
       <circle class="end-dot" cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="3.2"/>`
    : '';

  el.chartSvg.innerHTML = `
    <defs>
      <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:var(--chart);stop-opacity:.18"/>
        <stop offset="100%" style="stop-color:var(--chart);stop-opacity:0"/>
      </linearGradient>
    </defs>
    ${grid}
    <line class="baseline" x1="${left}" y1="${baselineY.toFixed(2)}" x2="${right}" y2="${baselineY.toFixed(2)}"/>
    ${area}
    <path class="line" d="${line}"/>
    <line class="crosshair" id="chartCrosshair" x1="0" y1="${top}" x2="0" y2="${bottom}" style="display:none"/>
    <circle class="hover-dot" id="chartHoverDot" cx="0" cy="0" r="3.2" style="display:none"/>
    ${endDot}
  `;

  state.currentChart = {
    series,
    pixels,
    width,
    height,
    top,
    bottom,
    left,
    right,
  };

  el.chartEmpty.hidden = pixels.length >= 2;
  if (pixels.length < 2) {
    if (!state.portfolio.holdings.length && totals.cash === 0) {
      el.chartEmpty.textContent = '添加资产后，这里会记录走势';
    } else if (!state.portfolio.holdings.some((item) => item.kind === 'stock')) {
      el.chartEmpty.textContent = '场外基金按最新净值，无盘中波动';
    } else {
      el.chartEmpty.textContent = '正在记录今日走势…';
    }
  }

  el.chartDate.textContent = totals.latest === todayStr() ? '今日' : dateStamp(totals.latest);
  el.chartBaseline.textContent = '基准 ' + compactMoney(totals.prevTotal);

  const labels = pixels.length
    ? [pixels[0].t, pixels[Math.floor((pixels.length - 1) / 2)]?.t || '', pixels[pixels.length - 1].t]
    : ['09:30', '11:30', '15:00'];
  el.chartAxis.innerHTML = labels.map((label) => `<span>${escapeHTML(label)}</span>`).join('');
}

function hideChartTip() {
  el.chartTip.hidden = true;
  const crosshair = document.getElementById('chartCrosshair');
  const dot = document.getElementById('chartHoverDot');
  if (crosshair) crosshair.style.display = 'none';
  if (dot) dot.style.display = 'none';
}

function handleChartPointer(event) {
  const chart = state.currentChart;
  if (!chart || chart.pixels.length < 2) return;
  const rect = el.chartWrap.getBoundingClientRect();
  const x = clamp(event.clientX - rect.left, 0, rect.width);
  const ratio = clamp((x - chart.left) / (chart.right - chart.left), 0, 1);
  const index = Math.round(ratio * (chart.pixels.length - 1));
  const point = chart.pixels[index];
  if (!point) return;

  const crosshair = document.getElementById('chartCrosshair');
  const dot = document.getElementById('chartHoverDot');
  if (crosshair) {
    crosshair.setAttribute('x1', point.x.toFixed(2));
    crosshair.setAttribute('x2', point.x.toFixed(2));
    crosshair.style.display = '';
  }
  if (dot) {
    dot.setAttribute('cx', point.x.toFixed(2));
    dot.setAttribute('cy', point.y.toFixed(2));
    dot.style.display = '';
  }

  el.chartTip.innerHTML = `<b>${escapeHTML(money(point.v))}</b>${escapeHTML(point.t)}`;
  el.chartTip.hidden = false;
  const tipWidth = el.chartTip.offsetWidth || 90;
  const relativeX = point.x + (el.chartWrap.clientWidth - chart.width);
  const left = clamp(relativeX, tipWidth / 2 + 4, el.chartWrap.clientWidth - tipWidth / 2 - 4);
  el.chartTip.style.left = left + 'px';
  el.chartTip.style.top = point.y + 'px';
}

/* ------------------------------ Rendering: allocation & holdings ------------------------------ */

function renderAllocation(totals) {
  const items = [
    { key: 'stock', label: '股票 / ETF', value: totals.stock, color: COLORS.stock },
    { key: 'fund', label: '场外基金', value: totals.fund, color: COLORS.fund },
    { key: 'cash', label: '现金', value: totals.cash, color: COLORS.cash },
  ];
  const total = totals.total || 1;

  el.allocBar.innerHTML = items
    .filter((item) => item.value > 0)
    .map((item) => {
      const percent = (item.value / total) * 100;
      return `<span class="alloc-seg" style="width:${percent.toFixed(3)}%;--c:${item.color}"></span>`;
    })
    .join('');

  el.allocLegend.innerHTML = items.map((item) => {
    const percent = totals.total > 0 ? (item.value / totals.total) * 100 : 0;
    return `<div class="alloc-item" style="--c:${item.color}">
      <span class="ai-top"><i class="ai-dot"></i>${escapeHTML(item.label)}</span>
      <b>${percent.toFixed(1)}%</b>
      <small>${escapeHTML(money(item.value, 0))}</small>
    </div>`;
  }).join('');

  el.allocTotal.textContent = money(totals.total, 0);
}

function holdingDetail(item, quote, marketValue, weight, totals) {
  const isFund = item.kind === 'fund';
  const today = quote && quote.date === totals.latest && Number.isFinite(quote.prevClose)
    ? (quote.price - quote.prevClose) * item.qty
    : null;
  const pnl = item.cost > 0 && quote ? (quote.price - item.cost) * item.qty : null;
  const todayText = today === null ? '—' : signedMoney(today);
  const pnlText = pnl === null ? '未填成本' : signedMoney(pnl);
  const todayTone = today === null ? '' : toneClass(today);
  const pnlTone = pnl === null ? '' : toneClass(pnl);

  return `<div class="h-detail"><div><div class="detail-inner">
    <div><span>持仓市值</span><b>${escapeHTML(money(marketValue))}</b></div>
    <div><span>${isFund ? '该净值日盈亏' : '今日盈亏'}</span><b class="${todayTone}">${escapeHTML(todayText)}</b></div>
    <div><span>累计盈亏</span><b class="${pnlTone}">${escapeHTML(pnlText)}</b></div>
    <div><span>占总资产</span><b>${weight.toFixed(2)}%</b></div>
  </div></div></div>`;
}

function holdingRow(item, totals) {
  const quote = state.quotes[qkey(item.kind, item.code)];
  const isFund = item.kind === 'fund';
  const marketValue = quote ? quote.price * item.qty : null;
  const weight = marketValue !== null && totals.total > 0 ? (marketValue / totals.total) * 100 : 0;
  const expanded = state.expanded.has(item.id);
  const name = item.name || quote?.name || item.code;
  const codeLine = isFund ? '场外基金' : stockMarket(item.code);
  const badgeText = isFund
    ? `净值 ${dateStamp(quote?.date || '')}`
    : (isETF(item.code) ? 'ETF' : '股票');
  const badgeClass = isFund && quote?.date && quote.date !== totals.latest && dateDifferenceDays(quote.date) > 7 ? 'badge warn' : 'badge';
  const pct = quote ? Number(quote.pct) : NaN;
  const price = quote ? priceText(quote) : '—';
  const changeText = quote ? pctText(pct) : '行情缺失';
  const tone = quote ? toneClass(pct) : 'flat';
  const costText = item.cost > 0 ? money(item.cost, isFund ? 4 : 2) : '未填成本';
  const unit = isFund ? '份' : '股';

  return `<article class="holding ${expanded ? 'open' : ''} ${quote ? '' : 'missing'}"
      data-id="${escapeHTML(item.id)}" tabindex="0" role="button" aria-expanded="${expanded}">
    <div class="h-top">
      <div class="h-id">
        <span class="h-name">${escapeHTML(name)}</span>
        <span class="h-code">${escapeHTML(item.code)} · ${escapeHTML(codeLine)}<span class="${badgeClass}">${escapeHTML(badgeText)}</span></span>
      </div>
      <div class="h-val">
        <span class="h-price">${escapeHTML(price)}</span>
        <span class="h-chg ${tone}">${escapeHTML(changeText)}</span>
      </div>
    </div>
    <div class="h-bottom">
      <span class="h-qty">${escapeHTML(qtyText(item.qty))} ${unit} · 成本 ${escapeHTML(costText)}</span>
      <span class="h-mv">${escapeHTML(marketValue === null ? '—' : money(marketValue))}</span>
    </div>
    <div class="h-bar"><i style="width:${Math.max(0, Math.min(100, weight)).toFixed(2)}%"></i></div>
    ${holdingDetail(item, quote, marketValue, weight, totals)}
  </article>`;
}

function cashRow(item, totals) {
  const weight = totals.total > 0 ? (item.amount / totals.total) * 100 : 0;
  return `<article class="holding no-expand" data-id="${escapeHTML(item.id)}">
    <div class="h-top">
      <div class="h-id">
        <span class="h-name">${escapeHTML(item.name || '现金')}</span>
        <span class="h-code">现金 / 存款</span>
      </div>
      <div class="h-val">
        <span class="h-price">${escapeHTML(money(item.amount))}</span>
        <span class="h-chg flat">计入总资产</span>
      </div>
    </div>
    <div class="h-bottom">
      <span class="h-qty">无行情波动</span>
      <span class="h-mv">${weight.toFixed(2)}% 仓位</span>
    </div>
    <div class="h-bar"><i style="width:${Math.max(0, Math.min(100, weight)).toFixed(2)}%"></i></div>
  </article>`;
}

function dateDifferenceDays(dateString) {
  const then = new Date(dateString + 'T00:00:00+08:00').getTime();
  const now = new Date(todayStr() + 'T00:00:00+08:00').getTime();
  return Math.round((now - then) / (24 * 60 * 60 * 1000));
}

function renderHoldings(totals) {
  const stocks = state.portfolio.holdings
    .filter((item) => item.kind === 'stock')
    .sort((a, b) => {
      const qa = state.quotes[qkey('stock', a.code)];
      const qb = state.quotes[qkey('stock', b.code)];
      return ((qb?.price || 0) * b.qty) - ((qa?.price || 0) * a.qty);
    });
  const funds = state.portfolio.holdings
    .filter((item) => item.kind === 'fund')
    .sort((a, b) => {
      const qa = state.quotes[qkey('fund', a.code)];
      const qb = state.quotes[qkey('fund', b.code)];
      return ((qb?.price || 0) * b.qty) - ((qa?.price || 0) * a.qty);
    });
  const cash = state.portfolio.cash;

  const stockValue = stocks.reduce((sum, item) => {
    const quote = state.quotes[qkey('stock', item.code)];
    return sum + (quote ? quote.price * item.qty : 0);
  }, 0);
  const fundValue = funds.reduce((sum, item) => {
    const quote = state.quotes[qkey('fund', item.code)];
    return sum + (quote ? quote.price * item.qty : 0);
  }, 0);

  const parts = [];
  if (stocks.length) {
    parts.push(`<div class="group">
      <div class="group-head"><span>股票 / 场内 ETF</span><span class="group-val">${escapeHTML(money(stockValue))}</span></div>
      ${stocks.map((item) => holdingRow(item, totals)).join('')}
    </div>`);
  }
  if (funds.length) {
    parts.push(`<div class="group">
      <div class="group-head"><span>场外基金</span><span class="group-val">${escapeHTML(money(fundValue))}</span></div>
      ${funds.map((item) => holdingRow(item, totals)).join('')}
    </div>`);
  }
  if (cash.length) {
    const cashValue = cash.reduce((sum, item) => sum + item.amount, 0);
    parts.push(`<div class="group">
      <div class="group-head"><span>现金 / 存款</span><span class="group-val">${escapeHTML(money(cashValue))}</span></div>
      ${cash.map((item) => cashRow(item, totals)).join('')}
    </div>`);
  }

  el.holdingGroups.innerHTML = parts.join('');
  el.emptyHoldings.hidden = parts.length > 0;
  const count = state.portfolio.holdings.length + cash.length;
  el.holdingCount.textContent = `${count} 项资产`;
}

/* ------------------------------ Banners ------------------------------ */

function renderBanners() {
  el.demoBanner.hidden = !state.portfolio.demo;
  const offline = !navigator.onLine || state.networkError || Boolean(state.lastError);
  el.offlineBanner.hidden = !offline;
  if (!offline) return;

  if (!navigator.onLine) {
    el.offlineText.textContent = '当前离线，显示上次行情';
  } else if (state.networkError) {
    el.offlineText.textContent = state.quotesAt
      ? `行情连接失败，显示 ${dateTimeLabel(state.quotesAt)} 的数据`
      : '行情连接失败，请检查网络';
  } else {
    el.offlineText.textContent = state.lastError || '部分行情未更新';
  }
}

function renderAll() {
  const totals = computeTotals();
  state.currentTotals = totals;
  renderHero(totals);
  renderChart(totals);
  renderAllocation(totals);
  renderHoldings(totals);
  renderBanners();
  if (el.editorModal.classList.contains('open')) renderEditor();
  if (el.settingsModal.classList.contains('open')) updateSettingsUI();
}

/* ------------------------------ Editor ------------------------------ */

function trashIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.8h6V7M6.5 7l1 12.2h9L17.5 7M10 11v5M14 11v5"/></svg>`;
}

function editRowHTML(item, valueText, metaText, kind) {
  return `<div class="edit-row" data-edit-id="${escapeHTML(item.id)}" data-edit-kind="${kind}" role="button" tabindex="0">
    <div class="er-main">
      <span class="er-name">${escapeHTML(item.name || item.code)}</span>
      <span class="er-meta">${escapeHTML(metaText)}</span>
    </div>
    <span class="er-val">${escapeHTML(valueText)}</span>
    <button class="er-del" type="button" data-del-id="${escapeHTML(item.id)}" data-del-kind="${kind}" aria-label="删除 ${escapeHTML(item.name || '资产')}">${trashIcon()}</button>
  </div>`;
}

function renderEditor() {
  const totals = state.currentTotals || computeTotals();
  el.editorTotal.textContent = money(totals.total) + (totals.partial ? '*' : '');
  el.editorTotal.className = 'money';
  el.editorCount.textContent = `${state.portfolio.holdings.length + state.portfolio.cash.length} 项`;

  const stocks = state.portfolio.holdings
    .filter((item) => item.kind === 'stock')
    .sort((a, b) => {
      const qa = state.quotes[qkey('stock', a.code)];
      const qb = state.quotes[qkey('stock', b.code)];
      return ((qb?.price || 0) * b.qty) - ((qa?.price || 0) * a.qty);
    });
  const funds = state.portfolio.holdings
    .filter((item) => item.kind === 'fund')
    .sort((a, b) => {
      const qa = state.quotes[qkey('fund', a.code)];
      const qb = state.quotes[qkey('fund', b.code)];
      return ((qb?.price || 0) * b.qty) - ((qa?.price || 0) * a.qty);
    });
  const cash = state.portfolio.cash;

  const section = (title, kind, rows, emptyText) => `<div class="edit-group">
    <div class="edit-group-head">
      <h3>${escapeHTML(title)}</h3>
      <button type="button" data-add-kind="${kind}">＋ 添加</button>
    </div>
    ${rows.length ? rows.join('') : `<div class="edit-empty">${escapeHTML(emptyText)}</div>`}
  </div>`;

  const stockRows = stocks.map((item) => {
    const quote = state.quotes[qkey('stock', item.code)];
    const value = quote ? money(quote.price * item.qty) : '—';
    const meta = `${item.code} · ${qtyText(item.qty)} 股 · 成本 ${item.cost > 0 ? money(item.cost) : '未填'}`;
    return editRowHTML(item, value, meta, 'stock');
  });

  const fundRows = funds.map((item) => {
    const quote = state.quotes[qkey('fund', item.code)];
    const value = quote ? money(quote.price * item.qty) : '—';
    const meta = `${item.code} · ${qtyText(item.qty)} 份 · 成本 ${item.cost > 0 ? money(item.cost, 4) : '未填'}`;
    return editRowHTML(item, value, meta, 'fund');
  });

  const cashRows = cash.map((item) => editRowHTML(item, money(item.amount), '现金 / 存款', 'cash'));

  el.editorBody.innerHTML = [
    section('股票 / 场内 ETF', 'stock', stockRows, '还没有股票，点右上角添加'),
    section('场外基金', 'fund', fundRows, '还没有基金，点右上角添加'),
    section('现金 / 存款', 'cash', cashRows, '还没有现金账户'),
  ].join('');
}

/* ------------------------------ Modals ------------------------------ */

function syncBodyLock() {
  const open = document.querySelector('.modal.open');
  document.body.style.overflow = open ? 'hidden' : '';
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  if (id === 'formModal' && state.form?.lookupTimer) {
    clearTimeout(state.form.lookupTimer);
  }
  if (id === 'aiModal') {
    state.ai.runId += 1;
    state.ai.cancelled = true;
    if (state.ai.abort) state.ai.abort.abort();
    releaseAIFiles();
    resetAIFlow();
    state.ai.cancelled = true;
  }
  setTimeout(syncBodyLock, 20);
}

function openEditor() {
  renderEditor();
  openModal('editorModal');
  requestAnimationFrame(() => {
    el.editorBody.scrollTop = 0;
  });
}

function openAddChooser() {
  openModal('addModal');
}

/* ------------------------------ Form ------------------------------ */

function fieldHTML({ id, label, hint, unit, value, placeholder, mode = 'decimal', code = false, maxlength = 24 }) {
  return `<div class="field">
    <label for="${id}"><span>${escapeHTML(label)}</span></label>
    <div class="input-wrap ${code ? 'code' : ''}">
      <input id="${id}" name="${id}" inputmode="${mode}" ${code ? 'maxlength="6" autocomplete="off" spellcheck="false"' : `maxlength="${maxlength}"`} placeholder="${escapeHTML(placeholder || '')}" value="${escapeHTML(value ?? '')}">
      ${unit ? `<span class="unit">${escapeHTML(unit)}</span>` : ''}
    </div>
    ${hint ? `<p class="hint">${escapeHTML(hint)}</p>` : ''}
  </div>`;
}

function openForm(kind, id = null) {
  const existing = id
    ? (kind === 'cash'
      ? state.portfolio.cash.find((item) => item.id === id)
      : state.portfolio.holdings.find((item) => item.id === id))
    : null;

  state.form = {
    kind,
    id,
    quote: null,
    quoteCode: '',
    autoName: existing?.name || '',
    lookupSeq: 0,
    lookupTimer: null,
  };

  const titles = { stock: '股票 / 场内 ETF', fund: '场外基金', cash: '现金 / 存款' };
  el.formKicker.textContent = existing ? 'EDIT ASSET' : 'NEW ASSET';
  el.formTitle.textContent = (existing ? '编辑' : '添加') + titles[kind];
  el.formError.hidden = true;
  el.formError.textContent = '';
  el.deleteAssetBtn.hidden = !existing;
  el.lookupCard.hidden = true;
  el.lookupCard.classList.remove('bad');
  el.lookupName.textContent = existing?.name || '—';
  el.lookupMeta.textContent = existing?.code || '—';

  if (kind === 'cash') {
    el.lookupCard.hidden = true;
    el.formFields.innerHTML = [
      fieldHTML({
        id: 'fName', label: '名称', value: existing?.name || '', placeholder: '现金 / 活期 / 余额宝',
        maxlength: 30,
      }),
      fieldHTML({
        id: 'fAmount', label: '金额', unit: '元', value: existing?.amount ?? '', placeholder: '0.00',
      }),
    ].join('');
    el.formNote.textContent = '现金按填写的金额计入总资产，不抓取行情。';
  } else {
    const isFund = kind === 'fund';
    el.lookupCard.hidden = !existing;
    el.formFields.innerHTML = [
      fieldHTML({
        id: 'fCode', label: isFund ? '基金代码' : '证券代码', code: true, mode: 'numeric',
        value: existing?.code || '', placeholder: isFund ? '例如 005827' : '例如 600519',
        hint: '输入 6 位代码后自动查询名称与最新价',
      }),
      fieldHTML({
        id: 'fName', label: '名称', value: existing?.name || '', placeholder: '查询后自动填入',
        hint: '可以改成你熟悉的称呼',
      }),
      `<div class="field-row">
        ${fieldHTML({
          id: 'fQty', label: isFund ? '持有份额' : '持有数量', unit: isFund ? '份' : '股',
          value: existing?.qty ?? '', placeholder: isFund ? '50000' : '100',
        })}
        ${fieldHTML({
          id: 'fCost', label: isFund ? '成本净值' : '成本价', unit: isFund ? '元/份' : '元/股',
          value: existing?.cost ?? '', placeholder: isFund ? '2.0500' : '1450.00',
        })}
      </div>`,
    ].join('');
    el.formNote.textContent = isFund
      ? '场外基金按基金公司最新公布的净值计算，每交易日更新一次；不是实时估值。成本净值可留空。'
      : '成本价用于计算累计盈亏，可留空。行情来自腾讯证券公开接口。';
  }

  openModal('formModal');

  requestAnimationFrame(() => {
    const first = kind === 'cash' ? document.getElementById('fName') : document.getElementById('fCode');
    first?.focus({ preventScroll: true });
    if (existing && kind !== 'cash') {
      const code = existing.code;
      const cached = state.quotes[qkey(kind, code)];
      if (cached) applyLookup(cached, true);
      const input = document.getElementById('fCode');
      if (input) input.value = code;
      triggerLookup(code);
    }
  });

  if (kind !== 'cash') {
    const codeInput = document.getElementById('fCode');
    codeInput?.addEventListener('input', () => {
      const cleaned = codeInput.value.replace(/\D/g, '').slice(0, 6);
      if (codeInput.value !== cleaned) codeInput.value = cleaned;
      state.form.quote = null;
      state.form.quoteCode = '';
      hideLookup();
      if (cleaned.length === 6) {
        clearTimeout(state.form.lookupTimer);
        state.form.lookupTimer = setTimeout(() => triggerLookup(cleaned), 320);
      }
    });
    codeInput?.addEventListener('blur', () => {
      const code = codeInput.value.replace(/\D/g, '');
      if (code.length === 6 && state.form.quoteCode !== code) triggerLookup(code);
    });
  }
}

function hideLookup() {
  el.lookupCard.hidden = true;
  el.lookupCard.classList.remove('bad');
}

function applyLookup(quote, fromCache = false) {
  if (!state.form || !quote) return;
  state.form.quote = quote;
  state.form.quoteCode = quote.code;
  el.lookupCard.hidden = false;
  el.lookupCard.classList.remove('bad');
  el.lookupName.textContent = quote.name;
  if (quote.kind === 'fund') {
    el.lookupMeta.textContent = `${fromCache ? '上次 · ' : ''}净值 ${money(quote.price, 4)} · ${quote.date || '—'}`;
  } else {
    el.lookupMeta.textContent = `${fromCache ? '上次 · ' : ''}现价 ${priceText(quote)} · ${dateStamp(quote.date)} ${quote.time ? quote.time.slice(0, 5) : ''}`;
  }
  const nameInput = document.getElementById('fName');
  if (nameInput) {
    const current = nameInput.value.trim();
    if (!current || current === state.form.autoName) {
      nameInput.value = quote.name;
      state.form.autoName = quote.name;
    }
  }
}

async function triggerLookup(code) {
  if (!state.form || state.form.kind === 'cash') return;
  if (!/^\d{6}$/.test(code)) return;

  const seq = ++state.form.lookupSeq;
  el.lookupCard.hidden = false;
  el.lookupCard.classList.remove('bad');
  el.lookupName.textContent = '正在查询…';
  el.lookupMeta.textContent = code;

  try {
    const id = state.form.kind === 'fund' ? fundId(code) : stockId(code);
    const map = await fetchTencent([id]);
    if (!state.form || seq !== state.form.lookupSeq) return;
    const quote = map[qkey(state.form.kind, code)];
    if (!quote) {
      throw new Error('not-found');
    }
    if (quote.kind === 'fund' && (!quote.price || !quote.date)) {
      throw new Error('money-fund');
    }
    applyLookup(quote);
  } catch (err) {
    if (!state.form || seq !== state.form.lookupSeq) return;
    const cached = state.quotes[qkey(state.form.kind, code)];
    el.lookupCard.hidden = false;
    if (cached) {
      state.form.quote = cached;
      state.form.quoteCode = code;
      el.lookupCard.classList.remove('bad');
      el.lookupName.textContent = cached.name;
      el.lookupMeta.textContent = '刷新失败，使用上次行情';
      return;
    }
    el.lookupCard.classList.add('bad');
    el.lookupName.textContent = state.form.kind === 'fund'
      ? '未查到该基金'
      : (err.message === 'money-fund' ? '暂不支持货币基金' : '未查到该代码');
    el.lookupMeta.textContent = state.form.kind === 'fund'
      ? '请检查代码；货币基金请按「现金」录入'
      : (err.message === 'money-fund' ? '请按「现金 / 存款」录入' : '请检查代码，或稍后再试');
    state.form.quote = null;
    state.form.quoteCode = '';
  }
}

function showFormError(message) {
  el.formError.textContent = message;
  el.formError.hidden = false;
}

async function handleAssetSubmit(event) {
  event.preventDefault();
  if (!state.form) return;
  el.formError.hidden = true;

  const { kind, id } = state.form;

  if (kind === 'cash') {
    const name = document.getElementById('fName').value.trim() || '现金';
    const amount = num(document.getElementById('fAmount').value);
    if (!Number.isFinite(amount) || amount < 0) {
      showFormError('请输入有效的现金金额。');
      return;
    }
    if (id) {
      const item = state.portfolio.cash.find((entry) => entry.id === id);
      if (item) {
        item.name = name;
        item.amount = amount;
      }
    } else {
      state.portfolio.cash.push({ id: uid(), name, amount });
    }
  } else {
    const codeInput = document.getElementById('fCode');
    const code = codeInput.value.replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) {
      showFormError('请输入 6 位数字代码。');
      return;
    }
    if (!state.form.quote || state.form.quote.code !== code) {
      await triggerLookup(code);
      if (!state.form.quote || state.form.quote.code !== code) {
        showFormError(el.lookupName.textContent === '暂不支持货币基金'
          ? '货币基金暂不支持实时净值，请按现金录入。'
          : '还没有查到该代码的行情，请检查代码或网络。');
        return;
      }
    }

    const qty = num(document.getElementById('fQty').value);
    const costRaw = document.getElementById('fCost').value.trim();
    const cost = costRaw === '' ? 0 : num(costRaw);
    if (!Number.isFinite(qty) || qty <= 0) {
      showFormError(kind === 'fund' ? '请输入有效的持有份额。' : '请输入有效的持有数量。');
      return;
    }
    if (!Number.isFinite(cost) || cost < 0) {
      showFormError('成本价需要是 0 或正数，也可以留空。');
      return;
    }

    const nameInput = document.getElementById('fName');
    const name = nameInput.value.trim() || state.form.quote.name;
    const item = {
      id: id || uid(),
      kind,
      code,
      name,
      qty,
      cost: Number.isFinite(cost) ? cost : 0,
    };

    if (id) {
      const index = state.portfolio.holdings.findIndex((entry) => entry.id === id);
      if (index >= 0) state.portfolio.holdings[index] = item;
    } else {
      state.portfolio.holdings.push(item);
    }
  }

  state.portfolio.demo = false;
  savePortfolio();
  state.history = [];
  saveHistory();
  state.expanded.delete(id || '');
  closeModal('formModal');
  renderAll();
  if (el.editorModal.classList.contains('open')) renderEditor();
  toast(id ? '已更新' : '已添加');
  refreshAll(false);
}

function deleteAsset(kind, id) {
  const source = kind === 'cash'
    ? state.portfolio.cash.find((item) => item.id === id)
    : state.portfolio.holdings.find((item) => item.id === id);
  if (!source) return;
  const label = source.name || source.code || '这笔资产';
  if (!window.confirm(`确定删除「${label}」吗？`)) return;

  if (kind === 'cash') {
    state.portfolio.cash = state.portfolio.cash.filter((item) => item.id !== id);
  } else {
    state.portfolio.holdings = state.portfolio.holdings.filter((item) => item.id !== id);
  }
  state.portfolio.demo = false;
  state.expanded.delete(id);
  savePortfolio();
  state.history = [];
  saveHistory();
  closeModal('formModal');
  renderAll();
  if (el.editorModal.classList.contains('open')) renderEditor();
  toast('已删除');
  refreshAll(false);
}

/* ------------------------------ Batch import ------------------------------ */

function openBatch() {
  el.batchInput.value = '';
  el.batchError.hidden = true;
  el.batchError.textContent = '';
  el.batchSaveBtn.disabled = false;
  el.batchSaveBtn.textContent = '导入';
  openModal('batchModal');
  setTimeout(() => el.batchInput.focus(), 250);
}

function parseBatchLine(line) {
  const parts = line.trim().split(/[\s,，\t]+/).filter(Boolean);
  if (parts.length < 3) throw new Error('格式不完整');
  const kindRaw = parts[0].toLowerCase();
  const kindMap = {
    '股票': 'stock', '股': 'stock', 'stock': 'stock',
    '基金': 'fund', '基': 'fund', 'fund': 'fund',
    '现金': 'cash', '钱': 'cash', 'cash': 'cash',
  };
  const kind = kindMap[kindRaw];
  if (!kind) throw new Error('类型应为 股票 / 基金 / 现金');

  if (kind === 'cash') {
    const amount = num(parts[parts.length - 1]);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('现金金额无效');
    const name = parts.slice(1, -1).join(' ') || '现金';
    return { kind, name, amount };
  }

  const code = parts[1].replace(/\D/g, '');
  if (code.length !== 6) throw new Error('代码应为 6 位数字');
  const qty = num(parts[2]);
  const cost = num(parts[3] ?? 0);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('数量无效');
  if (!Number.isFinite(cost) || cost < 0) throw new Error('成本价无效');
  return { kind, code, qty, cost };
}

async function handleBatchImport() {
  const raw = el.batchInput.value.trim();
  if (!raw) {
    el.batchError.textContent = '先粘贴几行资产数据。';
    el.batchError.hidden = false;
    return;
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = [];
  const errors = [];

  lines.forEach((line, index) => {
    try {
      parsed.push({ ...parseBatchLine(line), line: index + 1 });
    } catch (err) {
      errors.push(`第 ${index + 1} 行：${err.message}`);
    }
  });

  if (errors.length) {
    el.batchError.textContent = errors.join('；');
    el.batchError.hidden = false;
    return;
  }

  el.batchSaveBtn.disabled = true;
  el.batchSaveBtn.textContent = '导入中…';

  try {
    const ids = parsed
      .filter((item) => item.kind !== 'cash')
      .map((item) => (item.kind === 'fund' ? fundId(item.code) : stockId(item.code)));
    const uniqueIds = Array.from(new Set(ids));
    const map = uniqueIds.length ? await fetchTencent(uniqueIds) : {};
    const missing = [];

    parsed.forEach((item) => {
      if (item.kind === 'cash') return;
      const quote = map[qkey(item.kind, item.code)];
      if (!quote) {
        missing.push(`第 ${item.line} 行：未查到 ${item.code} 的行情`);
      } else {
        item.quote = quote;
      }
    });

    if (missing.length) {
      el.batchError.textContent = missing.join('；');
      el.batchError.hidden = false;
      return;
    }

    parsed.forEach((item) => {
      if (item.kind === 'cash') {
        state.portfolio.cash.push({ id: uid(), name: item.name, amount: item.amount });
      } else {
        state.portfolio.holdings.push({
          id: uid(),
          kind: item.kind,
          code: item.code,
          name: item.quote.name,
          qty: item.qty,
          cost: item.cost,
        });
      }
    });

    state.portfolio.demo = false;
    savePortfolio();
    state.history = [];
    saveHistory();
    closeModal('batchModal');
    closeModal('addModal');
    renderAll();
    if (el.editorModal.classList.contains('open')) renderEditor();
    toast(`已导入 ${parsed.length} 项`);
    refreshAll(false);
  } catch (err) {
    el.batchError.textContent = '导入失败：' + (err.message || '请检查网络');
    el.batchError.hidden = false;
  } finally {
    el.batchSaveBtn.disabled = false;
    el.batchSaveBtn.textContent = '导入';
  }
}

/* ------------------------------ AI screenshot import ------------------------------ */

let aiSearchSeq = 0;
const aiSearchCache = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aiKeyConfigured() {
  return Boolean(state.aiConfig.apiKey);
}

function updateAISettingHint() {
  if (!el.aiSettingHint) return;
  el.aiSettingHint.textContent = aiKeyConfigured()
    ? `已配置 · ${state.aiConfig.model}`
    : '智谱 GLM-4V · 未配置 Key';
}

function saveAIConfig() {
  writeLS(LS.ai, state.aiConfig);
  updateAISettingHint();
}

function releaseAIFiles() {
  state.ai.files.forEach((file) => {
    try { URL.revokeObjectURL(file.url); } catch (err) { /* ignore */ }
  });
  state.ai.files = [];
}

function resetAIFlow() {
  state.ai.step = 'upload';
  state.ai.results = [];
  state.ai.warnings = [];
  state.ai.error = '';
  state.ai.busy = false;
  state.ai.progress = '';
  state.ai.progressPct = 0;
  state.ai.abort = null;
  state.ai.cancelled = false;
}

function openAIImport() {
  if (state.ai.abort) state.ai.abort.abort();
  state.ai.runId += 1;
  releaseAIFiles();
  resetAIFlow();
  state.ai.mode = 'merge';
  state.ai.editingKey = false;
  renderAIModal();
  openModal('aiModal');
  setTimeout(() => {
    if (!aiKeyConfigured()) document.getElementById('aiKeyInput')?.focus({ preventScroll: true });
  }, 350);
}

function aiUploadHTML() {
  const thumbs = state.ai.files.map((file, index) => `<div class="ai-thumb">
    <img src="${file.url}" alt="持仓截图 ${index + 1}">
    <span class="ai-thumb-index">${index + 1}</span>
    <button type="button" class="ai-thumb-del" data-ai-action="remove" data-ai-id="${escapeHTML(file.id)}" aria-label="移除截图">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>`).join('');

  const configured = aiKeyConfigured();
  const showKeyForm = !configured || state.ai.editingKey;
  const keyStatus = configured
    ? '<span class="ai-status ok">已配置</span>'
    : '<span class="ai-status">未配置</span>';
  const modelOptions = AI_MODELS.map((item) => `<option value="${item.id}" ${item.id === state.aiConfig.model ? 'selected' : ''}>${escapeHTML(item.label)}</option>`).join('');
  const currentModel = AI_MODELS.find((item) => item.id === state.aiConfig.model) || AI_MODELS[0];
  const error = state.ai.error ? `<div class="form-error">${escapeHTML(state.ai.error)}</div>` : '';

  const keyBlock = showKeyForm ? `<div class="ai-config-card">
    <div class="ai-config-head"><span>智谱 GLM-4V</span>${keyStatus}</div>
    <div class="field">
      <label for="aiKeyInput"><span>API Key</span><a class="ai-link" href="https://bigmodel.cn/usercenter/proj-mgmt/apikeys" target="_blank" rel="noopener">获取 Key →</a></label>
      <div class="input-wrap"><input id="aiKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${configured ? '已保存，留空不修改' : '粘贴智谱 API Key'}"></div>
    </div>
    <div class="field">
      <label for="aiModelSelect"><span>识别模型</span><small>${escapeHTML(currentModel.note)}</small></label>
      <select class="ai-select" id="aiModelSelect">${modelOptions}</select>
    </div>
    <div class="ai-key-actions">
      <button class="btn tiny ghost" type="button" data-ai-action="save-config">保存配置</button>
      ${configured ? '<button class="ai-clear" type="button" data-ai-action="clear-key">清除 Key</button>' : ''}
    </div>
    <p class="ai-note">Key 只保存在本机浏览器，不上传；截图会发送给智谱，不经过其他服务器。识别可能有误，务必核对后再导入。</p>
    ${error}
  </div>` : `<div class="ai-key-mini">
    <span class="ai-status ok">已配置</span>
    <span>智谱 · ${escapeHTML(currentModel.label)}</span>
    <button type="button" data-ai-action="edit-key">更换</button>
  </div>${error}`;

  return `<div class="ai-intro">
    <p>上传券商或基金 App 的持仓截图，AI 会提取名称、代码、数量和成本。识别后先核对，再导入账本。</p>
    <span class="ai-privacy">截图只发送给智谱 · 识别结果先校对</span>
  </div>
  ${keyBlock}
  <div class="ai-drop" id="aiDrop">
    <input type="file" id="aiFileInput" accept="image/png,image/jpeg,image/webp" multiple hidden>
    <span class="ai-drop-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M9 12h6M12 9v6"/></svg></span>
    <b>点此选择持仓截图</b>
    <small>支持 JPG / PNG / WEBP，最多 6 张</small>
    <button class="btn small ghost" type="button" data-ai-action="pick">选择图片</button>
  </div>
  ${thumbs ? `<div class="ai-thumbs">${thumbs}</div>` : ''}`;
}

function renderAIModal() {
  if (state.ai.cancelled) return;
  if (state.ai.step === 'recognizing') {
    el.aiBody.innerHTML = `<div class="ai-progress">
      <div class="ai-spinner"></div>
      <h3>正在识别持仓</h3>
      <p>${escapeHTML(state.ai.progress || '准备中…')}</p>
      <div class="ai-progress-bar"><i style="width:${clamp(state.ai.progressPct, 0, 100)}%"></i></div>
    </div>`;
    el.aiFoot.innerHTML = '<button class="btn ghost" type="button" data-ai-action="cancel">取消</button>';
    return;
  }

  if (state.ai.step === 'error') {
    el.aiBody.innerHTML = `<div class="ai-error-card">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 16.5v.1"/><path d="M10.3 4.6 2.8 18a1.5 1.5 0 0 0 1.3 2.2h15.8a1.5 1.5 0 0 0 1.3-2.2L13.7 4.6a1.5 1.5 0 0 0-2.6 0Z"/></svg>
      <h3>识别没有完成</h3>
      <p>${escapeHTML(state.ai.error || '请稍后重试。')}</p>
    </div>`;
    el.aiFoot.innerHTML = `<button class="btn ghost" type="button" data-ai-action="back">返回</button>
      <button class="btn primary grow" type="button" data-ai-action="retry">重试</button>`;
    return;
  }

  if (state.ai.step === 'review') {
    renderAIReview();
    return;
  }

  el.aiBody.innerHTML = aiUploadHTML();
  el.aiFoot.innerHTML = `<button class="btn ghost" type="button" data-ai-action="cancel">取消</button>
    <button class="btn primary grow" type="button" data-ai-action="start" ${state.ai.files.length ? '' : 'disabled'}>开始识别${state.ai.files.length ? `（${state.ai.files.length} 张）` : ''}</button>`;
}

function aiItemStatusText(item) {
  if (item.status === 'ready') return '可导入';
  return item.error || '待补全';
}

function aiRowHTML(item) {
  const kindLabel = item.kind === 'cash' ? '现金' : item.kind === 'fund' ? '基金' : '股票';
  const kindOptions = [
    ['stock', '股票 / ETF'],
    ['fund', '场外基金'],
    ['cash', '现金'],
  ].map(([value, label]) => `<option value="${value}" ${item.kind === value ? 'selected' : ''}>${label}</option>`).join('');
  const confidence = Math.round((Number(item.confidence) || 0) * 100);
  const selected = Boolean(item.selected);
  const isCash = item.kind === 'cash';
  const fields = isCash
    ? `<div class="ai-row-fields">
        <label>金额（元）<input data-field="marketValue" inputmode="decimal" value="${escapeHTML(item.marketValue ?? '')}" placeholder="0.00"></label>
        <label>识别置信度<input value="${confidence}%" readonly></label>
      </div>`
    : `<div class="ai-row-fields">
        <label>代码<input data-field="code" inputmode="numeric" maxlength="6" value="${escapeHTML(item.code || '')}" placeholder="6 位代码"></label>
        <label>数量<input data-field="qty" inputmode="decimal" value="${escapeHTML(item.qty ?? '')}" placeholder="股 / 份"></label>
        <label>成本<input data-field="cost" inputmode="decimal" value="${escapeHTML(item.cost ?? '')}" placeholder="元"></label>
        <label>市值<input data-field="marketValue" inputmode="decimal" value="${escapeHTML(item.marketValue ?? '')}" placeholder="元"></label>
      </div>`;

  return `<div class="ai-row ${selected ? 'selected' : ''} ${item.status === 'ready' ? '' : 'needs'}" data-row-id="${escapeHTML(item.id)}">
    <div class="ai-row-head">
      <button class="ai-check ${selected ? 'on' : ''}" type="button" data-ai-toggle aria-label="${selected ? '取消选择' : '选择'}">✓</button>
      <select class="ai-kind" data-field="kind">${kindOptions}</select>
      <input class="ai-name" data-field="name" value="${escapeHTML(item.name || '')}" placeholder="名称" aria-label="资产名称">
      <span class="ai-conf ${confidence >= 80 ? '' : 'low'}">${confidence}%</span>
    </div>
    ${fields}
    <div class="ai-row-status ${item.status === 'ready' ? 'ready' : 'needs'}">${escapeHTML(aiItemStatusText(item))}</div>
  </div>`;
}

function updateAIImportButton() {
  const button = el.aiFoot.querySelector('[data-ai-action="import"]');
  if (!button) return;
  const selected = state.ai.results.filter((item) => item.selected && item.status === 'ready').length;
  button.textContent = `导入 ${selected} 项`;
  button.disabled = selected === 0;
}

function renderAIReview() {
  const results = state.ai.results;  results.forEach((item) => evaluateAIItem(item));
  const ready = results.filter((item) => item.status === 'ready').length;
  const selected = results.filter((item) => item.selected && item.status === 'ready').length;
  const warnings = state.ai.warnings;

  if (!results.length) {
    el.aiBody.innerHTML = `<div class="ai-empty">没有识别到持仓。<br>换一张更清晰、包含代码或名称的截图试试。</div>`;
    el.aiFoot.innerHTML = `<button class="btn ghost" type="button" data-ai-action="back">返回</button>`;
    return;
  }

  el.aiBody.innerHTML = `<div class="ai-review-head">
    <div><b>识别到 ${results.length} 项</b><small>${ready} 项可导入 · ${results.length - ready} 项待补全</small></div>
    <div class="ai-head-actions">
      <button type="button" data-ai-action="select-ready">全选可导入</button>
      <button type="button" data-ai-action="add-row">＋ 手动</button>
    </div>
  </div>
  <div class="ai-mode">
    <span>导入方式</span>
    <div class="segmented mini" role="group" aria-label="AI 导入方式">
      <button type="button" data-ai-mode="merge" class="${state.ai.mode === 'merge' ? 'active' : ''}">合并同代码</button>
      <button type="button" data-ai-mode="replace" class="${state.ai.mode === 'replace' ? 'active' : ''}">清空后导入</button>
    </div>
  </div>
  ${state.ai.error ? `<div class="form-error">${escapeHTML(state.ai.error)}</div>` : ''}
  <div class="ai-rows">${results.map(aiRowHTML).join('')}</div>
  ${warnings.length ? `<div class="ai-warnings"><b>需要留意</b>${warnings.slice(0, 8).map((warning) => `<p>· ${escapeHTML(warning)}</p>`).join('')}</div>` : ''}`;

  el.aiFoot.innerHTML = `<button class="btn ghost" type="button" data-ai-action="back">返回</button>
    <button class="btn primary grow" type="button" data-ai-action="import" ${selected ? '' : 'disabled'}>导入 ${selected} 项</button>`;
}

function rerenderAIKeepScroll() {
  const top = el.aiBody.scrollTop;
  renderAIModal();
  el.aiBody.scrollTop = top;
}

function addAIFiles(fileList) {
  const incoming = Array.from(fileList || []).filter((file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|heic)$/i.test(file.name || ''));  if (!incoming.length) {
    toast('请选择图片文件');
    return;
  }
  const remaining = 6 - state.ai.files.length;
  if (remaining <= 0) {
    toast('最多识别 6 张截图');
    return;
  }
  incoming.slice(0, remaining).forEach((file) => {
    if (file.size > 20 * 1024 * 1024) {
      toast(`${file.name} 超过 20MB，已跳过`);
      return;
    }
    state.ai.files.push({
      id: uid(),
      file,
      url: URL.createObjectURL(file),
    });
  });
  state.ai.error = '';
  renderAIModal();
}

function removeAIFile(id) {
  const index = state.ai.files.findIndex((file) => file.id === id);
  if (index < 0) return;
  try { URL.revokeObjectURL(state.ai.files[index].url); } catch (err) { /* ignore */ }
  state.ai.files.splice(index, 1);
  renderAIModal();
}

function saveAIConfigFromForm(showToast = true) {
  const keyInput = document.getElementById('aiKeyInput');
  const modelSelect = document.getElementById('aiModelSelect');
  if (keyInput) {
    const key = keyInput.value.trim().replace(/^Bearer\s+/i, '');
    if (key) state.aiConfig.apiKey = key;
  }
  if (modelSelect) state.aiConfig.model = modelSelect.value;
  if (!state.aiConfig.apiKey) {
    state.ai.error = '请先填写智谱 API Key。';
    renderAIModal();
    return false;
  }
  saveAIConfig();
  state.ai.editingKey = false;
  state.ai.error = '';
  if (showToast) {
    toast('AI 配置已保存');
    renderAIModal();
  }
  return true;
}

function prepareAIImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const maxSide = 2000;
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
        const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
        const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      } catch (err) {
        reject(new Error('图片处理失败，请换一张截图。'));
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片无法读取，请换成 JPG / PNG 截图。'));
    };
    image.decoding = 'async';
    image.src = url;
  });
}

function normalizeAIFloat(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).trim().replace(/[−–]/g, '-').replace(/,/g, '').replace(/[￥¥+\s]/g, '').replace(/[份股]/g, '');
  let multiplier = 1;
  if (/万元?$/.test(text)) {
    multiplier = 10000;
    text = text.replace(/万元?$/, '');
  } else if (/亿元?$/.test(text)) {
    multiplier = 100000000;
    text = text.replace(/亿元?$/, '');
  }
  const negative = /^\(.*\)$/.test(text);
  const number = parseFloat(text.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(number)) return null;
  return (negative ? -number : number) * multiplier;
}

function normalizeAICode(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length >= 6) return digits.slice(-6);
  if (digits.length > 0) return digits.padStart(6, '0');
  return '';
}

function normalizeAIKind(value, name = '', code = '') {
  const text = String(value ?? '').toLowerCase();
  if (/(cash|现金|活期|余额宝|货币)/.test(text)) return 'cash';
  if (/(fund|基金|场外|otc|联接)/.test(text)) return 'fund';
  if (/(stock|股票|a股|etf|lof|场内)/.test(text)) return 'stock';
  if (/余额宝|货币/.test(name)) return 'cash';
  if (/基金|联接/.test(name)) return 'fund';
  if (/^[15]/.test(code)) return 'stock';
  return 'stock';
}

function normalizeAIName(value) {
  return String(value || '').replace(/[\s·（）()\-—]/g, '').toLowerCase();
}

function normalizeAIItems(payload, sourceIndex) {
  const rawItems = Array.isArray(payload) ? payload : payload?.items;
  if (!Array.isArray(rawItems)) {
    throw new Error('AI 没有返回可识别的持仓列表，请重试或换用更清晰的截图。');
  }
  const items = [];
  rawItems.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return;
    const name = String(raw.name || raw.securityName || raw.fundName || '').trim();
    const code = normalizeAICode(raw.code || raw.securityCode || raw.fundCode || '');
    if (!name && !code) return;
    const kind = normalizeAIKind(raw.kind || raw.type, name, code);
    const qty = normalizeAIFloat(raw.qty ?? raw.quantity ?? raw.shares ?? raw.holdQty);
    const cost = normalizeAIFloat(raw.cost ?? raw.costPrice ?? raw.avgCost);
    const marketValue = normalizeAIFloat(raw.marketValue ?? raw.value ?? raw.amount ?? raw.holdAmount);
    const profit = normalizeAIFloat(raw.profit ?? raw.pnl ?? raw.gain);
    let confidence = normalizeAIFloat(raw.confidence);
    if (confidence === null) confidence = 0.75;
    if (confidence > 1) confidence /= 100;
    confidence = clamp(confidence, 0, 1);
    items.push({
      id: uid(),
      kind,
      code,
      name,
      qty,
      cost,
      marketValue,
      profit,
      confidence,
      quote: null,
      selected: true,
      status: '',
      error: '',
      source: sourceIndex,
    });
  });
  return items;
}

function dedupeAIItems(items, warnings) {
  const map = new Map();
  items.forEach((item) => {
    const key = item.kind === 'cash'
      ? 'cash:' + normalizeAIName(item.name)
      : item.code
        ? item.kind + ':' + item.code
        : item.kind + ':name:' + normalizeAIName(item.name);
    if (!map.has(key)) {
      map.set(key, item);
      return;
    }
    const existing = map.get(key);
    ['qty', 'cost', 'marketValue', 'profit', 'name', 'code'].forEach((field) => {
      if ((existing[field] === null || existing[field] === undefined || existing[field] === '') && item[field]) {
        existing[field] = item[field];
      }
    });
    existing.confidence = Math.max(existing.confidence, item.confidence);
    warnings.push(`「${existing.name || existing.code}」在多张截图中重复出现，已合并。`);
  });

  const byName = new Map();
  Array.from(map.values()).forEach((item) => {
    if (!item.name) {
      byName.set('id:' + item.id, item);
      return;
    }
    const key = item.kind + ':name:' + normalizeAIName(item.name);
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, item);
      return;
    }
    if (existing.code && item.code && existing.code !== item.code) {
      byName.set(key + ':' + item.code, item);
      return;
    }
    ['qty', 'cost', 'marketValue', 'profit', 'code'].forEach((field) => {
      if ((existing[field] === null || existing[field] === undefined || existing[field] === '') && item[field]) {
        existing[field] = item[field];
      }
    });
    existing.confidence = Math.max(existing.confidence, item.confidence);
    warnings.push(`「${item.name}」名称相同，已合并重复项。`);
  });

  return Array.from(byName.values());
}

function jsonpRequest(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const callback = '__sz_ai_' + (++aiSearchSeq) + '_' + Date.now();
    const script = document.createElement('script');
    let settled = false;
    const timer = setTimeout(() => cleanup(new Error('timeout')), timeout);
    function cleanup(error, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { delete window[callback]; } catch (err) { window[callback] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
      if (error) reject(error);
      else resolve(data);
    }
    window[callback] = (data) => cleanup(null, data);
    script.onerror = () => cleanup(new Error('jsonp-error'));
    script.async = true;
    script.src = url + '&cb=' + encodeURIComponent(callback);
    document.head.appendChild(script);
  });
}

async function searchSecurityByName(name, kind) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return null;
  const cacheKey = kind + ':' + normalizeAIName(cleanName);
  if (aiSearchCache.has(cacheKey)) return aiSearchCache.get(cacheKey);

  const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(cleanName)
    + '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10';
  try {
    const data = await jsonpRequest(url);
    const list = data?.QuotationCodeTable?.Data;
    if (!Array.isArray(list)) {
      aiSearchCache.set(cacheKey, null);
      return null;
    }
    const pool = list.filter((item) => /^\d{6}$/.test(String(item.Code || '')));
    let candidates;
    if (kind === 'fund') {
      candidates = pool.filter((item) => item.Classify === 'OTCFUND');
    } else {
      candidates = pool.filter((item) => item.Classify === 'AStock');
      if (!candidates.length) {
        candidates = pool.filter((item) => /^(5|1[5-8])/.test(String(item.Code || '')) && (item.Classify === 'Fund' || /ETF|LOF/.test(String(item.SecurityTypeName || ''))));
      }
    }
    const exact = candidates.find((item) => normalizeAIName(item.Name) === normalizeAIName(cleanName));
    const result = exact || candidates[0] || null;
    aiSearchCache.set(cacheKey, result);
    return result;
  } catch (err) {
    aiSearchCache.set(cacheKey, null);
    return null;
  }
}

async function resolveAIItems(items) {
  const warnings = [];
  for (const item of items) {
    if (item.kind === 'cash' || item.code || !item.name) continue;
    const found = await searchSecurityByName(item.name, item.kind);
    if (found) {
      item.code = normalizeAICode(found.Code);
      if (!item.name) item.name = found.Name;
      warnings.push(`按名称匹配「${item.name}」为 ${item.code}，请核对。`);
    } else {
      warnings.push(`未能自动匹配「${item.name}」的代码，请手动补充。`);
    }
  }

  const ids = Array.from(new Set(items
    .filter((item) => item.kind !== 'cash' && item.code)
    .map((item) => (item.kind === 'fund' ? fundId(item.code) : stockId(item.code)))));
  const quotes = ids.length ? await fetchTencent(ids) : {};

  items.forEach((item) => {
    if (item.kind === 'cash') {
      if (!item.marketValue && item.qty) item.marketValue = item.qty;
      evaluateAIItem(item);
      return;
    }

    if (!item.code) {
      item.status = 'needs';
      item.error = '缺少 6 位代码';
      item.selected = false;
      return;
    }

    const quote = quotes[qkey(item.kind, item.code)];
    if (!quote) {
      item.status = 'needs';
      item.error = '未查到该代码的行情，请核对';
      item.selected = false;
      return;
    }

    item.quote = quote;
    if (!item.name) item.name = quote.name;
    if (item.name && quote.name && normalizeAIName(item.name) !== normalizeAIName(quote.name)) {
      warnings.push(`代码 ${item.code} 对应「${quote.name}」，与截图名称「${item.name}」不一致，请核对。`);
    }
    if (!(normalizeAIFloat(item.qty) > 0) && normalizeAIFloat(item.marketValue) > 0) {
      item.qty = Number((normalizeAIFloat(item.marketValue) / quote.price).toFixed(2));
    }
    if (normalizeAIFloat(item.qty) > 0 && !(normalizeAIFloat(item.marketValue) > 0)) {
      item.marketValue = Number((normalizeAIFloat(item.qty) * quote.price).toFixed(2));
    }
    if (!(normalizeAIFloat(item.cost) > 0) && normalizeAIFloat(item.profit) !== null && normalizeAIFloat(item.qty) > 0) {
      const derivedCost = (normalizeAIFloat(item.marketValue) - normalizeAIFloat(item.profit)) / normalizeAIFloat(item.qty);
      if (derivedCost > 0) item.cost = Number(derivedCost.toFixed(4));
    }
    evaluateAIItem(item);
    if (item.status !== 'ready') item.selected = false;
  });

  return warnings;
}

function evaluateAIItem(item) {
  item.qty = normalizeAIFloat(item.qty);
  item.cost = normalizeAIFloat(item.cost);
  item.marketValue = normalizeAIFloat(item.marketValue);
  if (item.kind === 'cash') {
    const amount = normalizeAIFloat(item.marketValue ?? item.qty);
    item.marketValue = amount;
    if (!item.name) {
      item.status = 'needs';
      item.error = '缺少名称';
    } else if (!(amount > 0)) {
      item.status = 'needs';
      item.error = '缺少金额';
    } else {
      item.status = 'ready';
      item.error = '';
    }
    return;
  }
  if (!item.code || item.code.length !== 6) {
    item.status = 'needs';
    item.error = '缺少 6 位代码';
  } else if (!(item.qty > 0)) {
    item.status = 'needs';
    item.error = '缺少数量或市值';
  } else if (item.cost !== null && item.cost < 0) {
    item.status = 'needs';
    item.error = '成本不能为负数';
  } else {
    item.status = 'ready';
    item.error = '';
  }
}

function extractAIContent(json) {
  const message = json?.choices?.[0]?.message;
  let content = message?.content ?? '';
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  if (!content && message?.reasoning_content) content = message.reasoning_content;
  return String(content || '');
}

function parseAIJSON(content) {
  let text = String(content || '').trim();
  text = text.replace(/<\|[^>]*\|>/g, '');
  text = text.replace(/[“”]/g, '"');
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    text = text.slice(objectStart, objectEnd + 1);
  } else {
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) text = text.slice(arrayStart, arrayEnd + 1);
  }
  try {
    return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
  } catch (err) {
    throw new Error('AI 返回的内容不是有效 JSON，请重试，或在设置里换用 GLM-4.6V。');
  }
}

function zhipuErrorMessage(status, json, rawText) {
  const message = json?.error?.message || json?.message || String(rawText || '').slice(0, 180);
  if (status === 401 || status === 403) return 'API Key 无效或已过期，请在设置里重新填写智谱 Key。';
  if (status === 429) return '请求太频繁或额度不足，请稍后再试。';
  if (status === 400 && /model/i.test(message)) return '当前模型不可用，请在识别设置里换一个模型。';
  return `识别失败（${status}）：${message || '请检查网络和 Key 后重试。'}`;
}

function mockAIExtraction() {
  if (new URLSearchParams(location.search).get('aiMock') === 'search') {
    return {
      items: [
        { kind: 'fund', name: '易方达消费行业股票', qty: 10000, cost: 2.5, marketValue: 27850, confidence: 0.9 },
      ],
      warnings: ['当前为演示识别结果，未调用真实模型。'],
    };
  }
  return {
    items: [
      { kind: 'stock', code: '600519', name: '贵州茅台', qty: 100, cost: 1250, marketValue: 132900, confidence: 0.98 },
      { kind: 'fund', code: '005827', name: '易方达蓝筹精选混合', qty: 50000, cost: 1.3, marketValue: 70810, confidence: 0.94 },
      { kind: 'cash', name: '活期', marketValue: 186420, confidence: 0.99 },
    ],
    warnings: ['当前为演示识别结果，未调用真实模型。'],
  };
}

async function callZhipuVision(dataUrl, parentSignal) {
  const mock = new URLSearchParams(location.search).get('aiMock');
  if (mock) {
    await delay(650);
    return mockAIExtraction();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  const abortParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', abortParent, { once: true });
  }

  try {
    const body = {
      model: state.aiConfig.model,
      messages: [
        { role: 'system', content: '你是严谨的资产截图结构化助手，只输出 JSON。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: AI_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      stream: false,
    };

    const response = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + state.aiConfig.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let json = null;
    try { json = JSON.parse(rawText); } catch (err) { /* keep raw error text */ }
    if (!response.ok) {
      throw new Error(zhipuErrorMessage(response.status, json, rawText));
    }
    const content = extractAIContent(json);
    return parseAIJSON(content);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('识别请求超时，请重试或换用更小的截图。');
    throw err;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', abortParent);
  }
}

async function startAIRecognition() {
  if (state.ai.busy) return;
  if (!state.ai.files.length) {
    toast('先选择持仓截图');
    return;
  }
  if (!saveAIConfigFromForm(false)) {
    if (!state.ai.error) state.ai.error = '请先填写智谱 API Key。';
    renderAIModal();
    toast('请先填写智谱 API Key');
    document.getElementById('aiKeyInput')?.focus();
    return;
  }

  state.ai.cancelled = false;
  state.ai.busy = true;
  state.ai.step = 'recognizing';
  state.ai.error = '';
  state.ai.progress = '正在压缩截图…';
  state.ai.progressPct = 3;
  renderAIModal();

  const controller = new AbortController();
  state.ai.abort = controller;
  const runId = state.ai.runId;
  const files = state.ai.files.slice();

  try {
    const prepared = [];
    for (let index = 0; index < files.length; index += 1) {
      if (controller.signal.aborted || runId !== state.ai.runId) throw new Error('cancelled');
      state.ai.progress = `正在处理第 ${index + 1}/${files.length} 张截图…`;
      state.ai.progressPct = 4 + ((index + 1) / files.length) * 16;
      renderAIModal();
      prepared.push(await prepareAIImage(files[index].file));
    }

    let done = 0;
    const allItems = [];
    const warnings = [];
    await mapLimit(prepared, 2, async (dataUrl, index) => {
      if (controller.signal.aborted || runId !== state.ai.runId) throw new Error('cancelled');
      state.ai.progress = `AI 正在读取第 ${done + 1}/${prepared.length} 张截图…`;
      renderAIModal();
      const payload = await callZhipuVision(dataUrl, controller.signal);
      if (controller.signal.aborted || runId !== state.ai.runId) throw new Error('cancelled');
      allItems.push(...normalizeAIItems(payload, index + 1));
      if (Array.isArray(payload?.warnings)) {
        payload.warnings.forEach((warning) => {
          if (warning) warnings.push(String(warning));
        });
      }
      done += 1;
      state.ai.progressPct = 20 + (done / prepared.length) * 62;
      renderAIModal();
    });

    if (controller.signal.aborted || state.ai.cancelled || runId !== state.ai.runId) throw new Error('cancelled');
    state.ai.progress = '正在匹配代码与行情…';
    state.ai.progressPct = 88;
    renderAIModal();

    const items = dedupeAIItems(allItems, warnings);
    if (!items.length) {
      throw new Error('没有识别到持仓。请换一张更清晰、包含代码或名称的截图。');
    }
    const resolveWarnings = await resolveAIItems(items);
    if (controller.signal.aborted || state.ai.cancelled || runId !== state.ai.runId) throw new Error('cancelled');

    state.ai.results = items;
    state.ai.warnings = Array.from(new Set([...warnings, ...resolveWarnings])).slice(0, 10);
    state.ai.progressPct = 100;
    state.ai.busy = false;
    state.ai.step = 'review';
    renderAIModal();
  } catch (err) {
    if (runId !== state.ai.runId || state.ai.cancelled || err.message === 'cancelled') return;
    state.ai.busy = false;
    state.ai.step = 'error';
    state.ai.error = err.message || '识别失败，请检查网络后重试。';
    renderAIModal();
  } finally {
    if (runId === state.ai.runId) state.ai.abort = null;
  }
}

async function importAIResults() {
  const selected = state.ai.results.filter((item) => item.selected && item.status === 'ready');
  if (!selected.length) {
    toast('先选择要导入的资产');
    return;
  }
  state.ai.error = '';

  const ids = Array.from(new Set(selected
    .filter((item) => item.kind !== 'cash' && item.code)
    .map((item) => (item.kind === 'fund' ? fundId(item.code) : stockId(item.code)))));
  let quotes = {};
  try {
    quotes = ids.length ? await fetchTencent(ids) : {};
  } catch (err) {
    state.ai.error = '行情连接失败，请检查网络后重试导入。';
    renderAIModal();
    return;
  }
  const errors = [];
  const prepared = [];

  selected.forEach((item) => {
    if (item.kind === 'cash') {
      const amount = normalizeAIFloat(item.marketValue ?? item.qty);
      if (!item.name) errors.push('有一项现金缺少名称');
      else if (!(amount > 0)) errors.push(`「${item.name}」缺少金额`);
      else prepared.push({ kind: 'cash', name: item.name, amount });
      return;
    }

    const quote = quotes[qkey(item.kind, item.code)];
    if (!quote) {
      errors.push(`「${item.name || item.code}」没有查到行情，请核对代码`);
      return;
    }
    let qty = normalizeAIFloat(item.qty);
    if (!(qty > 0) && normalizeAIFloat(item.marketValue) > 0) {
      qty = Number((normalizeAIFloat(item.marketValue) / quote.price).toFixed(2));
    }
    if (!(qty > 0)) {
      errors.push(`「${item.name || item.code}」缺少数量`);
      return;
    }
    const cost = normalizeAIFloat(item.cost);
    prepared.push({
      kind: item.kind,
      code: item.code,
      name: item.name || quote.name,
      qty,
      cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
    });
  });

  if (errors.length) {
    state.ai.error = errors.join('；');
    renderAIModal();
    return;
  }

  if (state.ai.mode === 'replace') {
    if (!window.confirm('会先清空现有股票 / 基金持仓（现金保留），再导入识别结果。确定继续吗？')) return;
  }

  if (state.ai.mode === 'replace') state.portfolio.holdings = [];

  prepared.forEach((item) => {
    if (item.kind === 'cash') {
      const existing = state.portfolio.cash.find((entry) => entry.name === item.name);
      if (existing) existing.amount = item.amount;
      else state.portfolio.cash.push({ id: uid(), name: item.name, amount: item.amount });
      return;
    }
    const existing = state.portfolio.holdings.find((entry) => entry.kind === item.kind && entry.code === item.code);
    if (existing) {
      existing.name = item.name;
      existing.qty = item.qty;
      existing.cost = item.cost;
    } else {
      state.portfolio.holdings.push({
        id: uid(),
        kind: item.kind,
        code: item.code,
        name: item.name,
        qty: item.qty,
        cost: item.cost,
      });
    }
  });

  state.portfolio.demo = false;
  savePortfolio();
  state.history = [];
  saveHistory();
  releaseAIFiles();
  closeModal('aiModal');
  renderAll();
  if (el.editorModal.classList.contains('open')) renderEditor();
  toast(`已导入 ${prepared.length} 项`);
  refreshAll(false);
}

function handleAIAction(event) {
  const actionElement = event.target.closest('[data-ai-action]');
  if (actionElement) {
    const action = actionElement.dataset.aiAction;
    if (action === 'pick') {
      document.getElementById('aiFileInput')?.click();
      return;
    }
    if (action === 'remove') {
      removeAIFile(actionElement.dataset.aiId);
      return;
    }
    if (action === 'save-config') {
      saveAIConfigFromForm(true);
      return;
    }
    if (action === 'edit-key') {
      state.ai.editingKey = true;
      renderAIModal();
      document.getElementById('aiKeyInput')?.focus();
      return;
    }
    if (action === 'clear-key') {
      if (!window.confirm('清除本机保存的智谱 API Key？')) return;
      state.aiConfig.apiKey = '';
      state.ai.editingKey = false;
      saveAIConfig();
      renderAIModal();
      toast('已清除 AI Key');
      return;
    }
    if (action === 'start' || action === 'retry') {
      startAIRecognition();
      return;
    }
    if (action === 'cancel') {
      closeModal('aiModal');
      return;
    }
    if (action === 'back') {
      state.ai.step = 'upload';
      state.ai.error = '';
      state.ai.busy = false;
      renderAIModal();
      return;
    }
    if (action === 'select-ready') {
      state.ai.results.forEach((item) => { item.selected = item.status === 'ready'; });
      rerenderAIKeepScroll();
      return;
    }
    if (action === 'add-row') {
      state.ai.results.push({
        id: uid(),
        kind: 'stock',
        code: '',
        name: '',
        qty: null,
        cost: null,
        marketValue: null,
        profit: null,
        confidence: 0.5,
        quote: null,
        selected: true,
        status: 'needs',
        error: '请补全',
        source: 0,
      });
      rerenderAIKeepScroll();
      return;
    }
    if (action === 'import') {
      importAIResults();
      return;
    }
  }

  const toggle = event.target.closest('[data-ai-toggle]');
  if (toggle) {
    const row = toggle.closest('[data-row-id]');
    const item = state.ai.results.find((entry) => entry.id === row?.dataset.rowId);
    if (!item) return;
    item.selected = !item.selected;
    rerenderAIKeepScroll();
    return;
  }

  const mode = event.target.closest('[data-ai-mode]');
  if (mode) {
    state.ai.mode = mode.dataset.aiMode;
    rerenderAIKeepScroll();
    return;
  }

  if (event.target.closest('#aiDrop') && !event.target.closest('button')) {
    document.getElementById('aiFileInput')?.click();
  }
}

function handleAIInput(event) {
  if (event.target.id === 'aiFileInput') {
    addAIFiles(event.target.files);
    event.target.value = '';
    return;
  }

  const field = event.target.dataset.field;
  if (!field) return;
  const row = event.target.closest('[data-row-id]');
  const item = state.ai.results.find((entry) => entry.id === row?.dataset.rowId);
  if (!item) return;

  if (field === 'kind') {
    item.kind = event.target.value;
    item.quote = null;
    evaluateAIItem(item);
    rerenderAIKeepScroll();
    return;
  }

  if (field === 'code') {
    const code = event.target.value.replace(/\D/g, '').slice(0, 6);
    event.target.value = code;
    item.code = code;
    item.quote = null;
  } else if (field === 'qty' || field === 'cost' || field === 'marketValue') {
    item[field] = event.target.value;
  } else {
    item[field] = event.target.value;
  }

  const wasNeeds = item.status !== 'ready';
  evaluateAIItem(item);
  if (wasNeeds && item.status === 'ready') item.selected = true;
  row.classList.toggle('selected', item.selected);
  row.classList.toggle('needs', item.status !== 'ready');
  const status = row.querySelector('.ai-row-status');
  if (status) {
    status.textContent = aiItemStatusText(item);
    status.className = 'ai-row-status ' + (item.status === 'ready' ? 'ready' : 'needs');
  }
  const check = row.querySelector('.ai-check');
  if (check) check.classList.toggle('on', item.selected);
  updateAIImportButton();
}

function handleAIDrag(event) {
  const drop = event.target.closest('#aiDrop');
  if (!drop) return;
  event.preventDefault();
  if (event.type === 'dragover' || event.type === 'dragenter') drop.classList.add('drag');
  if (event.type === 'dragleave') drop.classList.remove('drag');
  if (event.type === 'drop') {
    drop.classList.remove('drag');
    if (event.dataTransfer?.files?.length) addAIFiles(event.dataTransfer.files);
  }
}

/* ------------------------------ Settings & backup ------------------------------ */

function updateSettingsUI() {
  $$('#refreshSeg button').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.refresh) === state.settings.refresh);
  });
  $$('#themeSeg button').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeOpt === state.settings.theme);
  });
  el.privacySwitch.classList.toggle('on', Boolean(state.settings.privacy));
  el.privacySwitch.setAttribute('aria-checked', String(Boolean(state.settings.privacy)));
  updateAISettingHint();

  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) {
    el.installBtn.textContent = '已安装';
    el.installBtn.disabled = true;
    el.installHint.textContent = '正在以 App 模式运行';
  } else if (state.deferredPrompt) {
    el.installBtn.textContent = '安装';
    el.installBtn.disabled = false;
    el.installHint.textContent = '像 App 一样全屏打开';
  } else {
    el.installBtn.textContent = '安装';
    el.installBtn.disabled = false;
    el.installHint.textContent = '浏览器菜单 → 添加到主屏幕';
  }
}

function openSettings() {
  updateSettingsUI();
  openModal('settingsModal');
}

function exportData() {
  const payload = {
    app: 'sizhang',
    version: 1,
    exportedAt: new Date().toISOString(),
    portfolio: state.portfolio,
    settings: state.settings,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `私账备份-${todayStr()}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('备份已导出');
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const rawPortfolio = data?.portfolio || data;
    const portfolio = sanitizePortfolio(rawPortfolio);
    if (!window.confirm('导入会覆盖当前账本，确定继续吗？')) return;

    state.portfolio = portfolio;
    state.portfolio.demo = false;
    if (data?.settings && typeof data.settings === 'object') {
      if ([5, 10, 30, 60].includes(Number(data.settings.refresh))) state.settings.refresh = Number(data.settings.refresh);
      if (['light', 'dark', 'system'].includes(data.settings.theme)) state.settings.theme = data.settings.theme;
      if (typeof data.settings.privacy === 'boolean') state.settings.privacy = data.settings.privacy;
      saveSettings();
      applyTheme();
      applyPrivacy();
    }
    savePortfolio();
    state.history = [];
    state.quotes = {};
    state.minute = {};
    state.quotesAt = 0;
    saveHistory();
    writeLS(LS.quotes, { at: 0, quotes: {} });
    writeLS(LS.minute, {});
    renderAll();
    closeModal('settingsModal');
    toast('备份已导入');
    refreshAll(false);
  } catch (err) {
    toast('导入失败：文件格式不正确');
  }
}

function clearLedger() {
  if (!window.confirm('确定清空整个账本吗？所有持仓和现金记录都会被删除，此操作不可恢复。')) return;
  [LS.portfolio, LS.history, LS.quotes, LS.minute, LS.onboarded].forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch (err) { /* ignore */ }
  });
  state.portfolio = { cash: [], holdings: [], demo: false, updatedAt: 0 };
  state.history = [];
  state.quotes = {};
  state.minute = {};
  state.quotesAt = 0;
  state.currentTotals = null;
  state.displayedTotal = null;
  state.expanded.clear();
  closeModal('settingsModal');
  closeModal('editorModal');
  renderAll();
  showOnboarding();
}

/* ------------------------------ Onboarding & demo ------------------------------ */

function demoPortfolio() {
  return {
    demo: true,
    updatedAt: Date.now(),
    cash: [{ id: uid(), name: '现金 / 活期', amount: 186420 }],
    holdings: [
      { id: uid(), kind: 'stock', code: '600519', name: '贵州茅台', qty: 100, cost: 1250 },
      { id: uid(), kind: 'stock', code: '300750', name: '宁德时代', qty: 300, cost: 190 },
      { id: uid(), kind: 'stock', code: '510300', name: '沪深300ETF华泰柏瑞', qty: 20000, cost: 3.6 },
      { id: uid(), kind: 'fund', code: '005827', name: '易方达蓝筹精选混合', qty: 50000, cost: 1.3 },
      { id: uid(), kind: 'fund', code: '000051', name: '华夏沪深300ETF联接A', qty: 30000, cost: 1.4 },
    ],
  };
}

function showOnboarding() {
  el.onboarding.hidden = false;
  document.body.style.overflow = 'hidden';
}

function hideOnboarding() {
  el.onboarding.hidden = true;
  if (!document.querySelector('.modal.open')) document.body.style.overflow = '';
}

function startLedger() {
  hideOnboarding();
  try {
    localStorage.setItem(LS.onboarded, '1');
  } catch (err) { /* ignore */ }
  if (!state.portfolio.cash.length && !state.portfolio.holdings.length) {
    state.portfolio.cash.push({ id: uid(), name: '现金', amount: 0 });
    savePortfolio();
  }
  state.portfolio.demo = false;
  renderAll();
  openEditor();
  toast('先添加你的第一笔资产');
}

function loadDemo() {
  hideOnboarding();
  try {
    localStorage.setItem(LS.onboarded, '1');
  } catch (err) { /* ignore */ }
  state.portfolio = demoPortfolio();
  state.history = [];
  if (!state.preview) savePortfolio();
  renderAll();
  refreshAll(false);
  toast('已载入示例账本');
}

function replaceDemo() {
  if (!window.confirm('示例数据会被清空，确定开始录入自己的资产吗？')) return;
  state.portfolio = {
    demo: false,
    updatedAt: Date.now(),
    cash: [{ id: uid(), name: '现金', amount: 0 }],
    holdings: [],
  };
  state.history = [];
  state.quotes = {};
  state.minute = {};
  state.quotesAt = 0;
  state.displayedTotal = null;
  if (!state.preview) savePortfolio();
  saveHistory();
  writeLS(LS.quotes, { at: 0, quotes: {} });
  writeLS(LS.minute, {});
  renderAll();
  openEditor();
  toast('示例已清空，开始录入你的资产');
}

/* ------------------------------ Install & service worker ------------------------------ */

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function handleInstall() {
  if (isStandalone()) {
    toast('已经在 App 模式运行');
    return;
  }
  if (!state.deferredPrompt) {
    toast('请点浏览器右上角菜单 → 添加到主屏幕');
    return;
  }
  state.deferredPrompt.prompt();
  try {
    await state.deferredPrompt.userChoice;
  } catch (err) { /* ignore */ }
  state.deferredPrompt = null;
  updateSettingsUI();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !local) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* Offline support is optional. */
    });
  });
}

/* ------------------------------ Toast ------------------------------ */

function toast(message, duration = 2400) {
  clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('show');
  state.toastTimer = setTimeout(() => el.toast.classList.remove('show'), duration);
}

/* ------------------------------ Events ------------------------------ */

function bindEvents() {
  el.refreshBtn.addEventListener('click', () => refreshAll(true));
  el.privacyBtn.addEventListener('click', () => {
    state.settings.privacy = !state.settings.privacy;
    saveSettings();
    applyPrivacy();
    renderAll();
  });
  el.themeBtn.addEventListener('click', () => {
    state.settings.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
    saveSettings();
    applyTheme();
    renderAll();
    if (el.settingsModal.classList.contains('open')) updateSettingsUI();
  });
  el.settingsBtn.addEventListener('click', openSettings);
  el.editBtn.addEventListener('click', openEditor);
  el.dockAdd.addEventListener('click', openAddChooser);
  el.emptyAddBtn.addEventListener('click', openAddChooser);
  el.demoReplaceBtn.addEventListener('click', replaceDemo);
  el.offlineRetryBtn.addEventListener('click', () => refreshAll(true));

  $$('.add-choice').forEach((button) => {
    button.addEventListener('click', () => {
      const kind = button.dataset.addKind;
      closeModal('addModal');
      if (kind === 'ai') openAIImport();
      else openForm(kind);
    });
  });
  el.batchBtn.addEventListener('click', () => {
    closeModal('addModal');
    openBatch();
  });

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  });

  $$('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal.id);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = $$('.modal.open').pop();
    if (open) closeModal(open.id);
  });

  el.assetForm.addEventListener('submit', handleAssetSubmit);
  el.deleteAssetBtn.addEventListener('click', () => {
    if (!state.form?.id) return;
    deleteAsset(state.form.kind, state.form.id);
  });

  el.holdingGroups.addEventListener('click', (event) => {
    const row = event.target.closest('.holding[data-id]');
    if (!row || row.classList.contains('no-expand')) return;
    toggleHolding(row);
  });
  el.holdingGroups.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.holding[data-id]');
    if (!row || row.classList.contains('no-expand')) return;
    event.preventDefault();
    toggleHolding(row);
  });

  el.editorBody.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('.er-del');
    if (deleteButton) {
      event.stopPropagation();
      deleteAsset(deleteButton.dataset.delKind, deleteButton.dataset.delId);
      return;
    }
    const addButton = event.target.closest('[data-add-kind]');
    if (addButton) {
      openForm(addButton.dataset.addKind);
      return;
    }
    const row = event.target.closest('.edit-row');
    if (row) openForm(row.dataset.editKind, row.dataset.editId);
  });
  el.editorBody.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('.er-del')) return;
    const row = event.target.closest('.edit-row');
    if (!row) return;
    event.preventDefault();
    openForm(row.dataset.editKind, row.dataset.editId);
  });

  el.editorBatchBtn.addEventListener('click', openBatch);
  el.editorAIBtn.addEventListener('click', openAIImport);
  el.editorExportBtn.addEventListener('click', exportData);
  el.batchSaveBtn.addEventListener('click', handleBatchImport);
  el.aiSettingBtn.addEventListener('click', openAIImport);

  el.aiBody.addEventListener('click', handleAIAction);
  el.aiFoot.addEventListener('click', handleAIAction);
  el.aiBody.addEventListener('input', handleAIInput);
  el.aiBody.addEventListener('change', handleAIInput);
  el.aiBody.addEventListener('dragenter', handleAIDrag);
  el.aiBody.addEventListener('dragover', handleAIDrag);
  el.aiBody.addEventListener('dragleave', handleAIDrag);
  el.aiBody.addEventListener('drop', handleAIDrag);

  el.refreshSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-refresh]');
    if (!button) return;
    state.settings.refresh = Number(button.dataset.refresh);
    saveSettings();
    updateSettingsUI();
    scheduleNext();
    toast(`刷新频率 ${state.settings.refresh} 秒`);
  });
  el.themeSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-theme-opt]');
    if (!button) return;
    state.settings.theme = button.dataset.themeOpt;
    saveSettings();
    applyTheme();
    updateSettingsUI();
    renderAll();
  });
  el.privacySwitch.addEventListener('click', () => {
    state.settings.privacy = !state.settings.privacy;
    saveSettings();
    applyPrivacy();
    updateSettingsUI();
    renderAll();
  });
  el.installBtn.addEventListener('click', handleInstall);
  el.exportBtn.addEventListener('click', exportData);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', handleImportFile);
  el.aboutBtn.addEventListener('click', () => {
    openModal('infoModal');
  });
  el.clearBtn.addEventListener('click', clearLedger);

  el.startBtn.addEventListener('click', startLedger);
  el.demoBtn.addEventListener('click', loadDemo);

  $$('.dock-item[data-nav]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.nav;
      if (target === 'settings') {
        openSettings();
        return;
      }
      if (target === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
      else document.getElementById('holdings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setDockActive(target);
    });
  });

  el.chartWrap.addEventListener('pointermove', handleChartPointer);
  el.chartWrap.addEventListener('pointerdown', handleChartPointer);
  el.chartWrap.addEventListener('pointerleave', hideChartTip);
  el.chartWrap.addEventListener('pointercancel', hideChartTip);
  el.chartWrap.addEventListener('pointerup', () => {
    setTimeout(hideChartTip, 1600);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(state.refreshTimer);
    } else {
      refreshAll(false);
    }
  });
  window.addEventListener('online', () => {
    renderBanners();
    refreshAll(false);
  });
  window.addEventListener('offline', renderBanners);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    updateSettingsUI();
  });
  window.addEventListener('appinstalled', () => {
    state.deferredPrompt = null;
    toast('已安装到手机');
    updateSettingsUI();
  });

  if (darkMedia) {
    darkMedia.addEventListener('change', () => {
      if (state.settings.theme === 'system') {
        applyTheme();
        renderAll();
      }
    });
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.currentTotals) renderChart(state.currentTotals);
    }, 140);
  });

  const sectionObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) setDockActive(entry.target.id === 'holdings' ? 'holdings' : 'top');
      });
    }, { rootMargin: '-15% 0px -65% 0px', threshold: 0 })
    : null;
  if (sectionObserver) {
    sectionObserver.observe(el.holdings);
    sectionObserver.observe(document.querySelector('.hero'));
  }
}

function toggleHolding(row) {
  const id = row.dataset.id;
  if (!id) return;
  const isOpen = state.expanded.has(id);
  if (isOpen) state.expanded.delete(id);
  else state.expanded.add(id);
  row.classList.toggle('open', !isOpen);
  row.setAttribute('aria-expanded', String(!isOpen));
}

function setDockActive(target) {
  $$('.dock-item[data-nav]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nav === target);
  });
}

/* ------------------------------ Debug (only with ?debug=1) ------------------------------ */

function setupDebug() {
  const params = new URLSearchParams(location.search);
  if (!params.has('debug')) return;
  const show = (message) => {
    let box = document.getElementById('jsError');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'jsError';
      box.style.cssText = 'position:fixed;z-index:9999;left:8px;right:8px;bottom:8px;max-height:40vh;overflow:auto;background:#300;color:#fff;font:11px/1.5 monospace;padding:10px;border-radius:8px;white-space:pre-wrap';
      document.body.appendChild(box);
    }
    box.textContent += message + '\n';
  };
  window.addEventListener('error', (event) => show('JS ERROR: ' + event.message + ' @ ' + event.filename + ':' + event.lineno));
  window.addEventListener('unhandledrejection', (event) => show('PROMISE: ' + (event.reason?.message || event.reason)));
  if (params.has('layout')) {
    setTimeout(() => {
      const names = ['.onb-frame', '.onb-top', '.onb-index', '.onb-foot', '.onb-foot span:last-child', '.onb-main', '.onb-actions'];
      const lines = ['viewport ' + innerWidth + 'x' + innerHeight];
      names.forEach((selector) => {
        const node = document.querySelector(selector);
        if (!node) {
          lines.push(selector + ' MISSING');
          return;
        }
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        lines.push(`${selector} x=${rect.x.toFixed(1)} w=${rect.width.toFixed(1)} right=${rect.right.toFixed(1)} pad=${style.padding} overflow=${style.overflow}`);
      });
      show(lines.join('\n'));
    }, 1600);
  }
}

/* ------------------------------ Init ------------------------------ */

function init() {
  setupDebug();
  loadState();
  applyTheme();
  applyPrivacy();
  bindEvents();
  registerServiceWorker();
  updateAISettingHint();

  const params = new URLSearchParams(location.search);
  state.preview = params.get('preview') || '';

  if (state.preview === 'onboard') {
    renderAll();
    showOnboarding();
    return;
  }

  if (state.preview === 'demo') {
    state.portfolio = demoPortfolio();
    state.history = [];
    hideOnboarding();
    renderAll();
    refreshAll(false);
    if (params.get('action') === 'add') setTimeout(openAddChooser, 350);
    if (params.get('action') === 'ai') setTimeout(openAIImport, 350);
    return;
  }

  const hasAssets = state.portfolio.holdings.length > 0
    || state.portfolio.cash.some((item) => item.amount > 0);
  const onboarded = readLS(LS.onboarded, false);

  if (!hasAssets && !state.portfolio.demo && !onboarded) {
    renderAll();
    showOnboarding();
    return;
  }

  hideOnboarding();
  renderAll();
  refreshAll(false);
  if (params.get('action') === 'add') setTimeout(openAddChooser, 350);
  if (params.get('action') === 'ai') setTimeout(openAIImport, 350);
}

init();
