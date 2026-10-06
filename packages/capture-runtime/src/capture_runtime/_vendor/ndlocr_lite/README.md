# NDLOCR-Lite layout and reading-order sources

Part of [NDLOCR-Lite](https://github.com/ndl-lab/ndlocr-lite) by the National Diet
Library, Japan, copied from commit `636d1cfeb1331f89f4048f416e49e23a09a714b5`
(version 1.2) and licensed under CC BY 4.0; see `LICENCE`.

The runtime's vertical page reader (`capture_runtime/ocr_vertical_reader.py`) uses
`ndl_parser.convert_to_xml_string3` to group detected lines into text blocks and
`reading_order.xy_cut.eval.eval_xml` to order them.

## Changes from upstream

`scripts/vendor_ndlocr_lite.py` reproduces this directory from an upstream checkout
and holds the digest of every source file. It makes these changes and no others:

- `ndl_parser.py`: the top-level imports of `lxml` and `tqdm` are removed. The
  functions the runtime calls do not use them; neither is a runtime dependency.
- `reading_order/**`: `from reading_order.` becomes
  `from capture_runtime._vendor.ndlocr_lite.reading_order.`.
- `reading_order/order/smooth_order.py`: `import networkx as nx` becomes an import
  of `_digraph.py`.
- Line endings are LF.

`_digraph.py`, `__init__.py` in this directory and this file are not part of
NDLOCR-Lite. `_digraph.py` provides the two networkx calls `smooth_order.py` uses,
with paths in the same order.

Upstream files not copied: the command-line program, the detector and recognizer
wrappers (rewritten in `ocr_vertical_reader.py`), the PDF and GUI code, and the
models. The models are delivered with the engine, not with this package: the
detector as upstream publishes it, and the three recognizers after ONNX Runtime's
extended graph optimization (`scripts/derive_vertical_reader_models.py`), which
changes their bytes but not the text they return on the pages compared.

The copied files are excluded from linting and type checking so that they stay as
upstream wrote them.
