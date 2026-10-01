# 直排日文在 PaddleOCR 內的可行處置

研究日期：2026-10-01。只讀既有實驗與官方文件，沒有改產品、沒有重跑模型。範圍停在 PaddleOCR 3.x 與其官方模型；不把 EasyOCR、manga-ocr、Tesseract 或其他非 Paddle 引擎當解法。產品現況：`paddleocr==3.7.0` 的 runtime 鎖定 `pp-ocrv6-medium-windowsml`，資產只有 `PP-OCRv6_medium_det`、`PP-OCRv6_medium_rec` 與 `rec/ppocrv6_dict.txt`，且 `useDocOrientationClassify`、`useDocUnwarping`、`useTextlineOrientation` 都必須是 false，否則 profile 拒絕載入。

以下 CER／edit distance 都是既有筆記裡**單頁、人工欄序或 oracle 裁切**的數字，不是全頁逐字準確率，也不是 53 頁的辨識準確率。53 頁驗證沒有公布辨識準確率。

## 依現有證據的處置排序

### Takeaway

直排日文頁上，第一步不該是 textline orientation 模型。官方文字行方向分類只有 0 度與 180 度；真正把高瘦直欄轉成橫向再送辨識的，是 OCR 管線裡 `CropByPolys` 的長寬比規則，而且在 `use_textline_orientation=false` 時仍然會跑。本機第 16 頁在這個路徑下，字形錯誤遠小於偵測框接序錯誤。依證據，優先序是：先做直排讀序，再微調已轉正裁切的邊界，用分數門檻只解決空字串契約；不要為了直排去開 0/180 分類，也不要在沒有同集日文證據時換掉 `PP-OCRv6_medium_rec`。

### Cited Findings

排序只根據已寫下的測量與官方類別定義。每一項標明改的是程式、模型或兩者，用到的官方元件，以及能碰到的失敗階段。

1. **直排讀序（程式，不換模型）。** 官方元件是既有檢測框，加上產品自己的接序；不要靠 `SortQuadBoxes`。失敗階段：reading order。第 16 頁同一批辨識文字，偵測順序的 edit distance 是 171／216 字，人工由右至左的 oracle 順序是 18／216（CER 0.0833）；正確欄的原始 index 是 10、9、8、7、6、5、4、3、2，x 由大到小。PP-DocLayoutV3 的受限重排把同一段從 171 降到 18，字形沒有改。 — [summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/summary.json)；[v3-validation/summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-validation/summary.json)；[v3-multiblock-source-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-multiblock-source-findings.md)
2. **維持官方裁切轉正，只調整裁切邊界（程式，同一個 `PP-OCRv6_medium_rec`）。** 官方元件是 `CropByPolys.get_rotate_crop_image`：透視裁切後若 `height / width >= 1.5`，做一次 `np.rot90`。失敗階段：90 度方向之後的 recognition，不是檢測漏整欄。研究腳本繞過這段、改呼叫 `TextRecognition`，所以自己先 `np.rot90`。同一 216 字、CPU、欄邊距 0／6／12 px 的 edit distance 是 18／15／13，CER 0.0833／0.0694／0.0602。這是 oracle 多邊形，不是自動分欄。 — [crop_image_regions.py](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/components/common/crop_image_regions.py)；[compare_column_crops.py](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/compare_column_crops.py)；[column-crops-summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/column-crops-summary.json)
3. **`text_rec_score_thresh=1e-6`（程式，公開 predict 參數）。** 官方元件是 OCR pipeline 的分數過濾，比較式是 `score >= threshold`，預設 0。失敗階段：空辨識字串讓產品 normalizer 整頁失敗，不是字形。53 頁 normalizer 由 49 頁通過變 53 頁通過；`nonempty_removed` 是 0；辨識框 2162 變 2158，少的是空字串。第 16 頁 index 11 是空字串、score 0，目前 `normalize_paddle_results` 會拒絕整頁。 — [v3-validation/summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-validation/summary.json)；[v3-empty-result-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-empty-result-findings.md)；[adoption-baseline-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/adoption-baseline-findings.md)
4. **`text_det_unclip_ratio` 只在有分區條件時試到 2.5（程式）。** 官方元件是文本檢測的 unclip。失敗階段：裁切太緊造成的小字（促音），不是讀序。第 16 頁 oracle CER：1.5 為 0.0833（小促音計數 0、標點計數 0）、2.0 為 0.0787（小促音 1）、2.5 為 0.0648（小促音 4、標點仍 0）。控制頁沒有全頁 CER；視覺對照看到第 8、15 頁有改善，第 2、44 頁丟題號／選項號，第 44 頁三個可見 ruby 變成空字串。 — [unclip-summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/unclip-summary.json)；[control-page-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/control-page-findings.md)
5. **PP-DocLayoutV3 受限 order-only（模型加程式）。** 官方元件是 `PP-DocLayoutV3` 的版面框與 order，加上 PaddleX `LayoutBlock.group_boxes_into_lines`。失敗階段：reading order。它不輸出 `rec_texts`，不能當成辨識模型。53 頁：original 44 頁裡只有 1 頁有 vertical layout 且被 V3 改序；jlpt-n1 有直排的那一頁改序 0、拒絕 9 個 block；bunka-archive 6 頁都有直排，5 頁被改、套用 11 個 block、拒絕 44 個（41 個是 `noncontiguous_original_slots`）。V3-only 的 normalizer 通過數與 baseline 相同。 — [v3-validation/summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-validation/summary.json)；[doclayout-v3-source-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/doclayout-v3-source-findings.md)
6. **換辨識模型（模型，而且一定要改 profile）。** 官方可跑的候選是 `PP-OCRv5_server_rec`、`PP-OCRv5_mobile_rec`、`PP-OCRv6_small_rec`，以及文件仍列出的 `japan_PP-OCRv3_mobile_rec`、`PP-OCRv4_server_rec_doc`。沒有任何本機直排頁比較。官方日文分項只查到 v5：server 60.35%、mobile 54.65%。v6 medium 公布的是另一套內部多場景集的綜合 83.2*，文件同時寫 v6 與 v5 評估集不同、不可直接比。`PP-OCRv6_tiny_rec` 不含日文。 — [PaddleOCR 3.7.0 OCR 產線](https://www.paddleocr.ai/v3.7.0/version3.x/pipeline_usage/OCR.html)；[PaddleX 3.7 OCR 產線](https://paddlepaddle.github.io/PaddleX/3.7/pipeline_usage/tutorials/ocr_pipelines/OCR.html)；[PP-OCRv6 簡介](https://paddlepaddle.github.io/PaddleOCR/main/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html)
7. **不要當直排主手段的項目。** `PP-LCNet_x1_0_textline_ori`／`PP-LCNet_x0_25_textline_ori` 只分 0 度與 180 度。`PP-LCNet_x1_0_doc_ori` 分的是整頁 0／90／180／270。整頁 scale 4 的 oracle CER 仍是 0.0833，空框從 1 增到 2。分數門檻 0.5 會刪掉第 44 頁仍看得到的選項號。`line_height_iou_threshold=0.05` 已因語意錯序淘汰。 — [textline inference.yml](https://huggingface.co/PaddlePaddle/PP-LCNet_x1_0_textline_ori/blob/main/inference.yml)；[PaddleX OCR pipeline.py](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/ocr/pipeline.py)；[summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/summary.json)；[opus55-source-handoff.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/opus55-source-handoff.md)

### Inferences

- 第 16 頁這種直欄已經被檢測成獨立高框時，讀者看到的「整段不可讀」主要是接序，不是模型完全不識字。18／216 的殘差才是字形（促音、濁音、標點這一類），邊距與 unclip 只動到這一層。
- 在現有 ONNX worker 裡再對每個框做一次 90 度旋轉，有機會和 `CropByPolys` 已做的 `np.rot90` 疊成 180 度。那是推測的風險，本機沒有做「關閉官方轉正後再自己轉」的對照。
- 換模型要改 `ocr_profile.py` 的模型名、artifact 清單與 orientation 以外的身份；只改 constructor 會被 `verify_paddle_kwargs` 拒絕。這不表示 v5 或 v3 日文模型在 JLPT 直排上更差或更好，只表示現在沒有這份測量。

### Gaps

- 沒有自動（非 oracle）分欄或自動 RTL 排序的回歸數字。x 座標與人工 index 只證明第 16 頁這 9 欄排得起來。
- 沒有混排頁、ruby 頁、跨頁掃描頁上，純幾何讀序是否不退化的數字。
- 欄邊距 12 px 的 CER 0.0602 只覆蓋這一條 216 字文章，而且裁切框是人工的。

## 文字行方向模型是不是第一步，它只判 0/180 嗎

### Takeaway

不是直排的第一步。PaddleOCR 3.7.0 文件與 `PP-LCNet_x1_0_textline_ori` 的 `inference.yml` 都只列兩個類別：`0_degree` 與 `180_degree`。管線把類別 id 乘 180 再旋轉，而且斷言 id 只能是 0 或 1。本機直排實驗把 `use_textline_orientation` 留在 false，沒有量過這個分類器在直欄上的輸出。

### Cited Findings

- 文件表：`PP-LCNet_x0_25_textline_ori` Top-1 98.85%、0.96 MB；`PP-LCNet_x1_0_textline_ori` Top-1 99.42%、6.5 MB。兩列介紹都寫「兩個類別，即 0 度，180 度」。OCR 產線 YAML 範例的預設名稱是 `PP-LCNet_x1_0_textline_ori`。 — [PaddleOCR 3.7.0 OCR 產線](https://www.paddleocr.ai/v3.7.0/version3.x/pipeline_usage/OCR.html)
- `inference.yml` 的 `PostProcess.Topk.label_list` 是 `0_degree`、`180_degree`。同一倉庫的 Hugging Face 介紹表把 x1_0 寫成 98.85%、0.96 MB、「based on PP-LCNet_x0_25」，和上面的官方表不一致；類別清單仍是 0 與 180。以 label list 與產線文件為準，不採用那張抄錯的精度表。 — [inference.yml](https://huggingface.co/PaddlePaddle/PP-LCNet_x1_0_textline_ori/blob/main/inference.yml)；[HF model card](https://huggingface.co/PaddlePaddle/PP-LCNet_x1_0_textline_ori)
- PaddleX v3.7.1 `OCR` pipeline 的 `rotate_image` 寫明：0 對應 0 度，1 對應 180 度，`rotate_angle = rotate_indicator * 180`，其他值直接 assert。這個旋轉發生在 `CropByPolys` 之後、辨識之前；旗標關閉時角度記成 -1，不做這一步。 — [pipeline.py](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/ocr/pipeline.py)
- 產品 profile 強制三個方向旗標都是 false；接受的 kwargs 只有 `use_doc_orientation_classify`、`use_doc_unwarping`、`use_textline_orientation`。模型名不是 `pp-ocrv6-medium-windowsml` 會拒絕。`engine_adapters.py` 會去找 `textline_orientation_model` 的 ONNX session，但旗標關閉時不會建立它。 — [ocr_profile.py](file:///c:/software-dev/capture-workbench/packages/capture-runtime/src/capture_runtime/ocr_profile.py)；[engine_adapters.py](file:///c:/software-dev/capture-workbench/packages/capture-runtime/src/capture_runtime/engine_adapters.py)
- 本機 `fresh-scale2.json` 與 `fresh-scale4.json` 的 `model_settings.use_textline_orientation` 是 false。已讀的研究筆記沒有這個分類器的 `class_ids` 或直欄準確率。 — [fresh-scale2.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/fresh-scale2.json)；[fresh-scale4.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/fresh-scale4.json)
- 衝突來源：PaddleX discussion #3573 裡，協作者在 2025-07-11 寫文字行分類的目的是把 90 度或 270 度轉成水平；同一串後續留言則說產線原本是二分類旋轉，自訂 0/90/180/270 模型還要改旋轉邏輯。這段話和已固定的 `label_list`、`rotate_image` 原始碼不一致。不把該留言當成模型會輸出 90/270。 — [Discussion #3573](https://github.com/PaddlePaddle/PaddleX/discussions/3573)
- 整頁方向是另一個模型：`PP-LCNet_x1_0_doc_ori`，四類 0°、90°、180°、270°，Top-1 99.06%，7 MB。它矯正的是文件影像，不是單一文字行。 — [PaddleOCR 3.7.0 OCR 產線](https://www.paddleocr.ai/v3.7.0/version3.x/pipeline_usage/OCR.html)

### Inferences

- 正放的 JLPT 掃描頁若被 `PP-LCNet_x1_0_doc_ori` 判成 0 度，整頁不會轉成橫排，直欄仍在。這是依類別定義做的推測，本機沒有跑過這個模型。
- 直欄若先被 `CropByPolys` 轉成橫向，0/180 分類才有機會修正「轉完之後上下顛倒」。那是 180 度殘差，不是「把直排辨認出來」的主步驟。本機沒有量這個殘差占多少。

### Gaps

- 本機沒有 textline orientation 在直欄、轉正後橫條、或 ruby 細條上的分類分布。不能寫它在這些圖上的準確率。
- 沒有量過正放直排頁的 doc-orientation 類別。不能宣稱開 `use_doc_orientation_classify` 會或不會把直排頁轉壞。

## 現行辨識模型在裁切轉成橫向後能不能讀

### Takeaway

能讀，而且這已是程式路徑裡的行為，不是還缺一個新模型。`PP-OCRv6_medium_rec` 在第 16 頁被轉成橫向的直欄上，oracle 順序的 edit distance 是 18／216。整頁放大到 4 倍沒有把這個數字降下來。欄裁切實驗證明同一辨識器在人工轉正後仍是這個水準，多留 12 px 邊距才降到 13／216。

### Cited Findings

- `get_rotate_crop_image` 在裁切高寬比 `>= 1.5` 時執行 `np.rot90`（預設逆時針 90 度）。一般文本檢測走 `det_box_type="quad"`，因此會進這段。它不看 `use_textline_orientation`。 — [crop_image_regions.py](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/components/common/crop_image_regions.py)
- 研究的欄裁切不是產品 worker。它用檢測多邊形裁圖、`np.rot90`、再呼叫 `TextRecognition(model_name="PP-OCRv6_medium_rec", engine="onnxruntime")`。邊距 0 的九欄文字與整頁 scale 2 的 oracle 文字對得上，CER 都是 0.0833。邊距 6 是 15／216（0.0694），邊距 12 是 13／216（0.0602）。scope 寫明 same recognizer、CPU、不是產品管線。 — [compare_column_crops.py](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/compare_column_crops.py)；[column-crops-summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/column-crops-summary.json)；[summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/summary.json)
- 整頁 `fresh-scale2` 與 `fresh-scale4`：passage 都是 9 區，oracle edit distance 都是 18／216，CER 都是 0.0833。scale 4 的空區是 2，scale 2 是 1。兩者 `use_textline_orientation` 都是 false。耗時 2.969 秒對 6.875 秒，只代表該次 CPU 研究呼叫。 — [summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/summary.json)
- 對照原文，scale 2 的殘差包含缺字而不是整欄亂碼，例如「合てい」對「合ってい」、「よてかえて」對「よって、かえって」，句讀大量不見。邊距 12 的輸出出現「合ってい」「よってかえって」和至少一處「、」，但仍不是逐字原文。這些是 JSON 裡的字串，不是另算的準確率。 — [summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/summary.json)；[column-crops-summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/column-crops-summary.json)
- 產品字典鎖定 `rec/ppocrv6_dict.txt`，`languageCoverage` 必須是 `traditional-chinese-multilingual`。辨識模型名必須是 `PP-OCRv6_medium_rec`。 — [ocr_profile.py](file:///c:/software-dev/capture-workbench/packages/capture-runtime/src/capture_runtime/ocr_profile.py)

### Inferences

- 「把直欄轉橫再辨識」對這個 runtime 不是新模型，官方裁切已經做了。產品裡還值得寫的程式，是那些高寬比不到 1.5 的短直排、以及裁切太緊的邊，而不是再實作一次相同的 `np.rot90`。短直排這句是從門檻推出的推測，沒有單獨消融。
- 欄裁切腳本證明的是：跳過檢測、用人工框轉正後，現有辨識器讀得動。它沒有證明未旋轉的直向像素條也能讀。腳本每次都 `np.rot90`。

### Gaps

- 沒有「同一裁切、不旋轉、直接送 `PP-OCRv6_medium_rec`」的對照，所以不能說模型原生接受直向文字行。
- 沒有第 16 頁以外的欄裁切 CER。`fresh-scale4-passage-crop.json` 這次沒有重算成另一個準確率數字。
- 標點仍缺多少、是字典沒有還是裁切切掉，筆記沒有分開計。unclip 摘要的 `punctuation_count` 在 1.5、2.0、2.5 都是 0，只表示那個計數器在第 16 頁文章框上是 0。

## 哪個 PaddleOCR 辨識模型比 PP-OCRv6_medium_rec 更適合日文

### Takeaway

官方清單裡沒有一個模型被寫成「原生吃直向文字行、且日文高於 PP-OCRv6_medium_rec」。有日文分項數字的是 PP-OCRv5，不是 v6。v6 medium／small 支援日文，tiny 明確不含日文。舊的 `japan_PP-OCRv3_mobile_rec` 仍在模型表上，但數字是另一套 45.69% 的平均精度，不能拿來宣稱它比 v6 差或好。這些模型都沒有在本機直排頁上跑過。

### Cited Findings

- PaddleOCR 3.7.0 產線預設辨識是 `PP-OCRv6_medium_rec`：綜合精度 83.2*，73.3 MB，單模型 50 種語言（tiny 檔 49 種）。同一頁寫 medium 比 `PP-OCRv5_server` 辨識 +5.1%、檢測 +4.6%。 — [PaddleOCR 3.7.0 OCR 產線](https://www.paddleocr.ai/v3.7.0/version3.x/pipeline_usage/OCR.html)
- PaddleX 3.7 同一產線頁的註記：PP-OCRv6 指標來自內部多場景評估集，PP-OCRv5／v4 來自通用評估集，兩者不可直接比較。兩份官方頁的「能否直接比較」互相衝突；這裡同時保留，不把 +5.1 百分點當成日文提升。 — [PaddleX 3.7 OCR 產線](https://paddlepaddle.github.io/PaddleX/3.7/pipeline_usage/tutorials/ocr_pipelines/OCR.html)；[PaddleOCR 3.7.0 OCR 產線](https://www.paddleocr.ai/v3.7.0/version3.x/pipeline_usage/OCR.html)
- PP-OCRv6 簡介：medium／small 含簡體中文、繁體中文、英文、日文及 46 種拉丁語系。tiny 支援 49 種，不含日文，理由是避免約 4000 個漢字／假名壓到輸出層。 — [PP-OCRv6 簡介](https://paddlepaddle.github.io/PaddleOCR/main/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html)
- 日文分項，同一份 3.7.0 產線頁的 PP-OCRv5 多場景表：`PP-OCRv5_server_rec` 日文 60.35%（中文 86.38%、繁體 93.29%、英文 64.70%，81 MB）；`PP-OCRv5_mobile_rec` 日文 54.65%（中文 81.29%、繁體 83.55%、英文 66.00%，16 MB）。介紹句寫這代模型支援手寫、豎版、拼音、生僻字。這句綁在 PP-OCRv5_rec，不是 v6 的分項表。 — [PaddleOCR 3.7.0 OCR 產線](https://www.paddleocr.ai/v3.7.0/version3.x/pipeline_usage/OCR.html)
- `japan_PP-OCRv3_mobile_rec`：平均精度 45.69%，9.8 MB，介紹是日文與數字。`PP-OCRv4_server_rec_doc`：平均精度 86.58%，182 MB，介紹寫增加了部分繁體、日文與特殊字元，字元數 1.5 萬以上；沒有單獨的日文欄。多語表沒有 `japan_PP-OCRv5_*` 或 `japan_PP-OCRv6_*` 這一列。 — [PaddleOCR 3.7.0 OCR 產線](https://www.paddleocr.ai/v3.7.0/version3.x/pipeline_usage/OCR.html)；[PP-OCRv5 多語文件](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.md)
- 「豎版」沒有對應到一個不旋轉的辨識輸入規格。管線仍先裁切，再依高寬比 `np.rot90`，然後才辨識。 — [crop_image_regions.py](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/components/common/crop_image_regions.py)
- 本機欄裁切與整頁實驗的辨識器都是 `PP-OCRv6_medium_rec`。筆記沒有 v5、v4、v3 日文模型在這些頁上的輸出。 — [compare_column_crops.py](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/compare_column_crops.py)

### Inferences

- 若只為了日文而換模型，文件上最接近的叙述是 `PP-OCRv5_server_rec` 的日文分項與「豎版」句子，而不是 `japan_PP-OCRv3_mobile_rec`。但 v5 的 60.35% 與 v6 的 83.2* 不是同一評估集，不能排序成誰更準。這是文件限制，不是實驗結論。
- `PP-OCRv6_small_rec` 的綜合數是 81.3*，低於同頁 medium 的 83.2*，且同樣沒有日文分項。沒有理由用它換掉現在的 medium 來修直排。
- PaddleOCR-VL 是另一條文件解析產線，不是這個 ONNX det／rec worker 的替換辨識頭。本機直排筆記沒有它的結果，因此不列入可行處置。

### Gaps

- 官方頁上沒有查到 `PP-OCRv6_medium_rec` 的日文單獨精度。這個空缺不能用綜合 83.2* 填。
- 沒有任何候選模型在第 16 頁、控制頁或 53 頁上的直排 CER。換模型之後促音、標點、ruby 會不會更好，完全未測。
- 「豎版」在訓練資料裡是直向像素還是轉正後的橫條，文件沒有寫。不能說 v5 比 v6 更原生支援直排。

## PP-Structure／PP-DocLayout 有沒有只改善讀序、沒有修字形

### Takeaway

有測量的部分是讀序，不是字形。第 16 頁文章的序列 edit distance 從 171 降到 18，18 與不換布局、只改 oracle 順序的字形誤差相同。53 頁裡 V3 沒有多讓任何一頁通過 normalizer；通過數增加來自分數門檻。直排 block 還會被行寬過濾刪掉正文。

### Cited Findings

- 53 頁合計：baseline normalizer 通過 49（original 42／44、jlpt-n1 2／3、bunka-archive 5／6）。只加 epsilon 是 53。只加 V3 仍是 49。兩者都開也是 53。交接筆記寫明 49→53 是門檻的共通收益，不是 V3 的額外收益。 — [v3-validation/summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-validation/summary.json)；[opus55-source-handoff.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/opus55-source-handoff.md)
- 直排版面出現頁數：original 1、jlpt-n1 1、bunka-archive 6，其餘 `no_vertical_pages` 45。V3 實際改序的頁：original 1、jlpt-n1 0、bunka-archive 5。套用的 block：original 1、jlpt-n1 0、bunka-archive 11。拒絕的 block：jlpt-n1 9（`noncontiguous_original_slots` 7、`fewer_than_two_regions` 2），bunka-archive 44（41 與 3，同一組原因）。 — [v3-validation/summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-validation/summary.json)
- `original_p16_passage`：`truth_chars` 216，`before_sequence_edits` 171，`after_sequence_edits` 18。`nonempty_removed` 是 0。辨識區 2162→2158 對得上四個空字串被門檻拿掉，不是改字。 — [v3-validation/summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-validation/summary.json)
- jlpt-n1 第 14 頁 block 8，標籤 `vertical_text`：五行正文（index 29、30、31、32、38）被原生行寬過濾拿掉，留下窄 ruby index 41。機制是直排時 `TextLine.height` 用的是 x 寬度；最大寬大於最小寬的兩倍，且窄行不足 40% 時只留窄行。`line_height_iou_threshold=0.05` 的 replay 讓這個 block 收回 6／6，但 block 9 的順序改變；交接筆記說擴大 replay 已因語意錯序淘汰，不能再推薦。 — [v3-multiblock-source-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-multiblock-source-findings.md)；[opus55-source-handoff.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/opus55-source-handoff.md)
- V3 官方描述是版面區域之間的順序與輪廓，類別含 `vertical_text`。它不辨識文字。文件沒有這個直排試題、振假名或小假名的品質數字。ONNX 約 130.5 MB，revision `46bbdf188bb0a772c08aed74882ce7e51a8f1ea6`。 — [doclayout-v3-source-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/doclayout-v3-source-findings.md)
- 採用筆記：純 permutation 不新增、不修正字元。第 16 頁空字串仍讓目前 normalizer 失敗，所以讀序收益不能算成產品 capture 已成功。profile 現在只有 det、rec、字典五個資產；加 layout 模型是新的身份與交付物。 — [adoption-baseline-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/adoption-baseline-findings.md)；[ocr_profile.py](file:///c:/software-dev/capture-workbench/packages/capture-runtime/src/capture_runtime/ocr_profile.py)
- `SortQuadBoxes`／`SortPolyBoxes` 沒有直排由右至左的參數；退回這兩個函式會回到不適合直排的排序。 — [v3-multiblock-source-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-multiblock-source-findings.md)

### Inferences

- 布局實驗回答的是「框已經有字時怎麼排」。它沒有回答缺促音、缺標點、ruby 讀錯。把 V3 的 171→18 說成辨識變準，會和採用筆記禁止的宣稱衝突。
- 在直排頁比例不高、而且多數直排 block 被 guard 拒絕的這份 53 頁樣本上，先上整顆 PP-DocLayoutV3 不如先做只作用於高瘦框的讀序。後者仍未實測，見下一節。

### Gaps

- 53 頁沒有字形 CER、促音召回或 ruby 正確率。不能把 normalizer 53／53 寫成辨識品質。
- 被 guard 拒絕的 block 如果改走幾何排序，順序對不對，沒有數字。
- 跨實體頁的讀序，交接筆記列為未驗證。`use_region_detection` 沒有在這批頁上的結果。

## 現有 ONNX runtime 裡還能做的程式調整

### Takeaway

已經試過而且有數字的，是 unclip、人工欄邊距、整頁放大、分數門檻、布局重排與行分組門檻。還沒有試過、而且仍在 PaddleOCR 管線內說得通的，是：只對高瘦框做由右至左排序、高寬比不到 1.5 的短直排要不要轉、檢測閾值、以及字典約束。字典約束沒有實驗，不能預先說它會修好濁音。

### Cited Findings

已試過：

- 長寬比轉正：官方預設規則是 `height / width >= 1.5` 才 `np.rot90`。整頁實驗在旗標 false 時已經走出可讀直欄，與這條規則相容。研究腳本又在 `TextRecognition` 前手動轉了一次，因為那條路徑不經過 `CropByPolys`。 — [crop_image_regions.py](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/components/common/crop_image_regions.py)；[compare_column_crops.py](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/compare_column_crops.py)
- 分欄：只有人工 oracle 裁切。邊距 0／6／12 px 的 CER 見上，0.0833／0.0694／0.0602。沒有自動切欄演算法的輸出。 — [column-crops-summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/column-crops-summary.json)
- unclip：公開參數 1.5、2.0、2.5。oracle CER 0.0833、0.0787、0.0648。2.5 在控制頁有可見退化，不能當全域預設。信心分數上升過，同時題號消失，所以不能用信心挑 unclip。 — [unclip-summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/unclip-summary.json)；[control-page-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/control-page-findings.md)
- 整頁尺度：scale 2 與 scale 4 的 oracle CER 同為 0.0833。 — [summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/summary.json)
- 分數門檻：`1e-6` 已有真實 predict 驗證，53 頁 normalizer 49→53，非空文字損失 0。0.5 的 replay 會刪第 44 頁 index 17（`I`，CPU score 0.467433，原圖是選項號）和 index 31（`1`，CPU score 0.412525）。 — [v3-empty-result-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-empty-result-findings.md)；[opus55-source-handoff.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/opus55-source-handoff.md)
- 讀序與行過濾：V3 order-only、預設行寬過濾、以及 0.05 分組門檻都跑過 replay 或驗證。0.05 已淘汰。布局 threshold 0.5 降到 0.3 時，第 16 頁框數由 8 降到 6，不是「閾值越低框越多」。 — [v3-validation/summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-validation/summary.json)；[doclayout-v3-source-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/doclayout-v3-source-findings.md)

未見完成實驗、但仍是官方管線參數或產品側後處理：

- 只用多邊形高寬比決定「這一框是直欄」，再依 x 由右至左排序。官方 `SortQuadBoxes` 不做這件事。第 16 頁的 x 與 index 顯示這條規則會對上人工順序，但沒有程式跑過全頁、也沒有控制頁回歸。 — [summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/summary.json)；[v3-multiblock-source-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-multiblock-source-findings.md)
- 把 1.5 這個轉正門檻改掉，或只補轉高寬比小於 1.5 的直向碎片。原始碼門檻是寫死的 1.5，不是 profile 欄位。沒有消融。 — [crop_image_regions.py](https://raw.githubusercontent.com/PaddlePaddle/PaddleX/v3.7.1/paddlex/inference/pipelines/components/common/crop_image_regions.py)
- `text_det_thresh` 與 `text_det_box_thresh`。已讀筆記與摘要沒有這兩個檢測閾值的完成對照。不要把布局 threshold 的 8→6 當成檢測閾值結果。 — [doclayout-v3-source-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/doclayout-v3-source-findings.md)
- 字典約束。profile 把字典鎖成 `ppocrv6_dict.txt`。筆記沒有「限制輸出字元集」或換字典的辨識結果。CTC 空字串來自 blank index，不是字典事後過濾能把字補回來。 — [ocr_profile.py](file:///c:/software-dev/capture-workbench/packages/capture-runtime/src/capture_runtime/ocr_profile.py)；[v3-empty-result-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-empty-result-findings.md)
- 開啟 `use_textline_orientation` 或 `use_doc_orientation_classify`。profile 現在拒絕。本機 JSON 保持 false，沒有分類輸出。 — [ocr_profile.py](file:///c:/software-dev/capture-workbench/packages/capture-runtime/src/capture_runtime/ocr_profile.py)

### Inferences

- 分數門檻、unclip、放大都動得到現有 ONNX 辨識器，不必換模型。其中只有 `1e-6` 在 53 頁上是「不刪非空字」的那一個；unclip 2.5 與 scale 4 都已經有反例或零收益。
- 字典約束若做成解碼後刪字，會碰到和第 44 頁 0.5 門檻一樣的風險：短選項號先被拿掉。這是類比，不是新實驗。
- 任何要寫進產品的 predict 參數，交接筆記要求進 profile 身份。現在的 profile 沒有 unclip 或 `text_rec_score_thresh` 欄位。

### Gaps

- `text_det_thresh`、`text_det_box_thresh`、轉正門檻 1.5、字典約束，都沒有本機數字。不能估計它們對直排 CER 的方向。
- 自動分欄沒有做。人工邊距的 0.0602 不能外推成「產品只要多裁 12 px」。

## 不可宣稱的範圍

### Takeaway

可以引用的辨識數字只有第 16 頁這條 216 字文章的 oracle edit distance，以及欄裁切的同一條文章。沒有全資料集準確率。布局與門檻的頁數是 normalizer 與讀序，不是字形準確率。

### Cited Findings

- 控制頁筆記寫明：沒有全頁逐字 ground truth，以下不是全頁 CER。六頁框數合計 174，raw 文字不同 44，其中格式等價 25，其餘字元變化 19。 — [control-page-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/control-page-findings.md)
- 採用筆記禁止把某一段 edit distance 下降說成模型更準、或標點／小促音／ruby 已解決。純重排不改字元。七個研究頁不能拿來估直排出現率。 — [adoption-baseline-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/adoption-baseline-findings.md)
- 53 頁沒有辨識準確率欄位。有的是 normalizer 通過數、改序頁數、拒絕原因、以及第 16 頁文章的 171 與 18。 — [v3-validation/summary.json](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/v3-validation/summary.json)
- v6 綜合 83.2* 與 v5 日文 60.35% 來自官方表，而且 PaddleX 頁寫明評估集不同。它們不是本產品 JLPT 頁的準確率。 — [PaddleX 3.7 OCR 產線](https://paddlepaddle.github.io/PaddleX/3.7/pipeline_usage/tutorials/ocr_pipelines/OCR.html)；[PaddleOCR 3.7.0 OCR 產線](https://www.paddleocr.ai/v3.7.0/version3.x/pipeline_usage/OCR.html)
- 第 16 頁空字串仍會讓目前 normalizer 失敗。讀序改善不是「這一頁產品 capture 已修好」。 — [adoption-baseline-findings.md](file:///c:/software-dev/capture-workbench/tmp/research-vertical-japanese/adoption-baseline-findings.md)

### Inferences

- 報告若需要一個「直排辨識準確率」，現成材料不夠。最多可以說：在第 16 頁、人工欄序、NFKC 後去空白、標點仍計入的條件下，現有 `PP-OCRv6_medium_rec` 的文章 edit distance 是 18／216；這不是產品指標。
- 官方模型表的百分數不能改寫成「換到 v5 日文會好 60.35%」或「v6 比 v5 高 5.1 個百分點的日文」。

### Gaps

- 沒有跨頁、含 ruby、含選擇題編號的辨識準確率。控制頁只有逐例視覺判斷。
- 沒有 textline orientation、doc orientation、其他辨識模型在這些影像上的任何準確率。缺的就是未測，不是 0。
