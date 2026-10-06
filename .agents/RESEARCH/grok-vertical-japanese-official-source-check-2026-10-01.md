# Grok 直排日文研究：官方來源核對與優化判斷

核對日期：2026-10-01。範圍：兩份研究、官方文件／原始碼，以及 Root 本輪對既有 OCR 輸出的重播。產品基準 HEAD：`b2d15741c270b63d2ab7a17d851d50bf01306a20`；本機 `paddleocr==3.7.0`、`paddlex==3.7.1`。沒有修改產品、安裝套件或新增模型推論；重播不是 E2E、發布或安裝驗收。

**有優化空間；第一階段以可檢查的整框分組／讀序規則自動處理複雜混排，正文連續、註音按文章另列且保留位置。裁切、換模型、字框、Slice 與加權搜尋均不進第一階段。** [Grok 報告](../../reports/直排日文%20PaddleOCR%20研究.md)的主要管線判斷成立，但高瘦框不足以證明日文直欄群組；[處置筆記](../../research_notes/直排日文%20PaddleOCR%20研究/remediation-options.md)的部分模型指標與 normalizer 現況需要更新。

**有效計畫：** 以[修訂設計稿第 1–5 節](runtime-mixed-layout-grouping-design-2026-10-01.md)為實作範圍、輸出格式及第一個 policy 的依據，本文末保留產品決策與驗收要求。原「先做明確直欄，再驗證裁切」優先序已被取代；不得由歷史實驗恢復排除項。第二輪核實也修正短正文欄／碎片之分、Cert 分類路徑及空辨識不等於漏字的說法。
**Opus 5.5 Max後續核實（HEAD `648d042`）：** [獨立核實稿](opus55-vertical-japanese-verification-2026-10-01.md)確認純分析座標校正可作第一階段候選、PaddleX長欄順時針裁切反向可本機重現；不改raster或公開polygon。雲端CER尚未獨立重現，且正文抽取／GT篩框診斷不是完整產品CER。XY-cut在Bunka p2跨段帶、並排文章ruby歸屬已失敗，不能取代原文章／段帶規則。整頁轉正重跑與NDLOCR-Lite只列後續研究，第一階段範圍和四道驗收不變。

## 官方來源核對

| 項目 | 核對結果與適用範圍 |
| --- | --- |
| `SortQuadBoxes` | v3.7.1 先依第一點的 y、x 排序，近鄰 y 差小於 10 時調整為 x 遞增。沒有日文右至左或段落分組判斷。這支持讀序缺口，但不證明任何高瘦框都能反序。[固定版本原始碼](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/components/common/sort_boxes.py) |
| 辨識批次順序 | OCR 先排序、裁切；辨識前按裁切寬高比重排，再依 `sub_img_id` 還原，最後按原框序輸出。批次最佳化不會自動修正直欄讀序。[固定版本管線](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/ocr/pipeline.py) |
| 裁切旋轉 | Root 本輪核對已安裝來源：透視裁切後 `height / width >= 1.5` 才 `np.rot90`，不依文字行分類開關。線上同檔抓取失敗，此項依本機來源，不能稱已線上取得。[本機裁切來源](../../packages/capture-runtime/.venv/Lib/site-packages/paddlex/inference/pipelines/components/common/crop_image_regions.py)；[官方固定版本位置](https://github.com/PaddlePaddle/PaddleX/blob/v3.7.1/paddlex/inference/pipelines/components/common/crop_image_regions.py) |
| 方向分類 | 文字行模型只有 0／180 度；管線接受類別 0／1，再乘 180。整頁模型才有 0／90／180／270 度。它們沒有跨欄閱讀順序功能。[固定版本模型表](https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/v3.7.0/docs/version3.x/pipeline_usage/OCR.md)；[官方模型 label list](https://huggingface.co/PaddlePaddle/PP-LCNet_x1_0_textline_ori/raw/main/inference.yml) |
| v6 日文指標 | 固定 v3.7.0 演算法文件的同一內部辨識表列 medium **90.5%**、v5 server **73.7%**，差 16.8 個百分點。因此「v6 沒有日文分項」不成立。表格未標示日文直排、ruby 或 JLPT 子集；不能當成本產品準確率。[固定版本 v6 文件](https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/v3.7.0/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.md) |
| 評估集比較 | PaddleX 產線表混列 v6 內部集與 v5／v4 通用集，因此註記不可直接比較。這不能否定 v6 演算法頁同一內部表的比較；兩者不必然矛盾。也不能把綜合 83.2% 與另一表的日文 60.35% 相比。[PaddleX 3.7 產線表及註記](https://paddlepaddle.github.io/PaddleX/3.7/pipeline_usage/tutorials/ocr_pipelines/OCR.html) |
| v5 豎排指標 | 官方演算法表的「竖直文本」為 server 0.9314、mobile 0.8089，「日文」是另一欄。沒有日文直排交叉集、ruby 指標或直接輸入未旋轉直欄的承諾。[v5 官方文件，main，於本日核對](https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/docs/version3.x/algorithm/PP-OCRv5/PP-OCRv5.md) |

**短直排／ruby 仍是待驗證假說。** 高寬比不到 1.5 只能推出未走該次旋轉；ruby 可能很高瘦，也可能沒有被獨立偵測。頁面看得到 ruby，不足以判斷其框未旋轉，更不足以證明補轉會改善。高寬比規則是裁切幾何條件，不是文字語言、段落歸屬或註音關係分類器。

## 本輪 Root 重播補充：epsilon 已非必要修復

Root 對保留的 53 組 DML baseline／epsilon 輸出，使用當前 `normalize_paddle_results` 與各頁 raster 尺寸重播，並核對 53 張影像 SHA256 及原研究 corpus 的 3 份 PDF 身分；這不表示已逐一核對 Grok 報告列出的全部 4 份 PDF。

| 本輪重播指標 | 結果 |
| --- | --- |
| 當前 baseline 通過／epsilon 通過 | 53／53，各自全部通過 |
| 兩者正規化輸出相同 | 53／53 |
| baseline 原始框／正規化後框 | 2162／2158 |
| 空字串框／非空但零分框／失敗 | 4／0／0 |

當前 normalizer 在型別、分數、數量、多邊形與邊界驗證後略過空文字；測試另保證合法非空零分文字會保留。`score >= 1e-6` 會濾掉零分非空文字，並不是這個契約修復的等價替代。因此舊筆記的 49→53 是舊版本基準，不能再當作新增 epsilon 的產品收益。[當前 adapter](../../packages/capture-runtime/src/capture_runtime/engine_adapters.py)；[normalizer 測試](../../packages/capture-runtime/tests/unit/test_paddle_result_normalization.py)；[案例清單](../../tmp/research-vertical-japanese/v3-validation/cases.json)；[保留的原始輸出](../../tmp/research-vertical-japanese/v3-validation/raw/)

## 已被取代的初步優先序：只保留實驗證據

下表不再指示第一階段實作順序；裁切、補轉與只交付明確簡單群組均不在有效範圍。

| 歷史候選／結果 | 現在如何使用 |
| --- | --- |
| p16 同批 OCR，216 字；原 index 2→10 的 edit distance 171，人工反序 10→2 為18（NFKC、去空白、保留標點） | 支持讀序有收益，不能證明自動分組；人工索引不是 prototype gold。[原摘要](../../tmp/research-vertical-japanese/summary.json)；[保留raw](../../tmp/research-vertical-japanese/v3-validation/raw/ocr-dml-original-p16-baseline.json) |
| 人工 oracle 欄裁切：scale2、邊距0／6／12 px 的 edits18／15／13 | 僅是辨字實驗證據，不是首版工作項，不證明自動裁切安全。[裁切摘要](../../tmp/research-vertical-japanese/column-crops-summary.json) |
| 短直排／ruby 補轉假說 | p14短欄30及ruby41/42均超過既有1.5旋轉門檻；不據此再轉一次。第一版處理分組與讀序。[p14 raw](../../tmp/research-vertical-japanese/v3-validation/raw/ocr-dml-jlpt-n1-p14-baseline.json) |
| V3受限重排接受12／65直排blocks，並有組合程序記憶體失敗 | 不預設新layout模型，不移除保全檢查提高套用率；0.05已因錯序淘汰。[摘要](../../tmp/research-vertical-japanese/v3-validation/summary.json)；[失敗記錄](../../tmp/research-vertical-japanese/v3-validation/combined-process-failure.json)；[最新來源交接](../../tmp/research-vertical-japanese/opus55-source-handoff.md) |

## 第二輪核實後的有效優先序

1. **先定相容表示。** whole-region permutation；每篇正文及署名後空行列該篇ruby，再接下一頁域。boxes、regionConfidences、page.text由同一排列生成，不加role wire，不切框或改分數。空行沒有機器角色意義，須驗消費端解析。
2. **先凍結影像金標與控制頁。** p14舊手工序列不是gold；四份已看過的N1及53頁材料作回歸，另外至少兩份未看過的完整文件作留出。頁眉、題幹、框外A/B、署名、頁底注／頁碼皆納入；不拿PDF文字層或候選輸出當真值。
3. **先做明確規則的policy。** 依頁域上下位置、局部欄距、欄寬、x重疊／近側關係與文章歸屬分組；文內直欄由右至左，框內原字串不反轉。規則失敗才另開後續加權搜尋研究，不納入本階段或作執行期fallback，不能先把成本函數當必要模組。

Root本輪重算：p14 A/B欄距中位數44 px；31與30相差45 px，30「い」是下一短欄。ruby41與38的x交集3 px、42與31交集1 px，所以候選不能要求正間距；也不能反推所有ruby必須重疊。空slot24位於A文右框線，不能未經影像金標就定為漏辨。[p14原圖](../../tmp/research-vertical-japanese/v3-validation/images/jlpt-n1-p14.png)

### 第三輪核實補充：署名與同欄續接須分開

- p14署名25／43位於各文末正文欄左側，x起點分別相差41／42 px；相對各文章欄首帶末低341／355 px。原圖支持作署名附於正文後，不入正文欄序或尺度估計。
- 「約一字縮排的欄首帶」只確認獨立短正文欄，同欄續接下段不受此top限制。晚起框不能直接改判署名／ruby；須核對同文章段帶、分隔與競爭連接。Bunka p2 baseline raw8／39同x、y-gap25 px仍跨段帶，是禁止直接續接的反例；正文碎片真實正例尚待補，不能用姓名／署名分框代替。[具體規則與案例](runtime-mixed-layout-grouping-design-2026-10-01.md)
- `parse_jlpt_question_blocks`值得納入驗收，但需凍結預期題數／題號、完整stem／choices及題組關係；回傳空清單不代表無污染。實際mock-exam入口優先使用SourceChunk.raw_text，與mapping的source_text分類分開驗證；至少要有ruby與完整題目／四選項共存的真實頁，p14文章頁不能單獨證明。[解析器](../../../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/domains/exam_content.py)；[正式入口](../../../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/deterministic_parser.py)

驗收沿用當前0.4.4基準，分別量資料保全、文章／欄序、ruby歸屬、橫排控制、固定正序後CER、耗時與記憶體。純重排降低sequence edit distance不是辨字改善，53頁契約通過也不是53頁文字正確。

## Astra Ultra / grill-me 範圍審視

日期：2026-10-01。使用者指定 **GPT-6 Astra、Ultra 推理強度的 sub-agent worker**，使用 [grill-me](C:/Users/User/.codex/skills/grill-me/SKILL.md) 逐項檢視實益與範圍。風險分級 high：候選會改變 runtime 的文字輸出與跨消費端語意。本輪為唯讀設計檢視，沒有實作候選、模型推論、套件安裝或發布。審視基準 HEAD 仍為 `b2d15741c270b63d2ab7a17d851d50bf01306a20`，包含本評估與 `reports/`、`research_notes/` 的未追蹤研究內容。

### 已確認的產品需求

1. **讀序先行有實益。** 自動輸出可閱讀的文章，保住題號、選項與正確歸屬；允許保留既有少量促音／標點辨識錯誤，不得新增退化。
2. **複雜混排也是首版必達。** 只修簡單直欄、把多文章／振假名混排留在原序，不符合交付要求。合法但無法判定時，保留原序仍可作風險控制，但必達案例退避即未通過。
3. **正文連續，已辨識註音另列且保留原位置。** 首版不要求振假名逐字綁回漢字，也不承諾修復既有漏偵測或錯字。

### 實益與最小有用範圍

**範圍有實益；自動解法尚未成立，當前不得宣稱可發布。** 最小有用範圍是 runtime 內的文章分組、區塊間與欄內／欄間讀序、正文與註音角色判定，再由一致的結果產生消費端可用表示。候選須處理多篇直排文章、橫排題幹／選項、署名、短正文欄／真正同欄碎框與註音的相互關係，不能以頁碼、檔名或人工指定欄位索引決定結果。

實際使用路徑支持此收益：[頁面 raw segment](../../packages/capture-runtime/src/capture_runtime/extractors.py) 直接採用 `page.text`；[Workbench 預覽](../../packages/capture-workbench-ui/src/lib/capture-angular/components/capture-task-item/capture-task-item.component.ts) 顯示 segment 文字；[Cert Prep mapping](../../../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py) 保留 block 次序，以 projection.page.text 保存 raw_text；分類與 line metadata 則使用 document blocks 的 reviewed／target text 組成 source_text，排序可經 raw segments／structuring 間接影響分類；[LAW receipt payload](../../../gx.law-prep/apps/law-prep-ai-service/src/app/ocr/receipt_payload.py) 保留頁面文字、boxes 次序、原位置及來源身分。因此收益必須在顯示與保存後讀回的結果成立，不能只存在於研究摘要。

| 面向 | 範圍與必要條件 |
| --- | --- |
| 文章／區域分組 | 建立完整文章邊界與區塊歸屬，再決定讀序。高瘦、頂端對齊、相似欄寬、連續索引都只能是訊號，不能單獨當成同篇文章的證明。 |
| 正文／註音表示 | 首版內部分類，沿現有欄位做整框重排；各篇正文與署名後空行列該篇ruby，boxes／scores／page.text同源。原位置保留但未提供機器role／owner，消費端不得從空行猜角色。若需要角色查詢，再另做結構化契約；不可默默省略註音。 |
| 資料完整性 | 每個合法非空原始 region 恰好保留一次，包含文字、位置與分數。正文與註音的各種對外表示必須來自同一分類／排序結果。不能只改文字或只改 boxes。頁界與 `page-N` segment 身分維持。 |
| 跨版面安全 | 納入橫排、表格、短題號、署名、旋轉英文、中文直排等反例；高 confidence 不能替代正確讀序。有限驗證只支持受測範圍的無新增退化，不能宣稱全語言保證。 |
| 嚴格失敗與生命週期 | 型別、分數、數量、polygon／bounds 錯誤仍嚴格失敗；不能將例外一律吞為退避。處理須有規模上限與取消檢查，不得提前公布未驗證文字或取消後成功。 |
| 效能與模型成本 | 首版固定既有辨識器，不新增layout模型。先比較幾何規則與有界raster線索；若必達需求仍無法完成，呈現能力缺口，不自行引入模型或縮窄交付。新模型成本屬後續研究。 |
| 版本與所有權 | 所有角色與讀序政策屬 capture-runtime，不新增 consumer 私有 OCR 策略。先沿現有 release／profile 身分追溯；[profile](../../packages/capture-runtime/src/capture_runtime/ocr_profile.py) 沒有獨立後處理設定，不能直接塞入未受驗證參數。整框首版保持wire shape但屬輸出行為變更；releaseVersion綁runtime版本，不能保證正式升版後profile ID相同。日後需要機器角色時才另評估契約版本。 |

現行 [projection](../../packages/capture-runtime/src/capture_runtime/ocr_projection.py) 分別接收頁面 text 與 boxes；[worker validator](../../packages/capture-runtime/src/capture_runtime/worker_client.py) 要求 box 與 region confidence 按索引一致。因此排序／角色判定必須在完整結果組裝前由共同 runtime 接點完成，並同時驗證各表示的語意對齊。

### 明確排除

- 促音、標點等字形修正；生成式補字、字典清洗或信心門檻濾字。
- 擴裁切、全域 unclip、raster整頁旋轉／重複旋轉或更換辨識器；純分析座標的小角度校正不改raster，另依設計稿驗證。
- 振假名逐字綁定、完整一般文件解析平台，以及保證任意語言／任意版面。
- 首版引入字框、Slice、局部再辨識或新layout模型；加權搜尋不進第一階段，規則不足時另開後續研究。
- 移除完整保全與歸屬檢查來提高套用率。

### 可判定的驗收與停止條件

先依影像人工盤點每份文件的完整目標文章、正文／註音角色、期望讀序與題目／選項歸屬，再凍結樣本與通過標準。**分母是所有已盤點的目標文章與頁，包含漏分組、未改善及退避；不能只計 candidate 或已套用區塊。** 分別報告自動完整正確、錯改、未改善／退避與整頁成功率。必達複雜案例無改善或錯改，即返回設計；不能以平均值或單頁巨大收益抵銷。

1. **保留輸出重播。** 舊53頁及四份已參與設計的N1皆作回歸；必含2023／2024-07／2025直欄加下方選項、2024-12第16頁及2024-07第2頁全橫排控制，材料／影像金標依設計稿補齊而非宣稱本輪已驗證；另補必要版面／語言反例；通過資料保全、嚴格驗證、題號／選項歸屬與原本正確的橫排內容不退化。原 corpus 只有 8 頁有直排，p16 的 216 字人工真值不能代表其他複雜頁。註音另列後，分開評估正文序列、註音保全／位置，不能把移出正文的字當成 CER 改善。
2. **完整文件留出驗證。** 在調參前凍結至少兩份未參與設計的完整文件及人工標註，按文件隔離。真值由影像建立，不抄候選輸出；先前看過的53頁與四份N1均不再充作獨立留出集；留出失敗被研究後須另凍結新的未見文件。報告完整分母，必達複雜案例須通過。
3. **新鮮真推論。** 當前基準與候選各跑同一輸入，CPU／DML 分別驗證語意與資料保全。量測耗時、峰值記憶體、密集框輸入及取消；不得新增 OOM、逾時、錯誤降級或取消後成功。執行前記錄硬體與耗時／記憶體預算，不能事後放寬以符合候選結果；不要求用浮點完全相等替代品質驗證。
4. **安裝後實際使用路徑。** 經打包 loader、runtime、主要消費端至顯示／保存後讀回，證明正文可連續閱讀、註音另列且可定位、題號／選項關係正確；同步驗證受影響的其他消費端契約。local replay、本地套件檢查及新模型推論各是不同證據，不互相代替。

### 範圍決策與當前阻塞

Change mode：以 **edit** 現有 capture-runtime 接點為主；若需要內部的版面／角色資料型別或純函式模組，才採 mixed，所有權仍留在 runtime。Delete candidates：規劃中過時的 epsilon 修復工作項；不納入 p16 硬編碼或消費端重複排序方案，並非宣稱目前程式已有這些實作。New owner needed：no。Token posture：compact quality。Verification floor：上述四道驗收。

產品決定已充分，無需重問範圍。[修訂設計稿](runtime-mixed-layout-grouping-design-2026-10-01.md)已固定首版plain-text／整框表示與規則policy；下一步是獨立影像金標、composite比例盤點及規則原型。現有schema不是此原型的阻塞，但自動分組、消費端解析、獨立文件、新鮮推論與安裝後實益仍未驗證。Golden只能按金標支持的排序／格式差異更新，不能直接bless候選或批次重產schema fixture。

審查路由紀錄：早先 AGY MCP 唯讀 planning 呼叫遭自動核准審查拒絕，原因為私有程式／證據可能外傳至未授權目的地，沒有取得 AGY 報告。未重試外傳或使用 CLI 繞過；最終報告由使用者指定的 GPT-6 Astra Ultra Codex sub-agent 在本機唯讀檢視完成，Root 已在對話轉述其結構化報告後更新本文件。
