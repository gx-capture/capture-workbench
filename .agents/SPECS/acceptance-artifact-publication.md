# Acceptance artifact publication
Phase 1 has two deep modules: child journal and parent terminalizer.
The child owns live journal/scope evidence; the parent reads only after child close.
Mandatory order is launch -> cdp -> runtime -> ocr_compute -> ocr_semantic.
Manifest bytes are hashed when readable; missing/unreadable files have no digest.
OCR proof is physical and privacy-safe; output is one atomic typed terminal JSON.
