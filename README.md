# 知るカフェ シフト RPA（GitHub Actions・外部cron駆動）

ジョブカン（勤怠）Web版を保存セッションで操作し、
- **shift-tick**（15分毎・外部cron駆動）: セッション延命(keepalive) ＋ 営業時間はOP遅刻をリアルタイム検知しSlack通知
- **shift-import**（毎朝）: 勤務/申請CSVを自動DL → GAS Web App(doPost) → 集計(runAll) → Slack

※ジョブカンのセッションは短命（アイドル約30分・活動で延命される「スライディング」型）。
　GitHubの定期実行は間引かれて間に合わないため、**外部cron(cron-job.org)から workflow_dispatch で15分毎**に叩く。

## 秘密情報はコードに書かない（このリポジトリは公開）
すべて **GitHub Secrets** に入れる。コード/README/.env.example に実値を書かないこと。

| Secret | 用途 |
|---|---|
| `JC_STATE` | ジョブカンのログインセッション（`node login.js` で作成しbase64を登録） |
| `GAS_WEBAPP_URL` | GAS Web App の exec URL |
| `RUN_SECRET` | GAS doPost の認可キー（GASスクリプトプロパティと一致） |
| `SLACK_WEBHOOK_URL` | 通知先Slack Webhook |

## ワークフロー
- `.github/workflows/shift-tick.yml` … `workflow_dispatch` のみ。外部cronで15分毎に起動。`src/tick.js`。
- `.github/workflows/shift-import.yml` … 毎朝(schedule) or 外部cron。`src/main.js`。

## 外部cron（cron-job.org 無料）
GitHubの `workflow_dispatch` API を叩く（PATは Actions=Read and write のfine-grained）。
- tick: 15分毎 → `POST /repos/<owner>/<repo>/actions/workflows/shift-tick.yml/dispatches`  body `{"ref":"main"}`
- import: 1日1回(朝) → `POST /repos/<owner>/<repo>/actions/workflows/shift-import.yml/dispatches`

## セッション作成・更新（ローカル）
```bash
npm install
node login.js            # ブラウザでBotアカウントにログイン → base64表示
# 表示されたbase64を Secret JC_STATE に登録/更新
```
セッションが切れたらSlackに通知が来る → 上記を再実行して `JC_STATE` を更新。

## 補足
- 集計本体は GAS(`gas/Code.gs`, container-bound) 側。ここは取得＋送信のみ。
- `measure-ttl.js` はセッション寿命の計測用（運用では不使用）。
