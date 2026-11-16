/**
 * 全局常量与默认配置。
 */

/** 默认配置（与 docs/design.md 保持一致）。 */
export const DEFAULT_CONFIG = {
  scanIntervalMinutes: 60,
  checkAssignments: true,
  checkExams: true,
  reminderHours: [72, 24, 6, 1],
  expiredAlert: true,
  browserNotifications: true,
  emailEnabled: false,
  mailProxyUrl: 'http://127.0.0.1:8765',
  maxCourses: 15,
  autoFillAccount: true,
  rememberedAccount: '',
  /** 是否只用课表内的课程过滤扫描结果 */
  courseFilterEnabled: false,
  /** 课表中的课程名列表（用户上传 Excel 后确认） */
  scheduleCourses: [],
  /** 跳转到作答页后，自动打开「大学搜题酱」的 AI 会话 */
  dxAiChatAutoOpen: true,
  /** 扩展页是否显示「已截止/时间未知的未交项」分组（默认不显示） */
  showExpiredItems: false,
};

/** 学习通相关 URL。 */
export const URLS = {
  /** 建立会话的入口页 */
  interaction: 'https://mooc2-ans.chaoxing.com/mooc2-ans/visit/interaction',
  /** 课程列表 JSON 接口（需已登录会话） */
  courseList: 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',
  /** 进入课程（重定向到课程页） */
  courseEntry:
    'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid={courseId}&clazzid={classId}&cpi={cpi}&ismooc2=1&v=2',
  /** 移动版「我的作业」聚合页（全部课程作业，ul.nav > li 结构） */
  aggregateWorks: 'https://mooc1-api.chaoxing.com/work/stu-work',
  /** 移动版「我的考试」聚合页（全部课程考试，ul.ks_list > li 结构） */
  aggregateExams: 'https://mooc1-api.chaoxing.com/exam-ans/exam/phone/examcode',
  /** 登录页 */
  login: 'https://passport2.chaoxing.com/login',
};

export const ALARM_SCAN = 'chaoxing-due-scan';

/** 未登录/登录失效时使用的错误码。 */
export const ERR = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FETCH_FAILED: 'FETCH_FAILED',
  TAB_GONE: 'TAB_GONE',
  TIMEOUT: 'TIMEOUT',
  PARSED_EMPTY: 'PARSED_EMPTY',
  UNKNOWN: 'UNKNOWN',
};

/** 待办状态集合（需要提醒的状态）。 */
export const PENDING_STATUSES = new Set([
  '未交',
  '待互评',
  '进行中',
  '未开始',
  '未知',
  '',
]);

/** 已完成状态集合（不需要提醒）。 */
export const DONE_STATUSES = new Set(['已完成', '已批阅', '已结束', '待批阅']);

/** 全局日志前缀。 */
export const LOG_PREFIX = '[截止提醒]';
