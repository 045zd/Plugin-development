/**
 * 课表课程过滤：扫描结果只保留"课表中出现过的课程"。
 *
 * 目的：学习通课程列表会包含历史学期课程（例如上学期已结束的课），
 * 用户上传本学期课表后，只监控课表内的课程，避免无关课程的作业混入待办。
 */

/** 课程名归一化：去书名号/括号补充信息/截断省略号/空白，统一小写。 */
export function normalizeCourseName(name) {
  let s = String(name || '');
  // 学习通列表里的课程名常被书名号包裹（如《人工智能》）
  s = s.replace(/[《》〈〉]/g, '');
  // 去掉括号内的补充信息（如"（2026年秋）"、"（上）"）
  s = s.replace(/[（(【\[][^）)】\]]*[)）】\]]/g, '');
  // 去掉列表页截断产生的省略号（如"《计算机组成原...》" → "计算机组成原"）
  s = s.replace(/…/g, '').replace(/[.。]+$/g, '');
  return s.replace(/\s+/g, '').trim().toLowerCase();
}

/**
 * 判断某个课程名是否匹配课表课程。
 * 支持完全一致与包含匹配（"高等数学" ↔ "高等数学A"）。
 * @param {string} courseName
 * @param {string[]} scheduleCourses
 */
export function matchCourse(courseName, scheduleCourses) {
  const c = normalizeCourseName(courseName);
  if (!c) return false;
  for (const raw of scheduleCourses || []) {
    const s = normalizeCourseName(raw);
    if (!s) continue;
    if (c === s || c.includes(s) || s.includes(c)) return true;
  }
  return false;
}

/**
 * 过滤扫描结果。
 * - 未启用过滤 / 课表为空 → 原样返回；
 * - 课程名未知的条目（如部分考试）**保留**，避免漏提醒；
 * - 其余条目按课表过滤。
 *
 * @param {Array} items
 * @param {{courseFilterEnabled?:boolean, scheduleCourses?:string[]}} config
 * @returns {{items: Array, filteredCount: number}}
 */
export function filterItemsBySchedule(items, config) {
  const enabled = Boolean(config && config.courseFilterEnabled);
  const schedule = Array.isArray(config && config.scheduleCourses) ? config.scheduleCourses : [];
  const all = Array.isArray(items) ? items : [];
  if (!enabled || !schedule.length) {
    return { items: all, filteredCount: 0 };
  }
  const kept = [];
  let filteredCount = 0;
  for (const item of all) {
    if (!item) continue;
    if (!item.course) {
      kept.push(item);
      continue;
    }
    if (matchCourse(item.course, schedule)) kept.push(item);
    else filteredCount += 1;
  }
  return { items: kept, filteredCount };
}

/** 规范化用户保存的课表课程列表（去重、限长、容忍非数组输入）。 */
export function normalizeScheduleCourses(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const name = String(raw == null ? '' : raw).trim().slice(0, 40);
    if (!name) continue;
    const key = normalizeCourseName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 60) break;
  }
  return out;
}
