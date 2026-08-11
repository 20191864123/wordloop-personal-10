#!/usr/bin/env python3
"""Build a reproducible Chinese-meaning patch for empty WordLoop entries."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path


MISSING_VALUES = {"", "暂无释义"}

# These are transparent, reviewed translations for compounds that ECDICT does
# not contain (plus one ambiguous folded match). They are intentionally short.
MANUAL_OVERRIDES = {
    "antivirus": "n. 杀毒软件；抗病毒程序；adj. 抗病毒的",
    "unsubscribe": "v. 退订；取消订阅",
    "mm-mm": "嗯嗯；唔唔（表示肯定、否定或犹豫的鼻音）",
    "non-citizen": "非公民；外国人",
    "ten-year": "十年的；为期十年的",
    "computer-generated": "计算机生成的",
    "post-world": "世界大战后的（常见于 post-World War…）",
    "three-game": "三场比赛的",
    "caregiving": "照护；护理工作",
    "civil-military": "军民的；文职与军事之间的",
    "four-hour": "四小时的",
    "all-white": "全白色的；全由白人组成的",
    "fifth-grade": "五年级的",
    "three-bedroom": "三居室的；有三间卧室的",
    "eighth-grade": "八年级的",
    "test-retest": "测验—重测的；重测的",
    "public-private": "公共与私人部门的；公私合作的",
    "one-bedroom": "一居室的；有一间卧室的",
    "seventeenth-century": "十七世纪的",
    "single-payer": "单一支付方的（医疗保险制度）",
    "lower-income": "较低收入的",
    "parent-child": "亲子之间的",
    "three-week": "为期三周的",
    "two-and-a-half": "两个半的",
    "state-level": "州级的；国家层级的",
    "non-religious": "非宗教的；无宗教信仰的",
    "spanish-language": "西班牙语的",
    "likert-type": "李克特式的（量表）",
    "all-new": "全新的",
    "market-based": "以市场为基础的；市场导向的",
    "e-reader": "电子阅读器",
    "three-part": "由三部分组成的",
    "third-grade": "三年级的",
    "sixth-grade": "六年级的",
    "end-of-day": "日终的；一天结束时的",
    "anti-immigrant": "反移民的",
    "ponzi": "庞氏骗局的；庞氏（人名）",
    "third-largest": "第三大的",
    "high-income": "高收入的",
    "in-game": "游戏中的；比赛中的",
    "one-room": "单间的；只有一个房间的",
    "long-held": "长期持有的；长期以来的",
    "fourth-grade": "四年级的",
    "twelve-year-old": "十二岁的；十二岁的人",
    "low-sodium": "低钠的",
    "two-minute": "两分钟的",
    "state-sponsored": "国家资助的；国家支持的",
    "end-of-life": "临终的；使用寿命结束阶段的",
    "population-based": "基于人群的",
    "butt-head": "笨蛋；讨厌鬼（俚语）",
    "oscar-winning": "奥斯卡获奖的",
    "frickin": "该死的；非常（委婉的粗俗强调）",
    "son-of-a-bitch": "狗娘养的；混蛋（粗俗）",
    "well-respected": "广受尊敬的",
    "six-week": "为期六周的",
    "four-game": "四场比赛的",
    "infographic": "信息图；信息图表",
    "non-muslim": "非穆斯林的；非穆斯林",
    "four-time": "四次的；四届的",
    "webinar": "网络研讨会",
    "anti-muslim": "反穆斯林的",
    "two-month": "为期两个月的",
    "racial/ethnic": "种族/族裔的",
    "clubface": "高尔夫球杆杆面",
    "sex/nudity": "性内容/裸露内容",
    "four-cylinder": "四缸的",
    "decades-long": "长达数十年的",
    "ha-ha-ha": "哈哈哈（笑声）",
    "forty-seven": "四十七",
    "reauthorization": "重新授权；再授权",
    "quarter-century": "四分之一个世纪；二十五年",
    "seventy-two": "七十二",
}


def folded(value: str) -> str:
    value = value.casefold().replace("’", "'")
    return re.sub(r"[^a-z0-9]+", "", value)


def clean_translation(value: str) -> str:
    lines = []
    for line in str(value or "").replace("\\n", "\n").splitlines():
        line = line.strip()
        if not line or line.startswith("[网络]"):
            continue
        lines.append(line)
    return "；".join(lines[:3]).strip("； ")


def load_ecdict(path: Path):
    exact: dict[str, str] = {}
    folded_candidates: dict[str, set[tuple[str, str]]] = defaultdict(set)
    with path.open(encoding="utf-8", errors="replace", newline="") as handle:
        for row in csv.DictReader(handle):
            word = str(row.get("word") or "").strip()
            meaning = clean_translation(row.get("translation") or "")
            if not word or not meaning:
                continue
            key = word.casefold()
            exact.setdefault(key, meaning)
            folded_candidates[folded(word)].add((key, meaning))
    return exact, folded_candidates


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--ecdict", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    args = parser.parse_args()

    library = json.loads(args.library.read_text(encoding="utf-8"))
    exact, folded_candidates = load_ecdict(args.ecdict)
    entries = []
    unresolved = []
    ambiguous = []
    counts = defaultdict(int)

    for item in library.get("words", []):
        if str(item.get("meaning") or "").strip() not in MISSING_VALUES:
            continue
        word = str(item.get("word") or "").strip()
        word_key = word.casefold()
        meaning = MANUAL_OVERRIDES.get(word_key)
        method = "manual"
        if not meaning:
            meaning = exact.get(word_key)
            method = "ecdict-exact"
        if not meaning:
            candidates = folded_candidates.get(folded(word), set())
            meanings = {candidate_meaning for _, candidate_meaning in candidates}
            if len(meanings) == 1:
                meaning = next(iter(meanings))
                method = "ecdict-punctuation-folded"
            elif candidates:
                ambiguous.append(
                    {
                        "id": item.get("id"),
                        "rank": item.get("rank"),
                        "word": word,
                        "candidates": sorted(candidate_word for candidate_word, _ in candidates),
                    }
                )
        if not meaning:
            unresolved.append({"id": item.get("id"), "rank": item.get("rank"), "word": word})
            continue
        counts[method] += 1
        entries.append(
            {
                "id": item.get("id"),
                "rank": item.get("rank"),
                "word": word,
                "meaning": meaning,
                "method": method,
            }
        )

    missing_before = sum(
        str(item.get("meaning") or "").strip() in MISSING_VALUES for item in library.get("words", [])
    )
    payload = {
        "format": "wordloop-meaning-patch-v1",
        "datasetFingerprint": library.get("datasetFingerprint"),
        "source": {
            "name": "ECDICT",
            "url": "https://github.com/skywind3000/ECDICT",
            "commit": args.source_commit,
            "license": "MIT",
            "policy": "Only fill empty meanings; never overwrite an existing meaning.",
        },
        "missingBefore": missing_before,
        "patchedCount": len(entries),
        "manualCount": counts["manual"],
        "exactCount": counts["ecdict-exact"],
        "punctuationFoldedCount": counts["ecdict-punctuation-folded"],
        "unresolvedCount": len(unresolved),
        "ambiguousCount": len(ambiguous),
        "entries": entries,
        "unresolved": unresolved,
        "ambiguous": ambiguous,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload["contentSha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {key: payload[key] for key in (
                "missingBefore", "patchedCount", "manualCount", "exactCount",
                "punctuationFoldedCount", "unresolvedCount", "ambiguousCount",
            )},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
