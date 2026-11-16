use std::collections::BTreeMap;

use crate::contracts::{LibraryEdits, LibraryExportFormat, LibraryExportPayload};
use serde_json::Value;

pub(super) fn page_label(label: Option<&str>) -> Result<&str, String> {
    let label = label.unwrap_or("Page {page}");
    if label.chars().count() > 40
        || label.matches("{page}").count() != 1
        || label.chars().any(breaks_line)
    {
        return Err("Capture export pageLabel is invalid.".into());
    }
    Ok(label)
}

/// Control characters and the Unicode line and paragraph separators: each can
/// end a heading, a label or a cue line.
fn breaks_line(c: char) -> bool {
    c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')
}

fn single_line(text: &str) -> String {
    text.chars()
        .map(|c| if breaks_line(c) { ' ' } else { c })
        .collect()
}

/// Render recognized content, never the optional model's rewritten text.
pub(super) fn render(
    file_name: &str,
    media_type: &str,
    raw: Option<&Value>,
    result: Option<&Value>,
    edits: Option<&LibraryEdits>,
    format: &LibraryExportFormat,
    label: Option<&str>,
) -> Result<LibraryExportPayload, String> {
    let label = page_label(label)?;
    let recording = media_type.starts_with("audio/") || media_type.starts_with("video/");
    if !recording && matches!(format, LibraryExportFormat::Srt | LibraryExportFormat::Vtt) {
        return Err("Subtitle export requires a recording.".into());
    }
    let (extension, media) = match format {
        LibraryExportFormat::Text => ("txt", "text/plain;charset=utf-8"),
        LibraryExportFormat::Markdown => ("md", "text/markdown;charset=utf-8"),
        LibraryExportFormat::Srt => ("srt", "application/x-subrip;charset=utf-8"),
        LibraryExportFormat::Vtt => ("vtt", "text/vtt;charset=utf-8"),
        LibraryExportFormat::Json => return Err("JSON export requires a stored result.".into()),
    };
    let content = if let Some(raw) = raw {
        let heading = single_line(file_name);
        if recording {
            render_recording(raw, result, edits, format, &heading)
        } else {
            let pages = pages(raw, edits);
            if matches!(format, LibraryExportFormat::Markdown) {
                let mut sections = vec![format!("# {heading}")];
                sections.extend(pages.iter().map(|(page, text)| {
                    let title = format!("## {}", label.replace("{page}", &page.to_string()));
                    if text.trim().is_empty() {
                        title
                    } else {
                        format!("{title}\n\n{text}")
                    }
                }));
                if pages.is_empty() {
                    sections.extend(
                        text_of(raw, "sourceText")
                            .filter(|text| !text.trim().is_empty())
                            .map(str::to_owned),
                    );
                }
                sections.join("\n\n")
            } else if pages.is_empty() {
                // A result without page locators still has its recognized text.
                text_of(raw, "sourceText").unwrap_or("").to_owned()
            } else {
                // A page without text adds no blank block to the plain text.
                pages
                    .into_iter()
                    .map(|(_, text)| text)
                    .filter(|text| !text.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            }
        }
    } else if matches!(format, LibraryExportFormat::Text) {
        let result =
            result.ok_or_else(|| "Capture library result is not available.".to_string())?;
        export_text(result).ok_or_else(|| "Capture result has no exportable text.".to_string())?
    } else {
        return Err("Capture library raw result is not available.".into());
    };
    Ok(LibraryExportPayload {
        file_name: format!("{}.{extension}", super::stem(file_name)),
        media_type: media.into(),
        content,
    })
}

fn segments(raw: &Value) -> &[Value] {
    raw.get("segments")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Same grouping, blank-segment filtering and stable ordering as resultPages.
fn pages(raw: &Value, edits: Option<&LibraryEdits>) -> Vec<(u64, String)> {
    let mut pages: BTreeMap<u64, Vec<&Value>> = BTreeMap::new();
    for segment in segments(raw) {
        let locator = &segment["locator"];
        if text_of(locator, "kind") != Some("page")
            || text_of(segment, "text").unwrap_or("").trim().is_empty()
        {
            continue;
        }
        if let Some(page) = locator["page"].as_u64() {
            pages.entry(page).or_default().push(segment);
        }
    }
    if let Some(processed) = raw["ocrPageScope"]["processedPageNumbers"].as_array() {
        for page in processed.iter().filter_map(Value::as_u64) {
            pages.entry(page).or_default();
        }
    }
    pages
        .into_iter()
        .map(|(page, mut segments)| {
            segments.sort_by_key(|segment| segment["order"].as_u64().unwrap_or(0));
            let text = edits
                .and_then(|edits| edits.ocr_pages.get(&page.to_string()))
                .cloned()
                .unwrap_or_else(|| {
                    segments
                        .iter()
                        .map(|segment| text_of(segment, "text").unwrap_or(""))
                        .collect::<Vec<_>>()
                        .join("\n")
                });
            (page, text)
        })
        .collect()
}

fn timestamp(ms: u64, separator: &str) -> String {
    format!(
        "{:02}:{:02}:{:02}{separator}{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

fn cue_text(text: &str) -> String {
    // A lone carriage return is a line break to subtitle parsers too.
    text.replace('\r', "\n")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .replace("-->", "\u{2192}")
}

fn vtt_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn render_recording(
    raw: &Value,
    result: Option<&Value>,
    edits: Option<&LibraryEdits>,
    format: &LibraryExportFormat,
    heading: &str,
) -> String {
    // resultSpeakersList prefers even an explicitly empty structured speaker list.
    let speakers = result
        .and_then(|value| value.get("speakers"))
        .filter(|speakers| !speakers.is_null())
        .or_else(|| raw.get("speakers"))
        .and_then(Value::as_array);
    let mut output = Vec::new();
    if matches!(format, LibraryExportFormat::Markdown) {
        output.push(format!("# {heading}"));
    }
    if matches!(format, LibraryExportFormat::Vtt) {
        output.push("WEBVTT".into());
    }
    let mut cue = 0;
    for segment in segments(raw) {
        let locator = &segment["locator"];
        if text_of(locator, "kind") != Some("time") {
            continue;
        }
        let id = text_of(segment, "segmentId").unwrap_or("");
        let text = edits
            .and_then(|edits| edits.transcript_lines.get(id))
            .map(String::as_str)
            .unwrap_or_else(|| text_of(segment, "text").unwrap_or(""));
        let name = text_of(segment, "speaker").map(|id| {
            edits
                .and_then(|edits| edits.speaker_names.get(id))
                .map(String::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .or_else(|| {
                    speakers
                        .and_then(|speakers| {
                            speakers
                                .iter()
                                .find(|speaker| text_of(speaker, "speakerId") == Some(id))
                        })
                        .and_then(|speaker| text_of(speaker, "displayName"))
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                })
                .unwrap_or(id)
        });
        let named = || name.map_or_else(|| text.to_owned(), |name| format!("{name}: {text}"));
        // HH:MM:SS of the line's start, for the formats a person reads.
        let time = timestamp(locator["startMs"].as_u64().unwrap_or(0), ".");
        let time = &time[..time.len() - 4];
        match format {
            LibraryExportFormat::Text => output.push(format!("[{time}] {}", named())),
            LibraryExportFormat::Markdown => {
                // A name must not close the bold span or start a new block.
                let prefix = name.map_or_else(
                    || format!("**[{time}]**"),
                    |name| {
                        let name = single_line(name).replace('\\', "\\\\").replace('*', "\\*");
                        format!("**[{time}] {name}:**")
                    },
                );
                output.push(format!("{prefix} {text}"));
            }
            LibraryExportFormat::Srt | LibraryExportFormat::Vtt => {
                let (Some(start), Some(end)) =
                    (locator["startMs"].as_u64(), locator["endMs"].as_u64())
                else {
                    continue;
                };
                // A cue without text would end at its own blank line.
                if end <= start || cue_text(text).is_empty() {
                    continue;
                }
                cue += 1;
                let vtt = matches!(format, LibraryExportFormat::Vtt);
                let separator = if vtt { "." } else { "," };
                let text = if vtt {
                    let text = vtt_escape(&cue_text(text));
                    name.map_or(text.clone(), |name| {
                        let name: String = name
                            .chars()
                            .filter(|c| *c != '>' && !breaks_line(*c))
                            .collect();
                        // "--" before the closing ">" would read as a cue arrow.
                        let gap = if name.ends_with('-') { " " } else { "" };
                        format!("<v {}{gap}>{text}", vtt_escape(&name))
                    })
                } else {
                    cue_text(&named())
                };
                let range = format!(
                    "{} --> {}",
                    timestamp(start, separator),
                    timestamp(end, separator)
                );
                output.push(if vtt {
                    format!("{range}\n{text}")
                } else {
                    format!("{cue}\n{range}\n{text}")
                });
            }
            LibraryExportFormat::Json => unreachable!("JSON handled by store"),
        }
    }
    let separator = if matches!(format, LibraryExportFormat::Text) {
        "\n"
    } else {
        "\n\n"
    };
    let mut content = output.join(separator);
    if matches!(format, LibraryExportFormat::Vtt) {
        content.push_str("\n\n");
    }
    content
}

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Text of a result. A transcript with speakers reads "name: what they said",
/// using the name a person gave the speaker when there is one.
fn export_text(result: &Value) -> Option<String> {
    let plain = || {
        result
            .get("targetText")
            .or_else(|| result.get("sourceText"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let speakers = match result.get("speakers").and_then(Value::as_array) {
        Some(speakers) if !speakers.is_empty() => speakers,
        _ => return plain(),
    };
    let (Some(blocks), Some(segments)) = (
        result.get("blocks").and_then(Value::as_array),
        result.get("rawSegments").and_then(Value::as_array),
    ) else {
        return plain();
    };
    let names: std::collections::HashMap<&str, &str> = speakers
        .iter()
        .filter_map(|speaker| {
            let id = text_of(speaker, "speakerId")?;
            let name = text_of(speaker, "displayName")
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(id);
            Some((id, name))
        })
        .collect();
    let speaker_of: std::collections::HashMap<&str, &str> = segments
        .iter()
        .filter_map(|segment| Some((text_of(segment, "segmentId")?, text_of(segment, "speaker")?)))
        .collect();
    let lines: Vec<String> = blocks
        .iter()
        .filter_map(|block| {
            let text = text_of(block, "targetText")?;
            let name = text_of(block, "sourceSegmentId")
                .and_then(|segment| speaker_of.get(segment))
                .and_then(|speaker| names.get(speaker));
            Some(match name {
                Some(name) => format!("{name}: {text}"),
                None => text.to_owned(),
            })
        })
        .collect();
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::LibraryEditMaps;
    use serde_json::json;

    fn edits() -> LibraryEdits {
        LibraryEdits::new(
            LibraryEditMaps {
                ocr_pages: [
                    ("1".into(), "corrected page".into()),
                    ("99".into(), "orphan".into()),
                ]
                .into(),
                transcript_lines: [
                    ("a".into(), "corrected line".into()),
                    ("orphan".into(), "ignored".into()),
                ]
                .into(),
                speaker_names: [
                    ("s".into(), " Alice ".into()),
                    ("orphan".into(), "ignored".into()),
                ]
                .into(),
            },
            0,
        )
    }

    fn ocr() -> Value {
        json!({"segments": [
            {"segmentId":"c", "order":3, "text":"last", "locator":{"kind":"page", "page":2}},
            {"segmentId":"b", "order":2, "text":"second", "locator":{"kind":"page", "page":1}},
            {"segmentId":"a", "order":1, "text":"first", "locator":{"kind":"page", "page":1}}
        ], "ocrPageScope":{"processedPageNumbers":[1,2,3]}})
    }

    fn transcript() -> Value {
        json!({"speakers":[{"speakerId":"s", "displayName":"Recognized"}], "segments":[
            {"segmentId":"a", "speaker":"s", "text":"original", "locator":{"kind":"time", "startMs":1000, "endMs":2500}},
            {"segmentId":"b", "speaker":"s", "text":"next", "locator":{"kind":"time", "startMs":3600000, "endMs":3601000}}
        ]})
    }

    fn rendered(raw: &Value, format: LibraryExportFormat, recording: bool) -> LibraryExportPayload {
        render(
            "sample.wav",
            if recording {
                "audio/wav"
            } else {
                "application/pdf"
            },
            Some(raw),
            None,
            Some(&edits()),
            &format,
            None,
        )
        .unwrap()
    }

    #[test]
    fn ocr_formats_apply_only_existing_page_edits() {
        assert_eq!(
            rendered(&ocr(), LibraryExportFormat::Text, false).content,
            "corrected page\n\nlast"
        );
        let payload = rendered(&ocr(), LibraryExportFormat::Markdown, false);
        assert_eq!(payload.file_name, "sample.md");
        assert_eq!(payload.media_type, "text/markdown;charset=utf-8");
        assert_eq!(
            payload.content,
            "# sample.wav\n\n## Page 1\n\ncorrected page\n\n## Page 2\n\nlast\n\n## Page 3"
        );
        assert_eq!(pages(&ocr(), None)[0].1, "first\nsecond");
        for format in [LibraryExportFormat::Srt, LibraryExportFormat::Vtt] {
            assert!(render(
                "sample.pdf",
                "application/pdf",
                Some(&ocr()),
                None,
                None,
                &format,
                None
            )
            .is_err());
        }
    }

    #[test]
    fn transcript_formats_apply_text_and_speaker_edits() {
        let raw = transcript();
        let text = rendered(&raw, LibraryExportFormat::Text, true);
        assert_eq!(text.file_name, "sample.txt");
        assert_eq!(text.media_type, "text/plain;charset=utf-8");
        assert_eq!(
            text.content,
            "[00:00:01] Alice: corrected line\n[01:00:00] Alice: next"
        );
        assert_eq!(
            rendered(&raw, LibraryExportFormat::Markdown, true).content,
            "# sample.wav\n\n**[00:00:01] Alice:** corrected line\n\n**[01:00:00] Alice:** next"
        );
        let srt = rendered(&raw, LibraryExportFormat::Srt, true);
        assert_eq!(srt.file_name, "sample.srt");
        assert_eq!(srt.media_type, "application/x-subrip;charset=utf-8");
        assert_eq!(srt.content, "1\n00:00:01,000 --> 00:00:02,500\nAlice: corrected line\n\n2\n01:00:00,000 --> 01:00:01,000\nAlice: next");
        let vtt = rendered(&raw, LibraryExportFormat::Vtt, true);
        assert_eq!(vtt.file_name, "sample.vtt");
        assert_eq!(vtt.media_type, "text/vtt;charset=utf-8");
        assert_eq!(vtt.content, "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<v Alice>corrected line\n\n01:00:00.000 --> 01:00:01.000\n<v Alice>next\n\n");
        assert_eq!(
            render(
                "x",
                "video/mp4",
                Some(&raw),
                None,
                None,
                &LibraryExportFormat::Text,
                None
            )
            .unwrap()
            .content,
            "[00:00:01] Recognized: original\n[01:00:00] Recognized: next"
        );
        let structured = json!({"speakers":[{"speakerId":"s", "displayName":"Structured name"}]});
        assert_eq!(
            render(
                "x",
                "audio/wav",
                Some(&raw),
                Some(&structured),
                None,
                &LibraryExportFormat::Text,
                None
            )
            .unwrap()
            .content,
            "[00:00:01] Structured name: original\n[01:00:00] Structured name: next"
        );
    }

    #[test]
    fn transcripts_without_speakers_have_no_name_prefix() {
        let raw = json!({"segments":[{"segmentId":"z", "text":"hello", "locator":{"kind":"time", "startMs":0, "endMs":1000}}]});
        for (format, expected) in [
            (LibraryExportFormat::Text, "[00:00:00] hello"),
            (
                LibraryExportFormat::Markdown,
                "# sample.wav\n\n**[00:00:00]** hello",
            ),
            (
                LibraryExportFormat::Srt,
                "1\n00:00:00,000 --> 00:00:01,000\nhello",
            ),
            (
                LibraryExportFormat::Vtt,
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n\n",
            ),
        ] {
            assert_eq!(rendered(&raw, format, true).content, expected);
        }
    }

    #[test]
    fn validates_localized_page_labels_and_contains_file_headings() {
        assert_eq!(page_label(None).unwrap(), "Page {page}");
        let label = "第 {page} 頁";
        assert_eq!(page_label(Some(label)).unwrap(), label);
        assert!(page_label(Some(&format!("{}{{page}}", "a".repeat(34)))).is_ok());
        for invalid in [
            "page",
            "{page}{page}",
            "\n{page}",
            "\u{0085}{page}",
            "\u{2028}{page}",
            &format!("{}{{page}}", "a".repeat(35)),
        ] {
            assert!(page_label(Some(invalid)).is_err());
        }
        let payload = render(
            "file\n# injected\u{2028}title",
            "image/png",
            Some(&ocr()),
            None,
            Some(&edits()),
            &LibraryExportFormat::Markdown,
            Some(label),
        )
        .unwrap();
        assert!(payload
            .content
            .starts_with("# file # injected title\n\n## 第 1 頁"));
        let request: crate::contracts::LibraryExportRequest = serde_json::from_value(json!({
            "documentId":"test", "format":"markdown", "pageLabel":label
        }))
        .unwrap();
        assert_eq!(request.page_label.as_deref(), Some(label));
    }

    #[test]
    fn subtitles_sanitize_payloads_and_skip_unusable_ranges() {
        let raw = json!({"segments":[
            {"segmentId":"x", "speaker":"s", "text":"one\n \n--> <two>&", "locator":{"kind":"time", "startMs":1, "endMs":1001}},
            {"text":"no end", "locator":{"kind":"time", "startMs":0}},
            {"text":" \r\n ", "locator":{"kind":"time", "startMs":5, "endMs":9}},
            {"text":"backward", "locator":{"kind":"time", "startMs":3, "endMs":2}},
            {"text":"empty range", "locator":{"kind":"time", "startMs":2, "endMs":2}},
            {"text":"negative", "locator":{"kind":"time", "startMs":-1, "endMs":2}},
            {"text":"no locator"}
        ], "speakers":[{"speakerId":"s", "displayName":"A>\n<B&"}]});
        let srt = rendered(&raw, LibraryExportFormat::Srt, true).content;
        assert_eq!(srt.matches("-->").count(), 1);
        assert!(srt.contains("one\n→ <two>&"));
        let vtt = render(
            "x",
            "audio/wav",
            Some(&raw),
            None,
            None,
            &LibraryExportFormat::Vtt,
            None,
        )
        .unwrap()
        .content;
        assert!(vtt.contains("<v A&lt;B&amp;>one\n→ &lt;two&gt;&amp;"));
        assert_eq!(vtt.matches("-->").count(), 1);
        assert!(!vtt.contains("no end"));
        let unlocated = json!({"sourceText":"whole text", "segments":[]});
        assert_eq!(
            rendered(&unlocated, LibraryExportFormat::Text, false).content,
            "whole text"
        );
        assert_eq!(
            rendered(&unlocated, LibraryExportFormat::Markdown, false).content,
            "# sample.wav\n\nwhole text"
        );
        let null_speakers = json!({"speakers": null});
        assert_eq!(
            render(
                "x",
                "audio/wav",
                Some(&transcript()),
                Some(&null_speakers),
                None,
                &LibraryExportFormat::Text,
                None
            )
            .unwrap()
            .content,
            "[00:00:01] Recognized: original\n[01:00:00] Recognized: next"
        );
    }

    #[test]
    fn speaker_names_cannot_change_the_structure_of_a_file() {
        let raw = json!({"speakers":[{"speakerId":"s", "displayName":"A*\u{2028}B --"}], "segments":[
            {"segmentId":"a", "speaker":"s", "text":"one", "locator":{"kind":"time", "startMs":0, "endMs":1000}},
            {"segmentId":"b", "speaker":"s", "text":"skipped", "locator":{"kind":"time", "startMs":5, "endMs":5}},
            {"segmentId":"c", "speaker":"s", "text":"two", "locator":{"kind":"time", "startMs":2000, "endMs":3000}}
        ]});
        let content = |format| {
            render("x", "audio/wav", Some(&raw), None, None, &format, None)
                .unwrap()
                .content
        };
        assert_eq!(
            content(LibraryExportFormat::Markdown),
            "# x\n\n**[00:00:00] A\\* B --:** one\n\n**[00:00:00] A\\* B --:** skipped\n\n**[00:00:02] A\\* B --:** two"
        );
        let vtt = content(LibraryExportFormat::Vtt);
        assert_eq!(vtt.matches("-->").count(), 2);
        assert!(vtt.contains("<v A*B -- >one"));
        // Cue numbers stay consecutive after a skipped line.
        let srt = content(LibraryExportFormat::Srt);
        assert!(srt.starts_with("1\n00:00:00,000 --> 00:00:01,000\n"));
        assert!(srt.contains("\n\n2\n00:00:02,000 --> 00:00:03,000\n"));
        assert_eq!(srt.matches("-->").count(), 2);
    }

    #[test]
    fn only_text_falls_back_to_the_legacy_structured_result() {
        let result = json!({"targetText":"legacy text"});
        assert_eq!(
            render(
                "old.pdf",
                "application/pdf",
                None,
                Some(&result),
                None,
                &LibraryExportFormat::Text,
                None
            )
            .unwrap()
            .content,
            "legacy text"
        );
        assert!(render(
            "old.pdf",
            "application/pdf",
            None,
            None,
            None,
            &LibraryExportFormat::Text,
            None
        )
        .is_err());
        assert!(render(
            "old.pdf",
            "application/pdf",
            None,
            Some(&result),
            None,
            &LibraryExportFormat::Markdown,
            None
        )
        .is_err());
    }
    fn spoken(speakers: serde_json::Value) -> serde_json::Value {
        json!({
            "targetText": "Good morning\nHello there\nmm",
            "speakers": speakers,
            "rawSegments": [
                {"segmentId": "segment-1", "speaker": "SPEAKER_00"},
                {"segmentId": "segment-2", "speaker": "SPEAKER_01"},
                {"segmentId": "segment-3", "speaker": null}
            ],
            "blocks": [
                {"sourceSegmentId": "segment-1", "targetText": "Good morning"},
                {"sourceSegmentId": "segment-2", "targetText": "Hello there"},
                {"sourceSegmentId": "segment-3", "targetText": "mm"}
            ]
        })
    }

    #[test]
    fn transcript_lines_carry_the_given_name_or_the_anonymous_label() {
        let result = spoken(json!([
            {"speakerId": "SPEAKER_00", "displayName": " Ms. Lin "},
            {"speakerId": "SPEAKER_01", "displayName": null}
        ]));
        assert_eq!(
            export_text(&result).as_deref(),
            Some("Ms. Lin: Good morning\nSPEAKER_01: Hello there\nmm")
        );
    }

    #[test]
    fn a_result_without_speakers_exports_its_plain_text() {
        assert_eq!(
            export_text(&spoken(json!([]))).as_deref(),
            Some("Good morning\nHello there\nmm")
        );
        assert_eq!(
            export_text(&json!({"sourceText": "page one"})).as_deref(),
            Some("page one")
        );
        assert_eq!(export_text(&json!({})), None);
    }
}
