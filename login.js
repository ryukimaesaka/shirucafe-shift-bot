/**
 * login.js — ジョブカンのセッション作成（ローカルで1回だけ実行）
 * ------------------------------------------------------------
 * ブラウザが開くので、ジョブカン管理者ページに手でログインしてください（全権限管理者）。
 * 管理画面が表示されたら、このターミナルで Enter を押すとセッションを保存し、base64 を表示します。
 * （URLが /login から離れれば自動でも検知します。どちらか早い方で確定）
 *
 * 使い方（Nodeのある環境で）:
 *   npm install
 *   npx playwright install chromium
 *   node login.js
 *
 * セッションが切れてSlack通知が来たら、再度これを実行して JC_STATE を更新します。
 */
const fs = require('fs');
const readline = require('readline');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('https://ssl.jobcan.jp/login/client');

  console.log('\n=== 開いたブラウザでジョブカン管理者にログインしてください（Bot専用グループ管理者） ===');
  console.log('   会社ID / ログインID / パスワード を入力');
  console.log('管理画面が表示されたら、このターミナルに戻って【Enter】を押してください。');
  console.log('（ログイン後URLが /login から離れれば自動でも保存します）\n');

  // デバッグ用に現在URLを5秒ごとに表示（どこに遷移したか分かる）
  const ticker = setInterval(() => { try { console.log('現在のURL:', page.url()); } catch (_) {} }, 5000);

  // 自動検知: jobcan上で /login を含まないURLに到達したら
  const auto = page
    .waitForURL((u) => { const s = u.toString(); return /ssl\.jobcan\.jp/.test(s) && !/\/login/.test(s); }, { timeout: 300000 })
    .then(() => 'auto').catch(() => null);
  // 手動確定: ターミナルでEnter
  const manual = new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); res('manual'); });
  });

  const how = await Promise.race([auto, manual]);
  clearInterval(ticker);
  await page.waitForTimeout(1500);
  console.log('\n確定方法:', how || '(タイムアウト)', '/ 最終URL:', page.url());

  const s = await ctx.storageState();
  if (!s.cookies || !s.cookies.length) {
    console.error('⚠️ cookieが取得できませんでした。ログインが完了しているか確認し、もう一度実行してください。');
    await browser.close();
    process.exit(1);
  }

  // 認証に必要なcookieだけに絞る（GitHub Secretの上限に収める）
  const trimmed = JSON.stringify({ cookies: s.cookies, origins: [] });
  fs.writeFileSync('jc_state.json', trimmed);
  const b64 = Buffer.from(trimmed).toString('base64');
  console.log('\n✅ 保存しました: jc_state.json（cookie ' + s.cookies.length + '件 / base64 ' + b64.length + '文字）');
  console.log('\n=== 下の1行をコピーして GitHub Secret「JC_STATE」に貼り付けてください ===\n');
  console.log(b64);
  console.log('\n（Macなら: base64 -i jc_state.json | pbcopy でコピーできます）\n');

  await browser.close();
})();
