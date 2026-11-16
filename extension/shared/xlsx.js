/**
 * 课表文件解析器（零第三方依赖）。
 *
 * 用途：设置页上传 Excel（.xlsx / .xls 不支持 / .csv）课表，提取课程名候选，
 * 由用户勾选后保存，扫描时只保留这些课程的作业/考试。
 *
 * 实现：
 * - xlsx = zip 容器 + XML；用 DecompressionStream('deflate-raw') 解压；
 * - 只解析第一个工作表；支持 sharedStrings / inlineStr / 数值；
 * - 纯字符串正则解析 XML，不依赖 DOMParser，方便在 Node 中单测。
 *
 * 浏览器用法：<script src="../shared/xlsx.js"></script> 后 window.CXSchedule。
 * Node 用法：await import('./xlsx.js') 后读取 globalThis.CXSchedule。
 */
(function (root) {
  'use strict';

  const MAX_FILE_BYTES = 5 * 1024 * 1024;

  /* ------------------------------ zip ------------------------------ */

  function readU16(view, off) {
    return view.getUint16(off, true);
  }

  function readU32(view, off) {
    return view.getUint32(off, true);
  }

  function decodeUtf8(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /** 解析 zip，返回 Map<文件名, Uint8Array>。 */
  async function unzip(buffer) {
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
    if (eocd < 0) throw new Error('不是有效的 xlsx 文件（缺少 zip 目录）');

    const entryCount = readU16(view, eocd + 10);
    const cdOffset = readU32(view, eocd + 16);
    const files = new Map();
    let p = cdOffset;
    for (let n = 0; n < entryCount; n += 1) {
      if (p + 46 > length || readU32(view, p) !== 0x02014b50) break;
      const method = readU16(view, p + 10);
      const compSize = readU32(view, p + 20);
      const nameLen = readU16(view, p + 28);
      const extraLen = readU16(view, p + 30);
      const commentLen = readU16(view, p + 32);
      const localOffset = readU32(view, p + 42);
      const name = decodeUtf8(new Uint8Array(buffer, p + 46, nameLen));
      if (localOffset + 30 <= length && readU32(view, localOffset) === 0x04034b50) {
        const lhNameLen = readU16(view, localOffset + 26);
        const lhExtraLen = readU16(view, localOffset + 28);
        const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
        if (dataStart + compSize <= length) {
          const compressed = new Uint8Array(buffer, dataStart, compSize);
          try {
            if (method === 0) files.set(name, compressed);
            else if (method === 8) files.set(name, await inflateRaw(compressed));
          } catch {
            /* 单个条目失败忽略 */
          }
        }
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  /* ------------------------------ xml ------------------------------ */

  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
        try {
          return String.fromCodePoint(parseInt(h, 16));
        } catch {
          return '';
        }
      })
      .replace(/&#(\d+);/g, (_, d) => {
        try {
          return String.fromCodePoint(Number(d));
        } catch {
          return '';
        }
      })
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /** 解析 xl/sharedStrings.xml → 字符串数组。 */
  function parseSharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml)) !== null) {
      const inner = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      const parts = [];
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRe.exec(inner)) !== null) parts.push(decodeXmlEntities(tm[1]));
      out.push(parts.join(''));
    }
    return out;
  }

  function colIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i += 1) {
      n = n * 26 + (letters.charCodeAt(i) - 64);
    }
    return n - 1;
  }

  /** 解析工作表 XML → string[][]（按列序号对齐）。 */
  function parseSheet(xml, shared) {
    const rows = [];
    if (!xml) return rows;
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      const cells = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      let lastCol = -1;
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const rMatch = attrs.match(/\br="([A-Z]+)\d+"/);
        let col = lastCol + 1;
        if (rMatch) col = colIndex(rMatch[1]);
        lastCol = col;
        const tMatch = attrs.match(/\bt="([^"]+)"/);
        const type = tMatch ? tMatch[1] : '';
        let text = '';
        if (type === 's') {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          if (v) {
            const idx = parseInt(v[1], 10);
            if (!Number.isNaN(idx)) text = shared[idx] || '';
          }
        } else if (type === 'inlineStr') {
          const t = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
          if (t) text = decodeXmlEntities(t[1]);
        } else if (type === 'str') {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          if (v) text = decodeXmlEntities(v[1]);
        } else {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          if (v) text = decodeXmlEntities(v[1]);
        }
        cells[col] = text;
      }
      const out = [];
      for (let i = 0; i < cells.length; i += 1) out.push(cells[i] == null ? '' : cells[i]);
      rows.push(out);
    }
    return rows;
  }

  function pickSheetName(files) {
    if (files.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
    for (const name of files.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) return name;
    }
    return '';
  }

  /** xlsx ArrayBuffer → string[][]。 */
  async function parseXlsxRows(buffer) {
    const files = await unzip(buffer);
    const sheetName = pickSheetName(files);
    if (!sheetName) throw new Error('xlsx 中找不到工作表');
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const sharedXml = files.has('xl/sharedStrings.xml')
      ? decoder.decode(files.get('xl/sharedStrings.xml'))
      : '';
    const sheetXml = decoder.decode(files.get(sheetName));
    const shared = parseSharedStrings(sharedXml);
    return parseSheet(sheetXml, shared);
  }

  /* ------------------------------ csv ------------------------------ */

  function decodeText(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        return new TextDecoder('gbk').decode(bytes);
      } catch {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }
    }
  }

  /** 简单 CSV 解析（支持双引号转义、逗号/制表符分隔）。 */
  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const delimiter = text.indexOf('\t') !== -1 && text.indexOf(',') === -1 ? '\t' : ',';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          cell += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (ch === '\r') {
        /* skip */
      } else {
        cell += ch;
      }
    }
    if (cell.length || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows;
  }

  /* --------------------------- 课程名提取 --------------------------- */

  const TIME_RE = /^\d{1,2}[:：]\d{2}/;
  const WEEKDAY_RE = /^(星期|周)[一二三四五六日天]/;
  const SECTION_RE = /^第?\d+([-~～—,，、]\d+)?(节|大节|小节)?$/;
  const NOISE_RE =
    /^(课程|课程表|课表|时间|节次|上午|下午|晚上|中午|午休|备注|教师|老师|地点|教室|学分|序号|星期|周一|周二|周三|周四|周五|周六|周日|周末|作息|校历|专业)/;
  const ROOM_RE = /^(教|楼|室|馆|区|实验|机房)[\u4e00-\u9fa5A-Za-z0-9-]{0,12}$/;
  const TITLE_RE =
    /^(20\d\d|.*学年|.*学期|专业[:：]|.*课表|注[-\u2014]|打印时间|内容顺序|本学期|选课人数)/;

  /**
   * 清洗一条课程文本。
   * 支持教务系统导出格式："课程名/(节次)周次/校区 地点/教师/课程性质/人数"，
   * 以及"其他课程：课程★教师(共N周)/周次;"这种汇总行。
   */
  function cleanCourseText(line) {
    let s = String(line || '').trim();
    if (!s) return '';
    // 取第一个 "/" 之前的部分（字段分隔符）
    const slash = s.indexOf('/');
    if (slash > 0) s = s.slice(0, slash);
    // 去掉 ★/☆ 及其后的教师名、括号信息
    s = s.replace(/[★☆][\s\S]*$/, '');
    // 去掉"（共16周）"之类
    s = s.replace(/[（(]\s*共\s*\d+\s*周\s*[)）]/g, '');
    // 去掉【必修】之类前缀
    s = s.replace(/^[【\[][^】\]]{1,10}[】\]]\s*/, '');
    return s.trim();
  }

  /** 判断一段清洗后的文本是否像课程名。 */
  function looksLikeCourse(text) {
    const s = String(text || '').trim();
    if (!s || s.length < 2 || s.length > 40) return false;
    if (TIME_RE.test(s) || WEEKDAY_RE.test(s) || NOISE_RE.test(s)) return false;
    if (SECTION_RE.test(s)) return false;
    if (/^[\d\s:：\-~～/、,，.]+$/.test(s)) return false;
    if (TITLE_RE.test(s)) return false;
    if (/正式上课|打印时间|内容顺序|选课人数/.test(s)) return false;
    if (ROOM_RE.test(s) && !/[\u4e00-\u9fa5]{3,}/.test(s)) return false;
    return /[\u4e00-\u9fa5A-Za-z]/.test(s);
  }

  /**
   * 从表格行中提取课程名候选。
   * 策略：
   * - 每个单元格按换行拆成多行（教务课表一个格子常含多门课）；
   * - 每行按 "/" 取第一个字段作为课程名（兼容"课程/节次/地点/教师"格式）；
   * - 同行用分号分隔多门课时逐个拆分（"其他课程：A★..; B☆.."）；
   * - 统计出现次数，按次数降序返回 [{name, count}]。
   * @param {string[][]} rows
   */
  function extractCourseCandidates(rows) {
    const counts = new Map();
    const add = (name) => {
      const cleaned = cleanCourseText(name);
      if (!looksLikeCourse(cleaned)) return false;
      counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
      return true;
    };
    for (const row of rows || []) {
      for (const cell of row) {
        const text = String(cell || '').trim();
        if (!text) continue;
        const lines = text
          .split(/[\r\n]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!lines.length) continue;

        // 教务系统格式：单元格内每行是一整门课（"课程/节次/地点/教师/性质/人数"）
        const hasSlash = lines.some((line) => line.indexOf('/') > 0);
        if (hasSlash) {
          for (const line of lines) {
            const segments =
              /^其他课程[:：]/.test(line) || /[;；]/.test(line)
                ? line.replace(/^其他课程[:：]/, '').split(/[;；]+/)
                : [line];
            for (const seg of segments) add(seg);
          }
        } else {
          // 纯文本格式（如"高等数学\n张老师\n教A101"）：只取第一个像课程名的行
          for (const line of lines) {
            if (add(line)) break;
          }
        }
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  }

  /* ------------------------------ API ------------------------------ */

  /**
   * 解析课表文件。
   * @param {{name:string, buffer:ArrayBuffer}} file
   * @returns {Promise<{rows: string[][], candidates: Array<{name:string,count:number}>}>}
   */
  async function parseFile(file) {
    const name = String(file && file.name ? file.name : '');
    const buffer = file && file.buffer;
    if (!buffer) throw new Error('没有读取到文件内容');
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new Error('文件超过 5MB，请精简后再上传');
    }
    const lower = name.toLowerCase();
    let rows;
    if (lower.endsWith('.xlsx') || isZip(buffer)) {
      rows = await parseXlsxRows(buffer);
    } else if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
      rows = parseCsvRows(decodeText(new Uint8Array(buffer)));
    } else {
      // 兜底：先按 xlsx 试，再按 csv 试
      try {
        rows = await parseXlsxRows(buffer);
      } catch {
        rows = parseCsvRows(decodeText(new Uint8Array(buffer)));
      }
    }
    return { rows, candidates: extractCourseCandidates(rows) };
  }

  function isZip(buffer) {
    if (!buffer || buffer.byteLength < 4) return false;
    const head = new Uint8Array(buffer, 0, 4);
    return head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05);
  }

  const api = {
    parseFile,
    parseXlsxRows,
    parseCsvRows,
    extractCourseCandidates,
    looksLikeCourse,
    MAX_FILE_BYTES,
  };

  root.CXSchedule = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
