# Recording transcription (ASR) TODO

Capture Workbench verifies recording transcription as an experimental
product. Speech recognition is TEA-ASR
([decision](../DECISIONS/speech-recognition-tea-asr.md)).

Development transcriptions use TEA-ASR 1.1 mini on CUDA
(`tea-asr-1.1-mini` / `cuda`). The shipping runtime installs one of two speech
packs per machine: with the NVIDIA driver the `cuda` pack (TEA-ASR 1.1 on CUDA,
that same checkpoint on CPU after a GPU failure), without it the `cpu` pack
(TEA-ASR 1.1 mini on CPU). The release fixture and the desktop smokes stay on
TEA-ASR 1.1 / CUDA. Select mini
with `CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1-mini` and disable CPU fallback; see
`.agents/RESEARCH/tea-asr-1.1-mini-gpu-2026-11-04.md`.

- [ ] Real Workbench desktop journey with a user-consented recording, repeated
  several times, on the released runtime: transcript lines at the right times,
  playback from a line, speakers named. Never commit the recording or its
  transcript. Tracked with the packaged real OCR/ASR run:
  https://github.com/gx-capture/capture-workbench/issues/163
- [ ] Recordings over the 50 MiB source limit:
  https://github.com/gx-capture/capture-workbench/issues/155
- [ ] Playback of formats WebView2 cannot play (WMA, AMR, AVI): https://github.com/gx-capture/capture-workbench/issues/249
