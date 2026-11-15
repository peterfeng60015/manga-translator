# 本機漫畫翻譯

Chrome 插件 + 本機 Python 伺服器。插件把網頁上的漫畫圖片送到 `127.0.0.1:8765`，伺服器用顯示卡做
文字偵測與 OCR、再翻譯，插件把譯文重新排版蓋回原圖。圖片不會離開這台電腦（選 Google 翻譯時只有辨識出的文字會送出）。

## 使用

1. Chrome 開 `chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選 `extension` 資料夾。
2. 在檔案總管**雙擊**執行一次 `install-native-host.bat`（只寫入目前使用者的登錄檔），之後彈出視窗就能用「啟動／關閉本機伺服器」按鈕控制伺服器。
   從按鈕啟動時伺服器在背景執行、不開視窗，輸出寫在 `server/server.log`；只有第一次還沒建立 venv 時會開視窗顯示安裝進度。
   不要從 Claude 桌面版等 MSIX 封裝 App 內的終端機執行：那裡寫入的登錄檔會被導到 App 的私有登錄檔，Chrome 看不到。
   不想註冊的話，也可以每次手動執行 `start-server.bat`（第一次會自動建立 venv 並安裝套件），視窗開著不要關。
3. 開漫畫頁面，點插件圖示 →「翻譯此頁」。

插件 ID 由 `manifest.json` 的 `key` 固定為 `ljcafbkmjchhgelhikfepgmeanecocle`，Native Messaging 的註冊依賴這個 ID。
移除註冊請執行 `uninstall-native-host.bat`。

| 操作 | 方式 |
| --- | --- |
| 翻譯／還原整頁 | 彈出視窗按鈕、`Alt+T`、右鍵選單 |
| 只翻一張圖 | 在圖片上按右鍵 →「翻譯這張圖片」（再按一次還原） |
| 截圖模式（漫畫畫在 canvas 上的網站） | `Alt+S` 或彈出視窗，拖曳框選區域 |
| 某網站一律自動翻譯 | 彈出視窗勾選「在這個網站自動翻譯」 |

原文支援日文、中文、韓文、英文；譯文預設繁體中文。字型、字級、直排、底色等在「設定」頁調整。

## 翻譯引擎

- **Google 翻譯**：免金鑰，需連網。
- **Ollama**：完全離線，可在設定頁換成任何已安裝的模型。

| 模型 | 大小 | 適合 |
| --- | --- | --- |
| `killgfat/sakura-7b-qwen2.5-v1.0`（預設） | 4.3 GB | 日文→中文。專為日翻中訓練，漫畫口語最自然；只支援日翻中，授權禁止商用 |
| `qwen3.5:9b` | 6.6 GB | 韓文、中文、英文原文，或譯成中文以外的語言；品質好但較慢 |
| `qwen2.5:7b` | 4.7 GB | 最快，錯譯較多 |

模型名稱含 `sakura` 時伺服器會改用 SakuraLLM 的專用提示格式。下載模型：`ollama pull <名稱>`。

## 模型

放在 `server/models/`（不進版控）：

| 檔案 | 來源 |
| --- | --- |
| `detector.onnx` | `ogkalu/comic-text-and-bubble-detector`（對話框與文字偵測） |
| `manga-ocr/encoder_model.onnx`、`decoder_model.onnx`、`vocab.txt` | `l0wgear/manga-ocr-2025-onnx`（日文 OCR） |

中文、韓文、英文的 OCR 用 RapidOCR（PP-OCRv5），模型在第一次使用時由套件自動下載。

## 結構

- `extension/`：MV3 插件。`content.js` 找圖與換圖、`typeset.js` 在 canvas 上排版、`background.js` 抓圖並呼叫伺服器。
- `server/`：FastAPI。`pipeline.py` 偵測與 OCR、`translators.py` 翻譯引擎、`app.py` API。
- `server/make_test_page.py`：產生測試用的合成漫畫頁。
