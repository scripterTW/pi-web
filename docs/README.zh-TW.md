# Pi Web

[English](../README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

[pi 編程代理（coding agent）](https://github.com/earendil-works/pi)的本機瀏覽器介面。Pi Web 與 pi 共用本機設定和工作階段檔案，可在瀏覽器中尋找和繼續對話、執行代理、設定模型與資源，並檢視專案檔案。

**[線上體驗示範 →](https://agegr.github.io/pi-web/)**：真正的 Pi Web 介面直接在瀏覽器裡執行，帶有示範工作階段、檔案和模型。無需安裝；回覆都是預設內容，不會呼叫任何模型。

中文微信社群：請見 [GitHub Discussions 討論串](https://github.com/agegr/pi-web/discussions/271)。

![Pi Web 顯示包含結構化 Markdown、工具呼叫和專案導覽的 pi 工作階段](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## 功能

- **工作階段工作區**：依專案尋找、繼續、重新命名、匯出和刪除對話，並檢視執行狀態、上下文用量、費用和壓縮資訊。
- **兩種分支方式**：**新增工作階段**會從較早的訊息建立獨立工作階段檔案；**從此處編輯**會在目前工作階段內建立分支。
- **專案檔案工具**：瀏覽和上傳檔案、檢視 Git Diff，並預覽原始碼、Markdown、圖片、音訊、PDF 和 DOCX；檔案變動後會自動重新整理。
- **SSH 遠端瀏覽**：當工作階段透過 [pi-ssh-remote](https://github.com/petrichor20211/pi-ssh-remote) pi 擴充功能連線到遠端主機時，檔案面板可在本機專案和遠端工作目錄之間切換，透過 SFTP 瀏覽和預覽遠端的原始碼、Markdown、圖片、音訊、PDF 和 DOCX；對話中的檔案連結也會透過同一連線開啟。
- **Git worktree**：從側邊欄切換 checkout，同時把同一倉庫不同 worktree 的工作階段歸在一起。
- **網頁設定**：無需離開 Pi Web，即可管理 Provider 登入和 API Key、模型、模型測試、外掛套件及技能。
- **英文、簡體中文和繁體中文介面**：Pi Web 首次開啟時跟隨瀏覽器語言，也可在「設定 → 一般 → 語言」中切換語言。

## 快速開始

Pi Web 需要 Node.js 22.19.0 或更高版本。先用 `node --version` 檢查版本，然後執行：

```bash
npx @agegr/pi-web@latest
```

服務就緒後，命令列會嘗試自動開啟瀏覽器。如果沒有開啟，請造訪 [http://127.0.0.1:30141](http://127.0.0.1:30141)。Pi Web 預設僅監聽 `127.0.0.1`。

如果尚未設定模型 Provider，請開啟**模型（Models）**面板登入或新增 API Key。

如需全域安裝 `pi-web` 指令：

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

指令：

```bash
pi-web version          # 顯示已安裝的版本
pi-web status           # 列出執行中的服務
pi-web stop [--port N]  # 停止執行中的服務
pi-web open [--port N]  # 在瀏覽器中開啟執行中的服務
pi-web update [--check] # 更新全域 npm 安裝
```

更新時先執行 `pi-web stop`，再執行 `pi-web update`（也可以再次執行同一條安裝指令）。解除安裝時執行 `npm uninstall -g @agegr/pi-web`。

## 設定

連接埠和主機名稱以命令列參數為準，優先於對應的環境變數。`--no-open` 與 `PI_WEB_NO_OPEN=1` 任一都會關閉自動開啟瀏覽器。執行 `pi-web --help`（或 `-h`）可列印啟動選項並以結束碼 0 離開，不會啟動服務；未知參數會報錯並以結束碼 1 離開。

| 參數或環境變數 | 用途 | 預設值 |
| --- | --- | --- |
| `--help`、`-h` | 列印啟動選項並結束 | — |
| `--port <連接埠>`、`-p <連接埠>` 或 `PORT` | 服務連接埠 | `30141` |
| `--hostname <主機>`、`-H <主機>` 或 `PI_WEB_HOSTNAME` | 監聽主機名稱 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自動開啟瀏覽器 | 自動開啟 |
| `PI_WEB_APP_NAME` | PWA manifest 的 `name` 和 `short_name`；去除首尾空白，空值使用預設值 | `Pi Web` |
| `PI_WEB_SKIP_VERSION_CHECK=1` | 關閉 Pi Web 的更新檢查 | 未設定 |
| `PI_WEB_ALLOWED_HOSTS` | 額外允許的代理或自訂主機名稱，多個值以逗號分隔，必須精確相符 | 未設定 |
| `PI_WEB_PASSWORD` | 啟用瀏覽器密碼登入；API 用戶端可使用使用者名稱為 `pi` 的 Basic Auth | 不啟用驗證 |
| `PI_WEB_IDLE_TIMEOUT_MS` | 工作階段閒置逾時，單位毫秒，最大 `2147483647`；`0` 表示不因閒置關閉工作階段；無效或超出範圍的值使用預設值 | `600000`（10 分鐘） |
| `PI_WEB_SHUTDOWN_DEADLINE_MS` | 關閉工作階段時留給擴充功能處理 `session_shutdown` 的時間，屆時仍會釋放工作階段；單位毫秒，最大 `2147483647`；`0`、無效或超出範圍的值使用預設值 | `5000`（5 秒） |
| `PI_CODEMODE_MAX_WORKERS` | pi 同時執行 codemode 腳本的上限，由伺服器裡所有工作階段和子代理共用；pi 自身的預設是 `2`，變數未設定或為空時 pi-web 設為 `8`。每個腳本最多可用 256 MB | `8` |

在啟動服務前設定 `PI_WEB_APP_NAME`，例如 `PI_WEB_APP_NAME='工作 Pi' pi-web`。修改後重新啟動服務即可提供新的 manifest，無需重新建置。已安裝 PWA 的名稱更新由瀏覽器管理，不保證立即生效；此設定不會變更頁面標題或圖示。

例如：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### 遠端存取

監聽非回環位址會暴露一個可執行高權限操作的代理。在可信區域網路中使用時，請設定足夠長的隨機密碼：

```bash
PI_WEB_PASSWORD='足夠長的隨機密碼' pi-web --hostname 0.0.0.0
```

密碼驗證不會加密連線。不要透過明文 HTTP 將 Pi Web 暴露到網際網路；遠端存取應使用可信反向代理提供 HTTPS，或透過可信 VPN。如果反向代理傳遞外部主機名稱，請把該名稱精確加入 `PI_WEB_ALLOWED_HOSTS`。這個允許清單不會變更 Pi Web 的監聽位址。

同時開啟很多進行中的工作階段、終端機或檔案預覽時，明文 HTTP 下瀏覽器最多只有六個連線，請求會開始排隊；見 [Serving Pi Web over HTTP/2](./http2.md)。

### Docker

每個版本都會發布映像到 `ghcr.io/agegr/pi-web`。映像用法、Compose 範例以及需要保留哪些 volume，見 [Running Pi Web in Docker](./docker.md)。

### HTTP 代理

伺服器的模型和 API 請求會讀取標準的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 環境變數。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 注意事項

- **代理資料**：Pi Web 預設讀取 `~/.pi/agent` 下的 pi 資料，包括 `sessions/<編碼後的工作目錄>/<時間戳記>_<uuid>.jsonl` 中的工作階段檔案。可用 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目錄。
- **檔案系統存取**：Pi Web 必須能讀取代理資料目錄及工作階段記錄中的工作目錄。與現有 pi 工作階段共用資料時，請讓 Pi Web 執行在與 pi 相同的檔案系統環境中。
- **共用設定**：模型面板使用 pi 的模型、設定和憑證儲存，因此兩種介面都能看到相關變更。已開啟的工作階段要再次選擇該模型，才會套用儲存的模型修改。
- **檔案存取邊界**：檔案瀏覽器僅能存取在 Pi Web 中選取過的工作目錄，以及它已辨識的專案或工作階段根目錄；它不是通用的檔案系統瀏覽器。
- **SSH 遠端檔案**：Pi Web 不會自行開啟或關閉遠端連線。它讀取 [pi-ssh-remote](https://github.com/petrichor20211/pi-ssh-remote) 儲存在工作階段中的連線狀態，並用記錄的 `ssh` 指令自行透過 SFTP 連線，從本機的 `~/.ssh/config` 和 ssh agent 解析金鑰與跳板主機。主機必須已在 pi 中被該擴充功能接受過，其金鑰才會寫入 `~/.pi/agent/ssh-remote-known-hosts.json`；遠端瀏覽不提供 Git 狀態、@ 提及搜尋索引和上傳。
- **Git worktree**：切換器何時顯示、如何建立 worktree，以及刪除會產生什麼影響，見 [Pi Web 中的 Worktree](./worktrees.md)（英文版）。
- **整合介面**：嵌入 Pi Web 的應用可以取代工作階段列的右鍵選單，伺服器的 pi 擴充功能可以讓工作階段不因閒置被關閉；見 [Integration Hooks](./integrations.md)。

## 開發

```bash
npm install
npm run dev
```

開發伺服器執行在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。常用檢查指令：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

日常開發時不要執行 `next build` 或 `npm run build`。它們會寫入 `.next/`，可能干擾開發伺服器；僅在發布流程中執行建置。

開始開發新功能之前，請先閱讀[貢獻指南](../CONTRIBUTING.md)（英文版），了解哪些變動在範圍內以及提交 PR 前的檢查項。

貢獻者文件：[國際化](./i18n.md)和[發布流程](./release.md)。

## 倉庫結構

```text
app/             Next.js 介面和 API 路由
components/      React 介面元件
hooks/           用戶端狀態和互動 hooks
lib/             工作階段、代理、模型、檔案、Git 和安全邏輯
public/          靜態資源和 PWA 檔案
bin/             npm CLI 進入點及啟動參數解析
docs/            面向使用者和貢獻者的專題文件
demo/            發布到 GitHub Pages 的靜態示範站（見 demo/README.md）
```

架構說明、API 路由和專題筆記見 [AGENTS.md](../AGENTS.md)。

## 授權條款

[MIT](../LICENSE)
