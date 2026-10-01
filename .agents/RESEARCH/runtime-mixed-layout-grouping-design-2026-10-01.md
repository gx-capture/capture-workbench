# Runtime 複雜混排：整框分組、讀序與正文／註音分離計畫

日期：2026-10-01；依 Grok 第二、三輪建議核實修訂。基準 HEAD：`b2d15741c270b63d2ab7a17d851d50bf01306a20`；runtime 0.4.4、Python 3.12、PaddleOCR 3.7.0／PaddleX 3.7.1。
本輪只有來源閱讀、保留 JSON 幾何重算及原圖檢視；未實作排序、執行新推論、更新測試 golden、安裝或發布。
**第 1–5 節是第一階段的有效計畫**，取代前版的 Slice 資料模型、先做加權聯合搜尋及先擴充角色 wire 的前提。[來源核對稿](grok-vertical-japanese-official-source-check-2026-10-01.md)的舊優先序只保留為歷史證據。
**[事實]** 表示已核對；**[計畫]** 表示尚待實作／驗收。有限測試不能保證所有文件語意零退步。

## 1. 已確認範圍

- 複雜混排必須自動處理：多文章、直欄與短欄、署名、框外標號、橫排題幹／選項及可分離的已辨識註音。
- 正文連續可讀，已辨識註音另列且保留 polygon；不要求逐字 ruby→漢字綁定。既有錯字可保留，不得新增漏字、重複、錯配或錯序。
- 第一版只對有效非空 **whole region 做 permutation**；不切字串、不切框、不建立 Slice／衍生字框、不改 confidence 權重。
- 裁切／擴裁切、局部再辨識、額外旋轉、換模型、字典修字、新 layout 模型及加權搜尋不進第一階段；保留既有 `PP-OCRv6_medium_rec`。
- 同框正文＋ruby、跨欄合框先單獨盤點。必達頁若因合框無法完成，列能力缺口、阻擋交付，不能隱瞞或縮成簡單頁範圍。
- 歧義可保留原始資料作失敗保全；必達案例退避仍未通過。取消／契約錯誤維持既有失敗路徑，不回成功原序。

## 2. Grok 主張的實測核對與限制

以下 index 均為 case `jlpt-n1-p14` 的 **baseline raw slot**，不是印刷頁碼20，也不是 epsilon／normalized index。[L5][L6]

| 核對項目 | 本輪結果 | 計畫修正 |
| --- | --- | --- |
| 短欄30與長欄31 | 30 bbox `[584,947,612,993]`；31 `[629,949,653,1469]`；x起點差45 px，頂端差2 px；A/B正文欄距中位數皆44 px | 30「い」是31左側的下一短欄，非其下方同欄碎片；不能按高度抽成ruby |
| 多字短正文欄 | 6「と話していた」27×155；10「ている」25×89；16「誇る」26×67 | 高寬比皆超過1.5；短、少字或假名都不是ruby判準 |
| 已辨識ruby | 41「いえでん」16×47，與欄38的x交集3 px；42「ほう」12×21，與欄31交集1 px | ruby候選須容許x重疊／零間距，不能要求正間距 |
| 裁切旋轉 | 30、41、42的h/w約1.643、2.938、1.75；本機`CropByPolys`在透視裁切後h/w≥1.5時`np.rot90` | 依既有裁切路徑均符合旋轉條件，無證據支持補轉；這不是本輪逐次旋轉trace。[L11] |
| 欄首不齊 | A有y=338與359–363；B有y=947–949與970 | 約一字縮排不能把同篇欄排到文章後面；20 px只是此解析度例子 |
| 左下署名 | A正文起點完整範圍337–363，署名25起點704；B正文947–970，署名43起點1325。相對各欄首帶末低341／355 px；署名位於末正文欄左側，兩框x起點分別相差41／42 px | Grok「約340 px」方向成立，但須明確比較基準；兩框作文章附屬署名，不作正文欄或尺度錨點 |
| 頁面結構 | 題幹3–4在A/B上方；標號5/26在框外；署名25/43在各文左下；注44及頁碼45更低 | 先排頁域，再排文章欄；禁止「全部直排＋剩餘橫排」 |
| 上游helper | block8匹配`[30,31,32,33,39,42]`，直排欄寬filter只留下`[[42]]` | 不靠調此helper取代產品分組；`TextLine.height`在此是x欄寬。[L7][P2] |
| 空框與索引 | slot24是`[1021,397,1038,858]`的17×461空字串；ruby baseline42對應epsilon41 | 保留raw→validated私有映射；空框仍嚴格驗證後略過 |

**不能照單全收的推論：** x重疊是p14正例，不是所有ruby的必要／充分條件；局部欄寬、欄距、近側關係、沿文方向重疊及競爭owner需一起檢查。JLReq記錄反側／雙側與overhang，側別和包含率也不是絕對規則。[P1]
slot24在原圖A文章右框線位置，未見明確目標文字；只能稱空辨識／疑似框線誤檢，不能直接計漏辨。是否漏字由影像金標判定，確定不屬讀序錯誤。[L6]
B文舊手工順序`40→37→36→35→34→39→33→32→31→30→38→29→28→27`及ruby 41→38、42→31只作研究判讀；須從圖獨立重標，不能直接升格為gold。

## 3. 先固定第一版輸出契約

**[事實]** worker page是封閉欄位集合；box只接受`polygon/text/confidence`。scored mode的`regionConfidences`須與boxes等長且逐index相等。`page.text`是獨立字串，worker／projection不會由boxes替呼叫端重算。[L2][L3][L12]
**[計畫]** 沿用現有wire shape，內部角色只決定順序與分隔。這是輸出行為變更，不是完全向後相容，也未新增可查詢的註音契約。

1. 先依頁域上下位置及文章／題組關係確定header、題幹、文章、下方題目／選項、頁底注與頁碼的順序；橫排區域內維持行次及由左至右。
2. 每篇文章輸出：附屬A/B或標題 → 正文欄 → 該文署名 → **該篇ruby run**。不把全頁ruby集中放到最後一個選項之後。
3. 一般相鄰region用`\n`；進入非空ruby run前用`\n\n`，ruby run結束後若還有其他頁域亦用`\n\n`。ruby內按owner欄序及沿欄位置排列，以`\n`相接；沒有ruby就不插入特殊分隔。
4. 原region的text、polygon、confidence原樣保留。空行只屬page.text分隔，不建立空box、不合成「註音」標題、不刪改原字。
5. 單一permutation同時產生boxes、regionConfidences、page.text；分隔邊界表只在內部。投影前再次驗證數量、配對及文字長度上限。
6. 已確認全橫排控制頁維持原順序及既有文字格式；頁界與`page-N`身分不變。

示意（`T(id)`只是原框原文的記號）：`T(題幹)\nT(A)\n…A正文…\nT(A署名)\n\n…A註音…\n\nT(B)\n…B正文…\nT(B署名)\n\n…B註音…\n\nT(頁底注)\nT(頁碼)`。不存在的ruby run及特殊分隔省略；記號本身不寫入OCR輸出。
**能力界線：** polygon保留回圖位置；空行只供人閱讀，不提供機器ruby role／owner，也不能反向用空行解析角色，原字串本身可能含換行。若要角色查詢／可逆owner，另做worker、projection、SDK、Cert、LAW的結構化契約設計。

### 消費端風險

- Cert：projection.page.text用於`raw_text`；分類與line metadata使用document blocks的reviewed／target text組成`source_text`。runtime page.text經raw segments／structuring可間接影響分類，不能稱直接分類projection.page.text。[L13][L15]
- Cert會忽略空行或合併whitespace，題組解析沒有ruby排除規則；每篇追加只是待驗證的呈現選擇，不能保證不污染題目／選項。[L16]
- LAW receipt保存page.text與有序boxes，不因此取得角色或關聯欄位。[L14]
- 真實輸出須通過保存／讀回及題組解析；新增污染即阻擋交付，schema通過不等於實益成立。

## 4. 最小內部資料模型與接點

**[計畫]** 保留`analyze_reading_layout(page, *, cancelled) -> PageReadingPlan`，接在嚴格normalization後、`OcrTextResult`聚合前；可新增小型`ocr_reading_layout.py`，不建立通用solver框架。[L1]

- `SourceKey=(run_key,page_key,raw_result_slot,raw_region_slot)`；normalizer略過空字串前記來源slot，私有wrapper／對應表隨region傳至排序接點，不加入公開box。
- `ValidatedSource`只持來源鍵與完整`OcrRegion`；角色、文章、欄及關聯留在內部分析結果。來源text不做NFKC或去重。
- `PageReadingPlan`包含完整permutation、內部文章／ruby分隔邊界、規則證據、issues及內部`policy_id`；**沒有Slice、字元span或衍生polygon**。
- assembler由同一plan組裝各表示；有效非空來源恰出現一次，重複字串不可用text hash合併。
- raw slot與normalized ordinal須明確命名；跨baseline／epsilon、CPU／DML不按裸index配對。
- 原始空框另作研究計數，不加回公開regions；型別、score、polygon、bounds、數量仍先驗證再略過空文字。[L1]

**[事實]** p14 raw為`return_word_box=false`且無`rec_word_info`；產品`pipeline.predict(str(path))`未請求／消費字框。`cal_ocr_word_box`依賴上游已有word information，不是任意region直接取得字框的現成產品能力。[L1][L5][L17]
composite從原圖盤點，分正文＋ruby合框、跨欄合框及可分離whole-region案例。保留整框不代表角色分離成功，來源帳本完整不能抵銷正文不完整。

## 5. 第一個policy：先寫可檢查規則

內部名稱可用`whole-region-rules-v1`，不新增公開profile開關。規則／容差按development文件凍結；使用局部欄寬、欄距，不將p14的44 px或20 px寫成跨DPI常數。

### A. 局部欄寬與欄距

由同一候選文章中多個正文欄的方向、寬度與鄰欄距估計局部尺度，不以最窄框或全頁平均作正文字級。
主欄錨點、短欄與小字候選分開記錄，防止ruby污染尺度；欄距容許缺欄及偏差，p14間距並非全部相等。
單獨高寬比不決定文字語言、角色或欄間方向；候選建立／拒絕理由可記研究診斷，但不提早輸出未驗證文字。
從已確認主欄的起點群估計局部欄首帶，容許約一個正文字級的縮排及偵測抖動；按局部尺度校準、凍結容差，不寫死20／24 px，也不把所有候選的min/max包成大帶。
署名、ruby及待判短框不參與欄首帶估計。多個不同起點群須先判文章內段帶，不能任意擴寬欄首帶吞入左下署名。「約一字」是首個policy待驗證條件，不是所有排版的定律。

### B. 頁域、文章與附屬內容

用主欄y範圍、欄距、空白走廊及已有raster的外框／分隔線提出文章範圍；框線分析限有界像素工作，不新增模型或修改辨識裁切。
同篇允許欄首縮排及極短末欄；不能先按全頁y排序，把y=970的欄丟到整篇末尾。短註音不能作連接兩文的橋。
上方題幹、框外A/B、左下署名、下方選項／頁底注建立附屬關係。上下不重疊頁域按y；並排文章、欄範圍重疊及雙頁須先判頁域／方向，不能宣稱全頁y排序可解所有混排。
混排頁的橫排區域按行次及行內x遞增；原本正確的全橫排頁保持identity permutation。

### C. 短正文欄、同欄碎片、署名與ruby

- **獨立短正文欄**：須同時符合文章／段帶歸屬、局部正文欄寬與欄距，且頂端落在其局部欄首帶；不能只因少字／假名抽走。p14的30在31左一欄且頂端在帶內，讀序31→30；它不是同欄碎片。
- **同欄碎片**：另走續接規則，下段不要求回到欄首帶。必須同頁域、同文章段帶、同x欄帶、沿y連續，且無段帶分隔或競爭連接；x對齊與小y-gap單獨不足。真正同欄多框才按y排，不能跳過上段其他欄。
- **署名／來源行**：聯合檢查末欄外側、文章下區、獨立來源行的空間歸屬，並排除已確認同欄前段及其他文章的競爭歸屬。p14的25／43由原圖確認為署名，輸出在各篇正文後，不參與正文欄序、欄距或欄首估計。括號／文字只作輔助，不硬編碼報紙名稱。
- **晚起但未解的框**：不符合欄首帶、又未確認同欄續接時，不能直接改判署名或ruby；可能是晚起正文、側注或另一段帶。保留歧義並計入未通過，不以強制分類提高覆蓋。
- **ruby**：相對正文較窄、靠近側緣、沿正文方向有合理重疊／外溢，且不符合另一正文欄的尺度／欄距。x相交、接觸、小正間距都可進候選，不要求正間距，也不以相交單獨定案。
- 記有號側距及x交集，例如右側`g=ruby.x_min-body.x_max`，p14為負值仍合法；容差以local scale凍結。反側／雙側不能因側別一項直接刪除。[P1]
- 多個owner合理或角色規則衝突時列歧義；不能先刪競爭者再宣稱唯一。署名、框外標號、小字頁眉也要排除；文字只作輔助，不按預期題號改字。

**已核對的續接負例：** Bunka p2 baseline raw8 `[494,102,514,406]` 與39 `[494,431,516,737]` 同x且y-gap只有25 px，原圖卻是上下不同橫向段帶，不能直接8→39而略過上段其他直欄。[L21]
真正正文的同欄上下碎片正例仍待補。作者姓名／出版欄分框只能驗附屬文字，不能替代正文正例；p14的31→30也不能充數。

### D. 順序與組裝

已確認的日文直排文章按欄x由大至小；每欄辨識字串照原樣使用，不倒轉字元。真正同欄多框才按y由上至下。
建立簡單typed precedence：題幹→文章、文內欄序、正文→署名、文章→下方題目／選項；再依第3節插入各篇ruby run。
矛盾、循環或會改變正文／題組的未決順序列issue，不任意刪邊。決定性tie-break不是語意證據，runtime不讀金標、手工欄索引或頁碼oracle。
全部來源一次保全、完整tuple對齊與分段輸出通過後才提交。

```text
sources = validated_sources_with_raw_slots(page)
domains = group_page_domains_by_geometry_and_bounded_raster(sources)
articles = fit_local_column_rules(domains)
roles = classify_whole_regions_with_explicit_rules(articles)
plan = order_domains_columns_and_per_article_ruby(roles)
validate_complete_permutation_and_relations(sources, plan)
check_cancelled()
return assemble_text_boxes_and_scores_from_one_plan(sources, plan)
```

### E. 規則不足時的研究順序

先比較geometry rules與加入有界raster線索的收益，記錄是哪條規則／哪種候選漏配；首個模組不放成本函數、beam search或通用joint solver。
只有規則版未達凍結文件門檻、且錯因確為歸屬競爭時，才另開後續weighted/joint研究；它不進本階段，也不是執行期fallback，不偷換policy沿用舊驗收。
留出失敗被看過後，不再作新policy的未見留出；保留失敗報告並另凍結獨立文件。字框、Slice、再辨識、新模型仍不進第一階段。
若必達需求只能靠排除能力，先呈現缺口及另階段成本，不宣稱整框版達標。`line_height_iou_threshold=0.05`已因語意錯序淘汰，不恢復為調參方向。[L10]

## 6. 先凍結影像金標與回歸清單

**[計畫]** 從raster人工獨立重標並另人複核；記PDF SHA256、PDF 1-based頁碼、印刷頁碼、raster hash／尺寸、run ID及raw→normalized映射。PDF文字層、候選輸出、舊手工索引都不是金標。
標全文文章／欄歸屬、上下頁域、正文／ruby／署名／標號、允許偏序與題目／選項關係；另標空框、漏偵測、合框、既有錯字。格式預期與影像逐字真值分開保存。

| 必納回歸材料 | 頁／角色要求 | 本輪證據狀態 |
| --- | --- | --- |
| 官方`jlpt-n1-p14` | 兩文、題幹3–4、A/B、兩署名、ruby、頁眉「N 1」、頁底注及印刷頁碼20全部標註；OCR原字如`-20—`不改成理想字形 | 已重算raw及看原圖，尚無獨立金標 |
| `【1】2023年12月N1 真题.pdf` | PDF第16頁直欄＋下方選項；全文件盤點其他必達頁 | Grok已看過／指定回歸；本輪未重新取得逐頁原圖或凍結金標 |
| `【1】2024年07月N1 真题-版本1.pdf` | 第16頁直欄＋下方問題48；第2頁全橫排，順序及格式不變 | 本輪看了retained original-p16／p2；仍需凍結整份材料與金標 |
| `【1】2024年12月日语N1真题-版本1.pdf` | 第16頁全橫排長文控制，順序及格式不變 | Grok已看過／指定回歸；本輪未重標 |
| `【1】2025年07月N1 真题.pdf` | 第16頁直欄＋下方選項；全文件盤點其他必達頁 | Grok已看過／指定回歸；本輪未重標 |
| 正文同欄上下碎片 | 另找至少一頁原圖／raw可確認的正文續接；下段頂端超出欄首帶仍應在本欄正確接續 | 尚待找到、重標及凍結；不得以署名／姓名碎框替代 |
| Bunka p2跨段帶反例 | baseline raw8／39不能因同x與25 px間距直接續接，須先完成上段欄序 | worker已核對原圖／raw；尚待獨立金標。[L21] |

四份N1均已參與設計，只作development／回歸；它們不等於53頁corpus。後者含原44頁、官方樣本3頁、Bunka6頁，不能宣稱四份試卷皆已驗證。[L8][L18]
Grok報告四份PDF文字層亂碼或缺失，本輪未逐份重驗；金標一律取影像，不依賴此主張是否適用每頁。[L18]
調參前另凍結**至少兩份未參與設計的完整文件**與人工標註，按整份文件隔離並防止近似掃描／模板洩漏；這是最低門檻，非統計保證。
另含橫排／表格、小題號、相鄰文章、短多字欄、署名、無ruby小字、正間距／重疊ruby、旋轉Latin、雙頁及密集框負例；合成案例不替代真掃描。

## 7. 計分、fixture與交付門檻

- **保全**：有效非空ID多重集合相同、各一次，原text／polygon／score成組不變；scored/no-score遵守既有契約。
- **讀序／角色**：分開量整篇正文順序、文章錯合／錯拆、短欄誤當ruby、ruby owner、題幹／選項／署名／頁碼位置；分母包括漏分組、未改善、歧義、composite，不只已接受群組。
- **辨識**：影像有文字但無有效輸出才計漏辨；空辨識、非文字誤檢另列。slot24不先計成漏字，空字串契約不改。
- **字元誤差**：固定正確順序後分別計正文／ruby CER；重排降低sequence edit distance不等於辨字改善，移出ruby不能充當降低錯字。
- **控制／穩定性**：全橫排identity；平移、均勻縮放、輸入列舉置換但保留source ID，在不改真實布局時結果等價。另量候選owner漏配率，不能只看有無飽和。

先完成獨立金標再設prototype gate；p14舊手工序列不可直接bless。必達混排頁任一錯改或未解即未通過，不能以平均收益抵銷。
模型／profile設定維持既有值、不加排序開關，但同一模型設定下輸出順序／換行會變。`releaseVersion`綁runtime version，不能承諾正式升版後完整profile ID不變。[L19]
盤點鎖住舊左至右輸出的golden，只更新經金標與tuple保全證實的排序／格式差異，不批次重產schema、invalid corpus或無關fixture；舊normalizer橫排行為斷言維持。[L20]
Cert分別驗raw_text保存、document blocks／reviewed text、line metadata、分類及題組／選項解析；LAW驗text／boxes保存讀回。先列預期差異，不拿候選輸出直接當答案。

### 明確的JLPT解析驗收

**[事實]** `parse_jlpt_question_blocks`的題組regex使用`re.DOTALL`，文字清理會合併whitespace；空行不會自動隔離ruby。沒有匹配，或候選缺有效題幹／四選項時，都可能沒有解析結果。[L16]
實際`extract_jlpt_question_blocks`以`SourceChunk.raw_or_text()`呼叫解析器，優先raw_text；這條mock-exam路徑與mapping使用source_text分類是不同分支，兩者均須覆蓋。[L22]

- 至少一個有已辨識ruby、完整題號／題幹與四選項共存的真實頁／consumer chunk作正例；由影像先凍結預期題數、題號、題幹、四選項及題組關係。p14主要是文章頁，不能單獨滿足此正例。
- 比對候選page.text的解析結果，以及保存後實際SourceChunk走正式入口的結果；核對完整stem／choices及group欄位，不只檢查函式不拋錯、回傳非空或source_excerpt。
- 預期有題目的正例回傳`[]`或漏題即失敗；本來無完整題組的頁另驗不憑空造題，不能用空結果宣稱無污染。
- 用完整預期欄位與來源歸屬判定ruby有無誤入題幹／選項；不能粗略要求某段假名永不出現，相同字串可能本就屬合法正文。
- 對照當前基準與候選，區分既有漏辨／解析限制及新增污染；不刪ruby、不跳過驗收，也不為通過而在本輪默改解析器。

獨立完整文件上以當前基準／候選做fresh inference，CPU／DML分開驗收；retained replay不是新推論，更不是packaged／installed證據。
最後走packaged worker→projection→主要消費端顯示／保存／讀回，完成其他受影響契約驗證；plain-text表示不能維持實際實益時仍阻擋發布。

## 8. 取消、資源與變更邊界

取消沿既有InterruptedError／失敗路徑；在像素／候選批次、排序與提交前檢查，不能catch後回成功原序。metadata錯誤與程式異常也不能吞成語意歧義。[L9]
契約容許每頁100,000 boxes／8,000,000 text chars；空間索引與有界鄰居目標`O(N log N + kN)`，不建全連接N²矩陣。[L3]
像素tiles、候選數、操作／記憶體預算依裝置及密集樣本量測後凍結；截斷／飽和留issue，必達頁超預算未通過。不得靜默改CPU重試或新增OOM／逾時。
整框重排不增減分數樣本或重加權；projection既有公式為`round(sum(region_confidences) / len(region_confidences), 4)`，維持此數值契約，驗收檢查重排浮點求和的邊界，不承諾bitwise相同。[L2]
只回報已驗證進度，terminal validation前不公布raw text或成功。本輪只改兩份研究筆記；產品實作、金標、fixture更新與各項驗收均尚未執行。

## 9. 來源

- [P1：W3C JLReq固定2020版，ruby側別／overhang](https://www.w3.org/TR/2020/NOTE-jlreq-20200811/)
- [P2：PaddleX v3.7.1 layout_objects.py](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/layout_parsing/layout_objects.py)
- [L1：adapter／normalizer／predict](../../packages/capture-runtime/src/capture_runtime/engine_adapters.py)
- [L2：page序列化與projection](../../packages/capture-runtime/src/capture_runtime/ocr_projection.py)
- [L3：公開contracts](../../packages/capture-runtime/src/capture_runtime/contracts/__init__.py)
- [L5：p14 baseline raw](../../tmp/research-vertical-japanese/v3-validation/raw/ocr-dml-jlpt-n1-p14-baseline.json)；[epsilon raw](../../tmp/research-vertical-japanese/v3-validation/raw/ocr-dml-jlpt-n1-p14-epsilon.json)
- [L6：p14原圖](../../tmp/research-vertical-japanese/v3-validation/images/jlpt-n1-p14.png)；[疊圖](../../tmp/research-vertical-japanese/v3-validation/overlay-dml-jlpt-n1-p14.png)
- [L7：p14 baseline audit](../../tmp/research-vertical-japanese/v3-validation/audit/dml-jlpt-n1-p14-baseline.json)
- [L8：53頁清單與影像身分](../../tmp/research-vertical-japanese/v3-validation/cases.json)
- [L9：worker取消／observe／terminal](../../packages/capture-runtime/src/capture_runtime/workers/ocr_main.py)
- [L10：來源交接，0.05已淘汰](../../tmp/research-vertical-japanese/opus55-source-handoff.md)
- [L11：本機CropByPolys，177–207行](../../packages/capture-runtime/.venv/Lib/site-packages/paddlex/inference/pipelines/components/common/crop_image_regions.py)；[官方對應位置，本輪抓取失敗](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/components/common/crop_image_regions.py)
- [L12：worker封閉欄位與分數配對](../../packages/capture-runtime/src/capture_runtime/worker_client.py)
- [L13：Cert raw_text／source_text mapping](../../../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py)
- [L14：LAW receipt](../../../gx.law-prep/apps/law-prep-ai-service/src/app/ocr/receipt_payload.py)
- [L15：runtime page segment](../../packages/capture-runtime/src/capture_runtime/extractors.py)
- [L16：Cert文字清理與題組分類](../../../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/domains/exam_content.py)
- [L17：本機word-box來源](../../packages/capture-runtime/.venv/Lib/site-packages/paddlex/inference/pipelines/components/common/cal_ocr_word_box.py)
- [L18：Grok四份N1版面記錄，非本輪驗收](../../reports/直排日文%20PaddleOCR%20研究.md)；[本輪看p2](../../tmp/research-vertical-japanese/v3-validation/images/original-p2.png)；[p16](../../tmp/research-vertical-japanese/v3-validation/images/original-p16.png)
- [L19：固定模型、profile keys及releaseVersion](../../packages/capture-runtime/src/capture_runtime/ocr_profile.py)
- [L20：normalizer測試](../../packages/capture-runtime/tests/unit/test_paddle_result_normalization.py)；[worker測試](../../packages/capture-runtime/tests/unit/test_ocr_worker.py)；[projection測試](../../packages/capture-runtime/tests/unit/test_ocr_projection.py)
- [L21：Bunka p2 baseline raw](../../tmp/research-vertical-japanese/v3-validation/raw/ocr-dml-bunka-archive-p2-baseline.json)；[原圖](../../tmp/research-vertical-japanese/v3-validation/images/bunka-archive-p2.png)
- [L22：Cert正式JLPT解析入口](../../../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/deterministic_parser.py)；[SourceChunk.raw_or_text](../../../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/domains/mock_exams/models.py)
