// shift-watch.js — OP(開店)シフトイン遅れの“リアルタイム見張り”
// ------------------------------------------------------------------
// 仕様（2026-09-07 確定）:
//   ・各店その日いちばん最初のシフト=OP(開店担当) が「開始+GRACE分」経過しても未打刻なら遅刻。
//   ・遅刻を検知したら Slack に投稿し、@松谷 @前坂 をメンション。
//   ・3分おきに再通知（nag）し続ける。停止条件は「そのケースのメッセージに“何かスタンプ”が付く」ことだけ。
//     └ 本人が遅れて打刻しても、スタンプが無ければ鳴り続ける（＝必ず人が確認する運用）。
//   ・状態は Slack 自身を真実の源にする（外部DB不要）。当日のチャンネル履歴から
//     「このケースの過去投稿」と「リアクション有無」を判定する。
//
// 必要な Secret / 環境変数:
//   JC_STATE          … 保存セッション(base64)。login.js で作成（Bot専用アカウント）
//   SLACK_BOT_TOKEN   … xoxb-… （Incoming Webhookでは不可。reactions:read が要る）
//   SLACK_CHANNEL_ID  … 投稿先チャンネルID（C…）
//   MENTION_IDS       … カンマ区切りの Slackメンバー ID（例: U0AAA,U0BBB）＝松谷,前坂
//   GRACE_MIN         … 猶予（既定 10）
//   OPEN_FROM / OPEN_TO … 監視時間帯(JST時, 既定 6〜23)。深夜は鳴らさない。
//
// ★未確定（実機で要特定）: ジョブカンから「今日のOP予定」「今日の打刻者」を“数秒で”取る経路。
//   → detectLateOpenShifts() の中の TODO を参照。速い経路が取れるまでは空配列を返す＝新規検知はしない。
//     （nag/ack/停止のロジックはこの状態でも単体で検証可能）

const fs = require('fs');
const { chromium } = require('playwright');
const { checkLoggedIn, jstNow } = require('./jobcan');

const TEST = process.env.WATCH_TEST === '1'; // ジョブカン抜きでSlack投稿/ack/停止だけ検証する
const STATE_B64 = process.env.JC_STATE || '';
const TOKEN = process.env.SLACK_BOT_TOKEN || '';
const CHANNEL = process.env.SLACK_CHANNEL_ID || '';
const MENTIONS = (process.env.MENTION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const GRACE_MIN = parseInt(process.env.GRACE_MIN || '10', 10);
const NAG_MIN = parseInt(process.env.NAG_MIN || '5', 10);   // 同じ案件を再通知する最小間隔(分)。cronが速くてもこれで律速。
const OPEN_FROM = parseInt(process.env.OPEN_FROM || '6', 10);
const OPEN_TO = parseInt(process.env.OPEN_TO || '23', 10);

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (d) => pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); // jstNow()はUTCフィールドにJSTを載せる規約
const todayKey = (d) => d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());

// ケースを一意化する隠しキー。メッセージ末尾に code-span で埋め、履歴から突合する。
// ★空白は除去する（氏名の姓名間スペースがあると、履歴復元の正規表現 wk:[^\s`]+ が
//   スペースでキーを切ってしまい、投稿側キーと照合側キーが不一致→スタンプ停止が効かないため）。
function caseKey(dateStr, store, staff) {
  const clean = (s) => String(s).replace(/\s+/g, '');
  return `wk:${dateStr}|${clean(store)}|${clean(staff)}`;
}

// ---- Slack Web API（依存追加なし。fetchで叩く） ---------------------------
async function slackApi(method, payload) {
  const res = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  if (!res.ok) throw new Error('Slack ' + method + ' 失敗: ' + res.error);
  return res;
}

// 当日分のチャンネル履歴（このBotの遅刻投稿）を取得し、caseKey→{hasReaction} を作る。
async function loadTodayCases(dateStr) {
  const oldest = Math.floor(Date.now() / 1000) - 24 * 3600; // 24h遡れば当日は十分カバー
  const map = new Map(); // caseKey -> { hasReaction: bool }
  let cursor;
  do {
    const res = await slackApi('conversations.history', {
      channel: CHANNEL, oldest: String(oldest), limit: 200, cursor,
    });
    for (const m of res.messages || []) {
      const text = m.text || '';
      const mt = text.match(/wk:[^\s`]+/); // 埋め込んだ caseKey
      if (!mt) continue;
      const key = mt[0];
      if (key.indexOf(dateStr) < 0) continue; // 当日分だけ
      const hasReaction = Array.isArray(m.reactions) && m.reactions.length > 0;
      const ts = parseFloat(m.ts) || 0; // 投稿時刻(epoch秒)。再通知の間隔判定に使う。
      const prev = map.get(key);
      // 同一ケースに複数投稿があっても、どれか1つでもリアクションがあれば「確認済み」。
      // lastTs は最新(最大)の投稿時刻。
      map.set(key, {
        hasReaction: (prev && prev.hasReaction) || hasReaction,
        lastTs: Math.max((prev && prev.lastTs) || 0, ts),
      });
    }
    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);
  return map;
}

function buildMessage(now, c, dateStr) {
  const startHHMM = c.startHHMM;
  const nowHHMM = hhmm(now);
  const head = `:red_circle: OP（オープン）シフトイン遅れ（${GRACE_MIN}分経過・未打刻）`;
  const line = `・${c.store} ${c.staff} OP ${startHHMM}（現在 ${nowHHMM} / ${c.elapsedMin}分経過・未打刻）`;
  const mention = MENTIONS.map((id) => `<@${id}>`).join(' ');
  const key = '`' + caseKey(dateStr, c.store, c.staff) + '`';
  return [head, line, mention, key].filter(Boolean).join('\n');
}

// ---- ジョブカン検知（実証済み: リアルタイム勤務状況ページ work-state） -------
// tick.js で実証済みの経路を移植。CSV生成待ちなしで数秒で読める。
// 返り値: [{ store, staff, startHHMM, elapsedMin }]
//   現在“開始+GRACE”を過ぎ、かつ 出勤状況='未出勤' の OP(各店で最も早いシフト) だけを返す。
//   ※上限窓は設けない（nag/停止は Slackのリアクションで判定するため）。
const WORK_STATE_URL = 'https://ssl.jobcan.jp/client/work-state/show/?submit_type=today&searching=1'
  + '&list_type=normal&number_par_page=1000&sort_order=&tags=&group_where_type=both&adit_group_id=0'
  + '&retirement=work&employee_id=&work_kind[0]=0&work_kind[1]=-1&work_kind[2]=-1&work_kind[3]=-1'
  + '&work_kind[4]=-1&work_kind[5]=-1&work_kind[6]=-1&work_kind[7]=-1&group_id=0';

async function detectLateOpenShifts(page, now) {
  await page.goto(WORK_STATE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  if (/\/login\//.test(page.url())) throw new Error('NEED_LOGIN');

  // 勤務状況テーブル（行数が最大のtable）から スタッフ/出勤状況/シフト を抽出
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
    const start = m ? (+m[1]) * 60 + (+m[2]) : null;    // シフト開始(分)
    const sm = r.staff.match(/(\d{2,3}\S.*)$/);          // 「氏名 118関西学院大学前店」形式から店舗を切り出す
    const store = sm ? sm[1] : r.staff;
    const name = sm ? r.staff.slice(0, sm.index).trim() : r.staff;
    return { start, store, name };
  };

  // 各店のOP = 当日で最も早いシフト開始
  const opStart = {};
  rows.forEach((r) => { const p = parseRow(r); if (p.start == null) return; if (opStart[p.store] == null || p.start < opStart[p.store]) opStart[p.store] = p.start; });

  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const late = [];
  rows.forEach((r) => {
    if (r.state !== '未出勤') return;                    // 既に打刻済みは対象外（新規検知）
    const p = parseRow(r);
    if (p.start == null) return;
    if (p.start !== opStart[p.store]) return;            // OP(最も早いシフト)だけ
    const over = nowMin - p.start;
    if (over < GRACE_MIN) return;                        // 開始+GRACE未満はまだ
    const stH = pad2(Math.floor(p.start / 60)), stM = pad2(p.start % 60);
    late.push({ store: p.store, staff: p.name, startHHMM: stH + ':' + stM, elapsedMin: over });
  });
  return late;
}

// ---- メイン ----------------------------------------------------------------
(async () => {
  const required = [['SLACK_BOT_TOKEN', TOKEN], ['SLACK_CHANNEL_ID', CHANNEL]];
  if (!TEST) required.push(['JC_STATE', STATE_B64]); // テストではセッション不要
  for (const [k, v] of required) {
    if (!v) { console.error('環境変数未設定:', k); process.exit(1); }
  }
  if (!MENTIONS.length) console.warn('MENTION_IDS 未設定（メンション無しで投稿します）');

  const now = jstNow();
  const dateStr = todayKey(now);

  // 監視時間帯外は何もしない（深夜に鳴らさない）。※テストは時間帯を無視。
  if (!TEST && (now.getUTCHours() < OPEN_FROM || now.getUTCHours() >= OPEN_TO)) {
    console.log('監視時間外', hhmm(now)); return;
  }

  // 当日の既存投稿と確認状況を先に取得（nag判定に使う）
  const cases = await loadTodayCases(dateStr);

  // 現在の遅刻ケースを検知（テストは固定のダミー1件でSlack動作だけ確認）
  let late = [];
  if (TEST) {
    late = [{ store: '118関西学院大学前店', staff: '吉見 光生', startHHMM: '13:40', elapsedMin: 21 }];
    console.log('WATCH_TEST: ダミー1件で検証');
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
        // セッション切れは監視の生命線。既存の shift-import と同じ様式で通知（Botで投稿）。
        await slackApi('chat.postMessage', {
          channel: CHANNEL,
          text: '⚠️ 遅刻ウォッチャー: ジョブカンのセッション切れ。`node login.js`→JC_STATE更新を。',
        });
        await ctx.close(); await browser.close(); process.exit(20);
      }
      late = await detectLateOpenShifts(page, now);
    } finally {
      try { await ctx.close(); await browser.close(); } catch (_) {}
    }
  }

  // 検知ケースごとに: 未投稿→新規投稿 / 投稿済み&未スタンプ→NAG_MIN経過なら再通知 / スタンプ有り→停止
  const nowSec = Date.now() / 1000;
  for (const c of late) {
    const key = caseKey(dateStr, c.store, c.staff);
    const existing = cases.get(key);
    if (existing && existing.hasReaction) { console.log('確認済み(停止):', key); continue; }
    // 再通知スロットル: 前回投稿から NAG_MIN 未満なら見送る（cronが速くても通知は必ずNAG_MIN間隔になる）。
    if (existing && existing.lastTs && (nowSec - existing.lastTs) < NAG_MIN * 60) {
      console.log('間隔内でスキップ(' + Math.round(nowSec - existing.lastTs) + 's<' + NAG_MIN * 60 + 's):', key);
      continue;
    }
    await slackApi('chat.postMessage', { channel: CHANNEL, text: buildMessage(now, c, dateStr) });
    console.log((existing ? '再通知' : '新規通知') + ':', key);
  }

  // 停止条件は2つ（確定仕様 2026-09-07）:
  //   (a) スタンプが付く → loadTodayCases の hasReaction=true で skip
  //   (b) 本人が打刻する → detect の '未出勤' から外れて late に出てこなくなる＝自動停止
  // どちらか早い方で鳴り止む。
})().catch((e) => { console.error(e); process.exit(1); });
