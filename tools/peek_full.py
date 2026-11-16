import re, json, os, glob, datetime

from _store import read_blob, store_dir

# 调试用：导出扩展存储里的完整 JSON 记录（config / items / reportCheckState 等）。
# 扩展 ID 通过环境变量 CXW_EXT_ID 指定，见 _store.py。
d = store_dir()
blob = read_blob(d)


def read_varint(buf, i):
    shift = 0
    val = 0
    while i < len(buf):
        b = buf[i]
        val |= (b & 0x7F) << shift
        i += 1
        if not (b & 0x80):
            break
        shift += 7
    return val, i


def free_json_bytes(start):
    depth = 0
    in_str = False
    esc = False
    i = start
    while i < len(blob):
        ch = blob[i : i + 1]
        if in_str:
            if esc:
                esc = False
            elif ch == b"\\":
                esc = True
            elif ch == b'"':
                in_str = False
            i += 1
            continue
        if ch == b'"':
            in_str = True
        elif ch == b"{":
            depth += 1
        elif ch == b"}":
            depth -= 1
            if depth == 0:
                return blob[start : i + 1]
        i += 1
    return None


objs = []
for m in re.finditer(b"reportCheckState", blob):
    _, q = read_varint(blob, m.end())
    while q < len(blob) and blob[q : q + 1] not in (b"{", b"["):
        q += 1
    raw = free_json_bytes(q)
    if not raw:
        continue
    try:
        objs.append(json.loads(raw.decode("utf-8", "replace"), strict=False))
    except Exception:
        pass

last = objs[-1]
results = last.get("results") or []
print("results: %d\n" % len(results))
for r in results:
    print("=" * 78)
    print("课程:", r.get("course"), "| 标题:", r.get("title"), "| level:", r.get("level"))
    print("viewUrl:", r.get("viewUrl"))
    print("url   :", r.get("url"))
    print("params:", json.dumps(r.get("params") or {}, ensure_ascii=False))
    print("status:", r.get("status"), "deadline:", r.get("deadline"))
    an = r.get("analysis") or {}
    print("reportTitle:", an.get("reportTitle"), "textLen:", an.get("textLen"))
    print("textAnswerLen:", r.get("textAnswerLen"))
    ta = r.get("textAnswer")
    if ta:
        print("textAnswer 前150:", str(ta)[:150])
    for a in r.get("attachments") or []:
        print(
            "  附件 name=%-42s zone=%-9s type=%-5s size=%-9s textLen=%-6s via=%-10s statusErr=%s dlErr=%s"
            % (
                str(a.get("name"))[:42],
                a.get("zone"),
                str(a.get("type"))[:5],
                str(a.get("size"))[:9],
                a.get("textLen"),
                str(a.get("downloadVia"))[:10],
                str(a.get("statusError"))[:30],
                str(a.get("downloadError"))[:70],
            )
        )
    dbg = r.get("debug") or r.get("pageSignals") or {}
    print("debug:", json.dumps(dbg, ensure_ascii=False)[:400])
    print("reasons:", [str(x)[:100] for x in (r.get("reasons") or [])])
