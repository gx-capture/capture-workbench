# 直排日文 OCR Phase 0 實作與證據紀錄

狀態：**進行中，Phase 0 尚未通過。Phase 1 已依使用者 2026-10-02 指示啟動，進度見
[Phase 1 紀錄](vertical-japanese-ocr-phase1-implementation-2026-10-02.md)；Phase 2–3B 未啟動。**
依 [使用者已核准規格](../SPECS/vertical-japanese-ocr.md) 執行。
來源 HEAD：`648d042b11f663a7c4932f97caf13adccbd22004`；本輪新增檔案尚未提交。

## 已實作的研究接點

- `packages/capture-runtime/scripts/ocr_benchmark.py`：同框集合評分、原始 slot、
  tuple 保全、讀序、role／article／band／owner、精確格式與獨立正文／註音 CER。
  候選宣稱的角色不能改變 CER 分母或分流；空參考有插字時保留 edits，CER 為 null。
  `passed` 僅表示該觀測的整框版面檢查，不能代表全文辨識品質或階段驗收。
  已增加明確列舉的 `allowedOrders`：每一項必須是完整來源集合的排列，且包含 canonical
  `order`。只接受列出的排列；文字必須與採用排列及逐篇空行相符。此功能處理頁面側欄
  metadata 的容許位置，不會忽略正文錯序。全文 CER 仍對 canonical 轉錄計算，屬診斷。
- `ocr_benchmark_runtime.py`：統一 PDF／既有 raster／合成 raster 材料入口，呼叫現有
  canonical profile、模型驗證、Paddle factory、PNG prediction、strict normalizer
  及 DML execution-evidence adapter。沒有修改產品 OCR 行為，也沒有另設產品管線。
- Nx `capture-runtime:test-ocr-benchmark` 與不快取的 `capture-runtime:ocr-benchmark`。
  CLI 包含 `freeze-materials`、`baseline`、`score`、`synthetic-variants`；
  證據目錄不可覆寫。另有 `ocr-benchmark-render`，只建立本機合成圖片。
- 推論紀錄包含源碼檔案快照、HEAD、profile／模型／輸入雜湊、原始 OCR、每次 observation
  與記憶體。送入 predict 的同一份 bytes 會重新核對雜湊；必要清理成功才寫 completed。
- 新增 `analyze_atomic_order`，只分析獨立影像綁定所給的來源字串 spans。逐一檢查
  允許排列、半開區間、重疊與涵蓋狀態；同父框的相鄰順序可行，跨框插入後再回到同
  父框、或同父框文字反序則不可達。不把互斥排列的限制混在一起。資料不完整但無
  矛盾時回 `incomplete`，不會當成通過；局部反證足以回 `infeasible`。
  此接點不推測切點、不進 runtime，所有結果均有 `phasePass=false`。

## 本機材料

證據根目錄：`tmp/vertical-japanese-ocr-phase0/`，不是發布資產。

| 材料 | 狀態 |
|---|---|
| 四份指定 N1 | 已凍結全部 167 頁 |
| 官方 N1 p14／p19／p26、Bunka 六頁 | 已凍結 9 頁 |
| 合計 | `materials-02/manifest.json`，176 個頁面 |
| 既有 53 頁 | 依 PDF hash＋頁碼對回；53／53 PNG bytes hash 相同 |
| P1／P2／P3A 留出候選 | 各兩份，共 88 頁；Astra 獨立保管，Root 未開其內容 |
| 留出資格 | 全頁目視內部連續性、精確去重及近重複候選複核完成；全文件金標未完成 |
| p14 影像金標 | Astra 獨立轉錄 45 個 blocks；Root 全圖逐塊複核，另存 cross-review |
| 四份 N1 的指定控制／直排頁 | 2024-07 p2／p16、2024-12 p16、2023-12 p16、2025-07 p16 已完成影像轉錄及交叉複核；跨頁歸屬、側欄排列及 source binding 狀態分列，未宣稱完整文件金標 |
| 2024-12 控制頁相鄰 p15／p17／p18 | 新增 71 個 blocks 的影像轉錄、第二位 Astra Ultra 全頁先看圖再比對之交叉複核與獨立裁定；已建立第 55–59 題的明確跨頁關聯 |
| 2024-12 全部提供頁 | 27／27 頁雙讀者影像複核完成，704 blocks；第 1–66 題四選項與跨頁連結已核對。來源框綁定與 consumer 驗收仍未完成 |
| 2023-12 全部提供頁 | 50／50 頁雙讀者影像複核完成，1,214 blocks、305 ruby blocks；66 題各四選項與 owner 參照完整性通過。完整來源綁定與語意 gate 仍開放 |
| 真實同欄正文碎片 | MEXT 2019-07 兩頁七組正文條列尾語正例經獨立確認；CPU／DML 各 14 片段已綁定。僅此子型態，不宣稱多字下段或任意句中碎片已覆蓋 |
| 2025-07 全部提供頁 | 46／46 頁雙讀者影像複核完成，1,055 blocks／308 ruby blocks；包含既有 p16。仍待完整 OCR source binding／CER 分區及 consumer 驗收，並非 Phase 0 PASS |
| Bunka p2 | 六段帶、108 正文欄已全文轉錄及交叉複核；正文 1,976 字元。一項字面及一項 bbox 修正已獨立確認，另有一個引用標記 `1／i` 無法確定；不能宣稱完整金標或完整頁 CER |
| 合成材料 | 六種版面各四種變體，共 24 張；已完成 CPU／DML 基準推論 |
| 正文同欄碎片正例 | 仍待獨立確認；不能用相鄰欄、署名或跨段帶框代替 |
| 補充碎片搜尋 | 文化廳月報 001（1 頁）、117（13 頁）及文部時報 1277 摘錄（13 頁）已凍結、DML 推論；僅作開發搜尋，不混入留出集 |

留出文件的公開資料只讀 `holdouts/public-manifest.json`；`custodian-private/`
由獨立標註者保管，不供政策開發者提前檢視。六份所提供版本均未見內部缺頁；無連續印刷
頁碼，未聲稱已證明官方原本完整性。限定本機歷史搜尋沒有原檔名／完整 SHA 命中，不能
證明未留紀錄的外部歷史。共用試卷版式本身不判為內容洩漏。

p14 複核確認署名是「中央経政新聞」，而非先前建議的「中央政経新聞」。三個 A 文短欄、
B 文短欄、兩個署名、兩組 ruby、題幹、框外 A／B、頁底注及頁碼都納入。原始 slot 24
仍記為空辨識觀測，不回收成有效框；它不算候選讀序漏框。

## 執行與證據邊界

- 本機五個 canonical 模型資產由既有快取複製至隔離研究目錄；大小及完整 SHA256 均符合
  0.4.4 canonical profile，profile bytes 原樣保留。
- `runs/dml-development-01/`：176 頁推論完成。兩個 session 各自取得 DML node 證據，
  合計 219,310 DML／1,974 CPU nodes；CPU nodes 是同一 DML session 的既定 provider
  分配，沒有另開 CPU retry。這批使用增量審查修正前的 runner，保留其實際源碼快照。
- `runs/cpu-development-01/`：176 頁推論完成，有 completed 紀錄且程序成功退出。
- `runs/dml-repaired-smoke-01/`：修後 runner 的三頁重驗（p14、橫排對照、Bunka p2）。
- `bindings/` 與 `scores/`：p14 baseline 與完整來源集合的人工排列 oracle。oracle
  不丟 ruby／noise、不改字，是診斷上限；不代表演算法已完成。
- 本機計時範圍是 PNG prediction＋strict normalization，排除 PDF raster／IPC；
  pipeline 初始化也不是完整產品冷啟動。尚不能用它通過使用者要求的整條產品資源門檻。
- `hardware.json` 保存本機 CPU、兩個 GPU、驅動與 RAM；研究 DML 要求 device 0，
  現有 ORT provider-options 未回讀 ordinal，不聲稱具有安裝產品的 adapter 身分證明。

`runs/{cpu,dml}-resource-02/` 已完成並逐筆確認每頁 22 observations：兩次 warmup、
20 次 timed，p95 使用 nearest-rank。三頁依次為 2024-07 p2、官方 p14、Bunka p2：

| provider | 橫排 p2 p95 | p14 p95 | Bunka p2 p95 | 程序記錄峰值 Working Set |
|---|---:|---:|---:|---:|
| CPU | 3.1515 s | 5.3842 s | 10.0724 s | 1,313,378,304 bytes |
| DML | 1.2126 s | 2.0043 s | 4.3374 s | 3,878,952,960 bytes |

此為研究推論／profiling 程序的基準，不能代替整個產品 worker 路徑或 Phase 1 相對資源
上限。先前 `resource-01` 額外做過一次先行 observation，只保留為歷史診斷；02 已修正。
02 runner SHA256：`3f48f1030ca92f1a1cdde61b64e06c07e9550d71624ef865c371d03e868b23f6`。
CPU completed SHA256：`3836044668e14259f8a3ac20b1f4433a240055d26297feac0a3b1e429c6c4a7d`；
DML completed SHA256：`feafd2f1b70a11e1b7862860fa9dae1bceb534832fa3f00db63754cff7da508f`。

`scores-03/` 用新增原子框診斷後的 scorer 重播三頁共 12 份綁定；原排序評分邏輯未改，
CPU／DML 相同：

| 頁 | baseline 正文 CER | 完整來源集合人工排列正文 CER | oracle 註音 CER |
|---|---:|---:|---:|
| 官方 N1 p14 | 561／651（86.18%） | 82／651（12.60%） | 0／6 |
| 2025-07 p16 | 170／201（84.58%） | 6／201（2.99%） | 無註音，0 edits／0 reference |
| 2023-12 p16 | 188／227（82.82%） | 17／227（7.49%） | 0／3 |

人工排列保留全部來源 tuple；2025 的第二至四選項各有獨立題號框及文字框，21 source
regions 對應 18 image blocks。已由 Astra 複核該綁定，無 slicing。這是排序收益的
診斷，並非候選演算法結果，也不是用 GT 篩框後的 oracle。2023-12 p16 的 22 框／
21 blocks 與兩種允許側欄排列已獨立核對。Astra 指出選項 `4` 不在任何輸出框內，
因此 v2 修正為 `unrepresentedImageSpans`，未知上游原因，不能定性為 recognition
omission；Root 改正後 Astra 再核對，已關閉歸因 finding。原草稿保留，來源 tuples、
金標文字與允許讀序皆未變，不補字、不虛構框。

## 消費端基準揭露與核准範圍

`consumer-probes/cert-p2-p16-01.json` 呼叫 Cert 的實際 `parse_jlpt_question_blocks`。
CPU／DML 的 2024-07 p2 與 p16 原序和完整來源集合 oracle 均解析出 0 題；影像轉錄
診斷分別能解析 6／1 題，卻把頁碼吃進最後選項。原始 OCR 漏失第一選項標記，整框排列
無法補字；p2 又必須維持橫排 identity。因此僅有題數或文字 anchors 不能通過語意驗收。

使用者已明確批准把「Cert 解析器相容性修正」加入 Phase 1，保留嚴格金標、runtime 不改
字及完整 tuple 不變。已同步到規格與決策稿；Phase 0 通過前不開始此產品修正。上述
probe 只涵蓋正式解析函式，不代表傳輸、UI 或保存讀回通過。

補充 `consumer-probes/cert-cross-page-2024-12-01.json`（SHA256
`e3d71608bcaa74d073e1790cb0dbd6b68a5db9c591587835283614ad60aef27c`）：
使用 Cert 本機既有虛擬環境，呼叫實際 `parse_jlpt_question_blocks` 與
`extract_jlpt_question_blocks`，逐頁建立 `SourceChunk`，沒有拼接、修正 OCR 或修改
消費端。CPU／DML baseline 與已複核影像轉錄三種輸入，正式抽取入口皆未得到第
55–59 題中的任何一題。第 15／17 頁因沒有題組提示標記而被 chunk filter 排除；
直接解析 p17 的影像轉錄還會將第一選項標為題號 `1`，把第 57 題選項及第 58 題題幹
混入同一題，最後選項再混入第 59 題題幹。這是實際 domain entrypoint 基準缺陷，
不是推論出的產品安裝結果。已批准的 Phase 1 Cert 修正須涵蓋題號標點、無提示的
延續頁及跨頁選項邊界；仍以原圖金標驗證，不能只放寬題數。

三頁新草稿及 `.astra-ultra.cross-review.json` 保留原樣，另存 `.adjudicated.json`。
p17 四處修正為原圖字面：`大切てある`、`盛り上ける`、`満足するとなく`、
`足りなさ補いつつ`；Root 再看放大原圖確認，沒有依文法補字。p15 的三點省略符
用 U+2026 作明示轉錄慣例，非原始 Unicode 證明；CER 的既有 NFKC 規則會一致處理。
`annotations/n1-2024-12-p15-p18.document-links.json` 以頁名＋block ID 連結題幹及
四選項；p16/p17 的 A 與 p18 新題組的 A 不合併。完整文件仍未標完，這五題的
domain probe 尚待階段整體獨立審查，沒有宣稱 consumer gate 已通過。

2024-12 p16 原圖有三處容易依文法誤補的字面：`ても`、`で油断か出る`、`これに対して`。
Astra 從圖指出後，Root 保存原始 draft、cross-review 與獨立 adjudicated 檔及雜湊鏈，
未覆寫初稿。2023-12 p16 已確認 `あらわ` → 首欄 `露`，並有完整四選項；侧欄 `読解`
已接受兩種 metadata 位置（頁首後，或完整文章／註音後、題目之前），不打斷正文或
選項。2025-07 p16 九欄轉錄無修正。這些均未充作整份文件 PASS。

Bunka 的原稿、cross-review、adjudicated 三份並存。Root 從同一凍結 PDF 以 scale 6
重繪疑義字，Astra 再獨立看圖，確認 `left-upper-col-19` 應為 `配室`（可見酉／己部），
以及 col14 框頂須由 y145 改為 y103 才包含原圖 `く、し`。引用標記仍保留 `text=null`，
未算成空字。adjudicated SHA256：`7a715711bafe1598462d34c8ba822b92be3333eb1b3cb95d30017ca5dfd05fef`。

## 跨段帶合框反證與已核准範圍調和

Bunka p2 的 CPU／DML 原始 slot 21 都是同一長框，字串長 37 個字元（原文不收錄於本紀錄）。
前段屬左頁上段第一欄、後段屬中段第一欄，正確影像順序必須在兩者間插入上段其餘
22 欄。只取 slot 20 `ない。` 就得到 `21≺20` 與 `20≺21`，整框排列無解。
Root／Astra 皆從圖及兩 provider 原始觀測確認；這與另處不清楚的引用標記無關。

使用者已核准保留 Bunka 必達，加入限定跨段帶合框處理研究與驗證。規格的普遍
「不可切框」限制僅由這項受控例外取代；普通框仍保留完整 tuple，不能放寬金標、
刪除 Bunka 或用 Phase 2 收益補抵。人工分界 `[0,19)`／`[19,37)` 僅為反證材料，
不得用於 runtime 規則。原始 proof、獨立審查及使用者決策分開保存：

- `scope-conflicts/bunka-atomic-cycle.json`：SHA256 `426e60c15910ee4b02e01e79b4b6546626f0fe5ce12fecb18389053df1893b89`。
- `scope-conflicts/bunka-atomic-cycle-adjudication.json`：關閉範圍決策，未宣稱自動處理可行。
- `scope-conflicts/bunka-atomic-order-replay.json`：新診斷器重播兩 provider 全 120 來源，
  只綁定三個已複核影像 blocks；結果 `infeasible`、`coverageComplete=false`，不冒充完整金標。

Astra 對本機 PaddleOCR 3.7.0／PaddleX 3.7.1 與現有消費契約的有界唯讀審查結論：

| 審查欄位 | 結論 |
|---|---|
| publicReasoningSummary | 可研究同次辨識私下保留 CTC 字元位置與真實座標轉換，再結合段帶空隙；尚未證明自動分割可靠 |
| evidenceChecked | CTC decoder、recognition predictor、OCR pipeline、cal_ocr_word_box、crop；runtime normalizer、worker、projection、Cert／LAW |
| findings | 原 rec_word_info 有去重後字元 timestep，但 pipeline 沒保留；假名會成為同一 symbol 群。合成 AST 探針中十個假名即使中間 timestep 有大空隙仍只有一個跨隙 word box |
| blockers | 舊 observation 沒有足夠 alignment；沒有真頁盲測切點證據。模糊時保留父框仍使 Bunka gate 失敗 |
| risks | CTC alignment 不是精確字形框；字數比例、空白或連通元件不保證正確。子框沿用父分數並不等於已校準獨立分數 |
| missingDecisions | 使用者已批准研究範圍，不重問。研究候選採沿用父分數及現有輸出框算術平均，實際政策仍待驗證凍結 |
| suggestedMarkdownSection | 先驗無侵入的同次 alignment 擷取，再驗轉換、盲測切點、parent/span 保全與消費端 |
| writeRecommendation | 記錄可研究路徑與缺口，不啟動 Phase 1 產品或宣稱放行 |

`worker_client.py` 要求 boxes／regionConfidences 逐一一致，`ocr_projection.py`
依輸出框分數作四位小數算術平均。Bunka 此一分割如沿用父分數，120 框變 121 框，
兩 provider 的平均均由 0.9566 變 0.9567；這不是品質改善，不偷偷改成父框加權。
後續研究必須驗證：

1. 同次 alignment 擷取對原文字、分數、polygon 與模型呼叫數沒有影響。
2. 保留未縮放 timestep、有效寬度／padding／feature 長度、crop homography／旋轉，
   驗證正負傾斜、寬度上限及逆映射，不能由推算 word box 反推真實轉換。
3. 真頁盲測切點及假名、標點、重複字、正常長框負例；GT 只驗收，不進候選演算法。
4. 半開 spans 完整且無重疊地涵蓋父字串，父框不重複輸出；非法 alignment 不作成功退避。
5. CPU／DML、全橫排 identity、完整留出文件、Cert／LAW 保存讀回與分數含義皆獨立驗證。

## 合成材料重建

從附件選取六頁 HTML／CSS／原始文章，未套用整份 patch。`ocr-benchmark-render.mjs`
使用固定本機 Chromium、字型雜湊及 DOM 字框生成 1191×1685 clean 圖與高解析圖。
本機使用 Yu Gothic Regular 與 MS Gothic，並非 Claude 雲端 Noto；不要求重現其百分比。

Astra 先看六张 clean 圖，再讀 HTML 與 glyph ledger；2,941 個非空白字元逐序一致。
11 組、39 字的 ruby 已放大複核，六個署名可見，未見缺字、遮字或裁切。結論是
`approve_renderer_evidence`，不是 OCR 金標或 Phase 0 PASS。DOM 中 ruby 仍夾在正文，
不能直接當逐篇末尾註音的讀序金標；橫排頁的五題四選項還需獨立標出角色。

`ocr_benchmark_synthetic.py` 沿用附件的掃描退化參數：Gaussian sigma 1.1、對比 0.92、
偏移 12、noise sigma 7、seed 7、JPEG quality 55；生成 clean、scan、+0.8°、−1.5°。
正角為逆時針。所有字框四頂點均經實際高解析尺寸、像素中心／邊界換算及縮放轉換，
記錄正反矩陣；超出畫布即失敗，不 clamp 或丟字。這是研究輸入生成，不是 Phase 2
產品 deskew。六個新行為測試涵蓋非對稱多邊形、反轉換、尺寸取整、非有限值、重播與裁切。

目前證據在 `output/playwright/vertical-ocr-phase0-synth02/`、
`tmp/vertical-japanese-ocr-phase0/synthetic-variants-02/`、`synthetic-materials-01/`，
以及 `runs/{cpu,dml}-synthetic-01/`。02 補上 HTML／glyph ledger 完整雜湊與來源鏈；
Astra 確認六頁的 clean／hi／HTML／glyph 與 01 共 24 個檔案 bytes 相同，Root 確認
24 張變體 PNG 相同，因此既有 CPU／DML 原始觀測仍對應同圖，不因純 metadata 改善
重跑推論。變體已 24／24 完成獨立全圖視覺複核。最初三張另有 76 個字框放大檢查，
1,486 字框的獨立 OpenCV 幾何重算最大差 2.28e-13 px；其餘 21 張另放大 38 組 ruby／
137 字，10,278 metadata records 來源及邊界檢查一致，未新增裁切或遮字。補充檔為
`annotations/synthetic-variant-review.remaining.independent.json`，SHA256
`4c5f760226c3b155e1d963739bbd4021e238c28b2cb2da39230cf6e01e36cf47`。
這仍是 renderer 證據，未宣稱全部 OCR 語意金標已完成。

`scores-02/synthetic-baseline-full-cer.json` 已對完整 baseline 字串評分；不篩 OCR 框、
不手工重排 hypothesis。reference 從已核對 renderer 的 glyph ledger 依 block 次序
生成，逐篇正文／署名／ruby，全 2,941 字各一次；這仍是 generated-reference 診斷，
尚非完整獨立影像語意金標。CPU 與 DML 的六頁加總相同：

| 變體 | 全文 edits／characters | CER |
|---|---:|---:|
| clean | 1606／2941 | 54.6073% |
| scan | 1602／2941 | 54.4713% |
| +0.8° | 1594／2941 | 54.1993% |
| −1.5° | 1618／2941 | 55.0153% |

此結果支持原 baseline 讀序有明顯問題，但本機字型與雲端不同，且未執行 Phase 1 候選；
不能據此核准 Claude 的 5.34／2.93／2.69／12.34% 改善數字。Astra 已獨立重算全部
48 筆 CER，確認分母與各變體加總一致。

## 驗證與獨立審查

standard Nx lint／typecheck／unit／216 個 integration 已非快取通過。其後只修改
研究評分器與相關測試；最新 lint／unit 再驗通過：Python 732 passed、1 項既有 skip，
TypeScript 22 passed，包含 66 個 benchmark 行為案例。新增原子讀序診斷的 10 案先
觀察到預期失敗，再實作通過。允許讀序擴充先
見七個預期失敗；後續補測又抓到 alternate order 會把 separator 放首位而遺失的缺口，
已修正為每個允許排列均檢查非首位 separator，完整 suite 再通過。
typecheck 既有 target 檢查 src 與 TypeScript，未宣稱研究 Python 腳本全經 mypy。
後續內容變更仍須重驗受影響檢查；下列雜湊僅綁定先前那次三項修正審查。

Astra Ultra 增量唯讀審查發現並已複核關閉三項：

1. reviewer 欄位錯誤接受字串／dict；改為嚴格 list，正規化身分後檢查獨立性。
2. preflight 與實際 predict 的圖片 bytes 可能不同；改為驗證後直接送同一份 bytes。
3. completed 早於 pipeline 清理；改為外層 evidence context 在 cleanup 成功後才完成。

複核綁定 SHA256：

| 檔案 | SHA256 |
|---|---|
| `ocr_benchmark.py` | `3b9379ea9d79acdf76f8f4ceccac08217547e61c03870a1c107a5abd1d52a5b4` |
| `ocr_benchmark_runtime.py` | `f52a4cf3957fbc211e5d87b9ae52fe5e6f5a03415443128882bd0270954c4b83` |
| `test_ocr_benchmark.py` | `14b96ceb6a31d0a3fc0d0c29e9543a35ce8dc09eb56c242b28e1e3426fc6beb8` |

審查明訂：這三項修正沒有剩餘 blocker，但 **不是 Phase 0 PASS**；reviewer 名稱本身
不能代替實際獨立轉錄／複核。任何後續修改須重綁快照。

第四項 Astra finding 是只有 glyphCount、沒有 glyph bytes 雜湊，可能接受等字數的假
轉錄或不同多邊形。已改成先驗同一份 HTML／glyph bytes 再使用，加入四個實際竄改測試；
Astra 獨立重驗關閉。該次綁定 renderer `519f8c5135947d03a5cb1f575798f86eae085ea6dbeebd817782a1d41edae989`、
synthetic helper `3c2d8f6c8c07fb594d04e9c6f9cb7c49292426f28ae6d59312e19c6c868ad7ca`、
test `94df06f85576c3ead448fd5a164772d3dfdda9670d6b40190b1d97b4988a96ad`。
最新允許排列、resource-02 計時及 2025 source binding 已通過 Astra Ultra 增量審查：

| 審查欄位 | 結論 |
|---|---|
| publicReasoningSummary | 本次增量無新 blocker；Phase 0 仍未通過 |
| evidenceChecked | scorer `2a331fbd…`、runner `3f48f103…`、tests `203505fc…`；132 筆 resource observations、兩份 2025 binding、2023 sidebar proposal |
| findings | 完整排列、精確格式及 separator 檢查成立；每頁 2＋20 與 p95 重算相符；21 tuples 全保留且短欄／選項 owner 正確 |
| blockers | 本次增量無；Bunka 不清引用及全階段其他材料缺口仍在 |
| risks | alternate order 的全文 CER 只作 canonical 診斷；計時非完整產品路徑 |
| missingDecisions | 無新產品決策；2023 側欄 proposal 可採納，但須完整 source mapping |
| suggestedMarkdownSection | 增量審查通過、完整 Phase 0 尚未放行 |
| writeRecommendation | 保存精確快照審查及 binding 結論，不把 Bunka 或 Phase 0 標完成 |

完整紀錄在 `reviews/astra-incremental-allowed-order-resources-bindings.json`。scorer 完整
SHA256 `2a331fbd8b605f3f2b840de9461030c92e77ee16fca0f7b319616880fabd6f75`；tests 完整
SHA256 `203505fc147d626809564986b003e438bd7d8201e2cd6de47e9e9e0748851f61`。

材料凍結另補上複製後 bytes 驗證：request 讀一次後解析及雜湊，PDF／PNG 複本的
SHA 必須符合捕捉的來源 bytes／預期值才進解碼。兩個可正常解碼卻被 copy 篡改的
測試先失敗後修正通過；Astra 已核對此增量。重查既有 4 manifests 的 8 PDF／214 張
圖均與來源及紀錄相符（僅 3 份 PDF request 事前列出 SHA，不把 freeze-time hash
說成全部預宣告）。`reviews/frozen-material-integrity-recheck.json` SHA256
`2ab4d7cea88ef44737d72953d705066ad010c46269098688280ccac7e26dce07`。
runner 現在 SHA256 `317b610b672fabcbfb4c4ee11416f10b53f3229d01a3eadd41d82747e7618319`，
既有 resource-02 的舊快照不重標。新增的變體、CER、copy 修補、2023 歸因修正與 Bunka
反證 8 欄審查紀錄位於 `reviews/astra-incremental-03.json`，SHA256
`d4189a47ef688289706cd3f71b0b4734384cf766113c4eb4863b968173a25c2f`。

原子來源排序診斷另通過 Astra 精確快照審查。獨立枚舉 1,957 個完整／部分字元順序，
逐一比對所有整父框排列，零差異；兩個 provider 的部分反證亦重算一致。
紀錄：`reviews/astra-atomic-order-review.json`。審查的 scorer SHA256
`b45cc5d2fc1d496e5cc92fb810df7a6a3b2ecb9468b2937fb7de3387cca47b1d`、tests SHA256
`3f7a7e4e44ff30393670ccb7c4fa949e011f3a94e01674236e61293426965f43`、replay SHA256
`9553a15558839549220cdb4cf401ffc1b1678d8a2b64cbc38f78d79ddb7329c6`。
無新增 blocker；不是切框演算法、完整金標或 Phase 0 PASS。

## 完整文件影像複核增量

2025-07 的 45 份新首讀稿由 Astra Ultra 逐頁直接轉錄原圖，Root 每頁先讀原圖再比對
草稿；連同既有 p16，共覆蓋提供檔案的 46 頁。獨立複核索引：
`annotations/n1-2025-07-root-review/supplied-document-image-review.json`，SHA256
`729f02303a0bee570becf619908cda5b161822ceb0989f3d23cd96e631a90d05`。
首讀索引 SHA256 `0032ca2ef339affe4b94545820eb37c492ee310f96f8bbb8a6f386f6b6043f36`。
唯一裁定修正為 p14 註音「け」所指的「怪」是正文內第二次出現，`occurrenceIndex`
由 0 改為 1；原文字不改、首稿不覆寫。25 組閱讀題的跨頁文章／四選項連結及兩處
跨頁斷字已獨立核對，p25 先前待補的第 57–59 題位置由獨立 supplement 解決；第 48
題仍引用既有 p16 金標。提供檔案可見印刷頁碼 26→28、32→34、聽解 8→10 跳號；
不能把「46 個檔案頁均覆蓋」寫成「官方原本完整無缺頁」。也不從沒有提供的音訊推測
聽解題幹或答案。公開契約與產品 OCR 均未修改。

2024-12 p14／p19 的 Astra cross-review SHA256 分別為
`fae75de07b9cf0e79b61204c0d65c581b74819c792d88eea22dc1aeb768930ab`、
`712352261d163d28bc9e6e3ab7aa5f39b26bf6498f9d2a3866b25da1ef9718c5`。
Root 重新目視原像素側欄與放大選項，確認兩項修正，另存 adjudicated。擴充後六頁
第 53–61 題／跨頁選項／不同 A/B 文章身分連結在
`annotations/n1-2024-12-p14-p19.document-links.json`，SHA256
`6744bc923fb218590a2464c8e07e88eb78b1460d1ed0bc0e2b8535c573eee11e`。
後續全文件新增 21 頁均完成 Root 原圖先讀再對稿的複核（562 blocks），批次 SHA256
`7d39098255670bc2ed3aa4aa5fb8e13882164df93812e97b93a18df3df4a141f`。
包含既有六頁的完整影像索引為 `annotations/n1-2024-12-root-review/supplied-document-image-review.json`，
SHA256 `1abdcdbaf6abbf1b8158cbb61db30016d4bff99ed50f3b9358c301246b73415b`，
共 27 頁、704 blocks、無另列 ruby。第 1–66 題皆核對到完整四選項，88 個跨頁 owner
與 21 個既有頁面 owner 連結可追溯；聽解重新起號及兩個子題仍獨立表示，不推測音訊內容。
新增頁唯一字面裁定為 p9 `けれども` → 原圖無濁點的 `けれとも`，Astra 與 Root
皆再次看放大原圖確認；首稿不覆寫。p21 四處 `普遍的` 放大後確認首稿正確。
原稿中的印刷異常與缺少句點原樣保留，不將金標修訂算作 OCR 改善。此索引只關閉提供
影像的雙讀者覆蓋，來源框綁定、固定 CER 分區、完整 consumer 與 Phase 0 gate 仍未完成。

私有留出只記不含內容的進度：第一份 P1 15／15 頁已雙讀者複核，裁定 v2 仍有一個
字形身分不明的 `text=null`；v2 index SHA256
`ab6eb23ecb2d7f29b3df89358e8c2c8dcdb2e3820a51f262086180a83eaaeb6b`。
第二份 P1 16／16 頁第二讀者已完成（690 blocks），review index SHA256
`cf59f9f51a1bbc6bc1192445b9c48371cac8c570daad85512657bc0ab08e385e`；保管者另存裁定
初版 index `f666a5009c4e7faab6e8cc4427e54c07ac52a5451b40ded95679960890067327`
曾有一項真正字形身分不明的 null。後續同源 PDF 高解析重繪經原兩讀者獨立複核，
第二份 P1 的 current null 已歸零，另存 index
`f3197c9f45d6f20b4e218cd65c310a903fa739b37db085005862cedbfc88d5bf`、integrity
`d016113ce4abb6191975ff64749b073352404c8d9c59698f0ffd5fb5d1dd4e5f`。
第一份仍有一個 null；不刪除舊稿、不以猜測或排除該頁取得資格，另備完整文件候選。
P2 第一份 14／14 頁首讀完成（684 blocks），index SHA256
`be7cc0fb251c75098bbc5670de5fd1660ae3a0453bfdaddbc0590a70a5f7ee53`，待第二讀者。
P2 第二份亦完成 15／15 頁首讀（691 blocks），index
`76717ba95b8668fca97df2d2d2b7929a4d36e7a3e0a20bd45809aabd8b25fbee`；兩份均待第二讀者。
Root 未讀私有內容，留出金標仍未凍結。

## Cert 跨頁探針獨立重播

Astra 已用現有 Cert venv、三個正式 source module 的精確 SHA，獨立核對十二份
輸入、八份 CPU／DML observations、四份 adjudicated annotations 與既有 links。
`consumer-probes/cert-cross-page-2024-12-01.astra-ultra.review.json` SHA256
`a0c1ccf813116907faeccf80953d8653c200f3b3818e95a6ef17ce64e2f4cc82`。

| 審查欄位 | 結論 |
|---|---|
| publicReasoningSummary | 四頁逐頁 SourceChunk 的正式 domain API 結果精確重現；不是 transport／安裝版驗收 |
| evidenceChecked | 12 input hashes、8 observations、4 annotations、links、3 source hashes、每筆 direct parser／extractor 結果 |
| findings | CPU、DML、影像轉錄經 extractor 均為 0 題；GT p17 direct parser 誤從選項 1 起題、混入後續題文，但被 extractor 頁篩選擋掉 |
| blockers | 限定重播本身無阻擋事項；完整 consumer 資格驗證仍開放 |
| risks | GT 的 U+3000 選項空白規約影響 regex 命中；0 題不能單獨歸因 OCR，不能將 direct parser 錯題說成實際回傳建議 |
| missingDecisions | 無新增授權需求；使用者已允許 Phase 1 Cert 相容性修正，仍須驗證實際 chunk 組裝與跨頁歸屬 |
| suggestedMarkdownSection | 保留正式 extractor 與直接 parser 的不同結果及證據層級 |
| writeRecommendation | 引用獨立重播，保持原 probe 與嚴格金標，不標產品驗收通過 |

## 正式來源 worker 路徑量測增量

隔離研究 helper `probe_worker_path.py` 呼叫既有 `WorkerClient.run` 與
`workers/ocr_main.py`，不建立另一套 OCR 行為。三個代表頁以 PDFium 複製原 PDF 單頁，
重繪 RGB bytes 與原已凍結 raster 完全相同。量測涵蓋既有程序啟動、模型載入、PDF
轉圖、OCR、projection、JSON-lines 驗證與清理；HTTP upload／host persistence、
打包安裝驗收仍不在這個證據層。既有產品每個 job 建立新 worker，因此兩次 warmup
只暖 OS／driver caches，不冒稱重用 OCR session。

原生 preflight 選中 RTX 4060、DML device 1；保留真實 identity、adapter map 與
plan digest。先前直接 runner 使用 device 0，两批計時不得混為同一基線。CPU 研究
對照明確使用合法 CPU plan，另保留原生 GPU readiness，不偽稱硬體不可用。
三頁 source-worker smoke 的非空輸出為 37／45／120 boxes，且每次 owned worker
清理回零；尚不是完整資源或品質放行。

第一版程序記憶體探針只量到 Windows venv 啟動器，`source-worker-cpu-smoke-02`
的幾 MiB **不是 OCR RAM 證據**。v3 探針以 Windows Job Object 輪詢 owned PIDs，
保留 process handles 到退出後讀原生 lifetime peak。`source-worker-cpu-smoke-03`
已量到真正 OCR 子程序，所有最後查詢成功。**後續獨立審查撤回 v3 的完整 tree bounds
與同時取樣論斷**：輪詢未證明涵蓋短命子程序，逐 PID 的 Working Set 總和也非 atomic。
其原始欄位名稱保持供稽核，不能引用為嚴格上下界或完整 RAM 放行。03 CPU smoke completed SHA256
`43a19e8c94b29b024d95dba3dbf2c13409198b56bdfbc8b37c49dc80f455c112`。

v3 完整三頁各 2＋20 計時完成，CPU completed SHA256
`9922ad2a54ebc47fa2bac0dc21dfcbdc0089bfaf575bf9992d858c6148a6a181`；DML
`3cb54dae448c9c45e57eb3b60d80db12eb3b6cf157471d7a415dca367911e540`。
依橫排 p2／官方 p14／Bunka p2 次序，CPU p95 為 6.237／8.435／11.998 秒，DML
為 6.961／7.555／7.977 秒；只屬上述 source-worker 計時範圍。Astra 已獨立核對 135 jobs
（兩 provider 各 66 與 CPU smoke 3）、98-file source snapshots、原生 adapter 1 與所有
最後查詢。除了上述兩項 RAM finding，completion guard 只查 helper／provider／repeat，
未重驗完整 artifacts；最後 native query 成功也未設成 completion 必要條件（本批皆成功）。
審查阻擋完整資源放行，無新增使用者決策需求；八欄報告已先在工作階段轉述。
正式報告 `reviews/source-worker-resource-astra-01.json` SHA256
`67795e43ddbb943210d76acc27fdc8f2ebf34a2273672830b3c3e33707cc0419`。

修正版 `probe_worker_path_v5.py` SHA256
`5edc3371f3b03857b05ad0be72ca62ee718416f1edd635247ff2f9f054e3ae3d` 另存執行。
只在既有 `_terminate_windows_job` 入口短暫持有 query-only duplicate；原函式仍執行一次
Terminate／Wait／Close，之後讀 Job 累計程序数，在 finally 立即關閉 duplicate，失敗不吞
原異常。這短暫延長 Job 物件存活，須如實記錄，沒有在整段 OCR 期間持有額外 Job handle。
以 `TotalProcesses == observed PID count`、所有原生 peak 查詢成功及 process exit signaled
作必要條件；嚴格 lower 只取單程序 peak 最大值，upper 為已證明全覆蓋程序之 peak 總和。
逐 PID RSS 取樣總和僅列描述值；未蒐集 Job commit 指標，不能與 working-set RAM 混用。
這依據 [Microsoft Job accounting 定義](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)，
亦避免將持有 process references 時的 ActiveProcesses 數值逕行當作活程序證據。
CPU smoke 三頁通過，completed SHA256
`bbdf44ed05562e84bdd2fb4af79ca1200e35e3951ba3b43c4b86daaa3f71457a`；完整計時、
錯誤路徑與獨立修正複審另列如下。v3/v5 不混為同一基線，仍未通過 Phase 0 資源門檻。

v5 DML 三頁各 22 次完成，completed SHA256
`2d282ab421cf2525bd22a65ffef17c876ae2f1d22314d5e1129d4171e2896ae8`。
Astra 報告 `reviews/source-worker-resource-astra-02.json` SHA256
`22bd59870ec4062e97ded344869776b48724f69dfaa64556fda3ca040e895dd0`，核對 DML 66、
CPU smoke 3、全部 artifacts／統計及 28 個 mocks，仍找到兩項工具失敗路徑問題：
monitor assertion 可能蓋過原 worker exception；保留的 process handles 未檢查 CloseHandle。
成功記錄保留，失敗路徑未閉合前不定版，也不宣稱 mock 等於原生故障驗收。

v6 helper SHA256 `eaf591ca61617db7d9ef01f2478392b29510f864a29688e9a79819e07b8a11d8`
保留原 worker／取消異常為 primary，次生量測／shutdown 失敗附 note；逐一嘗試全部
process handles 的關閉，聚合失敗並拒絕成功 completion。Astra 的 39 個獨立故障
mocks 已通過；報告 `reviews/source-worker-resource-astra-03.json` SHA256
`f91635b87184889fd459bef7c07ae7faa520901e9bd473cc49928afea31677cc`。

同一凍結 v6 的 CPU／DML 各 66 jobs 已完成並由 Astra 獨立核對，各 166 artifacts 的
全部雜湊一致；98 個 source files、6 個 model assets 與 3 個輸入相同。CPU completed
SHA256 `04a151111f6b0a4fc254aad87fe93cba4a6042293edf11f322fce0eba867c5fb`；DML
`7bcc8bdd0d3e725e88678a867014d96896e80682705fdc692e068ac47999f71b`。
每頁排除前 2 次 warmup，20 次計時的 nearest-rank p95 如下。RAM 是 20 次中最大
程序工作集總和的原生上下界，以 bytes 表示，非 unique physical RAM／GPU／commit。

| 頁面 | CPU p95 秒 | DML p95 秒 | CPU RAM 下界–上界 bytes | DML RAM 下界–上界 bytes |
| --- | ---: | ---: | ---: | ---: |
| 2024-07 p2 | 5.186458 | 6.007423 | 1286737920–1299488768 | 964612096–977379328 |
| 官方 p14 | 6.908943 | 6.421282 | 1220526080–1233276928 | 819904512–832647168 |
| Bunka p2 | 12.600304 | 7.534751 | 1354301440–1367056384 | 1033129984–1045876736 |

每個 job 的 observed PIDs 與最終 Job TotalProcesses 都是 3，final native queries、
process exit signals 全成功，owned worker 清理回零。計時涵蓋 `WorkerClient.run`
及既有產品 cleanup；**不包含其後 final monitor drain／process-handle query-close
與最終 shutdown**。132 筆 `execution_proof` 都是 null：研究 helper 未提供
`runtimeSha256`，不能視為 packaged device-proof、HTTP 或 installed acceptance。
CPU 是明示研究對照，DML 使用原生選中的 adapter 1，不能與舊 device 0 直接 runner
混成同一基線。此局部 source-worker 審查無新增 blocking defect，不授 Phase 0 PASS。

八欄審查已於寫入前轉述。`reviews/source-worker-resource-astra-04.json` SHA256
`f06574d67890ba0785069fbca97f78ad176226f1d581402a2592456679b815a9`；獨立 verifier
SHA256 `2e6f734c29c36ce378f677de3706e0da0454ddfb2160efee0ab3ad80b24a9d20`，
已由 Nx 執行兩次且結果相同。Root 的獨立統計摘要
`reviews/source-worker-resource-v6-root-summary.json` SHA256
`13bad1943c67ff0a4387effc38386121a12a61ce9fd6d586c9d0f72e15c7f244` 與數值一致；
其沿用 run 的簡寫 timing scope 須與上述更精確的時間窗一起解讀。

## 非正文註音與 2023 文件複核增量

2023 年 p2／p4／p5／p6 的註音附在題幹或選項上，p9 印刷例題也有註音，p21 的
頁底注另有註音。研究評分器原本只允許正文 owner，會拒絕這些正確金標；現改為
接受明確列出的文字角色，仍拒絕自指、不存在、跨文章及 ruby／noise／page-number
owner。印刷例題與正式題目保持不同角色；非正文 owner 不增加正文 CER 分母。
75 案版本完整 unit 為 Python 741 passed／1 existing skip、TypeScript 22 passed；
再補註解與頁碼負例後，77 個 benchmark cases 及 lint 通過。產品 OCR 原始碼未改。
最新 scorer SHA256 `3ce027044455f1bdf341af71d2f2164bc648e95b62d52e6f93fd76492b461734`，
tests SHA256 `2108c73ed98bcfa078447aff03023e6de83f6f78cb6885745e394d6a140281da`。
最新兩份檔案已經 Astra 狹範圍獨立複核，無新增 finding；報告
`reviews/nonbody-ruby-astra-review.json` SHA256
`30da2ddd0b674aa0e111f50b6d6310db22a1c95c000b5f625f6dd0ca907cbeb5`。
12 份既有已複核 source bindings 用新 scorer 重播至 `scores-04`，所有原有 metric
一致；重播紀錄 SHA256 `f19ac8f88d26ebd959e3927328ee65b713d302603eae644173d583aa5b62b386`。
這不等於新增 binding approval，也不將先前完整 unit 的結果改稱最新 77 案版本已全跑。

2023 全文複核逐批保存。p1–15 的 392 blocks 已完成雙讀者交叉核對，batch SHA256
`bec97bbc9868db7940f36a5c2da60bd79f584e141ad419732ccde36b265f7960`。
p1 初稿漏掉的最後一句經兩位讀者確認後另存裁定；p3 空格內可見短橫以明訂 U+002D
形狀轉錄保存，不猜原 Unicode 或印刷／掃描成因、不補答案。初稿不覆寫。
後續已封存 p1–15／p17–36 共 35 頁、815 blocks，batch SHA256
`65d89623824a12725419fe2e3dec2d83bce03be6f3ad658248eccd5e99db0913`。
其中三張空白掃描頁依原圖保存為零文字頁，未拿 OCR 的非空／空輸出反推真值。
後續 p38–40 經 Root 全頁複核與 Astra 的頁碼差異確認後另存裁定，補回頁碼兩側
可見長橫線並擴大索引框。最新 batch 含上述 35 頁與新增 3 頁，共 38 頁、918 blocks，
SHA256 `42ba915be0a41bce3eaf90774489adc73b34da240215bb3a2cbb3f763204eff6`。
原稿與較早 batch 均保留。頁腳確認報告 SHA256
`59f0f31c0a756501d9eb0072c30a5c6aa7a88424cbcd3c772fcbdac51a09bbaf`。

p37 原 PNG 在 viewer 解碼失敗；Root 先看過描述才看替代影像，故不將該次視讀算成
盲讀第二讀者。另位 Astra 先完整視讀兩張連續無損半頁、保存 blind notes，再讀首稿，
確認無可讀文字，只有重複幾何圖紋與白邊。獨立 Pillow verifier 經 Nx 兩次通過，證明
半頁合起來逐像素等於原圖、無缺口或重疊。報告 SHA256
`9295c07ef850b3aeb48a403f6722bff83e9112c9e24568b143d5b24975b3f9a8`；
blind notes `b311d82285a7effab744b6eee4b5e8f1ae6d33be1471b30680908051d7e14730`。

p41 的 Astra 首稿已匯出，21 blocks，SHA256
`5515b9b843e16f00d96cc6819f6675701776bb9977d19d5329fd04b52255b37e`；Root 圖先讀後
比對，也發現頁碼兩側長橫未收錄，首讀者重看同意後裁定另存。最新 Root batch 含
39 頁、939 blocks，SHA256 `c25874a3a3c89e44e12e136ef5d9fb5aa0b7a83fb84769c143d641b6ea959aa4`。
p42–50 改由 Root 先讀原圖並轉錄，
9 頁、254 blocks，首稿 index SHA256
`7e4e5e896f1c145e79ea234d23cfbb8dd4e7360595e99374a5a686696d7a4c5e`。
首稿匯出的影像雜湊、區塊唯一性、座標邊界與 ruby anchor 檢查通過；Astra 逐頁
image-first 第二讀者完成 9 頁、254 blocks、176 ruby、9 組四選項，無差異。second-reader
index SHA256 `2b0edd046f1742616df9bc849486d0315eefc3a243f43f829eff2bcc5cfa5909`；
integrity `2efbaf63636be7a51da5d84cff6806aa83044ce602db2aaeca3efb5733e76116`。
p46 的圖紋與 p37 不同，仍保留其可讀頁首與頁碼，不能當零文字頁。

最終供應檔案影像複核索引 `annotations/n1-2023-12-root-review/supplied-document-image-review.json`
SHA256 `2731723111f4b867ba1b51928af055637eadafd716d4c23babf3f08b8775c6cc`，共 50 頁、
1,214 blocks、305 ruby、66 題各四選項，0 dangling owner。整合檢查經 Nx 兩次一致；
p16 原有複核及側欄裁定均以精確 hash 引用。此為完整**影像雙讀覆蓋**，不代表 OCR
來源框已全部綁定、文章／段帶語意已完成 canonical 化，或 Phase 0 放行。

2024-07 新增全文首讀目前封存 p1／p3–15／p17 共 15 頁、370 blocks，index SHA256
`40337dec544452a617f5523fc4acb636ffdf5e2155f829c8c1a1d8b093414535`。14 個裁切側欄
字串維持 null 待原圖裁定，不從其他頁模板補字；p2／p16 沿用先前獨立材料。
新頁仍需第二讀者。p11 印出的範圍為 41–45，而實際本文插槽與 p12 選項是 41–44，
不得為符合說明自行補題或改字。後續 p18–44 已逐頁由原圖轉錄並完成 Nx 匯出，
最新首稿 index 含 42 個新增頁面、1,117 blocks、28 個裁切側欄 null，SHA256
`4236120e31fac81bbb06af0e2507ad04802ff9916f971879a736ed9243c1d4d1`。p2／p16 仍沿用
先前材料，故供應檔案 44 頁都有首讀來源；新增 42 頁仍需第二讀者，不稱金標完成。
跨頁文章與題組、並排 A／B、跨文章位置的頁底注、聽解註音與兩層子題歸屬均已記錄。

追加第二讀者目前封存 20／42 頁、468 blocks，index SHA256
`aa4ff140043239fd765ccd9bd2481d59be35da6529a658115217ad61a6855e05`。
Root 已逐一重看原圖，確認 p5「見通した。」及非底線粗體「コンスタント」、p11
「文書」、p17 小「っ」；原首稿不動，各裁定另存。p5／p11／p17 supplement SHA256
分別為 `b9c95ebcf98ed01947d96fd80f94494be0b365a1cdb49f372ec19561c076b8db`、
`acd3e278af2a144cb2ff66cf999fb1770a8a78047c06cab27edb0c50649d0cb8`、
`3902409f16ae299dbe2c45b9363a8213c84ea9e47d425bd5bbe3b3a4badbae48`。
其後 p23「好意的な読みから」中首稿誤增的「方」亦經兩讀者確認移除，supplement
SHA256 `f545156865c00596e3920714126800b1d2e9bc5a78d18ae9ab7fc7ea03a3e318`。
這些都是影像轉錄的更正，不能計成 OCR 改善；裁切側欄 null 與完整語意綁定仍開放。

本輪後段自動核准審查因使用額度用盡而未能完成，Nx 首讀保存指令未執行；這是
approval review failure，並非判定指令不安全。另有 Astra 全文首讀 turn 回報同一額度
限制。未改用其他路徑繞過核准，也未把未執行項目標成成功；先保存可寫的來源及待續
工作。後續經**同一 require_escalated 核准路徑**重試已成功，上述匯出與三頁裁定均
實際由 Nx 執行兩次、結果一致，Astra 工作亦恢復。先前的執行阻擋現已解除；未完成
金標、來源對映與 Phase 0 gate 仍不因此放行。

私有留出僅回傳 opaque 進度：P2 July 第二讀者完成 14 頁、684 blocks，index SHA256
`92f859a4438da92647ce0e1086c16b4a663b8fa15aab6de425d73f6ceddd9dc5`。
唯一差異已裁定，裁定版 17,076 codepoints、0 unresolved，index SHA256
`a57935df865d297b20ad710c5f9a7bddefd319c12adc5827037f052b33d0abd2`；第二讀者核對
exact delta 確認 SHA256 `e365a8d6b36d61a1236c1646ba361d345925e8dc78fb9f313e7cfe36c6dd65ca`。
P2 December 裁定副本已完成 15 頁、691 blocks、0 unresolved，index SHA256
`6f38b11341126a101a5b5086078992e6d7777fa9f2e67ae1ddb80d47c3346381`，第二讀者確認
SHA256 `dcc6639fd16e8845a4725b69b2ca7601450272600f97be38185b2eceb1d50f5a`。
P3A 兩份各 14 頁已完成首讀、第二讀、裁定與 exact-delta 核對。2020-12 裁定版為
688 blocks、16,874 codepoints、0 unresolved，index SHA256
`3260982dfbe6cb1151380e587669935a841fa40fc4fd741c091f65836915682f`；第二讀者確認
`f91a4f1800bb4e2e9569073302afe89492a25099d9e12648c0c133da61853e0d`，15 個區塊的
16 欄位差異均有既存裁定依據。2019-12 為 661 blocks、17,230 codepoints、0 unresolved，
裁定 index `e9d9385d0fb39f3e7711d8f2f14450a55fd0a4a0f7dcd8082065493015c4290b`；
第二讀者確認 `d9520e16081a5f31e8027f2409ecbf0f7482d25530ad5ec453f198979aacc685`，
僅一欄 metadata 改動，文字均不變。額外 P1 文件第二讀正在進行；原 P1 文件的未解字
沒有被隱藏、補猜或直接刪除。
Root 未讀留出文字或圖像；零 null／首讀完成不代表材料資格或任何階段通過。

## 真實同欄正文碎片正例的補充材料

另由[文部科學省官方 2019 年 7 月號索引](https://www.mext.go.jp/b_menu/kouhou/08121808/001/1419772.htm)
取得[原始 PDF](https://www.mext.go.jp/content/20221104_1907_1.pdf)，SHA256
`cb1c5ccb23aa8b8259ffb8daecc7455fa98d43de3e0f85d042e090344cc2e7da`。
索引標示 32 頁，實際檔案 35 頁；首次凍結後的頁數 assertion 因此失敗，經 Root 視讀
封面、目次、印刷頁 1／2／32 與版權頁後，另存分頁調和紀錄，保留全部供應頁面。
這是追加開發材料，不作留出集。manifest SHA256
`f5b2bfe3448a3c584a9d498d159861b49325f9c8c30e0c9d112a75816ae47971`。

35 頁 canonical DML 完成；只用幾何列出 554 對候選，shortlist SHA256
`8b6f8ae83fb48037d8bc11afac359914855e0a5ce229bbc89f0c08030cc9206a`。
Root 與 Astra 先看原圖後看 OCR，確認 supplied p14／p15 共七組主體政策條列的句末
「等」與同欄上方正文分成兩框。它們位於同一段帶，不是署名、頁碼、註音或上下文章。
例：p15 slots 80→132、p14 slots 129→139。p24 姓名＋職稱及 p27 統計標籤＋值另列
負例，未拿來充數。Astra 報告 `reviews/mext-same-column-fragments.independent.json`
SHA256 `02ff9b8198169203983d5711e866a998f7b1ee28ac441337a348336b866b6a26`。

兩頁另跑 canonical CPU；以**原 polygon 唯一匹配**定位 CPU 框，不假定相同數字 slot
就是同一框。七組各兩框的 CPU／DML 文字相同，最大原始 confidence 差為
`0.0000032186508178710938`。綁定紀錄 SHA256
`bb1bd5ed7598bd4ffe1b498f049ddb136ea2ebb6c4aabc79fc5fa59be6800b43`，Nx 兩次結果一致。
獨立審查確認 v1 artifact 正確，但要求 verifier 明示檢查 actual image hash、完整
sourceDigest 與 normalized polygon／confidence 和 raw 的一致性。v2 已補齊，helper
SHA256 `1854c0049b06676b99cccbb5a4d8687a9a48b0325c0fd0104270504ce3a7b289`；新 artifact
`3d58d982fda7b6a1ae7b3d20ed4f15c326f998a42654498c5003d88a63223066`，Nx 兩次一致。
Astra 窄幅重審確認缺口關閉；相對 v1 僅 helper hash 改變，case 內容不變。
這些是 14 片段的有界 source binding，**不是**全頁 gold、CER、純排序 benchmark 或
演算法通過。正例資格精確限定為正文條列尾語；所有尾字皆為「等」，不能宣稱已涵蓋
敘述句中途斷框或多字下段，亦不必假定「等」語義只附屬最後一 bullet。

兩頁整頁影像首稿已分工完成，包含全部圖表小字，而非只抄七個正例。p14 由 Astra
首讀，112 blocks、1,973 codepoints、0 null，draft SHA256
`c08892e1ef0bbf0a9e4bb58225caa21815e587b4bf2ad5c5bbd97be5f431717a`。Root 先看整圖與
四張同 PDF 高解析 raster、先存筆記再讀稿，逐字複核無字面差異；第二讀報告
`f6ab0c8512d7e131aa994822df864bacfd1ccaddd5ffa9fbe5641bf938f402ac`，integrity
`87f16b9d4a771dcbe950906c07bc334cc952f788b44343d12024879c8d54bb30`，Nx 兩次通過。
刊物頁尾的 role 從 body 到 footer 提案待首讀者裁定；圖表與正文是完整独立子序列，
兩種序列化例子不宣稱窮盡圖表節點的所有合法讀序。

p15 由 Root 首讀，145 blocks（57 主文、86 圖表、2 頁尾）、2,881 codepoints、0 null，
draft SHA256 `264384cf25541eafba7b4509fe40d7e7fe092e131df9250c2ee3344d1d546e39`，index
`12b1b9242265c7b1f6be422295f7f0e1481f237222bbbdda5d87d65dd8efdcfd`。原圖與五張同
PDF 6x raster 先讀後轉錄，Nx 匯出兩次一致，Astra 第二讀正在進行。兩位讀者曾在
先前候選圖讀後看過局部七 pairs 的 OCR tuple，此暴露如實記錄，不冒稱完全 OCR-naive。
上述兩頁尚未完成完整 source binding／語意 canonical 化，故不授 Phase 0 PASS。

## 尚未通過的 Phase 0 門檻

完整逐頁金標與交叉複核、已找到同欄碎片正例的完整頁面金標、完整留出金標與目標覆蓋、合成語意金標、
全面語意評分、固定代表頁與完整產品路徑資源證據、Phase 0 正式獨立 gate review
均須完成。現有單頁金標、單元測試或非空 OCR 結果不能代替這些門檻。

補充搜尋文件來自[文化廳官方封存索引](https://www.bunka.go.jp/tokei_hakusho_shuppan/hakusho_nenjihokokusho/archive/index.html)
所列[文部時報第 1277 號摘錄](https://www.bunka.go.jp/tokei_hakusho_shuppan/hakusho_nenjihokokusho/archive/pdf/93748801_01.pdf)。
PDF SHA256 `f480571fd7a76421342a4d5c0d79d763c65dfdfe47583a8a973a6b35db81ea40`，
13 個提供頁面已凍結並完成 canonical DML。頁首目錄碎片與署名不能充當正文正例；
目前未宣稱在此找到符合條件的正例，也未將此摘錄改稱完整期刊或完整留出文件。
新增 Astra 的有界原圖搜尋共 13 頁、475 對候選，未找到真正同欄正文碎片。index SHA256
`d5a9d043638315c71f647597a8520c9464e1ec9bdb7a03236fe88fc126ea33bc`、report
`8e0585b9c1e7e940f364280a662e3a1e5fbed334f274464e76693d44774fd231`、逐對裁定
`18e924a8c4cd8cc82e720282e8982b4fa99507e0a79c8750cf9d691aaf5ce8ee`。
分類為跨段帶 411、目錄／頁首 35、標題接署名 9、下期目錄接編輯後記 18、後記接版權頁 1、
正文接頁底碼 1。此負結果未經 Root 全對第二視读，不證明其他文件不存在正例；必達缺口仍開放。
