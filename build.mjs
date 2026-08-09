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
const RE_TIME  = /^(\d{1,2}:\d{2})(?:[～~-](\d{1,2}:\d{2}))?$/;
const RE_MIN   = /(\d{2,3})分/;
const RE_RATING= /(?:^|[^A-Za-z])(PG12|R15\+|R18\+|G)(?![A-Za-z0-9])/;

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

  // 日付は日付切替の <select> から。value="20260809" 形式なので確実
  const days = $('select[name="date"] option').map((_, e) => {
    const v = ($(e).attr('value') || '').trim();
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return { key: v, m: +m[2], d: +m[3], dow: DOW[dt.getUTCDay()] };
  }).get().filter(Boolean);
  if (!days.length) throw new Error('日付optionが見つからない（ページ構造が変わった可能性）');

  const idxOf = {};
  days.forEach((d, i) => { idxOf[d.key] = i; });

  const films = [];
  $('table.weekly-schedule').each((_, tbl) => {
    // 時刻表から親をたどり、作品見出しを含む最小のブロックを探す
    let node = tbl, block = null, titleEl = null;
    for (let i = 0; i < 8 && node.parent; i++) {
      node = node.parent;
      const $n = $(node);
      const h = $n.find('h1 a, h2 a, h3 a, h4 a')
        .filter((_, e) => /\/movie\/\d+\/?$/.test($(e).attr('href') || '')).first();
      if (h.length) { block = node; titleEl = h; break; }
      if ($n.find('table.weekly-schedule').length > 1) break;   // 別作品まで巻き込んだ
    }
    if (!titleEl) return;

    const title = titleEl.text().replace(/\s+/g, ' ').trim();
    if (!title) return;

    // 上映時間・レイティング・字幕は、時刻表を除いたブロックのテキストから拾う
    const meta = $(block).clone().find('table.weekly-schedule').remove().end()
      .text().replace(/\s+/g, ' ');
    const mm = meta.match(RE_MIN);
    const rr = meta.match(RE_RATING);

    const times = days.map(() => []);
    $(tbl).find('td[data-date]').each((_, td) => {
      const i = idxOf[($(td).attr('data-date') || '').trim()];
      if (i === undefined) return;
      $(td).find('a').each((_, a) => {
        const t = $(a).text().replace(/\s+/g, '').trim();
        const tm = t.match(RE_TIME);
        if (tm) times[i].push({ s: tm[1], e: tm[2] || null });
      });
    });

    if (times.some(a => a.length)) {
      films.push({
        title,
        minutes: mm ? +mm[1] : null,
        rating: rr ? rr[1] : null,
        sub: /字幕/.test(meta),
        times,
      });
    }
  });

  return { days, films };
}

/** 解析に失敗したとき、実際のHTMLの手がかりをログに出す */
let diagnosedOnce = false;
function diagnose(html, label) {
  if (diagnosedOnce) return;          // 1館ぶんで十分。全館出すとログが読めない
  diagnosedOnce = true;
  const $ = cheerio.load(html);

  console.error(`  ── 診断 (${label}) ──`);
  console.error(`     HTML長: ${html.length}`);

  // 日付は <select name="date"> の option から取れるはず
  const opts = $('select[name="date"] option').map((_, e) =>
    `${$(e).attr('value')}=${$(e).text().trim()}`).get();
  console.error(`     日付option: ${opts.length}件 ${JSON.stringify(opts.slice(0, 8))}`);

  // 時刻を持つ要素を起点に、上位の構造を見る
  const timeEls = $('*').filter((_, e) => {
    const own = $(e).clone().children().remove().end().text().trim();
    return /^\d{1,2}:\d{2}(\s*[～~-]\s*\d{1,2}:\d{2})?$/.test(own);
  });
  console.error(`     時刻を含む要素: ${timeEls.length}件`);

  if (timeEls.length) {
    const first = timeEls[0];
    const chain = [];
    let n = first;
    for (let i = 0; i < 6 && n; i++) {
      const cls = (n.attribs?.class || '').slice(0, 60);
      chain.push(`${n.name}${cls ? '.' + cls.replace(/\s+/g, '.') : ''}`);
      n = n.parent;
    }
    console.error(`     時刻要素の祖先: ${chain.join('  <  ')}`);

    // 時刻をまとめている一番近い「箱」の生HTML
    let box = first;
    for (let i = 0; i < 4 && box.parent; i++) box = box.parent;
    console.error(`     時刻まわりの生HTML:\n${$.html(box).replace(/\s+/g, ' ').slice(0, 1800)}`);
  }

  // 作品ブロックの外枠も見たい
  const h = $('h1 a,h2 a,h3 a,h4 a').filter((_, e) => /\/movie\/\d+\/?$/.test($(e).attr('href') || '')).first();
  if (h.length) {
    let sec = h[0];
    for (let i = 0; i < 5 && sec.parent; i++) sec = sec.parent;
    console.error(`     作品ブロック外枠: <${sec.name} class="${sec.attribs?.class || ''}">`);
    console.error(`     作品ブロック冒頭:\n${$.html(sec).replace(/\s+/g, ' ').slice(0, 2200)}`);
  }
  console.error(`  ── 診断ここまで ──`);
}

/** 取得＋日付検証＋リトライ */
async function load(theater, today) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const html = await fetchPage(theater.url + (attempt > 1 ? `?_=${Date.now()}` : ''));
    let parsed;
    try { parsed = parse(html); }
    catch (e) {
      console.error(`  ! ${theater.short} 解析失敗 (${attempt}/${RETRIES}): ${e.message}`);
      if (attempt === RETRIES) diagnose(html, theater.short);
      await sleep(RETRY_WAIT_MS); continue;
    }

    const first = parsed.days[0];
    if (first.m === today.m && first.d === today.d && parsed.films.length) {
      console.log(`  ✓ ${theater.short}  ${parsed.days.length}日分 / ${parsed.films.length}作品`);
      return parsed;
    }
    const why = parsed.films.length ? `キャッシュ検出: 先頭が ${first.label}（期待 ${today.m}/${today.d}）` : `作品が0件（解析が噛み合っていない可能性）`;
    console.error(`  ! ${theater.short} ${why} — 再取得 ${attempt}/${RETRIES}`);
    if (attempt === RETRIES && !parsed.films.length) diagnose(html, theater.short);
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
