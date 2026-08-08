/**
 * theaters.json に並べた劇場の上映スケジュールを映画.comから取得して index.html を生成する。
 *
 *   node build.mjs            通常実行
 *   node build.mjs --inspect  取得した生データを stdout に出す（セレクタ調整用）
 *
 * 設計上の要点:
 *  - クラス名に依存しない。日付ラベル・時刻・見出しを「文書順のトークン列」として
 *    読み、直前の見出し／直前の日付に時刻を割り当てる。映画.com側のCSSが変わっても
 *    表示テキストの形が変わらない限り壊れない。
 *  - 取得したページの先頭日付が今日でなければキャッシュとみなして再取得する。
 *    これは飾りではなく必須。実測で3〜4割のリクエストが古いページを返してくる。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (compatible; personal-schedule-bot/1.0)';
const RETRIES = 4;              // キャッシュを引いたときの再取得回数
const RETRY_WAIT_MS = 2500;
const POLITE_WAIT_MS = 1200;    // 館と館の間隔。相手のサーバに配慮する
const INSPECT = process.argv.includes('--inspect');

const DOW = ['日','月','火','水','木','金','土'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 実行日は必ず日本時間で決める。UTCで動くCI上では日付がずれる */
function todayJST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: DOW[d.getUTCDay()],
           stamp: `${d.getUTCFullYear()}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${String(d.getUTCDate()).padStart(2,'0')}` };
}

const RE_DAY   = /^(\d{1,2})\/(\d{1,2})[（(]([日月火水木金土])[）)]$/;
const RE_TIME  = /^(\d{1,2}:\d{2})(?:\s*[～~-]\s*(\d{1,2}:\d{2}))?$/;
const RE_MIN   = /(\d{2,3})分/;
const RE_RATING= /(PG12|R15\+|R18\+|G)(?![^ぁ-ん])/;

const toMin = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const fmt   = m => `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}`;

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/**
 * 劇場ページ → { days:[{label,m,d}], films:[{title,minutes,rating,sub,times:[[..],..]}] }
 */
function parse(html) {
  const $ = cheerio.load(html);
  const root = $('body');

  // 文書順にトークンを拾う
  const tokens = [];
  root.find('h1,h2,h3,h4,a,span,div,p,td,th,li').each((_, el) => {
    const $el = $(el);
    if ($el.children().length) {                 // 子要素を持つノードは自身のテキストのみ見る
      const own = $el.clone().children().remove().end().text().trim();
      if (!own) return;
      pushToken(tokens, el.tagName, own);
    } else {
      const t = $el.text().trim();
      if (t) pushToken(tokens, el.tagName, t);
    }
  });

  // 日付ラベルの並びから「この劇場が公開している日数」を決める
  const dayLabels = [];
  for (const tk of tokens) {
    if (tk.type !== 'day') continue;
    const key = tk.label;
    if (dayLabels.includes(key)) break;          // 2周目に入ったら1作品ぶんの並びが確定
    dayLabels.push(key);
  }
  if (!dayLabels.length) throw new Error('日付ラベルが1つも見つからない（ページ構造が変わった可能性）');

  // 見出し＝作品。直前の見出しと直前の日付に時刻を割り当てる
  const films = [];
  let cur = null, dayIdx = -1;
  for (const tk of tokens) {
    if (tk.type === 'title') {
      cur = { title: tk.text, minutes: null, rating: null, sub: false,
              times: dayLabels.map(() => []) };
      films.push(cur); dayIdx = -1;
    } else if (tk.type === 'day' && cur) {
      dayIdx = dayLabels.indexOf(tk.label);
    } else if (tk.type === 'time' && cur && dayIdx >= 0) {
      cur.times[dayIdx].push({ s: tk.start, e: tk.end });
    } else if (tk.type === 'meta' && cur) {
      const mm = tk.text.match(RE_MIN);       if (mm && !cur.minutes) cur.minutes = +mm[1];
      const rr = tk.text.match(RE_RATING);    if (rr && !cur.rating)  cur.rating = rr[1];
      if (tk.text.includes('字幕')) cur.sub = true;
    }
  }

  const days = dayLabels.map(l => { const m = l.match(RE_DAY); return { label: l, m: +m[1], d: +m[2], dow: m[3] }; });
  return { days, films: films.filter(f => f.times.some(a => a.length)) };
}

function pushToken(arr, tag, text) {
  const dm = text.match(RE_DAY);
  if (dm) { arr.push({ type:'day', label:text }); return; }
  const tm = text.match(RE_TIME);
  if (tm) { arr.push({ type:'time', start:tm[1], end:tm[2] || null }); return; }
  if (/^h[1-4]$/i.test(tag) || (tag === 'a' && text.length > 1 && text.length < 60 && !/^\d/.test(text))) {
    arr.push({ type:'title', text }); return;
  }
  if (RE_MIN.test(text) || RE_RATING.test(text) || text.includes('字幕')) {
    arr.push({ type:'meta', text });
  }
}

/** 取得＋日付検証＋リトライ */
async function load(theater, today) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const html = await fetchPage(theater.url + (attempt > 1 ? `?_=${Date.now()}` : ''));
    let parsed;
    try { parsed = parse(html); }
    catch (e) { console.error(`  ! ${theater.short} 解析失敗 (${attempt}/${RETRIES}): ${e.message}`); await sleep(RETRY_WAIT_MS); continue; }

    const first = parsed.days[0];
    if (first.m === today.m && first.d === today.d) {
      console.log(`  ✓ ${theater.short}  ${parsed.days.length}日分 / ${parsed.films.length}作品`);
      return parsed;
    }
    console.error(`  ! ${theater.short} キャッシュ検出: 先頭が ${first.label}（期待 ${today.m}/${today.d}）— 再取得 ${attempt}/${RETRIES}`);
    await sleep(RETRY_WAIT_MS);
  }
  return null;   // 諦める。データを捏造するより欠落を明示する
}

/** パース結果 → 画面が使う形 */
function shape(theater, parsed) {
  const days = parsed.days.map(d => `${d.m}/${d.d} ${d.dow}`);

  const today = [];
  for (const f of parsed.films) {
    for (const t of f.times[0]) {
      const facts = [];
      if (f.minutes) facts.push(`${f.minutes}分`);
      if (f.sub) facts.push('字幕');
      if (f.rating) facts.push(f.rating);
      if (!f.minutes && !t.e) facts.push('上映時間不明');
      today.push({
        s: t.s,
        e: t.e || (f.minutes ? fmt(toMin(t.s) + f.minutes) : null),
        x: t.e ? 1 : 0,                       // 1 = 映画.com記載 / 0 = 上映時間からの推定
        t: f.title,
        f: facts.length ? facts : ['—'],
      });
    }
  }
  today.sort((a, b) => toMin(a.s) - toMin(b.s));

  const week = parsed.films.map(f => {
    const meta = [f.minutes ? `${f.minutes}分` : null, f.sub ? '字幕' : null, f.rating].filter(Boolean).join(' / ') || '—';
    return { t: f.title, m: meta, d: f.times.map(a => a.map(x => x.s)) };
  });

  return { name: theater.name, short: theater.short, area: theater.area, note: theater.note, days, today, week };
}

async function main() {
  const today = todayJST();
  const theaters = JSON.parse(await readFile('theaters.json', 'utf8'));
  console.log(`■ ${today.stamp}（${today.dow}）のスケジュールを取得します`);

  const cinemas = {}, order = [], failed = [];
  for (const th of theaters) {
    const parsed = await load(th, today);
    if (!parsed) { failed.push(th.short); await sleep(POLITE_WAIT_MS); continue; }
    if (INSPECT) console.log(JSON.stringify(parsed, null, 2));
    cinemas[th.key] = shape(th, parsed);
    order.push(th.key);
    await sleep(POLITE_WAIT_MS);
  }

  if (!order.length) { console.error('× 全館で取得に失敗しました。index.html は更新しません。'); process.exit(1); }
  if (failed.length) console.error(`△ 取得できなかった館: ${failed.join('、')}`);

  const data = `const CINEMAS=${JSON.stringify(cinemas)};\nconst ORDER=${JSON.stringify(order)};`;
  const html = (await readFile('template.html', 'utf8'))
    .replace('/*__DATA__*/', data)
    .replace(/__DATE__/g, today.stamp)
    .replace(/__DOW__/g, `${today.dow}曜日`)
    .replace(/__STAMP__/g, `${today.stamp}`);

  await mkdir('dist', { recursive: true });
  await writeFile('dist/index.html', html);
  await writeFile('dist/data.json', JSON.stringify({ generated: today.stamp, cinemas, order, failed }, null, 2));
  console.log(`■ dist/index.html を生成しました（${order.length}館）`);
}

main().catch(e => { console.error(e); process.exit(1); });
