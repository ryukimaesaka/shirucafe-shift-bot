// ジョブカン操作（保存セッション前提。パスワードは扱わない）
const CLIENT_HOME = 'https://ssl.jobcan.jp/client/';
const DOWN_WORK = 'https://ssl.jobcan.jp/client/down-work';
const SHIFT_REQ = 'https://ssl.jobcan.jp/client/shift-pattern-request/';

const isLoginUrl = (url) => /\/login\//.test(url || '');
const pad = (n) => ('0' + n).slice(-2);
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000); // 実行環境TZに依存せずJSTを得る
function ymdSlash(d) { return d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()); }

// 復元したセッションが有効か（管理画面トップに入れるか）
async function checkLoggedIn(page) {
  try {
    await page.goto(CLIENT_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    return !isLoginUrl(page.url());
  } catch (_) { return false; }
}

async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// 勤務データDL（フォーマット=シフト分析_Claude / custom:29）。[from,to]はDate。CSVテキストを返す。
// ※実機のdown-work画面フィールドに準拠（2026-08実測）:
//   format(select) / output_ext(radio csv) / submit_type(radio: 指定月/指定日/指定期間/年指定) /
//   from_year,from_month,from_day, to_year,to_month,to_day (select) / adit_group_id(select 'all'=全ての打刻場所)
//   ★ adit_group_id='all' が無いと「打刻場所」列が空になり店舗分析(①②④)が壊れるため必須。
async function downloadWork(page, from, to) {
  await page.goto(DOWN_WORK, { waitUntil: 'networkidle', timeout: 60000 });
  if (isLoginUrl(page.url())) throw new Error('NEED_LOGIN');

  // フォーマット = custom:29（シフト分析_Claude）
  await page.selectOption('select[name="format"]', 'custom:29')
    .catch(async () => { await page.selectOption('select[name="format"]', { label: 'シフト分析_Claude' }); });
  // CSV形式（既定でCSVだが明示）
  await page.check('input[name="output_ext"][value="csv"]').catch(() => {});

  // 期間指定（submit_typeラジオは 指定月/指定日/指定期間/年指定 の順。3番目=指定期間）
  const y = (d) => String(d.getUTCFullYear());
  const mo = (d) => String(d.getUTCMonth() + 1);
  const da = (d) => String(d.getUTCDate());
  const hasRange = (await page.$('select[name="from_year"]')) && (await page.$('select[name="to_year"]'));
  if (hasRange) {
    await page.locator('input[name="submit_type"]').nth(2).check().catch(() => {});
    await page.selectOption('select[name="from_year"]', y(from));
    await page.selectOption('select[name="from_month"]', mo(from));
    await page.selectOption('select[name="from_day"]', da(from));
    await page.selectOption('select[name="to_year"]', y(to));
    await page.selectOption('select[name="to_month"]', mo(to));
    await page.selectOption('select[name="to_day"]', da(to));
  } else {
    // フォールバック: 指定月（toの月度）
    await page.locator('input[name="submit_type"]').nth(0).check().catch(() => {});
    await page.selectOption('select[name="month_year"]', y(to)).catch(() => {});
    await page.selectOption('select[name="month_month"]', mo(to)).catch(() => {});
  }

  // 打刻場所 = 全ての打刻場所（店舗別の行を得るため必須）
  await page.selectOption('select[name="adit_group_id"]', 'all');

  // 「ダウンロード」ボタン。完全一致テキスト＆可視の要素に Playwright の“信頼できるクリック”を行う。
  //  - 部分一致にすると「勤務データダウンロード」等の非表示ナビを掴み not visible で失敗する（前々回の失敗）
  //  - DOMの el.click() だとユーザー操作扱いにならず、~90秒後の自動DLをChromiumがブロックする（前回の失敗）
  //  → 完全一致(^ダウンロード$)＋visibleに locator.click() でユーザー操作を維持しつつ正しい要素を押す。
  const dlPromise = page.waitForEvent('download', { timeout: 1080000 }); // 生成は非同期。約19日窓で~10-13分かかる実績あり。余裕を持って18分
  await clickDownload(page, { equals: 'ダウンロード' });
  let download;
  try {
    download = await dlPromise;
  } catch (e) {
    // 診断: なぜダウンロードが来なかったかを掴む（次回実行で原因確定用）
    const info = await page.evaluate(() => ({
      url: location.href,
      progress: (document.body.innerText.match(/現在[\s\S]{0,10}?[\d.]+%|ファイルの作成中|ダウンロードの準備|メール/g) || []).slice(0, 3),
      readyLinks: [...document.querySelectorAll('a')]
        .filter((a) => /\.csv|download|ダウンロード/i.test((a.href || '') + a.textContent))
        .map((a) => ((a.textContent || '').trim().slice(0, 20) + '|' + (a.getAttribute('href') || '').slice(0, 60)))
        .slice(0, 5),
    })).catch(() => ({}));
    throw new Error('WORK_DL_TIMEOUT url=' + info.url + ' progress=' + JSON.stringify(info.progress) + ' links=' + JSON.stringify(info.readyLinks));
  }
  return await streamToString(await download.createReadStream());
}

// ダウンロードボタンを「DOMで要素中心を特定 → page.mouse.clickで実クリック」する。
//  - 要素発見はDOMロジック（Playwrightのactionability判定に阻まれない）
//  - 実マウスクリック＝ユーザー操作扱い（~90秒後の自動DLがブロックされない）
// opt: {equals:'...'} 完全一致 / {includes:'...'} 部分一致
async function clickDownload(page, opt) {
  const box = await page.evaluate(({ opt }) => {
    const els = [...document.querySelectorAll('a,button,input[type=submit],input[type=button]')];
    const txt = (e) => (e.value || e.textContent || '').replace(/\s+/g, ' ').trim();
    const match = (t) => (opt.equals != null ? t === opt.equals : (opt.includes != null ? t.indexOf(opt.includes) >= 0 : false));
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    let el = els.find((e) => match(txt(e)) && vis(e)) || els.find((e) => match(txt(e)));
    if (!el) {
      const cand = els
        .filter((e) => /ダウンロード|申請データ/.test(e.value || e.textContent || ''))
        .map((e) => ({ tag: e.tagName, t: txt(e).slice(0, 24), vis: vis(e), href: ((e.getAttribute && e.getAttribute('href')) || '').slice(0, 50) }))
        .slice(0, 8);
      return { notFound: true, cand };
    }
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName, t: txt(el).slice(0, 24) };
  }, { opt });
  if (box.notFound) throw new Error('DL_BTN_NOT_FOUND ' + JSON.stringify(opt) + ' candidates=' + JSON.stringify(box.cand));
  await page.mouse.click(box.x, box.y); // 信頼できる実クリック（ユーザー操作維持）
}

// 申請(希望)DL。当月・申請中(status=9)を検索URLで直接指定→DLボタン。CSVテキストを返す。
async function downloadRequests(page) {
  const n = jstNow();
  const y = n.getUTCFullYear(), m = n.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const q = new URLSearchParams({
    search_type: 'month', year: String(y), month: String(m),
    'from[y]': String(y), 'from[m]': String(m), 'from[d]': '1',
    'to[y]': String(y), 'to[m]': String(m), 'to[d]': String(last),
    group_id: '0', group_where_type: 'both', name: '', employee_id: '', tags: '',
    status: '9', ng: '1',
  });
  await page.goto(SHIFT_REQ + '?' + q.toString(), { waitUntil: 'networkidle', timeout: 60000 });
  if (isLoginUrl(page.url())) throw new Error('NEED_LOGIN');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    clickDownload(page, { includes: '申請データ' }),
  ]);
  return await streamToString(await download.createReadStream());
}

module.exports = { isLoginUrl, checkLoggedIn, downloadWork, downloadRequests, jstNow };
