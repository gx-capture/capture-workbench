# NDLOCR-Lite line detector — licence lineage (open question)

Recorded 2026-10-06 for the user to follow up. Capture 0.5.0 is published with
this question open, by the user's decision of that date
([decisions](../DECISIONS/vertical-japanese-ocr.md)). Nothing here is legal
advice; it lists what is known, what is not, and what could be done.

## What is delivered

The OCR engine of 0.5.0 installs six files from
`ndl-lab/ndlocr-lite` at commit `636d1cfeb1331f89f4048f416e49e23a09a714b5`,
unchanged, with upstream's `LICENCE`, `README.md` and `LICENCE_DEPENDENCEIES`:

| File | Role |
| --- | --- |
| `deim-s-1024x1024.onnx` | line detector (DEIMv2-S) — **the file in question** |
| `parseq-ndl-24x256-30-…onnx`, `…24x384-50-…onnx`, `…24x768-100-…onnx` | line recognizers (PARSeq) |
| `ndl.yaml`, `NDLmoji.yaml` | class names and character set |

The repository also vendors upstream's layout and reading-order source
(`packages/capture-runtime/src/capture_runtime/_vendor/ndlocr_lite/`), which is
not affected by this question.

## What is known

- Upstream's README states that the National Diet Library publishes the program
  under CC BY 4.0, and `LICENCE` is the CC BY 4.0 text. The models are in the
  same repository; there is no separate statement for the weights.
- Upstream's `LICENCE_DEPENDENCEIES` lists `parseq` and `deimv2` under
  Apache-2.0. It has no entry for DINOv3.
- Upstream's training configuration for the detector,
  `train/deimv2code/part2/configs/ndl_deimv2/deimv2_dinov3_s_coco_r4_800.yml`,
  uses the backbone `DINOv3STAs` with weights `./ckpts/vitt_distill.pt`. The
  DEIMv2 project describes its S and M models as using a ViT-Tiny distilled from
  DINOv3-S.
- The DINOv3 licence (`facebookresearch/dinov3`, `LICENSE.md`) is a custom
  agreement, not an open-source licence. As read by the reviewer it places
  derivative works under the agreement, asks for a copy of it on distribution,
  and carries trade-control and use restrictions.
- DEIMv2 itself was relicensed from Apache-2.0 to a non-commercial licence on
  2026-08-24. Upstream's detector file dates from 2026-02-19, when DEIMv2 was
  Apache-2.0, so upstream's description of DEIMv2 matches what it used.

## What is not known

- Whether a detector whose backbone was distilled from DINOv3 and then trained
  on the library's data is a "derivative work" under the DINOv3 agreement.
- Whether the National Diet Library considered this, and whether its CC BY 4.0
  statement is meant to cover the detector weights without further terms.
- Whether the distilled checkpoint `vitt_distill.pt` was itself published under
  terms of its own.

## Why it matters

`.agents/SPECS/release-model-artifact-provisioning.md` says unknown licensing
invalidates the model source lock. If the DINOv3 agreement applies to the
detector, redistribution would need that agreement's text and would carry its
use restrictions, which CC BY 4.0 alone does not convey to users of Capture.
Capture does not host the file: installers download it from upstream's
repository. The three recognizers are not in question.

## What could be done

1. Ask the National Diet Library (the repository's issue tracker or the
   library's contact for NDLOCR) whether the detector weights are offered under
   CC BY 4.0 without further terms, given the DINOv3-distilled backbone. A
   written answer would settle the lock's licence record.
2. Read the DINOv3 `LICENSE.md` and the DEIMv2 statement on its distilled
   backbones with someone qualified to judge "derivative work".
3. If the answer is unfavourable: release an engine without the vertical reader
   (the reading-order and furigana work does not depend on it), or replace the
   detector with one of clear lineage and re-verify. The routing code tolerates
   an engine without the reader directory; the profile and lock would need the
   reader removed.
4. If the answer is favourable: add the answer to the lock's notice and close
   this note.

## Where it is recorded in the release

- Lock: `packages/capture-runtime/model-sources/release-model-source-lock.json`
  (`model/vertical/deim-s-1024x1024.onnx`, SPDX `CC-BY-4.0` as upstream states).
- Decision: `.agents/DECISIONS/vertical-japanese-ocr.md`, entries of 2026-10-06.
- Open item: `.agents/TODOS/vertical-japanese-ocr.md`.
