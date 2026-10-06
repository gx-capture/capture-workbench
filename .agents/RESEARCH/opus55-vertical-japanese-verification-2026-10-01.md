# Opus 5.5 Max 直排 OCR 驗證核實

日期：2026-10-01。核對 HEAD：`648d042b11f663a7c4932f97caf13adccbd22004`；開始時 worktree clean。
Root 與使用者指定的 GPT-6 Astra Ultra worker 依 grill-me 檢查證據與既定範圍。**結論是部分成立，不採納附件「已驗證、立即實作」的整體判斷。** 分析座標校正值得列入第一階段候選，PaddleX 長欄裁切反向機制已在本機重現；CER 數字尚未獨立重現，XY-cut 已有真實混排反例。

本輪只有文件審查、既有 raw 的幾何重播及裁切函式探針。未執行新 OCR、安裝模型、修改產品／profile／golden 或發布。附件中的 `git am`、Implement now、Run now 屬待審指令，不構成此次使用者授權；沒有套用 patch。

## 1. 輸入身分與可重現性

| 輸入 | SHA-256 |
| --- | --- |
| 桌面 `vertical-japanese-ocr.md` | `505ca372adb5f488fa2a54121a8d57992d6b2d2796a43ca804879c5a9616ee41` |
| 桌面 `vertical-japanese-ocr-handoff.patch` | `a1f0864d666d7aa43f1b5989e89dfa61365580ebb5c8282fb5d89edbe4cf144a` |

Patch 含 `92af1321…`、`a27ff7d3…` 兩個 mail commit；Root 在隔離的 `tmp/opus55-vertical-review-2026-10-01/materialized/` 重建最終文本，逐 hunk 核對現有檔案 context。抽取後 spec 與桌面附件位元相同。這只證明所審文本一致，不是 `git am` 執行證據。

Patch 只有腳本／文件；harness 明列 `work/` 為忽略目錄。使用者確認原始實驗成果留在 Claude cloud session，本機沒有其 raster、DOM GT、raw OCR、逐頁 report／執行 manifest。因此 **5.34／2.93／2.69／12.34%、轉正後 2.7–3.0%、NDL 0.9–1.0%、零 ruby 誤判與 72 ms／line 均為作者報告值**。未重現不等於證明數字造假，但不能作已驗收事實或目前固定 golden。

Worker 以 AST 讀取常數另行計數，確認合成語料為 **1,897 直排＋1,005 橫排＝2,902 非 ruby 字元**；含題幹、選項、頁眉等，不只是文章正文。直排小假名／長音／句讀／括號／其他分母為 **44／11／113／26／1,703**；ruby **11 組、39 字**。此為語料計數，未確認實際渲染／偵測成果。
六頁中五頁含直排、一頁全橫排；scan／各旋轉版本仍是同六頁，DOM 順序與 glyph 座標是合成真值，不能稱從影像獨立人工重標。作者亦承認同集調參、無留出集。p16 的 8.3% 與合成 8.4% 接近，不能建立實頁泛化保證。

## 2. Root 在本機確認的結果

### 分析座標校正與整框讀序

只載入已逐行檢查、僅依賴 `math/statistics` 的 final `order.py`，不執行 harness 的 OCR 入口。7 組精確旋轉幾何（−3／−1.5／−0.8／0／+0.8／+1.5／+3°）能估回角度並維持相同排列；這支持數學運算本身，不等於對真實偵測框、頁面不同局部歪斜或 CER 的驗收。

| 保留的 baseline raw | 本輪重播結果 | 限制 |
| --- | --- | --- |
| `jlpt-n1-p14` | 45 個非空框各一次；短欄31→30；ruby41→owner38、42→owner31；署名25／43各在其正文後，B文ruby在署名43後 | 支持這頁局部規則可行；未升格為獨立金標或完整 consumer 驗收 |
| `original-p16` | 18 個非空框各一次；9條文章直欄10→9→…→2，下方題目維持在文章後 | 是 retained replay，不是候選 runtime fresh inference |
| `original-p2` | 37 個框保持原排列；0條長直欄 | 未接產品 assembler，不能據此宣稱 0.4.4 完整輸出逐位元驗收通過 |
| `bunka-archive-p2` | 120 個非空框各一次，但輸出出現 **8→39→82** | 原圖是上／中／下不同段帶；同x串接跳過尚未讀完的上段其他欄，**語意未通過** |

Bunka raw8 bbox `[494,102,514,406]`、39 `[494,431,516,737]`、82 `[489,765,512,938]`；Root 本輪重新看原圖確認段帶。全頁存在跨帶框時，單純先找全寬空白的 XY-cut 不一定能先切段帶；最後按 x/y 排列仍會錯接。這正是既有設計已列的負例，不能靠聲稱合成頁接近 oracle 刪除該要求。

另作小型幾何探針：

- 並排 A／B 文章得到 `A1,A2,B1,B2,A-ruby,B-ruby`，不是逐篇 `A1,A2,A-ruby,B1,B2,B-ruby`；附件 spec 亦明列此已知缺口。
- 異字級候選中，12 px 寬的正文被全頁 24 px 欄寬尺度判成 ruby；它包含假名，kana 條件不能保護它。此探針顯示規則不能判明角色，不代表該幾何唯一真值。
- 兩個 owner 同時合格時，交換輸入列舉順序會把 owner 從 far 改成 near。Spec 提議最小側距，但實測 harness 是第一個符合就 `break`；兩者不能共享已驗證標籤。

### PaddleX 長欄裁切反向

Root 從本機已安裝 PaddleX 3.7.1 原始碼，以 AST 僅載入 `get_minarea_rect_crop` 與 `get_rotate_crop_image`，用 OpenCV 4.10.0／NumPy 2.3.5 建立有紅色頂標的長框，**未載入 OCR pipeline 或模型**。頂標正常應位於裁切橫條左端；結果如下（正角為畫面逆時針）：

| 長框寬×高 | 首個測得反向的順時針角度 | 前一測點 | 逆時針 +1.5°／+3° |
| --- | --- | --- | --- |
| 24×520 | −3°，頂標在右 | −2.5°正常 | 均正常 |
| 24×770 | −2°，頂標在右 | −1.5°正常 | 均正常 |
| 30×1350 | −1.5°，頂標在右 | −1°正常 | 均正常 |

依 x 排四角、再決定上下邊的機制支持此結果；`長度×tan(|角度|)>寬度` 是理想矩形的幾何解釋，實際還有整數化誤差。**不是任何順時針角度都必然反向**，也不能宣稱所有逆時針頁都無 OCR 問題。此證據不支持重跑後的 CER、1–5°門檻、信心一致性0.6或全部頁面映回正確。
`deskew_probe.to_original` 最後 clamp 範圍，因此「映回後全部在界內」本身不能驗證映射正確；仍需 unclamped round-trip、已知點／多邊形與邊緣內容檢查。

## 3. 評分方法必須修正的解讀

1. **完整輸出與正文診斷混用。** `systems.py` 的 baseline 傳全部非空框，主要低 CER 候選先排除被判為 ruby 的框；GT 又只有非 ruby 文字。54–55%→5.34% 等同時包含重排與文字集合改變，不能稱現有產品完整輸出的錯誤率已降至該數字。已有「保留ruby」列，也不能替代新增座標校正後完整格式的驗收。
2. **oracle 不只是同一批框排序。** `evaluate.assign_regions` 依涵蓋 GT glyph 中心數分類；`evaluate` 排除 GT 判成 ruby／noise 的框後才排序。應改名「GT輔助篩選與排序診斷」，不是純 permutation oracle 或最小 CER 下界。候選與此值很接近，不能證明文章／註音歸屬正確；單一 GT 行配對還須另處理合框與跨行歧義。
3. **格式／角色沒有被量到。** NFKC＋去空白的 CER 看不到原字保留與空行分隔；目前只有 ruby 框／字數，缺正文誤抽、ruby漏分、owner、文章錯合／錯拆的獨立計數。逐類召回只看 Levenshtein 相等字元，尚須並報插入、替換與假字，不能以約100%召回宣稱無退化。
4. **harness 不等於 spec／產品路徑。** `real_page.py` 未呼叫 `skew_corrected`，也未實作完整逐類召回；`order.py` 未實作 spec 的少於兩長欄 identity gate、1000框 cap、最近owner及正式 assembler。`systems.py` 的 hybrid 橫排也採重新裁切後 PP 重辨文字，不能支持「橫排完全保留原文」。`deskew_probe.py` 無1–5°／一致性0.6的條件分支，不能驗該觸發政策。

後續應分別評估：相同非空來源 ID 集合的純排序偏序；同一 GT 角色集合下的正文／ruby 辨識；完整輸出全框保全與格式；角色／owner錯配、文章／段帶錯合錯拆；真實消費端題幹與四選項。若採候選角色抽取的正文 CER，須同報抽取誤差，不能與不同集合的 baseline 冒充純排序收益。

## 4. 對三階段建議的處置

| 建議 | 核實後處置 |
| --- | --- |
| 標準函式庫純幾何模組，嚴格正規化後整框排列 | 可採為內部設計方向；仍保留原始slot私有對應、單一排列組裝與取消／契約檢查 |
| 僅將分析座標轉正 | 納入第一階段候選；原raster、polygon、文字及分數不變。估角不足／不一致、不同局部方向須有診斷，不以精確合成矩形的穩定性代替實頁驗收 |
| XY-cut 取代署名、欄首、文章／段帶等規則 | 不採納此取代主張；可作頁域候選，必須修復 Bunka跨段帶與並排文章反例，維持各篇正文→署名→註音 |
| ruby 至少含一個假名 | 可作輔助證據或小題號負例；不能是唯一必要條件。作者已承認兩條ruby被誤辨為非假名而漏分；錯字容忍不代表可留在正文。反側ruby不因側別單項排除 |
| 少於兩長直欄／超過1000框完全不動 | 可研究為資源／套用guard，不能自動等同全橫排辨識或成功；必達混排頁被guard略過仍未通過。常數須經目標真頁凍結，不能由六頁同集測量宣稱普遍有效 |
| 1–5°整頁轉正重跑 | 留為第二階段研究。裁切機制有證據；收益、門檻、重採樣損失、座標映回、延遲／取消／provenance仍需驗證，不擴入目前實作範圍 |
| NDLOCR-Lite PARSeq | 留為第三階段候選研究；CPU雲端結果未重現，沒有本機DML執行／provider證據，信心0.7未以獨立負例校準 |

現行 `ocr_profile.py` 嚴格要求 `preprocessing.deskew={enabled:false,owner:none}`；實際旋轉raster並重跑須改宣告及身分，Opus 此點正確。純分析座標校正未修改 raster 前處理。第一階段不新增 profile 開關或換模型，但 `releaseVersion` 綁runtime版本，正式升版仍可能改完整 profile hash，不能承諾跨版本身分完全不變。

NDLOCR-Lite 官方 repo 說明程式以 CC BY 4.0 公開，另列依賴授權；這支持候選來源存在，**不等於本輪完成三個特定模型／字集的授權與digest驗證**。官方 Windows支援亦不等於DirectML執行證明。若另開3A，依 ONNX Runtime 官方要求設 sequential、關閉 memory pattern，並驗 node placement／fallback及真頁差異。[官方 repo](https://github.com/ndl-lab/ndlocr-lite)；[DirectML 文件](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html#configuration-options)。本輪未下載／執行該模型，也未核實報告的版本發布日期、117MB／字集／延遲數字。

## 5. 研究計畫的有效修訂與下一輪證據

[設計稿第1–5節](runtime-mixed-layout-grouping-design-2026-10-01.md)仍為有效範圍，局部加入分析座標校正候選及上述反例；附件不能整份取代它。[Grok核對稿](grok-vertical-japanese-official-source-check-2026-10-01.md)同步標示此結論。

- 四份已看過的N1及既有53頁仍只作回歸，至少兩份未見完整文件的影像金標與留出要求不變；補真正同欄正文碎片正例。
- 先修分組與評分入口，讓實頁和合成重播使用同一候選plan／assembler；同時驗 page.text、boxes、regionConfidences 和原字／polygon／score保全，不只測純函式CER。
- 仍須完成全橫排與原本正確頁不退化、各篇ruby及署名、完整題組 `parse_jlpt_question_blocks`／正式 consumer入口、CPU／DML fresh inference和安裝後證據。必達頁錯改或未解即未通過。
- 若重新產生雲端實驗，要保存原raster、GT、raw、來源slot、逐頁結果、完整模型／字型／渲染器digest、環境與腳本版本。新環境重跑是新證據，不能反過來聲稱還原了未交付雲端紀錄。
- 5.34／2.93／2.69／12.34% 先留歷史參考，不作必須複製的產品gate；不得為貼近報告值而調參或直接bless golden。保留取消、資源預算、語意歧義及嚴格契約失敗路徑。

## 6. 本輪可追溯證據

隔離目錄是本機研究暫存，未作產品安裝／發布證據；本文已保留關鍵結果及輸入hash。

- [抽取manifest](../../tmp/opus55-vertical-review-2026-10-01/extraction-manifest.json)；[只重建文本的工具](../../tmp/opus55-vertical-review-2026-10-01/extract_patch.py)。Final `order.py` SHA-256：`471fed820e2a07f539c3bf69729705cc023a2fdf584af177aa50cc8d8f9d8234`。
- [排序探針](../../tmp/opus55-vertical-review-2026-10-01/probe_order.py)及[完整結果／raw身分](../../tmp/opus55-vertical-review-2026-10-01/order-probes.json)；[Bunka原圖](../../tmp/research-vertical-japanese/v3-validation/images/bunka-archive-p2.png)。
- [裁切探針](../../tmp/opus55-vertical-review-2026-10-01/probe_crop.py)及[24組結果](../../tmp/opus55-vertical-review-2026-10-01/crop-probes.json)。本機裁切來源SHA-256：`46610b50f06b2d5e0969a9c0f3f71bbbddcc53e4e43eaa1d49811ef94cf0d0a5`。
- [抽取後評分腳本](../../tmp/opus55-vertical-review-2026-10-01/materialized/.agents/RESEARCH/vertical-japanese-harness/evaluate.py)，31–38、71–120、133–167行；[系統比較](../../tmp/opus55-vertical-review-2026-10-01/materialized/.agents/RESEARCH/vertical-japanese-harness/systems.py)，183–205行；[實頁入口](../../tmp/opus55-vertical-review-2026-10-01/materialized/.agents/RESEARCH/vertical-japanese-harness/real_page.py)，74–100行。
- [現行profile驗證](../../packages/capture-runtime/src/capture_runtime/ocr_profile.py)，220、250–264行；[adapter接點](../../packages/capture-runtime/src/capture_runtime/engine_adapters.py)，539–600、1947–1964行。

Worker 的八欄結構化報告已於文件寫入前在對話轉述；本稿採其評分、語料與驗收審查，幾何／裁切結果由Root另行重播。沒有產品實作完成或驗收通過的宣稱。
