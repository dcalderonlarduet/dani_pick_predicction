#!/usr/bin/env python3
"""Validate DK splits HTML parser logic without Node."""
import re
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "dk-splits-full.html").read_text(encoding="utf-8", errors="replace")

def strip_tags(value):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value or "")).strip()

def parse_odd_row(row_html):
    label_m = re.search(r'class="tb-slipline"[^>]*>([\s\S]*?)</div>', row_html, re.I)
    label = strip_tags(label_m.group(1) if label_m else "")
    pcts = [float(x) for x in re.findall(r"(\d+(?:\.\d+)?)\s*%", row_html)]
    return {"label": label, "handlePct": pcts[0] if len(pcts) > 0 else None, "betsPct": pcts[1] if len(pcts) > 1 else None}

def normalize_market(label):
    t = (label or "").lower()
    if "moneyline" in t: return "moneyline"
    if "spread" in t or "run line" in t: return "spread"
    if "total" in t: return "total"
    return t.replace(" ", "_") or "unknown"

def find_team_row(rows, team):
    target = strip_tags(team).lower()
    best, best_score = None, 0
    for row in rows:
        label = row["label"].lower()
        if label == target:
            return row
        if target in label or label in target:
            score = min(len(label), len(target)) / max(len(label), len(target))
            if score > best_score:
                best, best_score = row, score
    return best if best_score >= 0.45 else None

games = []
for block in re.split(r'<div class="tb-se">', html)[1:]:
    title_m = re.search(r'class="tb-se-title"[\s\S]*?<a[^>]*>([\s\S]*?)</a>', block, re.I)
    if not title_m:
        continue
    title = strip_tags(title_m.group(1))
    if "@" not in title:
        continue
    away, home = [p.strip() for p in title.split("@", 1)]
    markets = {}
    for m in re.finditer(r'<div class="tb-se-head">([\s\S]*?)</div>\s*<div class="tb-sm">([\s\S]*?)</div>', block, re.I):
        header = strip_tags(re.search(r"<div>([\s\S]*?)</div>", m.group(1), re.I).group(1))
        mtype = normalize_market(header)
        rows = []
        for row_html in re.findall(r'<div class="tb-sodd">([\s\S]*?)</div>\s*(?=<div class="tb-sodd">|</div>\s*</div>)', m.group(2), re.I):
            row = parse_odd_row(row_html)
            if row["label"]:
                rows.append(row)
        if rows:
            markets[mtype] = rows
    home_ml = find_team_row(markets.get("moneyline", []), home)
    games.append({"away": away, "home": home, "home_ml": home_ml})

result = {
    "ok": len(games) > 0,
    "count": len(games),
    "sample": games[0] if games else None,
}
print(json.dumps(result, indent=2))
