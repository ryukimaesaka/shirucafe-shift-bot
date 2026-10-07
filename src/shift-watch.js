// shift-watch.js — OP(開店)シフトイン遅れを LINE WORKS グループへ「1回だけ @All」で通知
// ------------------------------------------------------------------
// 仕様（2026-10-07 確定）:
//   ・各店その日いちばん最初のシフト=OP(開店担当) が「開始+GRACE分」経過しても未打刻なら遅刻。
//   ・遅刻を検知したら LINE WORKS Bot API でグループへ投稿し、本文に <m userId="all">（＝@All）を付ける。
//   ・通知は「1回だけ」。状態保存なしの“窓方式”で実現：elapsed が [GRACE, GRACE+WINDOW) に入った
//     ポーリング回だけ投稿する（cron間隔==WINDOWなら各ケース1回だけ命中）。再通知・停止・ackは無し。
//   ・本人が打刻すれば '未出勤' から外れて自然に対象外になる。
//
// 必要な Secret / 環境変数:
//   JC_STATE           … 保存セッション(base64)。login.js で作成（Bot専用アカウント）
//   LW_CLIENT_ID       … LINE WORKS 認証アプリ(API2.0) の Client ID
//   LW_CLIENT_SECRET   … 同 Client Secret
//   LW_SERVICE_ACCOUNT … 同 Service Account（xxxx.xxxx@domain 形式）
//   LW_PRIVATE_KEY     … 同 Private Key（PEM全文。\n を含む）
//   LW_BOT_ID          … Bot No.(Bot ID)
//   LW_CHANNEL_MAP     … 店舗別ルーティング。店舗番号→channelId のJSON（例 {"101":"18588256","118":"..."}）
//   LW_DEFAULT_CHANNEL_ID … 任意。未マッピング店舗の送り先（管理グループ等）。無ければスキップ
//   GRACE_MIN(=5) / ALERT_WINDOW_MIN(=5=cron間隔) / OPEN_FROM(=6) / OPEN_TO(=23)
//   WATCH_TEST=1       … ジョブカン抜きでダミー1件を投稿して疎通確認

const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { checkLoggedIn, jstNow } = require('./jobcan');

const TEST = process.env.WATCH_TEST === '1';
const STATE_B64 = process.env.JC_STATE || '';

const LW_CLIENT_ID = process.env.LW_CLIENT_ID || '';
const LW_CLIENT_SECRET = process.env.LW_CLIENT_SECRET || '';
const LW_SERVICE_ACCOUNT = process.env.LW_SERVICE_ACCOUNT || '';
const LW_PRIVATE_KEY = (process.env.LW_PRIVATE_KEY || '').replace(/\\n/g, '\n'); // Secretに\nで入っても実改行に戻す
const LW_BOT_ID = process.env.LW_BOT_ID || '';
// 店舗別ルーティング: 店舗番号 → channelId のJSONマップ（例 {"101":"18588256","118":"..."}）。
const LW_CHANNEL_MAP = (() => { try { return JSON.parse(process.env.LW_CHANNEL_MAP || '{}'); } catch (_) { return {}; } })();
// 未マッピング店舗の送り先（任意。管理グループ等）。未設定ならスキップしてログのみ。
const LW_DEFAULT_CHANNEL_ID = process.env.LW_DEFAULT_CHANNEL_ID || '';

const GRACE_MIN = parseInt(process.env.GRACE_MIN || '5', 10);
const WINDOW_MIN = parseInt(process.env.ALERT_WINDOW_MIN || '5', 10); // 窓幅=cron間隔。これで「1回だけ」になる
const OPEN_FROM = parseInt(process.env.OPEN_FROM || '6', 10);
const OPEN_TO = parseInt(process.env.OPEN_TO || '23', 10);

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (d) => pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); // jstNow()はUTCフィールドにJSTを載せる規約

// ---- LINE WORKS 認証（Service Account JWT → アクセストークン） ------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt() {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({ iss: LW_CLIENT_ID, sub: LW_SERVICE_ACCOUNT, iat: now, exp: now + 3600 }));
  const input = header + '.' + claims;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), LW_PRIVATE_KEY);
  return input + '.' + b64url(sig);
}
async function lwToken() {
  const body = new URLSearchParams({
    assertion: makeJwt(),
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: LW_CLIENT_ID,
    client_secret: LW_CLIENT_SECRET,
    scope: 'bot',
  });
  const r = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  }).then((x) => x.json());
  if (!r.access_token) throw new Error('LINE WORKS トークン取得失敗: ' + JSON.stringify(r));
  return r.access_token;
}
// トークルームへ送信（@All は text 内の <m userId="all"> で表現）
async function lwPostChannel(token, channelId, text) {
  const url = `https://www.worksapis.com/v1.0/bots/${LW_BOT_ID}/channels/${channelId}/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ content: { type: 'text', text } }),
  });
  if (!(r.status >= 200 && r.status < 300)) {
    throw new Error('LINE WORKS 送信失敗 ' + r.status + ' ' + (await r.text()));
  }
}

function buildMessage(now, lateArr) {
  const head = `🔴 OP（オープン）シフトイン遅れ（${GRACE_MIN}分経過・未打刻）`;
  const lines = lateArr.map((c) => `・${c.store} ${c.staff} OP ${c.startHHMM}（現在 ${hhmm(now)} / ${c.elapsedMin}分経過・未打刻）`);
  return [head, ...lines, '<m userId="all">'].join('\n');
}

// ---- ジョブカン検知（実証済み: リアルタイム勤務状況ページ work-state） -------
const WORK_STATE_URL = 'https://ssl.jobcan.jp/client/work-state/show/?submit_type=today&searching=1'
  + '&list_type=normal&number_par_page=1000&sort_order=&tags=&group_where_type=both&adit_group_id=0'
  + '&retirement=work&employee_id=&work_kind[0]=0&work_kind[1]=-1&work_kind[2]=-1&work_kind[3]=-1'
  + '&work_kind[4]=-1&work_kind[5]=-1&work_kind[6]=-1&work_kind[7]=-1&group_id=0';

async function detectLateOpenShifts(page, now) {
  // ※work-stateは常時通信があり 'networkidle' だとタイムアウトするため domcontentloaded＋表の出現待ち。
  await page.goto(WORK_STATE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (/\/login\//.test(page.url())) throw new Error('NEED_LOGIN');
  await page.waitForSelector('table', { timeout: 30000 }).catch(() => {});

  const rows = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')];
    let best = null, br = 0;
    tables.forEach((t) => { const r = t.querySelectorAll('tr').length; if (r > br) { br = r; best = t; } });
    if (!best) return [];
    const trs = [...best.querySelectorAll('tr')];
    const head = [...trs[0].querySelectorAll('th,td')].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
    const ci = (n) => head.indexOf(n);
    const iStaff = ci('スタッフ'), iState = ci('出勤状況'), iShift = ci('シフト');
    if (iStaff < 0 || iState < 0 || iShift < 0) return [];
    const out = [];
    for (let r = 1; r < trs.length; r++) {
      const cells = [...trs[r].querySelectorAll('th,td')].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
      if (cells.length <= iShift) continue;
      const staff = cells[iStaff] || '';
      if (!staff) continue;
      out.push({ staff, state: cells[iState] || '', shift: cells[iShift] || '' });
    }
    return out;
  });

  const parseRow = (r) => {
    const m = r.shift.match(/(\d{1,2}):(\d{2})/);
    const start = m ? (+m[1]) * 60 + (+m[2]) : null;
    const sm = r.staff.match(/(\d{2,3}\S.*)$/);          // 「氏名 118関西学院大学前店」形式から店舗を切り出す
    const store = sm ? sm[1] : r.staff;
    const name = sm ? r.staff.slice(0, sm.index).trim() : r.staff;
    return { start, store, name };
  };

  const opStart = {};
  rows.forEach((r) => { const p = parseRow(r); if (p.start == null) return; if (opStart[p.store] == null || p.start < opStart[p.store]) opStart[p.store] = p.start; });

  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const late = [];
  rows.forEach((r) => {
    if (r.state !== '未出勤') return;
    const p = parseRow(r);
    if (p.start == null) return;
    if (p.start !== opStart[p.store]) return;            // OP(最も早いシフト)だけ
    const over = nowMin - p.start;
    if (over < GRACE_MIN || over >= GRACE_MIN + WINDOW_MIN) return; // 窓方式＝1回だけ
    const stH = pad2(Math.floor(p.start / 60)), stM = pad2(p.start % 60);
    late.push({ store: p.store, staff: p.name, startHHMM: stH + ':' + stM, elapsedMin: over });
  });
  return late;
}

// ---- メイン ----------------------------------------------------------------
(async () => {
  const required = [
    ['LW_CLIENT_ID', LW_CLIENT_ID], ['LW_CLIENT_SECRET', LW_CLIENT_SECRET],
    ['LW_SERVICE_ACCOUNT', LW_SERVICE_ACCOUNT], ['LW_PRIVATE_KEY', LW_PRIVATE_KEY],
    ['LW_BOT_ID', LW_BOT_ID],
  ];
  if (!TEST) required.push(['JC_STATE', STATE_B64]);
  for (const [k, v] of required) {
    if (!v) { console.error('環境変数未設定:', k); process.exit(1); }
  }
  if (!Object.keys(LW_CHANNEL_MAP).length && !LW_DEFAULT_CHANNEL_ID) {
    console.error('環境変数未設定: LW_CHANNEL_MAP（店舗番号→channelId のJSON）'); process.exit(1);
  }

  // 店舗番号 → channelId を引く（番号は店舗文字列先頭の数字。無ければDEFAULT）
  const channelFor = (store) => {
    const m = String(store).match(/^(\d{2,3})/);
    const num = m ? m[1] : '';
    return (num && LW_CHANNEL_MAP[num]) || LW_DEFAULT_CHANNEL_ID || '';
  };

  const now = jstNow();
  if (!TEST && (now.getUTCHours() < OPEN_FROM || now.getUTCHours() >= OPEN_TO)) {
    console.log('監視時間外', hhmm(now)); return;
  }

  // 送り先不明時の保険（セッション切れ通知等）。DEFAULT→マップ先頭の順で1つ。
  const anyChannel = () => LW_DEFAULT_CHANNEL_ID || Object.values(LW_CHANNEL_MAP)[0] || '';

  let late = [];
  if (TEST) {
    // マップにある店舗でルーティングも検証（101同志社があればそこへ届く）
    late = [{ store: '101同志社大学前店', staff: 'テスト 太郎', startHHMM: '13:40', elapsedMin: 6 }];
    console.log('WATCH_TEST: ダミー1件で店舗別ルーティング＋@All疎通確認');
  } else {
    fs.writeFileSync('jc_state.json', Buffer.from(STATE_B64, 'base64'));
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({
      storageState: 'jc_state.json', locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
      viewport: { width: 1280, height: 900 }, acceptDownloads: true,
    });
    const page = await ctx.newPage();
    try {
      if (!(await checkLoggedIn(page))) {
        // セッション切れは監視の生命線。LINE WORKSへ（@Allなしで・保険の1チャンネルへ）通知して失敗終了。
        try { const ch = anyChannel(); if (ch) await lwPostChannel(await lwToken(), ch, '⚠️ 遅刻ウォッチャー: ジョブカンのセッション切れ。`node login.js`→JC_STATE更新を。'); } catch (_) {}
        await ctx.close(); await browser.close(); process.exit(20);
      }
      late = await detectLateOpenShifts(page, now);
    } finally {
      try { await ctx.close(); await browser.close(); } catch (_) {}
    }
  }

  if (!late.length) { console.log('OP遅刻なし', hhmm(now)); return; }

  // 店舗別ルーティング: 遅刻ケースを channelId 単位にまとめ、各店のグループへ @All で1回ずつ投稿
  const byChannel = new Map(); // channelId -> cases[]
  for (const c of late) {
    const ch = channelFor(c.store);
    if (!ch) { console.log('未マッピング店舗（スキップ）:', c.store); continue; }
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(c);
  }
  if (!byChannel.size) { console.log('送信対象なし（全て未マッピング）'); return; }

  const token = await lwToken();
  for (const [ch, cases] of byChannel) {
    await lwPostChannel(token, ch, buildMessage(now, cases));
    console.log('LINE WORKS通知 完了 ch=' + ch + ':', cases.map((c) => c.store + '/' + c.staff).join(', '));
  }
})().catch((e) => { console.error(e); process.exit(1); });
