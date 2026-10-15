# Recording transcription (ASR) TODO

Capture Workbench verifies recording transcription as an experimental
product. Found through LAW with a real 40-minute phone interview (M4A, AAC),
then fixed here; see the Unreleased section of `CHANGELOG.md`.

- [x] Keep only each resampled frame's samples in the progressive decoder.
  Done: `progressive_decoder.py`; `test_progressive_decoder.py`.
- [x] Fail a progressive capture for missing text only once the whole
      recording is heard.
  Done: `progressive_audio.py`; `test_progressive_audio.py`.
- [x] Keep each moment of a window overlap from one window.
  Done: `progressive_audio.py`; `test_progressive_audio.py`.
- [x] Let a Whisper or diarization run take the standard limit plus the
      recording's length.
  Done: `extractors.py`; `test_audio_run_timeout.py`.
- [x] Accept any audio or video recording FFmpeg decodes in the runtime, the
      Web Component and the Workbench.
  Done: `sniff_source`; `test_source_sniffing.py`; desktop library validation.
- [x] Show a transcript as timed lines beside a player in the Workbench.
  Done: `app.html`, `transcriptLines`; `app.spec.ts`.
- [ ] Release the runtime with a rebuilt Whisper engine: the window merging
      and the checkpoint rule run in the engine, not the runtime.
- [ ] Real Workbench desktop journey with a user-consented recording,
      repeated several times, on the released runtime: transcript lines at
      the right times, playback from a line, speakers named. Never commit the
      recording or its transcript.
- [ ] Recordings over the 50 MiB source limit (an hour of phone audio, most
      video). The speaker path also reads the whole source into memory.
- [ ] Playback of formats WebView2 cannot play (WMA, AMR, AVI).
- [ ] Whisper hallucinates on long silence ("You", "Thank you.", a video
      outro); decide whether the runtime should drop such text.
- [ ] Re-measure whether a one-pass transcription without speaker
      diarization is still needed now that progressive windows decode and
      merge correctly.
