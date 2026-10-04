#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""鶯歌工商校園查詢 MCP 工具：分機、班級分機、行事曆與生輔組規定。"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("ykvs_school")
BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
PACK = DATA / "ykvs_mvp_source_pack" / "data"

REGULATIONS = {
    "mobile_device_policy": {
        "title": "生輔組－行動載具管理規則",
        "keywords": ["行動載具", "手機", "平板", "載具"],
    },
    "conduct_and_class_order": {
        "title": "生輔組－品德教育暨班級生活秩序競賽實施要點",
        "keywords": ["品德", "生活秩序", "秩序競賽", "班級競賽"],
    },
    "student_rewards_discipline": {
        "title": "生輔組－學生獎懲規定",
        "keywords": ["獎懲", "嘉獎", "警告", "小過", "大過", "懲處", "銷過"],
    },
    "student_leave_rules": {
        "title": "生輔組－學生請假規則",
        "keywords": ["請假", "病假", "事假", "公假", "補假", "喪假", "身心調適假"],
    },
}


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _compact(text: str) -> str:
    return re.sub(r"\s+", "", str(text or "")).lower()


def _law_matches(query: str) -> list[tuple[str, dict[str, Any], str]]:
    q = _compact(query)
    found = []
    for key, meta in REGULATIONS.items():
        path = PACK / "regulations" / f"{key}.md"
        if any(_compact(word) in q for word in meta["keywords"]):
            text = path.read_text(encoding="utf-8") if path.exists() else ""
            found.append((key, meta, text))
    return found


def _law_snippets(query: str, text: str, profile: list[str]) -> list[str]:
    # PDF 文字換行可能切斷句子；以重疊字元區塊檢索，回傳原文附近段落。
    body = re.sub(r"\s+", "", text)
    body = re.sub(r"^.*?---第\d+頁---", "", body)
    if not body:
        return []
    q = _compact(query)
    if any(x in q for x in ("幾天", "多久", "期限", "幾日")):
        # 期限問題回傳每個假別的期限原文，避免把病假、事假等規則混成單一期限。
        pattern = re.compile(r"十天內|十日內|天內|日內|前一日|當天上課前")
        deadline_hits = []
        for match in pattern.finditer(body):
            start, end = max(0, match.start() - 130), min(len(body), match.end() + 90)
            snippet = body[start:end]
            if deadline_hits and start < deadline_hits[-1][0]:
                continue
            if deadline_hits and start <= deadline_hits[-1][1]:
                prev_start, prev_end, prev_text = deadline_hits[-1]
                deadline_hits[-1] = (prev_start, max(prev_end, end), body[prev_start:max(prev_end, end)])
            else:
                deadline_hits.append((start, end, snippet))
        deadline_hits = [x[2] for x in deadline_hits]
        if deadline_hits:
            return deadline_hits[:5]
    terms = list(dict.fromkeys(profile))
    if any(x in q for x in ("幾天", "多久", "期限", "幾日")):
        terms += ["十天內", "十日內", "天內", "日內", "前一日", "當天"]
    size, step = 420, 250
    scored = []
    for start in range(0, len(body), step):
        chunk = body[start:start + size]
        score = sum(2 if term in chunk else 0 for term in terms)
        # 也利用查詢中的兩字詞提高中文問句的命中率。
        cjk_runs = re.findall(r"[\u4e00-\u9fff]+", q)
        bigrams = {run[i:i+2] for run in cjk_runs for i in range(max(0, len(run)-1))}
        score += sum(1 for bg in bigrams if bg in chunk)
        if score:
            scored.append((score, start, chunk))
    scored.sort(key=lambda x: (-x[0], x[1]))
    results, used = [], set()
    for score, start, chunk in scored:
        if any(abs(start - old) < size for old in used):
            continue
        results.append(chunk)
        used.add(start)
        if len(results) == 3:
            break
    return results


def _cjk_bigrams(text: str) -> set[str]:
    runs = re.findall(r"[\u4e00-\u9fff]+", _compact(text))
    return {run[i:i + 2] for run in runs for i in range(max(0, len(run) - 1))}


def _additional_regulation_results(query: str) -> list[dict[str, Any]]:
    """Search PDF-to-JSON records added by other school offices."""
    data = _read_json(PACK / "additional_regulations.json")
    records = data.get("records", [])
    q = _compact(query)
    synonym_map = {
        "違反": ["違規", "懲處", "處分", "處罰"],
        "違規": ["違反", "懲處", "處分", "處罰"],
        "申請資格": ["申請條件", "符合資格", "應符合"],
        "申請條件": ["申請資格", "符合資格", "應符合"],
        "申請方式": ["應備文件", "檢附", "申請程序"],
        "申請期限": ["截止日期", "期限", "幾日內", "天內"],
        "補助金額": ["補助", "金額", "獎助金額"],
    }
    expanded_query = q + " " + " ".join(
        synonym for term, synonyms in synonym_map.items() if _compact(term) in q for synonym in synonyms
    )
    query_terms = _cjk_bigrams(expanded_query)
    by_document: dict[str, list[tuple[float, dict[str, Any]]]] = {}
    for row in records:
        meta = " ".join(str(row.get(key, "")) for key in
                        ("department", "unit", "category", "title", "section_heading"))
        keywords = [str(x) for x in row.get("keywords", []) if str(x).strip()]
        exact_keywords = [x for x in keywords if len(_compact(x)) >= 2 and _compact(x) in q]
        title = _compact(row.get("title", ""))
        title_match = bool(title and (title in q or q in title))
        meta_hits = len(query_terms & _cjk_bigrams(meta + " " + " ".join(keywords)))
        content_hits = len(query_terms & _cjk_bigrams(str(row.get("content", ""))))
        if not (exact_keywords or title_match or meta_hits >= 2 or (meta_hits >= 1 and content_hits >= 2)):
            continue
        score = 8 * len(exact_keywords) + (12 if title_match else 0) + 1.6 * meta_hits + 0.25 * content_hits
        doc_id = str(row.get("document_id") or row.get("title") or "unknown")
        by_document.setdefault(doc_id, []).append((score, row))

    output = []
    ranked_docs = sorted(by_document.values(), key=lambda rows: max(x[0] for x in rows), reverse=True)
    for rows in ranked_docs[:5]:
        rows.sort(key=lambda x: x[0], reverse=True)
        # Newly extracted PDF text is not trusted until a teacher has checked
        # it against the source document. Only explicitly approved records are
        # eligible for answers.
        approved_rows = [
            item for item in rows
            if str(item[1].get("review_status", "")).strip() in {"已人工核對", "教師已核可", "approved"}
        ]
        for _, row in approved_rows[:2]:
            output.append({
                "資料ID": row.get("data_id", ""),
                "類別": row.get("category", ""),
                "處室": row.get("department", ""),
                "單位": row.get("unit", ""),
                "標題": row.get("title", ""),
                "條次或段落": row.get("section_heading", ""),
                "內容": row.get("content", ""),
                "頁碼": row.get("page_start", ""),
                "公告日期": row.get("publication_date", ""),
                "官方來源": row.get("source_url", row.get("official_url", "")),
                "最後檢核日期": row.get("last_verified_date", ""),
                "抽核狀態": row.get("review_status", "待人工抽核"),
            })
    return output


def _extension_results(query: str) -> dict[str, Any]:
    q = _compact(query)
    staff_data = _read_json(PACK / "staff_extensions.json")
    class_data = _read_json(PACK / "class_extensions.json")
    results: dict[str, Any] = {}

    classes = class_data.get("班級分機", {})
    class_hits = [{"班級": k, "分機": v} for k, v in classes.items() if _compact(k) in q]
    if class_hits:
        results["班級分機"] = class_hits

    broadcast = class_data.get("年級廣播", {})
    broadcast_hits = [{"年級": k, "號碼": v} for k, v in broadcast.items() if _compact(k) in q]
    if broadcast_hits:
        results["年級廣播"] = broadcast_hits

    contacts = staff_data.get("處室窗口", [])
    aliases = {
        "教務處": "教務主任", "學務處": "學務主任", "總務處": "總務主任",
        "實習處": "實習處主任", "輔導室": "輔導主任",
        "生輔組": "生輔組長", "生活輔導組": "生輔組長",
    }
    contact_hits = []
    for row in contacts:
        labels = [row.get("單位", ""), row.get("職稱", "")]
        alias_match = any(_compact(a) in q and _compact(role) in _compact(row.get("職稱", ""))
                          for a, role in aliases.items())
        if alias_match or any(_compact(label) and _compact(label) in q for label in labels):
            if row not in contact_hits:
                contact_hits.append(row)
    if contact_hits:
        results["處室窗口"] = contact_hits

    records = staff_data.get("分機紀錄", [])
    record_hits = []
    # 處室名稱對應到總表中的主管職稱，補足總表以職稱而非處室名列資料的情形。
    for office, role in aliases.items():
        if _compact(office) in q:
            for row in records:
                if _compact(role) in _compact(row.get("職稱", "")):
                    item = {"單位": row.get("單位", ""), "職稱": row.get("職稱", ""), "姓名": row.get("姓名", ""), "分機": row.get("分機", [])}
                    if item not in record_hits:
                        record_hits.append(item)
    extension_numbers = set(re.findall(r"(?<!\d)\d{3,5}(?!\d)", query))
    name_matches = [row for row in records if _compact(row.get("姓名", "")) and _compact(row["姓名"]) in q]
    room_records = staff_data.get("場館分機", [])
    has_specific_place = any(_compact(row.get("場所", "")) and _compact(row["場所"]) in q for row in room_records)
    if has_specific_place:
        candidate_rows = []
    elif name_matches:
        # 姓名是最明確的條件；「查某老師的職稱/單位/分機」不要因為問句
        # 含有「教師」等泛稱而把整份教師名冊都帶回。
        candidate_rows = name_matches
    else:
        generic_roles = {"教師", "專任教師", "兼課教師", "導師", "教學支援人員", "班級導師", "任課教師"}
        generic_units = {"班級導師", "任課教師", "行政", "教學人員（請以職稱判讀）", "行政／教學人員（請以職稱判讀）"}
        role_candidates, unit_candidates, number_candidates = [], [], []
        for row in records:
            role, unit = row.get("職稱", ""), row.get("單位", "")
            role_match = _compact(role) in q and role not in generic_roles
            unit_match = any(_compact(part) in q for part in re.split(r"[／/、]", unit)
                             if _compact(part) and part not in generic_units)
            number_match = bool(extension_numbers.intersection(str(n) for n in row.get("分機", [])))
            if role_match:
                role_candidates.append(row)
            if unit_match:
                unit_candidates.append(row)
            if number_match:
                number_candidates.append(row)
        # 明確查詢職稱時優先回傳職稱命中，不因問句同時含單位名稱而列出整科人員。
        candidate_rows = role_candidates or unit_candidates or number_candidates
    for row in candidate_rows:
        item = {"單位": row.get("單位", ""), "職稱": row.get("職稱", ""),
                "姓名": row.get("姓名", ""), "分機": row.get("分機", [])}
        if item not in record_hits:
            record_hits.append(item)
    if record_hits:
        results["分機總表紀錄"] = record_hits[:12]

    # 公告版最右欄列出各大樓專業教室與公共空間；舊資料只有人員分機，
    # 因此另以「大樓／場所／分機」結構索引，避免場館查詢混入人員名冊。
    # 場館／教室查詢不要要求「完整場所名稱」必須逐字出現在問題中。
    # 例如資料是「6樓資處科6D電腦教室」，使用者輸入
    # 「我要查資處科6D電腦教室分機」也應該命中。
    # 這裡建立幾種自然語言常見別名：去掉樓層前綴、保留科別＋房號、
    # 以及單純的房號＋場所類型，避免把使用者綁死在公告原文格式。
    def _room_aliases(place: str) -> list[str]:
        value = _compact(place)
        aliases = {value} if value else set()
        no_floor = re.sub(r"^(?:第)?\d+樓", "", value)
        if no_floor:
            aliases.add(no_floor)
            # 例如「資處科6D電腦教室」→「6D電腦教室」
            m = re.search(r"([1-9]\d?[A-Za-zＡ-Ｚａ-ｚ]?)((?:電腦教室|電腦工場|專題室|選手室|教室))$", no_floor)
            if m:
                aliases.add(m.group(1) + m.group(2))
        return sorted(aliases, key=len, reverse=True)

    def _room_match(query: str, place: str, building: str) -> bool:
        q_text = _compact(query)
        place_text = _compact(place)
        building_text = _compact(building)
        if place_text and place_text in q_text:
            return True
        if any(alias and len(alias) >= 4 and alias in q_text for alias in _room_aliases(place)):
            return True
        # 「教學大樓6D」這種寫法也能命中，但單獨「電腦教室」不算。
        no_floor = re.sub(r"^(?:第)?\d+樓", "", place_text)
        code = re.match(r"(?:.*?)([1-9]\d?[A-Za-zＡ-Ｚａ-ｚ])(?:電腦教室|電腦工場|專題室|選手室|教室)$", no_floor)
        if code and code.group(1).lower() in q_text and (
            "教室" in q_text or "工場" in q_text or "專題室" in q_text or "選手室" in q_text
        ):
            if not building_text or building_text in q_text or "大樓" not in q_text:
                return True
        return False

    room_hits = []
    for row in room_records:
        building, place = row.get("大樓", ""), row.get("場所", "")
        if _room_match(q, place, building):
            room_hits.append(row)
    if room_hits:
        results["場館分機"] = room_hits
    if results.get("分機總表紀錄") or results.get("場館分機"):
        results["分機資料來源"] = {
            "文件": staff_data.get("資料名稱", "鶯歌工商分機公告版"),
            "公告日期": staff_data.get("資料日期", ""),
            "來源檔案": staff_data.get("來源檔案", ""),
            "校方網站": "https://www.ykvs.ntpc.edu.tw/",
        }
    return results


def _calendar_results(query: str) -> dict[str, Any]:
    calendar_data = _read_json(DATA / "english_center.json")
    weeks = calendar_data.get("calendar_weeks", [])
    if not weeks:
        return {"錯誤": "找不到行事曆週資料，請確認 english_center.json 已包含 calendar_weeks。"}
    q = _compact(query)
    month_hits = re.findall(r"(\d{1,2})月", q)
    date_hits = [(int(m), int(d)) for m, d in re.findall(r"(\d{1,2})月(\d{1,2})日", q)]
    if not date_hits:
        date_hits = [(int(m), int(d)) for m, d in re.findall(
            r"(?<!\d)(?:20\d{2}[/-])?(\d{1,2})[/-](\d{1,2})(?!\d)", q
        )]

    def event_mentions_day(text: str, month: int, day: int) -> bool:
        compact = re.sub(r"\s+", "", text)
        if re.search(rf"(?<!\d){month}(?:/|月){day}日?(?!\d)", compact):
            return True
        date_range = re.compile(
            r"(?<!\d)(\d{1,2})[/月](\d{1,2})日?(?:~|～|-|－|至|到)"
            r"(?:(\d{1,2})[/月])?(\d{1,2})日?"
        )
        target = month * 32 + day
        for match in date_range.finditer(compact):
            start_month, start_day = int(match.group(1)), int(match.group(2))
            end_month = int(match.group(3) or start_month)
            end_day = int(match.group(4))
            start, end = start_month * 32 + start_day, end_month * 32 + end_day
            check = target
            if end < start:
                end += 12 * 32
                if check < start:
                    check += 12 * 32
            if start <= check <= end:
                return True
        return False

    def only_day_events(notes: dict[str, str], month: int, day: int) -> dict[str, str]:
        selected = {}
        for office, text in notes.items():
            entries = re.split(r"(?=◎)", str(text))
            hits = [entry.strip() for entry in entries if entry.strip() and event_mentions_day(entry, month, day)]
            if hits:
                selected[office] = "\n".join(hits)
        return selected

    matched = []
    for week in weeks:
        dates = week.get("每日日期", [])
        if date_hits:
            month, day = date_hits[0]
            if not any(str(d).endswith(f"-{month:02d}-{day:02d}") for d in dates):
                continue
        elif month_hits:
            month = int(month_hits[0])
            if not any(str(d).split("-")[1:2] == [f"{month:02d}"] for d in dates):
                continue
        notes = week.get("各處室行程", {})
        if date_hits:
            notes = only_day_events(notes, month, day)
        office = next((name for name in notes if _compact(name) in q), None)
        if office:
            notes = {office: notes[office]}
        matched.append({
            "週別": week.get("週別"), "日期起": week.get("日期起"),
            "日期迄": week.get("日期迄"), "各處室行程": notes,
            "說明": "依行事曆文字中標註的日期或日期區間篩選。",
        })
        if len(matched) >= 8:
            break
    return {"行事曆": matched, "來源": calendar_data.get("calendar_source", "請查校方最新公告")}


@mcp.tool()
def search_school_info(query: str) -> str:
    """查詢鶯歌工商公開校務資料：教職員姓名／單位／職稱／分機、班級分機、
    綜合大樓／教學大樓／圖研大樓／陶工大樓／學生宿舍的辦公室與專業教室分機、
    115-1行事曆、生輔組四份規定，以及 additional_regulations.json 中新增處室規定。
    可按姓名反查職稱、單位與分機，或按場所名稱查場館分機。
    請輸入自然語言問題。只回傳相關資料或法規原文摘錄與官方來源。
    法規問題依假別／條文回答，不要把不同期限混為一談；資料沒有明確答案時應說明未提供。"""
    q = str(query or "").strip()
    if not q:
        return json.dumps({"錯誤": "請輸入查詢內容。"}, ensure_ascii=False)

    law_hits = _law_matches(q)
    if law_hits:
        results = []
        manifest = _read_json(PACK / "manifest.json")
        source_map = {x.get("id"): x for x in manifest.get("regulations", [])}
        for key, meta, text in law_hits:
            src = source_map.get(key, {})
            snippets = _law_snippets(q, text, meta["keywords"])
            results.append({"文件": meta["title"], "來源": src.get("source_url", ""), "原文摘錄": snippets})
        return json.dumps({"查詢": q, "法規結果": results}, ensure_ascii=False)

    additional_hits = _additional_regulation_results(q)
    if additional_hits:
        return json.dumps({"查詢": q, "新增處室法規": additional_hits}, ensure_ascii=False)

    if any(x in _compact(q) for x in ("法規", "規定")) and any(x in _compact(q) for x in ("生輔", "生活輔導", "學務處")):
        manifest = _read_json(PACK / "manifest.json")
        return json.dumps({
            "查詢": q,
            "生輔組規定清單": [
                {"文件": REGULATIONS.get(x.get("id"), {}).get("title", x.get("title", "")), "來源": x.get("source_url", "")}
                for x in manifest.get("regulations", [])
            ],
        }, ensure_ascii=False)

    if any(x in q for x in ("行事曆", "行事历", "幾月", "幾日", "幾號", "行程")):
        return json.dumps({"查詢": q, **_calendar_results(q)}, ensure_ascii=False)

    ext_results = _extension_results(q)
    if ext_results:
        return json.dumps({"查詢": q, **ext_results}, ensure_ascii=False)

    return json.dumps({
        "查詢": q,
        "結果": "在目前資料中找不到明確紀錄。請改用班級名稱、處室名稱、職稱或法規名稱查詢，或查看校方公告。",
        "官方首頁": "https://www.ykvs.ntpc.edu.tw/",
    }, ensure_ascii=False)


if __name__ == "__main__":
    mcp.run(transport="stdio")
