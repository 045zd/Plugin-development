import re, json, os, glob, datetime

from _store import read_blob, store_dir

# 调试用：直接读 Edge 扩展的 LevelDB 存储，查看扩展实际写进去的检查结果。
# 扩展 ID 通过环境变量 CXW_EXT_ID 指定，见 _store.py。
d = store_dir()
blob = read_blob(d)


def read_varint(buf, i):
    """LevelDB 用 varint32 存长度前缀。"""
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
    """从 start 处的 { 开始，按 UTF-8 边界配平括号。"""
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


marker = b"reportCheckState"
objs = []
for m in re.finditer(marker, blob):
    p = m.end()
    # 跳过 varint 长度前缀（0x80 前缀字节）
    _, q = read_varint(blob, p)
    # 定位到 {
    while q < len(blob) and blob[q : q + 1] not in (b"{", b"["):
        q += 1
    if q >= len(blob):
        continue
    raw = free_json_bytes(q)
    if not raw:
        continue
    try:
        objs.append(json.loads(raw.decode("utf-8", "replace"), strict=False))
    except Exception:
        pass

print("共 %d 条 reportCheckState 记录\n" % len(objs))
for i, o in enumerate(objs):
    print(
        "[%2d] done=%s/%s skipped=%s running=%s msg=%s"
        % (
            i,
            o.get("done"),
            o.get("total"),
            o.get("skippedPast"),
            o.get("running"),
            str(o.get("message"))[:46],
        )
    )

if not objs:
    raise SystemExit

last = objs[-1]
results = last.get("results") or []
print("\n=== 最后一条 results: %d 项 ===" % len(results))
for r in results:
    print("\n" + "-" * 70)
    print("课程:", r.get("course"), "| 标题:", r.get("title"))
    print("level:", r.get("level"), "| status:", r.get("status"), "| deadline:", r.get("deadline"))
    print("viewUrl:", str(r.get("viewUrl"))[:110])
    an = r.get("analysis") or {}
    print(
        "analysis: reportTitle=%s textLen=%s textAnswerLen=%s"
        % (an.get("reportTitle"), an.get("textLen"), r.get("textAnswerLen"))
    )
    print("sections:", an.get("sections"))
    print("emptySections:", an.get("emptySections"), "| optionalEmpty:", an.get("optionalEmptySections"))
    for a in r.get("attachments") or []:
        print(
            "   附件: name=%-40s zone=%-9s textLen=%-6s error=%s"
            % (str(a.get("name"))[:40], a.get("zone"), a.get("textLen"), str(a.get("error"))[:70])
        )
    for x in r.get("reasons") or []:
        print("   reason:", str(x)[:170])
