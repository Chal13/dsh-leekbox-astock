#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""a-stock-data sidecar: only the endpoints that genuinely need Python.

Scope (deliberately narrow):
  - pboc_social_financing : PBC xls three-hop chain (openpyxl/xlrd)
  - chinabond_yield_curve : Chinabond HTML table parsing
  - repo_fixing_rates     : ChinaMoney CSV

Protocol: one JSON object per line on stdin, one per line on stdout.
  request : {"id": "...", "op": "...", "args": {...}}
  response: {"id": "...", "ok": true, "rows": [...], "meta": {...}}
            {"id": "...", "ok": false, "error": "中文", "detail": "..."}
"""
import io
import json
import re
import sys
from datetime import date, datetime, timedelta

import pandas as pd
import requests

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def _get(url, timeout=30, headers=None, params=None):
    merged = dict(UA)
    merged.update(headers or {})
    response = requests.get(url, headers=merged, params=params, timeout=timeout)
    response.raise_for_status()
    # PBC / NBS pages are Chinese HTML; without this requests falls back to
    # ISO-8859-1 and every Chinese regex fails silently.
    if response.encoding is None or response.encoding.lower() in ("iso-8859-1", "ascii"):
        response.encoding = response.apparent_encoding or "utf-8"
    return response


def _num(value):
    try:
        if value is None or (isinstance(value, float) and value != value):
            return None
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- PBC 社融
PBC_BASE = "https://www.pbc.gov.cn"
PBC_INDEX = f"{PBC_BASE}/diaochatongjisi/116219/116319/index.html"


def _abs_pbc(href):
    return href if href.startswith("http") else PBC_BASE + href


def pboc_social_financing(year=None):
    index = _get(PBC_INDEX).text
    years = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*(\d{4})年统计数据\s*</a>""", index)
    if not years:
        raise RuntimeError("人民银行索引页未找到「XXXX年统计数据」链接，页面结构可能已变更")
    table = {int(y): href for href, y in years}
    target = max(table) if year is None else int(year)
    if target not in table:
        raise RuntimeError(f"人民银行无 {target} 年数据，可选年份: {sorted(table, reverse=True)[:8]}")

    ypage = _get(_abs_pbc(table[target])).text
    topics = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*(社会融资规模)\s*</a>""", ypage)
    if not topics:
        raise RuntimeError(f"{target} 年页未找到「社会融资规模」专题链接")

    tpage = _get(_abs_pbc(topics[0][0])).text
    books = re.findall(r"""href=["']([^"']+\.xlsx?)["']""", tpage)
    if not books:
        raise RuntimeError(f"{target} 年社融专题页未找到 xls/xlsx 附件")

    content = _get(_abs_pbc(books[0]), timeout=60).content
    raw = pd.read_excel(io.BytesIO(content), header=None)

    start = None
    for i in range(len(raw)):
        if str(raw.iloc[i, 0]).strip() == "月份":
            start = i
            break
    if start is None:
        raise RuntimeError(
            f"{target} 年社融表没有独立的「月份」表头单元格；本端点仅支持 2021 年起"
        )

    cols = ["month", "afre_total", "rmb_loans", "fx_loans", "entrusted_loans",
            "trust_loans", "undiscounted_bankers_acceptance", "corporate_bonds",
            "government_bonds", "equity_financing", "abs_by_depository", "loans_written_off"]
    frame = raw.iloc[start + 3:].copy().iloc[:, :len(cols)]
    frame.columns = cols
    frame = frame[frame["month"].astype(str).str.match(r"^\d{4}\.\d{1,2}$", na=False)].copy()
    for column in cols[1:]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    def label(value):
        match = re.match(r"^(\d{4})\.(\d{1,2})$", str(value).strip())
        if not match:
            return None
        year_s, month_s = match.group(1), match.group(2)
        if len(month_s) == 1:
            month_s += "0"
        return f"{year_s}-{int(month_s):02d}"

    frame["month"] = [label(v) for v in frame["month"]]
    frame = frame[frame["month"].notna()]
    frame = frame[frame["month"].str.startswith(f"{target}-")].reset_index(drop=True)
    frame = frame.dropna(subset=["afre_total"]).reset_index(drop=True)
    if frame.empty:
        raise RuntimeError(f"社融表解析后无有效月份（{target} 年），格式可能已变更")

    rows = []
    for record in frame.to_dict(orient="records"):
        row = {"month": record["month"]}
        for column in cols[1:]:
            value = record.get(column)
            row[column] = None if pd.isna(value) else float(value)
        rows.append(row)
    return rows, {"year": target, "unit": "亿元"}


# ------------------------------------------------------------ 中债收益率
CHINABOND_URL = "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery"
CHINABOND_CURVES = {"all": "ycqx", "treasury": "hzsylqx", "bank_aaa": "syyhsylqx", "mtn_aaa": "zdqpjsylqx"}
CHINABOND_HEADER = ["曲线名称", "日期", "3月", "6月", "1年", "3年", "5年", "7年", "10年", "30年"]
CHINABOND_TENORS = ["3m", "6m", "1y", "3y", "5y", "7y", "10y", "30y"]
CHINABOND_NAMES = {
    "treasury": "中债国债收益率曲线",
    "bank_aaa": "中债商业银行普通债收益率曲线(AAA)",
    "mtn_aaa": "中债中短期票据收益率曲线(AAA)",
}
CHINABOND_FIRST = {"treasury": "2006-03-01", "mtn_aaa": "2006-12-25", "bank_aaa": "2009-12-24"}


def chinabond_yield_curve(start, end=None, curve="all"):
    if curve not in CHINABOND_CURVES:
        raise RuntimeError("curve 只能是 " + " / ".join(CHINABOND_CURVES))
    first = datetime.strptime(start, "%Y-%m-%d").date()
    last = datetime.strptime(end, "%Y-%m-%d").date() if end else date.today()
    if first > last:
        raise RuntimeError("start 不能晚于 end")
    wanted = [k for k in CHINABOND_NAMES if curve in ("all", k)]
    begin = datetime.strptime(min(CHINABOND_FIRST[k] for k in wanted), "%Y-%m-%d").date()
    if last < begin:
        raise RuntimeError(f"中债 {curve} 曲线从 {begin} 起才有数据")
    first = max(first, begin)
    by_name = {CHINABOND_NAMES[k]: k for k in wanted}

    rows, cursor, seen = [], first, {}
    while cursor <= last:
        stop = min(cursor + timedelta(days=359), last)
        response = _get(
            CHINABOND_URL,
            params={"startDate": cursor.isoformat(), "endDate": stop.isoformat(),
                    "gjqx": 0, "qxId": CHINABOND_CURVES[curve], "locale": "cn_ZH"},
            timeout=30,
        )
        text = re.sub(r"<!--.*?-->", "", response.text, flags=re.S)
        tables = text.split("<table")
        table_rows = re.findall(r"<tr[^>]*>(.*?)</tr>", tables[-1], re.S) if len(tables) > 2 else []
        cells = [[re.sub(r"<[^>]+>|\s+", "", c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S)]
                 for r in table_rows]
        if not cells or cells[0] != CHINABOND_HEADER:
            raise RuntimeError("中债收益率页面表头改变，不能按原列序解析")
        chunk = 0
        for record in cells[1:]:
            if len(record) != len(CHINABOND_HEADER):
                raise RuntimeError(f"中债收益率行列数不对: {record}")
            day = str(record[1])
            if not cursor.isoformat() <= day <= stop.isoformat():
                raise RuntimeError(f"中债 请求 {cursor}~{stop} 却返回了 {day} 的曲线，结果不可信")
            if record[0] not in by_name:
                raise RuntimeError(f"中债 返回了未请求的曲线「{record[0]}」")
            seen.setdefault(day, set()).add(by_name[record[0]])
            row = {"date": day, "curve": record[0]}
            row.update({k: _num(v) for k, v in zip(CHINABOND_TENORS, record[2:])})
            rows.append(row)
            chunk += 1
        if chunk == 0 and (stop - cursor).days >= 6:
            raise RuntimeError(f"中债 {cursor}~{stop} 一周以上却 0 行，接口口径可能变了")
        cursor = stop + timedelta(days=1)
    if not rows:
        raise RuntimeError(f"{first}~{last} 没有中债收益率（区间内无交易日）")
    rows.sort(key=lambda r: (r["date"], r["curve"]))
    return rows, {"curve": curve, "unit": "%"}


# --------------------------------------------------------- 回购定盘利率
CHINAMONEY_URL = "https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/currency/{name}-chrt.csv"


def repo_fixing_rates(kind="FR"):
    kind = str(kind).upper()
    names = {"FR": "frr", "FDR": "fdr"}
    if kind not in names:
        raise RuntimeError("kind 只能是 'FR' 或 'FDR'")
    response = _get(
        CHINAMONEY_URL.format(name=names[kind]),
        headers={"Referer": "https://www.chinamoney.com.cn/chinese/bkfrr/"},
        timeout=30,
    )
    rows = []
    for line in response.content.decode("utf-8-sig", "replace").splitlines():
        if not line.strip():
            continue
        parts = line.split(",")
        if len(parts) != 9 or any(p.strip() for p in parts[1:6]):
            raise RuntimeError(f"货币网定盘利率 CSV 格式改变: {line[:60]}")
        rows.append({
            "date": parts[0],
            kind + "001": _num(parts[6]),
            kind + "007": _num(parts[7]),
            kind + "014": _num(parts[8]),
        })
    if not rows:
        raise RuntimeError(f"货币网 {kind} 定盘利率为空")
    rows.sort(key=lambda r: r["date"])
    return rows, {"kind": kind, "unit": "%"}


OPS = {
    "pboc_social_financing": pboc_social_financing,
    "chinabond_yield_curve": chinabond_yield_curve,
    "repo_fixing_rates": repo_fixing_rates,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        request_id = request.get("id")
        op = request.get("op")
        args = request.get("args") or {}
        try:
            handler = OPS.get(op)
            if handler is None:
                raise RuntimeError(f"未知的 op: {op}")
            rows, meta = handler(**args)
            response = {"id": request_id, "ok": True, "rows": rows, "meta": meta or {}}
        except Exception as exc:  # noqa: BLE001 - report every failure to the host
            response = {"id": request_id, "ok": False, "error": str(exc), "detail": type(exc).__name__}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
