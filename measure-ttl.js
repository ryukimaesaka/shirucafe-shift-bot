// ジョブカン セッション判定テスト（スライディング vs 絶対寿命）。
// 10分毎にアクセスし続けて、頻繁な活動でセッションが延命できるかを見る。
//   ・10分毎に叩いても ~35〜40分で切れる → 「絶対寿命」型。活動では延ばせない＝自動維持は不可能。
//   ・10分毎なら60分以上ずっと生存        → 「スライディング」型。常時起動ホストで10分毎pingすれば維持可能。
// ※書き戻しはしない。計測中はGitHubの定期ワークフロー(late-check/keepalive)を止めておくこと。
// 使い方:  node login.js   →   node measure-ttl.js   （放置して結果を見る／最長約2時間）
const fs = require('fs');
const { chromium } = require('playwright');
const { checkLoggedIn } = require('./src/jobcan');

const STATE = 'jc_state.json';
const jst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
const sleepMin = (m) => new Promise((r) => setTimeout(r, m * 60 * 1000));

(async () => {
  if (!fs.existsSync(STATE)) { console.log('❌ jc_state.json が無い。先に `node login.js` を実行してください'); process.exit(1); }
  const ageMin = Math.round((Date.now() - fs.statSync(STATE).mtimeMs) / 60000);
  console.log(`▶ 判定テスト開始 ${jst()} JST / ログインから約${ageMin}分`);
  console.log('  10分毎にアクセスして延命できるか見ます。このまま放置してください（最長約2時間）。');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  async function probe() {
    for (let i = 0; i < 2; i++) {
      const ctx = await browser.newContext({ storageState: STATE, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
      const page = await ctx.newPage();
      let ok = null;
      try { ok = await checkLoggedIn(page); } catch (_) { ok = null; }
      await ctx.close();
      if (ok === true || ok === false) return ok;
    }
    return false;
  }

  const INTERVAL = 10;      // 10分毎にアクセス
  const MAX_MIN = 60;       // 最長60分（idle寿命が約30分と判明済のため、10分ping中心で60分生存すれば延命可＝スライディング確定）
  let elapsed = 0;
  // 最初に生存確認
  let ok = await probe();
  console.log(`[+0分] ${jst()} JST → ${ok ? 'ALIVE ✅' : 'EXPIRED ❌（開始時点で失効。login.jsをやり直してください）'}`);
  if (!ok) { await browser.close(); process.exit(1); }

  while (elapsed < MAX_MIN) {
    await sleepMin(INTERVAL); elapsed += INTERVAL;
    ok = await probe();
    console.log(`[+${elapsed}分] ${jst()} JST → ${ok ? 'ALIVE ✅' : 'EXPIRED ❌'}`);
    if (!ok) {
      console.log(`\n■ 結論: 10分毎にアクセスしても約${elapsed}分で失効 → 「絶対寿命」型の可能性大。`);
      console.log('  活動しても延びないため、常時起動ホストでも自動維持は困難。方式の見直しが必要。');
      await browser.close(); process.exit(0);
    }
  }
  console.log(`\n■ 結論: 10分毎アクセスで${MAX_MIN}分ずっと生存 ✅ →「スライディング」型（idle寿命約30分を10分pingが延命）。`);
  console.log('  常時起動ホストで10〜15分毎にpingすればセッション維持できる＝常駐方式が有効。');
  await browser.close();
})();
