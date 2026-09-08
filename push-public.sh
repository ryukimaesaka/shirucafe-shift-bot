#!/usr/bin/env bash
# この rpa/ フォルダを「まっさらな履歴」で新規publicリポジトリへpushする。
# 使い方:  NEW_REPO=ryukimaesaka/shirucafe-shift-bot GH_PAT=xxxxx bash push-public.sh
#   ・事前にGitHubで空のpublicリポジトリ(README無しが理想)を作成しておく
#   ・GH_PAT は Contents=Read and write を持つfine-grained PAT（対象=そのリポジトリ）
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"; cd "$SRC"
: "${NEW_REPO:?NEW_REPO=owner/name を指定してください}"
: "${GH_PAT:?GH_PAT=トークン を指定してください}"

rm -rf .git
git init -q && git checkout -q -b main
git add .
echo "=== これからpushするファイル（秘密が無いか目視確認）==="
git -c core.pager=cat diff --cached --name-only
echo "================================================"
git -c user.email="ryuki.maesaka@enrission.jp" -c user.name="shift-bot" commit -q -m "shift RPA: keepalive+late-check(tick) + import (external cron driven)"
git remote add origin "https://x-access-token:${GH_PAT}@github.com/${NEW_REPO}.git"
git push -q -u origin main --force
echo "✅ push 完了: https://github.com/${NEW_REPO}"
