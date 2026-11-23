// 财经快讯站 — 零依赖 Node.js 应用
// 数据全部来自免费公开接口（无 Key）：新浪财经、Yahoo Finance、Google 新闻 RSS
// 任一来源失败时对应栏目显示"暂无数据"，绝不编造数字或标题。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟缓存
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' };
const SINA_HEADERS = { ...UA, Referer: 'https://finance.sina.com.cn' };

let cache = { at: 0, data: null };

async function fetchText(url, encoding, headers) {
  const res = await fetch(url, { headers: headers || UA, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder(encoding || 'utf-8').decode(buf);
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers: headers || UA, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- A股指数：新浪 hq 接口（GBK 编码） ----------
const ASHARE_INDEX = [
  { code: 's_sh000001', name: '上证指数' },
  { code: 's_sz399001', name: '深证成指' },
  { code: 's_sz399006', name: '创业板指' },
];

async function getAshareIndices() {
  const text = await fetchText(
    `https://hq.sinajs.cn/list=${ASHARE_INDEX.map((i) => i.code).join(',')}`,
    'gbk',
    SINA_HEADERS
  );
  const out = [];
  for (const idx of ASHARE_INDEX) {
    const m = text.match(new RegExp(`hq_str_${idx.code}="([^"]*)"`));
    if (!m) continue;
    const f = m[1].split(',');
    const price = parseFloat(f[1]);
    const pct = parseFloat(f[3]);
    if (Number.isFinite(price) && Number.isFinite(pct)) {
      out.push({ name: idx.name, price, change: parseFloat(f[2]) || 0, pct });
    }
  }
  return out.length ? out : null;
}

// ---------- A股涨幅榜：新浪 Market Center ----------
async function getAshareMovers() {
  const data = await fetchJson(
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=5&sort=changepercent&asc=0&node=hs_a&symbol=&_s_r_a=init',
    SINA_HEADERS
  );
  if (!Array.isArray(data) || !data.length) return null;
  const out = data
    .map((d) => ({
      name: d.name,
      code: d.code,
      price: parseFloat(d.trade),
      pct: parseFloat(d.changepercent),
    }))
    .filter((d) => d.name && Number.isFinite(d.price) && Number.isFinite(d.pct));
  return out.length ? out : null;
}

// ---------- 美股：Yahoo Finance chart API（query1 失败则试 query2） ----------
async function yahooMeta(symbol) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const d = await fetchJson(
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`
      );
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta && Number.isFinite(meta.regularMarketPrice)) return meta;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('yahoo failed');
}

const US_INDEX = [
  { symbol: '^DJI', name: '道琼斯工业' },
  { symbol: '^GSPC', name: '标普 500' },
  { symbol: '^IXIC', name: '纳斯达克' },
];
const US_HOT = [
  { symbol: 'AAPL', name: '苹果' },
  { symbol: 'MSFT', name: '微软' },
  { symbol: 'NVDA', name: '英伟达' },
  { symbol: 'TSLA', name: '特斯拉' },
  { symbol: 'AMZN', name: '亚马逊' },
  { symbol: 'META', name: 'Meta' },
];

async function getUsQuotes(list) {
  const results = await Promise.allSettled(list.map((s) => yahooMeta(s.symbol)));
  const out = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const m = r.value;
    const pct = m.regularMarketChangePercent;
    if (Number.isFinite(pct)) {
      out.push({
        name: list[i].name,
        symbol: list[i].symbol,
        price: m.regularMarketPrice,
        pct,
      });
    }
  });
  return out.length ? out : null;
}

// ---------- 财经新闻：新浪滚动新闻（财经 lid=2509），失败则 Google 新闻 RSS ----------
function unescapeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function getNewsFromSina() {
  const d = await fetchJson(
    'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&k=&num=20&page=1',
    SINA_HEADERS
  );
  const items = d?.result?.data;
  if (!Array.isArray(items) || !items.length) return null;
  const out = items
    .filter((it) => it.title && it.url && /^https?:\/\//.test(it.url))
    .map((it) => ({
      title: it.title,
      url: it.url,
      source: it.media_name || '新浪财经',
      time: new Date(parseInt(it.ctime, 10) * 1000).toISOString(),
    }))
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 15);
  return out.length ? out : null;
}

async function getNewsFromGoogleRss() {
  const xml = await fetchText(
    'https://news.google.com/rss/search?q=%E8%B4%A2%E7%BB%8F&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'
  );
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const out = [];
  for (const [, b] of blocks) {
    const t = b.match(/<title>([\s\S]*?)<\/title>/);
    const l = b.match(/<link>([\s\S]*?)<\/link>/);
    const p = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const s = b.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    if (!t || !l) continue;
    let title = unescapeXml(t[1]).trim();
    let source = s ? unescapeXml(s[1]).trim() : '';
    if (!source) {
      const m = title.match(/^(.*)\s+-\s+([^-]+)$/);
      if (m) { title = m[1].trim(); source = m[2].trim(); }
    }
    const time = p ? new Date(unescapeXml(p[1]).trim()) : null;
    out.push({
      title,
      url: unescapeXml(l[1]).trim(),
      source: source || 'Google 新闻',
      time: time && !isNaN(time) ? time.toISOString() : null,
    });
    if (out.length >= 15) break;
  }
  return out.length ? out : null;
}

async function getNews() {
  try {
    const sina = await getNewsFromSina();
    if (sina) return sina;
  } catch (e) {
    console.error('sina news failed:', e.message);
  }
  try {
    return await getNewsFromGoogleRss();
  } catch (e) {
    console.error('google rss failed:', e.message);
    return null;
  }
}

// ---------- 聚合（带缓存） ----------
async function getData() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const [indices, movers, usIndices, usHot, news] = await Promise.all([
    getAshareIndices().catch((e) => { console.error('ashare indices failed:', e.message); return null; }),
    getAshareMovers().catch((e) => { console.error('ashare movers failed:', e.message); return null; }),
    getUsQuotes(US_INDEX).catch((e) => { console.error('us indices failed:', e.message); return null; }),
    getUsQuotes(US_HOT).catch((e) => { console.error('us hot failed:', e.message); return null; }),
    getNews(),
  ]);
  const data = {
    updatedAt: new Date().toISOString(),
    news,
    ashare: { indices, movers },
    us: { indices: usIndices, hot: usHot },
  };
  cache = { at: Date.now(), data };
  return data;
}

// ---------- HTTP 服务 ----------
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/data') {
      const data = await getData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'server error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`财经快讯站 running on http://${HOST}:${PORT}`);
});
