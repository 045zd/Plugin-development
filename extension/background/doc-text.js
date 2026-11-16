/**
 * 附件正文提取（用于实验报告检查）。
 *
 * 支持三种格式，全部零依赖、在扩展内完成：
 * 1. docx  —— zip + word/document.xml；
 * 2. doc   —— OLE2 复合文档，优先按 FIB 的 CLX/Piece Table 精确取文本，
 *              失败时回退为「扫描 WordDocument 流里的 UTF-16LE / CP1252 文本片段」；
 * 3. pdf   —— 解析对象流中的 /Contents 文本操作符（Tj、TJ、'、"）；
 *              无 ToUnicode 映射的中文 PDF 只能得到部分文本，此时标记为「需人工确认」。
 *
 * 所有函数都在**页面上下文**里执行（自包含，可被序列化注入），
 * 也导出可供 Node 测试使用的纯函数。
 */

/* ------------------------------------------------------------------ */
/* 通用：zip 读取（docx）                                              */
/* ------------------------------------------------------------------ */

function readU16(view, off) {
  return view.getUint16(off, true);
}
function readU32(view, off) {
  return view.getUint32(off, true);
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 从 zip 里取一个文件（返回 Uint8Array 或 null）。 */
async function unzipOne(buffer, wanted) {
  const view = new DataView(buffer);
  const length = buffer.byteLength;
  let eocd = -1;
  const minPos = Math.max(0, length - 22 - 65535);
  for (let i = length - 22; i >= minPos; i -= 1) {
    if (readU32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = readU16(view, eocd + 10);
  const cdOffset = readU32(view, eocd + 16);
  let p = cdOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (p + 46 > length || readU32(view, p) !== 0x02014b50) break;
    const method = readU16(view, p + 10);
    const compSize = readU32(view, p + 20);
    const nameLen = readU16(view, p + 28);
    const extraLen = readU16(view, p + 30);
    const commentLen = readU16(view, p + 32);
    const localOffset = readU32(view, p + 42);
    const name = new TextDecoder().decode(new Uint8Array(buffer, p + 46, nameLen));
    if (name === wanted) {
      const lhNameLen = readU16(view, localOffset + 26);
      const lhExtraLen = readU16(view, localOffset + 28);
      const start = localOffset + 30 + lhNameLen + lhExtraLen;
      if (start + compSize > length) return null;
      const compressed = new Uint8Array(buffer, start, compSize);
      return method === 0 ? compressed : await inflateRaw(compressed);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** WordprocessingML → 纯文本。 */
function docxXmlToText(xml) {
  return String(xml || '')
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocxText(buffer) {
  const bytes = await unzipOne(buffer, 'word/document.xml');
  if (!bytes) return '';
  return docxXmlToText(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
}

/* ------------------------------------------------------------------ */
/* .doc：OLE2 复合文档                                                 */
/* ------------------------------------------------------------------ */

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;

/** 解析 OLE2 容器，返回 { sectorSize, miniSectorSize, fat, miniFat, miniStream, entries }。 */
export function parseCompoundFile(buffer) {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length < 512 ||
    bytes[0] !== 0xd0 ||
    bytes[1] !== 0xcf ||
    bytes[2] !== 0x11 ||
    bytes[3] !== 0xe0
  ) {
    return null;
  }
  const view = new DataView(buffer);
  const sectorSize = 1 << readU16(view, 0x1e);
  const miniSectorSize = 1 << readU16(view, 0x20);
  const numFat = readU32(view, 0x2c);
  const dirStart = readU32(view, 0x30);
  const miniFatStart = readU32(view, 0x3c);
  const difatStart = readU32(view, 0x44);
  const numDifat = readU32(view, 0x48);

  const sectorOffset = (sid) => (sid + 1) * sectorSize;
  const readSector = (sid) => {
    const off = sectorOffset(sid);
    if (off + sectorSize > bytes.length) return new Uint8Array(0);
    return bytes.subarray(off, off + sectorSize);
  };

  // DIFAT → FAT 扇区列表
  const fatSectors = [];
  for (let i = 0; i < 109; i += 1) {
    const sid = readU32(view, 0x4c + i * 4);
    if (sid !== FREESECT && sid !== ENDOFCHAIN) fatSectors.push(sid);
  }
  let difatSid = difatStart;
  const perSector = sectorSize / 4 - 1;
  let guard = 0;
  while (
    difatSid !== FREESECT &&
    difatSid !== ENDOFCHAIN &&
    guard < numDifat + 8 &&
    sectorOffset(difatSid) + sectorSize <= bytes.length
  ) {
    const off = sectorOffset(difatSid);
    for (let i = 0; i < perSector; i += 1) {
      const sid = readU32(view, off + i * 4);
      if (sid !== FREESECT && sid !== ENDOFCHAIN) fatSectors.push(sid);
    }
    difatSid = readU32(view, off + perSector * 4);
    guard += 1;
  }

  const fat = [];
  for (const sid of fatSectors.slice(0, numFat)) {
    const sec = readSector(sid);
    const dv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
    for (let i = 0; i < sec.byteLength / 4; i += 1) fat.push(readU32(dv, i * 4));
  }

  const chain = (start) => {
    const out = [];
    const seen = new Set();
    let sid = start;
    while (sid !== FREESECT && sid !== ENDOFCHAIN && sid < fat.length && !seen.has(sid)) {
      seen.add(sid);
      out.push(sid);
      sid = fat[sid];
    }
    return out;
  };

  const readChain = (start) => {
    const parts = [];
    for (const sid of chain(start)) parts.push(readSector(sid));
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  };

  // 目录项
  const dirBytes = readChain(dirStart);
  const dview = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries = [];
  for (let i = 0; i + 128 <= dirBytes.byteLength; i += 128) {
    const nameLen = readU16(dview, i + 0x40);
    if (nameLen < 2 || nameLen > 64) continue;
    let name = '';
    for (let j = 0; j + 1 < nameLen - 1; j += 2) {
      name += String.fromCharCode(readU16(dview, i + j));
    }
    entries.push({
      name,
      type: dirBytes[i + 0x42],
      start: readU32(dview, i + 0x74),
      size: readU32(dview, i + 0x78),
    });
  }

  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? readChain(root.start) : new Uint8Array(0);
  const miniFat = [];
  if (miniFatStart !== ENDOFCHAIN && miniFatStart !== FREESECT) {
    const mf = readChain(miniFatStart);
    const mview = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    for (let i = 0; i + 4 <= mf.byteLength; i += 4) miniFat.push(readU32(mview, i));
  }

  const readMiniChain = (start, size) => {
    const out = new Uint8Array(size);
    let at = 0;
    const seen = new Set();
    let sid = start;
    while (
      sid !== FREESECT &&
      sid !== ENDOFCHAIN &&
      sid < miniFat.length &&
      !seen.has(sid) &&
      at < size
    ) {
      seen.add(sid);
      const off = sid * miniSectorSize;
      const take = Math.min(miniSectorSize, size - at, miniStream.byteLength - off);
      if (take <= 0) break;
      out.set(miniStream.subarray(off, off + take), at);
      at += take;
      sid = miniFat[sid];
    }
    return at === size ? out : out.subarray(0, at);
  };

  const getStream = (name) => {
    const ent = entries.find((e) => e.name === name && e.type === 2);
    if (!ent) return null;
    if (ent.size < 4096) return readMiniChain(ent.start, ent.size);
    return readChain(ent.start).subarray(0, ent.size);
  };

  return { sectorSize, miniSectorSize, entries, getStream };
}

/** 用 CLX 的 Piece Table 精确提取（Word 97+）。 */
function docTextFromClx(word, table, clxOffset, clxLength) {
  if (!table || clxOffset <= 0 || clxLength <= 0) return '';
  const clx = table.subarray(clxOffset, clxOffset + clxLength);
  const cv = new DataView(clx.buffer, clx.byteOffset, clx.byteLength);
  let i = 0;
  while (i < clx.byteLength && clx[i] === 1) {
    const cb = readU16(cv, i + 1);
    i += 3 + cb;
  }
  if (i >= clx.byteLength || clx[i] !== 2) return '';
  const lcb = readU32(cv, i + 1);
  const plcStart = i + 5;
  if (plcStart + lcb > clx.byteLength) return '';
  const n = Math.floor((lcb - 4) / 12);
  if (n <= 0) return '';
  const cps = [];
  for (let k = 0; k <= n; k += 1) cps.push(readU32(cv, plcStart + k * 4));
  const pieces = [];
  const fcBase = plcStart + (n + 1) * 4;
  for (let k = 0; k < n; k += 1) {
    const fcRaw = readU32(cv, fcBase + k * 8 + 2);
    const compressed = Boolean(fcRaw & 0x40000000);
    let fc = fcRaw & 0x3fffffff;
    const cch = cps[k + 1] - cps[k];
    if (cch <= 0 || cch > 8000000) continue;
    if (compressed) {
      fc = Math.floor(fc / 2);
      const raw = word.subarray(fc, fc + cch);
      pieces.push(new TextDecoder('windows-1252').decode(raw));
    } else {
      const raw = word.subarray(fc, fc + cch * 2);
      pieces.push(new TextDecoder('utf-16le').decode(raw));
    }
  }
  return pieces.join('');
}

/** 回退：扫描流里的 UTF-16LE / CP1252 可读片段。 */
function scanReadableRuns(bytes, minLen = 4) {
  const out = [];
  let cur = [];
  const push = () => {
    if (cur.length >= minLen) {
      const text = cur.join('');
      if (/[\u4e00-\u9fa5A-Za-z]/.test(text)) out.push(text);
    }
    cur = [];
  };
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const ch = bytes[i] | (bytes[i + 1] << 8);
    const printable =
      (ch >= 0x20 && ch <= 0x7e) ||
      (ch >= 0x4e00 && ch <= 0x9fff) ||
      [0x3001, 0x3002, 0xff0c, 0xff1a, 0xff08, 0xff09, 0xff1b, 0x2018, 0x2019, 0x201c, 0x201d, 0x300a, 0x300b, 0x2026, 0x00b7, 0x0020].includes(ch);
    if (printable) cur.push(String.fromCharCode(ch));
    else push();
  }
  push();
  return out;
}

/**
 * 从 .doc 提取正文。
 * 先按 FIB 精确定位 CLX，失败则回退启发式扫描。
 */
export function extractDocText(buffer) {
  const cfb = parseCompoundFile(buffer);
  if (!cfb) return { text: '', method: 'none', ok: false };
  const word = cfb.getStream('WordDocument');
  if (!word || word.byteLength < 64) return { text: '', method: 'none', ok: false };

  const wview = new DataView(word.buffer, word.byteOffset, word.byteLength);
  const fibFlags = readU16(wview, 0x0a);
  if (fibFlags & 0x0100) return { text: '', method: 'none', ok: false, encrypted: true };

  const tableName = fibFlags & 0x0200 ? '1Table' : '0Table';
  const table = cfb.getStream(tableName);

  // FIB 变长结构：csw(2) + rgW97(28) + cslw(2) + rgLw97(88) + cbRgFcLcb(2) + rgFcLcb(变长)
  let text = '';
  try {
    let pos = 0x20;
    const csw = readU16(wview, pos);
    pos += 2 + csw * 2;
    const cslw = readU16(wview, pos);
    pos += 2 + cslw * 4;
    const cbRgFcLcb = readU16(wview, pos);
    const rgStart = pos + 2;
    // fcClx/lcbClx 是 FibRgFcLcb97 中的第 33 对
    const CLX_PAIR = 33;
    if (cbRgFcLcb >= (CLX_PAIR + 1) * 8 && rgStart + (CLX_PAIR + 1) * 8 <= word.byteLength) {
      const fcClx = readU32(wview, rgStart + CLX_PAIR * 8);
      const lcbClx = readU32(wview, rgStart + CLX_PAIR * 8 + 4);
      text = docTextFromClx(word, table, fcClx, lcbClx);
    }
  } catch {
    text = '';
  }

  let method = 'pieceTable';
  if (!text || text.replace(/\s+/g, '').length < 8) {
    method = 'scan';
    text = scanReadableRuns(word).join('\n');
  }

  text = String(text)
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, method, ok: text.length > 0 };
}

/* ------------------------------------------------------------------ */
/* pdf：从内容流里取文本                                               */
/* ------------------------------------------------------------------ */

function pdfLiteralStrings(content) {
  // 解析 ( ... ) 字面量，处理转义与嵌套括号
  const out = [];
  const n = content.length;
  let i = 0;
  while (i < n) {
    if (content[i] !== '(') {
      i += 1;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    let buf = '';
    while (j < n && depth > 0) {
      const ch = content[j];
      if (ch === '\\') {
        const next = content[j + 1];
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (next in map) {
          buf += map[next];
          j += 2;
          continue;
        }
        if (/[0-7]/.test(next)) {
          let oct = '';
          let k = j + 1;
          while (k < n && oct.length < 3 && /[0-7]/.test(content[k])) {
            oct += content[k];
            k += 1;
          }
          buf += String.fromCharCode(parseInt(oct, 8));
          j = k;
          continue;
        }
        j += 2;
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      if (depth >= 1) buf += ch;
      j += 1;
    }
    if (buf) out.push(buf);
    i = j + 1;
  }
  return out;
}

/** 从 PDF 提取文本（英文/数字可靠；无 ToUnicode 的中文可能缺失）。 */
export function extractPdfText(buffer) {
  const bytes = new Uint8Array(buffer);
  const latin = new TextDecoder('windows-1252').decode(bytes);
  const texts = [];

  // 逐个 content stream 提取（BT ... ET 之间）
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  let scanned = 0;
  while ((m = streamRe.exec(latin)) !== null && scanned < 400) {
    scanned += 1;
    const content = m[1];
    if (!/(Tj|TJ)\b/.test(content)) continue;
    const parts = pdfLiteralStrings(content);
    if (parts.length) texts.push(parts.join(''));
  }

  // 有些 PDF 直接以十六进制串表示文本，这里只取字面量
  const text = texts
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 提取附件正文。
 * @param {ArrayBuffer} buffer
 * @param {string} name 文件名（用于判断格式）
 * @param {string} [declaredType] 学习通给出的 filetype
 * @returns {Promise<{ok:boolean, kind:string, text:string, method:string}>}
 */
export async function extractAttachmentText(buffer, name, declaredType) {
  const filename = String(name || '').toLowerCase();
  const type = String(declaredType || '').toLowerCase();
  const head = new Uint8Array(buffer.slice(0, 8));

  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isOle = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;

  // 魔数优先：学习通给出的 filetype 与文件名都可能是错的
  if (isZip) {
    const text = await extractDocxText(buffer);
    return { ok: text.length > 0, kind: 'docx', text, method: 'ooxml' };
  }
  if (isOle) {
    const r = extractDocText(buffer);
    return { ok: r.ok, kind: 'doc', text: r.text, method: r.method };
  }
  if (isPdf) {
    const text = extractPdfText(buffer);
    return { ok: text.length > 0, kind: 'pdf', text, method: 'contentStream' };
  }

  // 魔数不可用（极少数被截断的文件）时按文件名/声明类型兜底
  const docxLike = type === 'docx' || /\.docx$/i.test(filename) || /\.docm$/i.test(filename);
  const docLike = type === 'doc' || /\.doc$/i.test(filename);
  const pdfLike = type === 'pdf' || /\.pdf$/i.test(filename);

  if (docxLike) {
    const text = await extractDocxText(buffer);
    return { ok: text.length > 0, kind: 'docx', text, method: 'ooxml' };
  }
  if (docLike) {
    const r = extractDocText(buffer);
    return { ok: r.ok, kind: 'doc', text: r.text, method: r.method };
  }
  if (pdfLike) {
    const text = extractPdfText(buffer);
    return { ok: text.length > 0, kind: 'pdf', text, method: 'contentStream' };
  }
  return { ok: false, kind: 'other', text: '', method: 'unsupported' };
}
