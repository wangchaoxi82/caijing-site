// 财经快讯站 — 零依赖 Node.js 应用
// 数据全部来自免费公开接口（无 Key）：新浪财经、东方财富、Yahoo Finance、Google 新闻 RSS
// 任一来源失败时对应栏目显示"暂无数据"，绝不编造数字或标题。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时缓存
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

// ---------- A股涨跌家数：新浪 Market Center 全市场统计 ----------
// 注意：新浪每页最多返回 100 只（num 再大也会被截断），所以按 100 只一页分页拉取。
async function getMarketBreadth() {
  const NUM = 100, MAX_PAGES = 60, BATCH = 10;
  let rows = [];
  for (let start = 1; start <= MAX_PAGES; start += BATCH) {
    const pages = [];
    for (let p = start; p < Math.min(start + BATCH, MAX_PAGES + 1); p++) pages.push(p);
    const results = await Promise.allSettled(pages.map((p) =>
      fetchJson(`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${p}&num=${NUM}&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=init`, SINA_HEADERS)
    ));
    let done = false;
    for (const r of results) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return null; // 任一页失败则不返回不完整的统计
      rows = rows.concat(r.value);
      if (r.value.length < NUM) { done = true; break; }
    }
    if (done) break;
  }
  // 合理性校验：A股总数约 5300 只，行数过少说明接口被限流/截断，宁可不显示也不给错数
  if (rows.length < 3000) {
    console.error(`ashare breadth: only ${rows.length} rows, discarding`);
    return null;
  }
  let up = 0, flat = 0, down = 0;
  for (const d of rows) {
    const pct = parseFloat(d.changepercent);
    if (!Number.isFinite(pct)) continue;
    if (pct > 0) up++;
    else if (pct < 0) down++;
    else flat++;
  }
  return { up, flat, down, total: up + flat + down };
}

// ---------- 行业板块：东方财富板块行情（成交额前 40），失败则用中证全指行业指数 ----------
// 备选指数（新浪 hq 实测有数据）：全指能源/材料/可选/医药/金融/信息 + 中证消费（全指消费新浪无数据）。
const SECTOR_INDEX_FALLBACK = [
  's_sh000986', 's_sh000987', 's_sh000989', 's_sh000932', 's_sh000991', 's_sh000992', 's_sh000993',
];

async function getSectorBoardsFromSina() {
  const text = await fetchText(
    `https://hq.sinajs.cn/list=${SECTOR_INDEX_FALLBACK.join(',')}`,
    'gbk',
    SINA_HEADERS
  );
  const out = [];
  for (const code of SECTOR_INDEX_FALLBACK) {
    const m = text.match(new RegExp(`hq_str_${code}="([^"]*)"`));
    if (!m) continue;
    const f = m[1].split(',');
    const name = f[0];
    const pct = parseFloat(f[3]);
    const amount = parseFloat(f[5]); // 新浪指数成交额单位是万元
    if (name && Number.isFinite(pct) && Number.isFinite(amount) && amount > 0) {
      out.push({ name, code: code.replace('s_sh', ''), pct, amount: amount * 10000 });
    }
  }
  return out.length >= 3 ? out : null; // 至少 3 个才有意义
}

async function getSectorBoards() {
  try {
    const d = await fetchJson(
      'https://push2.eastmoney.com/api/qt/clist/get?fid=f3&po=1&pz=120&pn=1&np=1&fltt=2&invt=2&fs=m:90+t:2&fields=f2,f3,f6,f12,f14'
    );
    const list = d?.data?.diff;
    if (Array.isArray(list) && list.length) {
      const out = list
        .map((b) => ({
          name: b.f14,
          code: b.f12,
          pct: typeof b.f3 === 'number' ? b.f3 : parseFloat(b.f3),
          amount: typeof b.f6 === 'number' ? b.f6 : parseFloat(b.f6),
        }))
        .filter((b) => b.name && Number.isFinite(b.pct) && Number.isFinite(b.amount) && b.amount > 0);
      if (out.length) {
        out.sort((a, b) => b.amount - a.amount);
        return { source: 'eastmoney', list: out.slice(0, 40) };
      }
    }
  } catch (e) {
    console.error('sectors eastmoney failed:', e.message);
  }
  const sina = await getSectorBoardsFromSina().catch((e) => {
    console.error('sectors sina fallback failed:', e.message);
    return null;
  });
  if (sina) return { source: 'sina', list: sina };
  return null;
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

// ---------- 聚合（带缓存；过期后先返回旧数据、后台刷新，避免访问者等 18 秒） ----------
let refreshPromise = null;
function refreshCache() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const [indices, movers, breadth, sectors, usIndices, usHot, news] = await Promise.all([
          getAshareIndices().catch((e) => { console.error('ashare indices failed:', e.message); return null; }),
          getAshareMovers().catch((e) => { console.error('ashare movers failed:', e.message); return null; }),
          getMarketBreadth().catch((e) => { console.error('ashare breadth failed:', e.message); return null; }),
          getSectorBoards().catch((e) => { console.error('sectors failed:', e.message); return null; }),
          getUsQuotes(US_INDEX).catch((e) => { console.error('us indices failed:', e.message); return null; }),
          getUsQuotes(US_HOT).catch((e) => { console.error('us hot failed:', e.message); return null; }),
          getNews(),
        ]);
        cache = {
          at: Date.now(),
          data: {
            updatedAt: new Date().toISOString(),
            news,
            ashare: { indices, movers, breadth },
            sectors,
            us: { indices: usIndices, hot: usHot },
          },
        };
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

async function getData() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (cache.data) {
    refreshCache(); // 有旧数据：先返回，后台刷新
    return cache.data;
  }
  await refreshCache(); // 冷启动：等第一次抓完
  return cache.data;
}

// 启动时预热缓存，第一个访问者不用等
refreshCache();

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
