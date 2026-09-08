// 保存セッション(JC_STATE)を復元 → 勤務/申請DL → GAS(doPost)へCSV送信 → Slack通知
// パスワードログインはしない（ジョブカンが無人ログインを拒否するため。人がlogin.jsで一度作成）
const fs = require('fs');
const { chromium } = require('playwright');
const { checkLoggedIn, downloadWork, downloadRequests, jstNow } = require('./jobcan');

const STATE_B64 = process.env.JC_STATE || '';
const WEBHOOK = process.env.SLACK_WEBHOOK_URL || '';
const REPO = process.env.GITHUB_REPOSITORY || '';
const SECRETS_URL = REPO ? `https://github.com/${REPO}/settings/secrets/actions` : '(リポジトリのSecrets設定)';

async function slack(text) {
  console.log('SLACK:', text);
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (e) { console.error('slack失敗', e.message); }
}

(async () => {
  if (!STATE_B64) {
    await slack('⚠️ シフト自動取込: セッション未設定です。ローカルで `node login.js` して Secret JC_STATE を設定してください: ' + SECRETS_URL);
    process.exit(1);
  }
  // 必須Secretの検証（未設定だと fetch('') が Invalid URL で落ちるため、分かりやすく通知）
  const missing = ['GAS_WEBAPP_URL', 'RUN_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) {
    await slack('⚠️ シフト自動取込: Secret未設定（' + missing.join(', ') + '）。設定してください: ' + SECRETS_URL);
    process.exit(1);
  }
  fs.writeFileSync('jc_state.json', Buffer.from(STATE_B64, 'base64'));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    storageState: 'jc_state.json', locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 900 }, acceptDownloads: true,
  });
  const page = await ctx.newPage();
  try {
    if (!(await checkLoggedIn(page))) {
      await slack(`⚠️ シフト自動取込: セッションが切れました。ローカルで \`node login.js\` して再ログイン → 新しい JC_STATE を設定してください:\n${SECRETS_URL}`);
      await ctx.close(); await browser.close();
      process.exit(20);
    }

    // GAS側が「日付キーでマージ」するため、毎日は短い窓だけDLすれば過去日はシートに蓄積される。
    // 窓 = 前日 〜 今日+16日。理由:
    //   ・未来分(+16日)= ①②作成ミス/0オペは“作成済みの未来シフト”を検査する必要があるため
    //   ・前日〜当日 = ④乖離の直近実績を最新化（過去日は各日の実行時に取り込まれ蓄積）
    const now = jstNow();
    const from = new Date(now.getTime() - 2 * 24 * 3600 * 1000);   // 前日〜（余裕を持って2日前）
    const to = new Date(now.getTime() + 16 * 24 * 3600 * 1000);    // 今日+16日（作成済み未来シフト）
    const workCsv = await downloadWork(page, from, to);
    const reqCsv = await downloadRequests(page);

    const GAS = process.env.GAS_WEBAPP_URL, SECRET = process.env.RUN_SECRET;
    // ① 取込のみ（skipAggregate）→ GASは書き込みだけして即返す（doPostの6分/fetchの5分タイムアウトを回避）
    const res = await fetch(GAS, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, work: workCsv, requests: reqCsv, skipAggregate: true }),
    }).then(r => r.json());
    if (!res.ok) throw new Error('GAS取込 失敗: ' + (res.error || 'unknown'));

    // ② 集計(runAll)は“別呼び出し”で起動。GASは6分の実行枠をフルに使え、Nodeは待ちすぎない。
    //    fire-and-tolerate: 60秒だけ待って切る。GASはクライアント切断後もサーバ側で完走し、
    //    完了時に自前でSlackサマリを送る（runAll内 notifySlack）。
    try {
      await fetch(GAS, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: SECRET }),
        signal: AbortSignal.timeout(60000),
      });
      console.log('集計 同期完了');
    } catch (_) { console.log('集計はGAS側で継続実行中（完了時にSlack）'); }

    const w = (res.wrote && res.wrote.work) || 0;
    const s = (res.wrote && res.wrote.requests) || 0;
    await slack(`✅ シフト取込 完了（勤務${w}行 / 申請${s}行）。集計は別途実行し、結果を追ってSlack通知します。`);
    console.log('done', res.wrote);
    await ctx.close(); await browser.close();
  } catch (e) {
    if (/NEED_LOGIN/.test(e.message)) {
      await slack(`⚠️ シフト自動取込: セッション切れ。ローカルで \`node login.js\` → 新JC_STATE設定を: ${SECRETS_URL}`);
    } else {
      await slack('⚠️ シフト自動取込 失敗: ' + e.message);
    }
    console.error(e);
    try { await ctx.close(); await browser.close(); } catch (_) {}
    process.exit(1);
  }
})();
