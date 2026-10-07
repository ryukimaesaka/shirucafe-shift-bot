// shift-tick — 15分毎に外部cron(cron-job.org)からworkflow_dispatchで叩かれる1本。
//  ① 毎回: ジョブカンにアクセス＝セッション延命(keepalive)。スライディング寿命(約30分)を15分pingで維持。
//  ② セッション切れ検知時のみ: Slackに再ログイン依頼(頻発防止のため毎回は出さない=下記の抑制)。
// ※OP遅刻のリアルタイム検知＋通知は shift-watch.js へ移管（Bot Token/@メンション/スタンプ停止/3分nag）。
// ※保存cookieは値が変わらないため書き戻し不要（実測: 同一cookieを繰り返し使い延命できることを確認済）。
const fs = require('fs');
const { chromium } = require('playwright');

const STATE_B64 = process.env.JC_STATE || '';
const WEBHOOK = process.env.SLACK_WEBHOOK_URL || '';
const REPO = process.env.GITHUB_REPOSITORY || '';
const SECRETS_URL = REPO ? `https://github.com/${REPO}/settings/secrets/actions` : '(リポジトリのSecrets設定)';

// keepalive用に軽くアクセスするページ（当日の勤務状況。ログイン要否の判定にも使う）
const WORK_STATE_URL = 'https://ssl.jobcan.jp/client/work-state/show/?submit_type=today&searching=1'
  + '&list_type=normal&number_par_page=1000&sort_order=&tags=&group_where_type=both&adit_group_id=0'
  + '&retirement=work&employee_id=&work_kind[0]=0&work_kind[1]=-1&work_kind[2]=-1&work_kind[3]=-1'
  + '&work_kind[4]=-1&work_kind[5]=-1&work_kind[6]=-1&work_kind[7]=-1&group_id=0';

function jstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function nowMinJst() { const n = jstNow(); return n.getUTCHours() * 60 + n.getUTCMinutes(); }
function hhmm(min) { return ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2); }
function log(...a) { console.log('[' + jstNow().toISOString().replace('T', ' ').slice(0, 19) + ' JST]', ...a); }

async function slack(text) {
  log('SLACK:', text);
  if (!WEBHOOK) return;
  try { await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); }
  catch (e) { log('slack失敗', e.message); }
}

(async () => {
  if (!STATE_B64) { await slack('⚠️ 遅刻検知/keepalive: セッション未設定(JC_STATE)。`node login.js`で設定を: ' + SECRETS_URL); process.exit(1); }
  fs.writeFileSync('jc_state.json', Buffer.from(STATE_B64, 'base64'));

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ storageState: 'jc_state.json', locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    // セッション切れ通知の連発防止: 15分毎に叩かれるので、毎正時台の最初(0-14分)だけ通知＝最大1回/時
    const alertExpiryAllowed = () => (nowMinJst() % 60) < 15;

    // ① keepalive も兼ねてアクセス（このgoto自体がセッション延命になる）
    // ※work-stateは常時通信があり 'networkidle' に到達せずタイムアウトすることがあるため domcontentloaded に。
    await page.goto(WORK_STATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/\/login\//.test(page.url())) {
      if (alertExpiryAllowed()) await slack('⚠️ jobcan: セッション切れ。`node login.js`で JC_STATE 更新を: ' + SECRETS_URL);
      else log('セッション切れ（通知抑制中: 1時間に1回のみ）');
      await ctx.close(); await browser.close(); process.exit(20);
    }

    // ② OP遅刻検知は shift-watch.js（Bot Token＋@メンション＋スタンプ停止＋3分nag）へ移管。
    //    二重通知を避けるため、ここでは検知しない。tick は keepalive＋セッション切れ通知専用。
    log('keepalive OK', hhmm(nowMinJst()));
    await ctx.close(); await browser.close();
  } catch (e) {
    if (/\/login\//.test(e.message)) { if ((nowMinJst() % 60) < 15) await slack('⚠️ jobcan: セッション切れ。`node login.js`で更新を: ' + SECRETS_URL); }
    else await slack('⚠️ jobcan tick 失敗: ' + e.message);
    log('ERROR', e.stack || e.message);
    try { await ctx.close(); await browser.close(); } catch (_) {}
    process.exit(1);
  }
})();
