from __future__ import annotations

from capture_runtime.japanese_kanji import TABLE


def test_old_kanji_forms_become_their_japanese_forms() -> None:
    assert "會議の天氣、企畫書を說明する。".translate(TABLE) == "会議の天気、企画書を説明する。"


def test_an_old_form_with_several_listed_forms_takes_the_joyo_one() -> None:
    # OpenCC also lists 䀋 for 鹽 and 畵 for 畫; neither is a jōyō kanji.
    assert "鹽と畫".translate(TABLE) == "塩と画"


def test_kanji_standard_japanese_writes_stay_as_they_are() -> None:
    # 填 is an accepted alternate of the jōyō 塡; 們 and 這 have no Japanese form.
    text = "補填した会議の天気、們這"
    assert text.translate(TABLE) == text


def test_one_pass_converts_every_old_form_fully() -> None:
    olds = "".join(chr(code) for code in TABLE)
    once = olds.translate(TABLE)
    assert all(old != japanese for old, japanese in zip(olds, once, strict=True))
    assert once.translate(TABLE) == once
