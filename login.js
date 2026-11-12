/**
 * login.js — ジョブカンのセッション作成＋GitHub Secret「JC_STATE」自動更新（ローカル実行）
 * ------------------------------------------------------------
 * ブラウザが開くので、ジョブカン管理者（Bot専用アカウント）に手でログインしてください。
 * 管理画面が表示されたら、このターミナルで Enter を押すとセッションを保存します。
 *
 * ★自動更新：PATが設定されていれば、取得したセッションを GitHub API 経由で
 *   Secret「JC_STATE」に自動反映します（libsodiumでsealed box暗号化→PUT）。
 *   APIなので“メール認証(sudo)”は不要。GitHub画面での貼り付け作業も不要になります。
 *
 * 事前準備（初回のみ）:
 *   1) npm install            （libsodium-wrappers を入れる）
 *   2) npx playwright install chromium   （未導入なら）
 *   3) Secrets書込み権限付きPATを用意して、次のどちらかに置く:
 *        ・環境変数 GH_PAT
 *        ・このフォルダに gh_pat.txt（中身はPATの1行。.gitignore済み）
 *      ※PAT = Fine-grained personal access token / Resource owner=ryukimaesaka /
 *        Only select repositories=shirucafe-shift-bot /
 *        Permissions → Repository → Secrets = Read and write
 *
 * 使い方（毎回）:
 *   node login.js   → ジョブカンにログイン → Enter → 自動で JC_STATE が更新される
 *
 * PATが無い場合は従来どおり base64 を表示するので、手動で貼り付けてもOK（フォールバック）。
 */
const fs = require('fs');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const REPO = process.env.GH_REPO || 'ryukimaesaka/shirucafe-shift-bot';
const SECRET_NAME = process.env.JC_SECRET_NAME || 'JC_STATE';

// 方式①(推奨): gh CLI で Secret を更新（gh が認証済みなら PAT 不要・メール認証不要）
function findGh() {
  const cands = ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe', 'C:\\Program Files (x86)\\GitHub CLI\\gh.exe'];
  for (const g of cands) {
    try { execFileSync(g, ['--version'], { stdio: 'ignore' }); return g; } catch (_) {}
  }
  return '';
}
function updateViaGh(value) {
  const gh = findGh();
  if (!gh) return false;
  // 値は stdin 経由で渡す（コマンドライン露出を避ける）
  execFileSync(gh, ['secret', 'set', SECRET_NAME, '-R', REPO], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
  return true;
}

// 方式②(フォールバック): PATを 環境変数GH_PAT → gh_pat.txt → .gh_pat の順で探す
function readPat() {
  if (process.env.GH_PAT && process.env.GH_PAT.trim()) return process.env.GH_PAT.trim();
  for (const p of ['gh_pat.txt', '.gh_pat']) {
    try { const v = fs.readFileSync(p, 'utf8').trim(); if (v) return v; } catch (_) {}
  }
  return '';
}

// 方式②: GitHub Secret を更新（公開鍵取得→sealed box暗号化→PUT）。成功でtrue。
async function updateSecret(pat, value) {
  const sodium = require('libsodium-wrappers');
  await sodium.ready;
  const base = `https://api.github.com/repos/${REPO}/actions/secrets`;
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'shiftwatch-login',
  };
  const pk = await fetch(`${base}/public-key`, { headers }).then((r) => r.json());
  if (!pk || !pk.key || !pk.key_id) {
    throw new Error('公開鍵の取得に失敗（PATのSecrets権限を確認）: ' + JSON.stringify(pk));
  }
  const keyBin = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), keyBin);
  const encrypted_value = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
  const r = await fetch(`${base}/${SECRET_NAME}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value, key_id: pk.key_id }),
  });
  if (r.status !== 201 && r.status !== 204) {
    throw new Error('Secret更新に失敗 ' + r.status + ' ' + (await r.text()));
  }
  return true;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('https://ssl.jobcan.jp/login/client');

  console.log('\n=== 開いたブラウザでジョブカン管理者にログインしてください（Bot専用グループ管理者） ===');
  console.log('   会社ID / ログインID / パスワード を入力');
  console.log('管理画面が表示されたら、このターミナルに戻って【Enter】を押してください。');
  console.log('（ログイン後URLが /login から離れれば自動でも保存します）\n');

  const ticker = setInterval(() => { try { console.log('現在のURL:', page.url()); } catch (_) {} }, 5000);

  const auto = page
    .waitForURL((u) => { const s = u.toString(); return /ssl\.jobcan\.jp/.test(s) && !/\/login/.test(s); }, { timeout: 300000 })
    .then(() => 'auto').catch(() => null);
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
  console.log('\n✅ セッション取得（cookie ' + s.cookies.length + '件 / base64 ' + b64.length + '文字）');

  await browser.close();

  // ★ 自動更新：① gh CLI → ② PAT(libsodium) → ③ 手動(base64表示) の順でフォールバック
  let done = false;

  // ① gh CLI（認証済みなら PAT もメール認証も不要）
  try {
    if (updateViaGh(b64)) {
      done = true;
      console.log('\n🎉 gh CLI で GitHub Secret「' + SECRET_NAME + '」を自動更新しました（' + REPO + '）。');
    }
  } catch (e) {
    console.error('\n⚠️ gh での更新に失敗:', (e.message || '').split('\n')[0]);
  }

  // ② PAT + libsodium
  if (!done) {
    const pat = readPat();
    if (pat) {
      try {
        await updateSecret(pat, b64);
        done = true;
        console.log('\n🎉 PAT で GitHub Secret「' + SECRET_NAME + '」を自動更新しました（' + REPO + '）。');
      } catch (e) {
        console.error('\n⚠️ PAT での更新に失敗:', e.message);
      }
    }
  }

  // ③ 手動フォールバック
  if (done) {
    console.log('   数分以内の次回 shift-watch 実行でセッションが復活します。手作業は不要です。');
  } else {
    console.log('\n（自動更新できませんでした。下の base64 を手動で Secret「' + SECRET_NAME + '」に貼り付け↓）');
    console.log('\n' + b64 + '\n');
    console.log('自動更新を有効化するには: gh CLI にログイン（gh auth login、repoスコープ）するか、Secrets書込み権限付きPATを gh_pat.txt / 環境変数GH_PAT に設定してください。');
  }
})();
