/* ===========================================================================
 * 四象限优先级视图 — 交互效果图(共享逻辑)
 *
 * 仅用于评审布局与交互,不属于产品代码。fullwidth.html(A 全宽)与
 * split.html(B 左树 + 右矩阵)共用本文件,由 #app[data-variant] 区分。
 *
 * 刻意与真实实现保持一致的部分(保证手感保真):
 *   - 原生 HTML5 拖拽(同 TaskTable / ResourceList),不引入拖拽库;
 *   - 选中语义:单击替换、Ctrl/⌘+单击切换、Shift+单击按可见顺序连选;
 *   - 双击 = 打开编辑抽屉;右键 = 任务菜单;
 *   - 值没变就不产生撤销记录;一次操作(含多选)= 一条撤销记录。
 * =========================================================================== */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const VARIANT = app.dataset.variant; // 'fullwidth' | 'split'
  const IS_SPLIT = VARIANT === 'split';
  const THEME_KEY = 'ganttly:mockup:theme';

  // ---- 优先级定义(对应拟新增的 Task.priority: 1 | 2 | 3 | 4;缺省 = 未分级) ----
  const PRIORITY = {
    1: { tag: 'P1', title: '紧急且重要', hint: '立即做' },
    2: { tag: 'P2', title: '重要不紧急', hint: '计划做' },
    3: { tag: 'P3', title: '紧急不重要', hint: '授权做' },
    4: { tag: 'P4', title: '不紧急不重要', hint: '少做' },
  };
  const QUADS = [1, 2, 3, 4];
  /** 结束日期距今不超过这么多工作日 → 标"临期"。 */
  const DUE_SOON_WORKING_DAYS = 3;

  const ROW_HEIGHT = 32;
  /** 任务树列宽:工期 / 人天 / 进度(同 layoutPrefs 的 DEFAULT_COLUMN_WIDTHS)。 */
  const COL_DURATION = 72;
  const COL_EFFORT = 56;
  const COL_PROGRESS = 56;
  const COL_WBS = 76;
  const TREE_GRID = `${COL_WBS}px minmax(0, 1fr) ${COL_DURATION}px ${COL_EFFORT}px ${COL_PROGRESS}px`;
  const TREE_WIDTH = { default: 480, min: 320, max: 720 };

  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  const MOD_KEY = IS_MAC ? 'metaKey' : 'ctrlKey';
  const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

  // ---- 图标(lucide 线稿路径) ----
  const ICONS = {
    'calendar-days':
      '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    expand:
      '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'git-branch':
      '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevrons-up-down': '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    'list-tree':
      '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
    users:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'layout-grid':
      '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    inbox:
      '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    alert:
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    'rotate-ccw':
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
    grip:
      '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    pencil:
      '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    scissors:
      '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
    paste:
      '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11v6"/><path d="m9 14 3 3 3-3"/>',
    diamond:
      '<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.4l7.6 7.6a2.41 2.41 0 0 0 3.4 0l7.6-7.6a2.41 2.41 0 0 0 0-3.4l-7.6-7.6a2.41 2.41 0 0 0-3.4 0Z"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    indent: '<polyline points="3 8 7 12 3 16"/><line x1="21" x2="11" y1="12" y2="12"/>',
    outdent: '<polyline points="7 8 3 12 7 16"/><line x1="21" x2="11" y1="12" y2="12"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    sort: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
    gantt: '<path d="M5 4v16"/><path d="M9 7h9"/><path d="M9 11h5"/><path d="M9 15h7"/>',
  };
  const icon = (name, size = 15) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

  // ---- 工具函数 ----
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromDate = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (iso, n) => {
    const d = fromDate(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
  };
  /** b - a,自然日。 */
  const diffDays = (a, b) => Math.round((fromDate(b) - fromDate(a)) / DAY);
  /** (from, to] 内的工作日个数(仅排除周末;效果图不接节假日日历)。 */
  const workdaysAfter = (from, to) => {
    let n = 0;
    for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
      const w = fromDate(d).getDay();
      if (w !== 0 && w !== 6) n++;
    }
    return n;
  };
  /** 含首尾的工作日个数。 */
  const workdaysInclusive = (a, b) => (a > b ? 0 : workdaysAfter(addDays(a, -1), b));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** 同 Canvas 的规则:进度色 = 任务色 × factor。 */
  const darken = (hex, factor) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = (shift) => Math.round(((n >> shift) & 255) * factor);
    return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- 资源(负责人) ----
  const RESOURCES = [
    { id: 'wang', name: '王强', role: '前端' },
    { id: 'li', name: '李娜', role: '后端' },
    { id: 'meng', name: '孟祥俊', role: '设计' },
    { id: 'chen', name: '陈晨', role: '测试' },
    { id: 'zhao', name: '赵磊', role: '产品' },
  ];
  const RESOURCE_BY_ID = new Map(RESOURCES.map((r) => [r.id, r]));
  /** 同 ResourceList:姓名哈希配色 + 首字。 */
  const avatarClass = (name) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return `av${Math.abs(hash) % 8}`;
  };
  const initialsOf = (name) => {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return words[0][0].toUpperCase();
  };
  /** `withTitle` 只在抽屉里用:卡片上的头像不带 title,避免与自定义悬浮提示叠出两个气泡。 */
  const avatarHtml = (r, withTitle = false) =>
    `<span class="avatar ${avatarClass(r.name)}"${withTitle ? ` title="${esc(r.name)}"` : ''}>${esc(initialsOf(r.name))}</span>`;

  /** 同 lib/taskColors.ts 的色卡。 */
  const TASK_PALETTE = [
    '#60a5fa', '#818cf8', '#a78bfa', '#f472b6', '#fb7185',
    '#fb923c', '#fbbf24', '#34d399', '#2dd4bf', '#94a3b8',
  ];

  // ---- 模拟数据:一个软件项目,日期相对"今天"生成,保证总能看到逾期 / 临期 ----
  const C = { violet: '#a78bfa', teal: '#2dd4bf', emerald: '#34d399', amber: '#fbbf24', rose: '#fb7185' };
  function seedTasks(today) {
    const T = (id, name, parent, start, end, progress, who = [], x = {}) => ({
      id,
      name,
      parent,
      start: addDays(today, start),
      end: addDays(today, end),
      progress,
      who,
      ms: Boolean(x.ms),
      color: x.color,
      prio: x.prio,
    });
    return [
      // 1 项目启动
      T('p1', '项目启动', null, 0, 0, 0, ['zhao']),
      T('t11', '需求评审会', 'p1', -22, -22, 100, ['zhao', 'wang', 'li', 'meng'], { ms: true, prio: 1 }),
      T('t12', '竞品调研', 'p1', -30, -25, 100, ['zhao']),
      T('t13', '项目章程签署', 'p1', -20, -18, 100, ['zhao'], { prio: 2 }),
      // 2 视觉与交互设计
      T('p2', '视觉与交互设计', null, 0, 0, 0, ['meng']),
      T('t21', '信息架构', 'p2', -21, -15, 100, ['meng'], { color: C.violet, prio: 2 }),
      T('t22', '首页视觉稿', 'p2', -14, -1, 85, ['meng'], { color: C.violet, prio: 1 }),
      T('t23', '列表页视觉稿', 'p2', -7, 2, 40, ['meng'], { color: C.violet }),
      T('t24', '详情页视觉稿', 'p2', -3, 5, 10, ['meng'], { color: C.violet }),
      T('t25', '设计评审', 'p2', 3, 3, 0, ['zhao', 'meng'], { ms: true, prio: 1 }),
      T('t26', '设计规范文档', 'p2', 4, 12, 0, ['meng'], { color: C.violet, prio: 2 }),
      T('t27', '图标素材导出', 'p2', 4, 6, 0, ['meng'], { color: C.violet, prio: 3 }),
      // 3 前端开发
      T('p3', '前端开发', null, 0, 0, 0, ['wang']),
      T('t31', '首页开发', 'p3', -10, 1, 60, ['wang'], { prio: 1 }),
      T('t32', '列表页开发', 'p3', 3, 12, 0, ['wang']),
      T('t33', '详情页开发', 'p3', 8, 18, 0, ['wang']),
      T('t34', '响应式适配', 'p3', 12, 20, 0, ['wang']),
      T('t35', '首屏性能优化', 'p3', 16, 22, 0, ['wang'], { prio: 2 }),
      T('t36', '埋点接入', 'p3', 18, 20, 0, ['wang'], { prio: 4 }),
      T('t37', '旧版浏览器兼容', 'p3', 20, 24, 0, ['wang'], { prio: 3 }),
      // 4 后端与接口
      T('p4', '后端与接口', null, 0, 0, 0, ['li']),
      T('t41', 'CMS 内容接口', 'p4', -12, -3, 70, ['li'], { color: C.teal, prio: 1 }),
      T('t42', '搜索服务联调', 'p4', -2, 3, 30, ['li'], { color: C.teal, prio: 2 }),
      T('t43', '缓存与 CDN 配置', 'p4', 6, 10, 0, ['li'], { color: C.teal, prio: 2 }),
      T('t44', '临时活动页接口', 'p4', -1, 2, 0, ['li'], { color: C.teal, prio: 3 }),
      T('t45', '安全扫描整改', 'p4', -8, -2, 40, ['li'], { color: C.rose, prio: 1 }),
      // 5 测试与上线
      T('p5', '测试与上线', null, 0, 0, 0, ['chen']),
      T('t51', '功能测试', 'p5', 14, 24, 0, ['chen'], { color: C.emerald }),
      T('t52', '兼容性测试', 'p5', 20, 26, 0, ['chen'], { color: C.emerald, prio: 3 }),
      T('t54', '上线', 'p5', 28, 28, 0, ['zhao', 'chen'], { ms: true, prio: 2 }),
      T('t55', '灰度发布', 'p5', 24, 27, 0, ['chen', 'li'], { color: C.emerald }),
      T('t56', '验收材料整理', 'p5', 26, 30, 0, ['chen']),
      T('t57', '回归测试', 'p5', 24, 27, 0, ['chen'], { color: C.emerald }),
      // 6 运营与支持
      T('p6', '运营与支持', null, 0, 0, 0, ['zhao']),
      T('t61', '双十一专题页', 'p6', -15, -6, 100, ['wang', 'li'], { color: C.amber, prio: 4 }),
      T('t62', '客服知识库更新', 'p6', 10, 14, 0, ['zhao'], { prio: 4 }),
      T('t63', '数据周报自动化', 'p6', 18, 30, 0, ['li'], { color: C.amber, prio: 2 }),
      T('t64', '旧版页面 301 跳转', 'p6', -4, -2, 0, ['li'], { color: C.rose, prio: 1 }),
      T('t65', 'SEO meta 补全', 'p6', 20, 22, 0, ['wang']),
      T('t66', '多语言文案校对', 'p6', 26, 34, 0, ['zhao']),
      T('t67', '日志告警接入', 'p6', 8, 11, 0, ['li'], { color: C.teal }),
      T('t68', '隐私政策更新', 'p6', 22, 26, 0, ['zhao']),
    ];
  }

  // ---- 状态(全部为内存态;刷新即重置) ----
  const state = {
    today: toISO(new Date()),
    tasks: [],
    sel: new Set(),
    anchor: null,
    search: '',
    assignee: 'all',
    showDone: false,
    sort: { 1: 'default', 2: 'default', 3: 'default', 4: 'default' },
    trayCollapsed: false,
    view: 'priority',
    drawer: null, // { taskId, draft }  draft: 1|2|3|4|undefined
    collapsed: new Set(),
    treeFilter: 'none',
    critical: new Set(['t41', 't42', 't31', 't51', 't54']),
    treeWidth: TREE_WIDTH.default,
  };
  const undoStack = [];
  let idx = { byId: new Map(), children: new Map(), parents: new Set(), wbs: new Map(), ancestors: new Map() };

  /** 由扁平任务数组推导树形信息(WBS 号、父子关系)。 */
  function reindex() {
    const byId = new Map();
    const children = new Map();
    const parents = new Set();
    const wbs = new Map();
    const ancestors = new Map();
    for (const t of state.tasks) byId.set(t.id, t);
    for (const t of state.tasks) {
      const key = t.parent ?? null;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(t);
    }
    const walk = (pid, prefix, anc) => {
      const kids = children.get(pid) ?? [];
      kids.forEach((t, i) => {
        const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
        wbs.set(t.id, num);
        ancestors.set(t.id, anc);
        if (children.has(t.id)) {
          parents.add(t.id);
          walk(t.id, num, [...anc, t.id]);
        }
      });
    };
    walk(null, '', []);
    idx = { byId, children, parents, wbs, ancestors };
    rollup();
  }

  const effortOf = (t) => workdaysInclusive(t.start, t.end) * 0.5 * t.who.length;
  /** 摘要任务的日期 / 进度 / 人天由叶子汇总(同 domain 的 rollup 语义)。 */
  function rollup() {
    for (const id of idx.parents) {
      const leaves = [];
      const walk = (pid) => {
        for (const t of idx.children.get(pid) ?? []) {
          if (idx.parents.has(t.id)) walk(t.id);
          else leaves.push(t);
        }
      };
      walk(id);
      if (leaves.length === 0) continue;
      const t = idx.byId.get(id);
      t.start = leaves.reduce((m, x) => (x.start < m ? x.start : m), leaves[0].start);
      t.end = leaves.reduce((m, x) => (x.end > m ? x.end : m), leaves[0].end);
      t.progress = Math.round(leaves.reduce((s, x) => s + x.progress, 0) / leaves.length);
      t.effort = leaves.reduce((s, x) => s + effortOf(x), 0);
    }
  }

  const isDone = (t) => t.progress >= 100;
  const isOverdue = (t) => !isDone(t) && t.end < state.today;

  /** 日期提示:只提示、不改变归类。逾期判定与现有"延期"筛选同式。 */
  function dueHint(t) {
    if (isDone(t)) return { kind: 'none', text: '已完成' };
    if (t.end < state.today) return { kind: 'danger', text: `逾期 ${diffDays(t.end, state.today)} 天` };
    const wd = workdaysAfter(state.today, t.end);
    if (wd <= DUE_SOON_WORKING_DAYS) {
      return { kind: 'warning', text: wd === 0 ? '今天到期' : `${wd} 天后到期` };
    }
    return { kind: 'none', text: t.end.slice(5) };
  }

  const isMatrixTask = (t) => !idx.parents.has(t.id);
  function isVisible(t) {
    if (isDone(t) && !state.showDone) return false;
    if (state.assignee === 'none' && t.who.length > 0) return false;
    if (state.assignee !== 'all' && state.assignee !== 'none' && !t.who.includes(state.assignee)) return false;
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || (idx.wbs.get(t.id) ?? '').includes(q);
  }
  /** "显示已完成"不算筛选:它不隐藏任何未完成的任务,汇总仍显示完整的分级进度。 */
  const isFilterActive = () => state.search.trim() !== '' || state.assignee !== 'all';

  const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function cmpWbs(a, b) {
    const pa = (idx.wbs.get(a.id) ?? '').split('.').map(Number);
    const pb = (idx.wbs.get(b.id) ?? '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  /** 象限内排序。已完成永远排最后。 */
  function comparator(mode) {
    return (a, b) => {
      const da = isDone(a);
      const db = isDone(b);
      if (da !== db) return da ? 1 : -1;
      let c = 0;
      if (mode === 'default') {
        c = (isOverdue(a) ? 0 : 1) - (isOverdue(b) ? 0 : 1) || cmpText(a.end, b.end);
      } else if (mode === 'end') c = cmpText(a.end, b.end);
      else if (mode === 'start') c = cmpText(a.start, b.start);
      else if (mode === 'progress') c = a.progress - b.progress;
      return c || cmpWbs(a, b);
    };
  }

  /** 把可见的叶子任务分到托盘 + 四个象限。 */
  function matrixModel() {
    const buckets = { tray: [], 1: [], 2: [], 3: [], 4: [] };
    for (const t of state.tasks) {
      if (!isMatrixTask(t) || !isVisible(t)) continue;
      buckets[t.prio ?? 'tray'].push(t);
    }
    buckets.tray.sort(comparator('wbs'));
    for (const n of QUADS) buckets[n].sort(comparator(state.sort[n]));
    return buckets;
  }

  // ---- DOM 引用(mount 后填充) ----
  let el = {};
  let scrollables = [];
  const cardEl = (id) => el.matrix.querySelector(`.card[data-id="${id}"]`);
  const rowEl = (id) => el.treeScroll?.querySelector(`.row[data-id="${id}"]`);

  function mount() {
    const other = IS_SPLIT ? 'fullwidth' : 'split';
    const otherLabel = IS_SPLIT ? 'A 全宽矩阵' : 'B 左树 + 右矩阵';
    const variantName = IS_SPLIT ? 'B · 左侧任务树 + 右侧矩阵' : 'A · 全宽矩阵';
    const quad = (n) => {
      const p = PRIORITY[n];
      return `
      <section class="quad q${n}" data-drop="${n}" aria-label="${p.tag} ${p.title}">
        <div class="quad-head">
          <span class="q-tag">${p.tag}</span>
          <span class="q-title">${p.title}</span>
          <span class="q-hint">${p.hint}</span>
          <span class="count-chip q-count" data-count="${n}">0</span>
          <button type="button" class="q-more" data-sort-for="${n}" aria-label="${p.tag} 排序" title="排序">${icon('sort', 13)}</button>
        </div>
        <div class="q-list" data-list="${n}"></div>
      </section>`;
    };
    const treeHtml = IS_SPLIT
      ? `
        <div class="tree" id="tree" style="width:${state.treeWidth}px">
          <div class="tree-bar">
            <label class="search">${icon('search', 13)}<input id="treeSearch" type="text" placeholder="搜索任务名或 WBS…" aria-label="搜索任务名或 WBS"></label>
            <button type="button" class="pill" data-tfilter="unassigned" aria-pressed="false">未分配</button>
            <button type="button" class="pill" data-tfilter="criticalPath" aria-pressed="false">关键路径</button>
            <button type="button" class="pill" data-tfilter="overdue" aria-pressed="false">延期</button>
            <button type="button" class="btn-new" data-new-task>${icon('plus', 13)} 新建任务</button>
          </div>
          <div class="tree-head" id="treeHead" style="grid-template-columns:${TREE_GRID}">
            <div class="cell">WBS</div><div class="cell">任务</div><div class="cell num">工期</div><div class="cell num">人天</div><div class="cell num">进度</div>
          </div>
          <div class="tree-scroll" id="treeScroll"></div>
          <div class="tree-resizer" id="treeResizer" title="拖动调整宽度,双击复位"></div>
        </div>`
      : '';
    app.innerHTML = `
      <header class="hdr">
        <button type="button" class="home" title="返回项目中心">G</button>
        <span class="hdr-div" aria-hidden="true"></span>
        <button type="button" class="switcher" title="切换项目"><span class="pdot"></span><span class="pname">官网改版 v2.0</span>${icon('chevrons-up-down', 14)}</button>
        <span class="hdr-div" aria-hidden="true"></span>
        <div class="tabs">
          <div class="tab active"><button type="button" class="tab-btn" title="官网改版 v2.0">官网改版 v2.0</button><button type="button" class="tab-x" aria-label="关闭标签页">${icon('x', 12)}</button></div>
          <div class="tab"><button type="button" class="tab-btn" title="移动端适配">移动端适配</button><button type="button" class="tab-x" aria-label="关闭标签页">${icon('x', 12)}</button></div>
        </div>
        <button type="button" class="tb icon" title="新建项目" aria-label="新建项目">${icon('plus', 17)}</button>
        <button type="button" class="tb icon" title="项目操作" aria-label="项目操作">${icon('more', 18)}</button>
      </header>

      <div class="toolbar">
        <div class="tb-group" data-view-only="timeline">
          <button type="button" class="tb" title="今天">${icon('calendar-days')} 今天</button>
          <button type="button" class="tb icon" title="缩放并定位到全部任务的起止范围" aria-label="适应范围">${icon('expand')}</button>
          <div class="seg show-lg" aria-label="时间缩放">
            <button type="button" class="tb mini" aria-label="缩小" title="缩小">${icon('minus', 14)}</button>
            <span class="zoom">月视图</span>
            <button type="button" class="tb mini" aria-label="放大" title="放大">${icon('plus', 14)}</button>
          </div>
        </div>
        <div class="tb-div show-lg" data-view-only="timeline"></div>
        <div class="tb-group show-lg" data-view-only="task">
          <button type="button" class="tb" title="关键路径">${icon('git-branch')} 关键路径</button>
          <button type="button" class="tb" title="基线">${icon('flag')} 基线 ${icon('chevron-down', 13)}</button>
        </div>
        <div class="tb-div show-lg" data-view-only="task"></div>
        <div class="tb-group">
          <div class="seg" role="group" aria-label="视图切换">
            <button type="button" class="tb compact" data-view="task" aria-pressed="false" title="任务视图">${icon('list-tree', 14)} 任务视图</button>
            <button type="button" class="tb compact" data-view="resource" aria-pressed="false" title="资源视图">${icon('users', 14)} 资源视图</button>
            <button type="button" class="tb compact" data-view="priority" aria-pressed="true" title="四象限">${icon('layout-grid', 14)} <span class="hide-narrow">四象限</span> <span class="new-badge hide-narrow">新增</span></button>
          </div>
        </div>
        <div class="tb-spacer"></div>
        <div class="tb-group">
          <button type="button" class="tb icon" data-undo title="撤销 (${MOD_LABEL}Z)" aria-label="撤销" disabled>${icon('undo', 16)}</button>
          <button type="button" class="tb icon" title="重做 (${MOD_LABEL}⇧Z)" aria-label="重做" disabled>${icon('redo', 16)}</button>
          <button type="button" class="tb icon" title="保存 (${MOD_LABEL}S)" aria-label="保存">${icon('check', 16)}</button>
        </div>
        <button type="button" class="tb icon" title="更多操作" aria-label="更多操作">${icon('more', 17)}</button>
      </div>

      <div class="content">
        ${treeHtml}
        <div class="matrix" id="matrix">
          <div class="viewbar">
            <span class="vb-summary" id="summary"></span>
            <span class="vb-spacer"></span>
            ${IS_SPLIT ? '' : `<label class="search">${icon('search', 13)}<input id="search" type="text" placeholder="搜索任务名或 WBS…" aria-label="搜索任务名或 WBS"></label>`}
            <select class="select" id="assignee" aria-label="按负责人筛选">
              <option value="all">全部负责人</option>
              <option value="none">未分配</option>
              ${RESOURCES.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}
            </select>
            <button type="button" class="pill" id="showDone" aria-pressed="false">显示已完成</button>
            ${IS_SPLIT ? '' : `<button type="button" class="btn-new" data-new-task>${icon('plus', 13)} 新建任务</button>`}
          </div>
          <div class="tray" id="tray" data-drop="tray">
            <div class="tray-head" id="trayHead">
              ${icon('inbox', 14)}
              <span class="tray-title">待分级</span>
              <span class="count-chip" id="trayCount">0</span>
              <span class="tray-hint" id="trayHint"></span>
              <span class="tray-spacer"></span>
              <button type="button" class="q-more tray-toggle" id="trayToggle" aria-label="折叠待分级" title="折叠 / 展开">${icon('chevron-up', 14)}</button>
            </div>
            <div class="tray-body" id="trayBody"><div class="tray-grid" id="trayGrid"></div></div>
          </div>
          <div class="qwrap">
            <div class="axis" aria-hidden="true"></div>
            <div class="axis" aria-hidden="true">紧急</div>
            <div class="axis" aria-hidden="true">不紧急</div>
            <div class="axis y" aria-hidden="true">重要</div>
            ${quad(1)}
            ${quad(2)}
            <div class="axis y" aria-hidden="true">不重要</div>
            ${quad(3)}
            ${quad(4)}
          </div>
        </div>
        <div class="drawer" id="drawer" hidden></div>
        <div class="placeholder" id="placeholder" hidden>
          <div class="ph-box">
            ${icon('gantt', 28)}
            <h3>任务视图 / 资源视图</h3>
            <p>这是现有的甘特图与资源负载界面,效果图未绘制。<br>新功能入口在工具栏的视图切换里。</p>
            <button type="button" class="btn-primary" data-view="priority">回到四象限</button>
          </div>
        </div>
        <div class="batch" id="batch" hidden></div>
      </div>

      <div class="statusbar"><span id="statusLeft"></span><span>已保存</span></div>

      <div class="helper">
        <span class="helper-tag">效果图辅助 · 非产品界面</span>
        <span class="helper-name">${variantName}</span>
        <button type="button" class="hbtn" id="themeBtn">${icon('moon', 13)} 切到暗色</button>
        <button type="button" class="hbtn" id="resetBtn">${icon('rotate-ccw', 13)} 重置数据</button>
        <a class="hbtn" href="./${other}.html">${icon('columns', 13)} 打开另一版:${otherLabel}</a>
        <span class="helper-spacer"></span>
        <span id="metrics"></span>
      </div>

      <div class="toasts" id="toasts"></div>
      <div class="tip" id="tip" hidden></div>
    `;

    const $ = (sel) => app.querySelector(sel);
    el = {
      matrix: $('#matrix'),
      tree: $('#tree'),
      treeScroll: $('#treeScroll'),
      treeResizer: $('#treeResizer'),
      summary: $('#summary'),
      search: $('#search'),
      treeSearch: $('#treeSearch'),
      assignee: $('#assignee'),
      showDone: $('#showDone'),
      tray: $('#tray'),
      trayHead: $('#trayHead'),
      trayToggle: $('#trayToggle'),
      trayCount: $('#trayCount'),
      trayHint: $('#trayHint'),
      trayBody: $('#trayBody'),
      trayGrid: $('#trayGrid'),
      lists: Object.fromEntries(QUADS.map((n) => [n, $(`[data-list="${n}"]`)])),
      counts: Object.fromEntries(QUADS.map((n) => [n, $(`[data-count="${n}"]`)])),
      drawer: $('#drawer'),
      placeholder: $('#placeholder'),
      batch: $('#batch'),
      statusLeft: $('#statusLeft'),
      metrics: $('#metrics'),
      toasts: $('#toasts'),
      tip: $('#tip'),
      themeBtn: $('#themeBtn'),
      undo: $('[data-undo]'),
    };
    scrollables = [...QUADS.map((n) => el.lists[n]), el.trayBody, el.treeScroll].filter(Boolean);
  }

  // ---- 渲染 ----
  function cardHtml(t) {
    const hint = dueHint(t);
    const who = t.who.map((id) => RESOURCE_BY_ID.get(id)).filter(Boolean);
    const hintIcon = hint.kind === 'danger' ? icon('alert', 11) : hint.kind === 'warning' ? icon('clock', 11) : '';
    const avatars =
      who.slice(0, 2).map(avatarHtml).join('') +
      (who.length > 2 ? `<span class="av-more">+${who.length - 2}</span>` : '');
    const prog =
      !t.ms && t.progress > 0
        ? `<span class="prog-track"></span><span class="prog" style="width:${t.progress}%;background:${t.color ? darken(t.color, 0.8) : 'rgb(var(--color-task-progress))'}"></span>`
        : '';
    return `
      <div class="card${isDone(t) ? ' done' : ''}" draggable="true" tabindex="0" role="button"
           data-id="${t.id}" data-wbs="${idx.wbs.get(t.id) ?? ''}" aria-label="${esc(t.name)}" title="">
        <span class="strip" style="background:${t.color ?? 'rgb(var(--color-task-bar))'}"></span>
        ${t.ms ? '<span class="ms">◆</span>' : ''}
        <span class="wbs">${idx.wbs.get(t.id) ?? ''}</span>
        <span class="name">${esc(t.name)}</span>
        <span class="due ${hint.kind}">${hintIcon}${esc(hint.text)}</span>
        ${who.length ? `<span class="avs">${avatars}</span>` : ''}
        ${prog}
      </div>`;
  }

  function renderMatrix() {
    const saved = captureScroll();
    const m = matrixModel();
    el.trayGrid.innerHTML = m.tray.map(cardHtml).join('');
    for (const n of QUADS) {
      const p = PRIORITY[n];
      el.lists[n].innerHTML =
        m[n].map(cardHtml).join('') ||
        `<div class="q-empty"><span>拖拽任务到这里</span><span class="q-empty-sub">设为 ${p.tag} ${p.title}</span></div>`;
      el.counts[n].textContent = String(m[n].length);
    }
    const empty = m.tray.length === 0;
    el.tray.classList.toggle('empty', empty);
    el.tray.classList.toggle('collapsed', state.trayCollapsed);
    el.trayCount.textContent = String(m.tray.length);
    el.trayHint.textContent = empty ? '全部已分级 · 把卡片拖到这里可取消分级' : '拖到下方象限完成分级';
    const prioritized = QUADS.reduce((s, n) => s + m[n].length, 0);
    const leafTotal = state.tasks.filter(isMatrixTask).length;
    el.summary.textContent = isFilterActive()
      ? `筛选后 ${prioritized + m.tray.length} / ${leafTotal} 个任务`
      : `已分级 ${prioritized} · 待分级 ${m.tray.length}`;
    restoreScroll(saved);
    const pd = state.tasks.filter(isMatrixTask).reduce((s, t) => s + effortOf(t), 0);
    el.statusLeft.textContent = `${state.tasks.length} 个任务 · ${Math.round(pd)} 人天`;
  }

  /** 任务树可见行:尊重折叠、搜索与快捷筛选(同 computeFilteredRows 的投影语义)。 */
  function treeRows() {
    const q = state.search.trim().toLowerCase();
    const pred =
      state.treeFilter === 'unassigned'
        ? (t) => isMatrixTask(t) && t.who.length === 0
        : state.treeFilter === 'overdue'
          ? (t) => isMatrixTask(t) && isOverdue(t)
          : state.treeFilter === 'criticalPath'
            ? (t) => state.critical.has(t.id)
            : null;
    const active = Boolean(q || pred);
    const matches = new Set(
      state.tasks.filter((t) => (!q || isVisibleText(t, q)) && (!pred || pred(t))).map((t) => t.id),
    );
    const collapsed = new Set(state.collapsed);
    // 命中项 + 其祖先保留(保留缩进语境);命中项的折叠祖先强制展开。
    const keepSet = new Set();
    if (active) {
      for (const id of matches) {
        keepSet.add(id);
        for (const anc of idx.ancestors.get(id) ?? []) {
          keepSet.add(anc);
          collapsed.delete(anc);
        }
      }
    }
    const rows = [];
    const walk = (pid, depth) => {
      for (const t of idx.children.get(pid) ?? []) {
        const isParent = idx.parents.has(t.id);
        const keep = !active || keepSet.has(t.id);
        if (keep) {
          rows.push({
            t,
            depth,
            isParent,
            wbs: idx.wbs.get(t.id) ?? '',
            collapsed: collapsed.has(t.id),
            childCount: (idx.children.get(t.id) ?? []).length,
          });
        }
        if (!collapsed.has(t.id)) walk(t.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }
  const isVisibleText = (t, q) => t.name.toLowerCase().includes(q) || (idx.wbs.get(t.id) ?? '').includes(q);

  function renderTree() {
    if (!IS_SPLIT) return;
    const saved = captureScroll();
    const rows = treeRows();
    el.treeScroll.innerHTML = rows
      .map(({ t, depth, isParent, wbs, collapsed, childCount }, i) => {
        const effort = isParent ? t.effort : effortOf(t);
        const ptag = t.prio ? `<span class="ptag p${t.prio}" title="${PRIORITY[t.prio].tag} ${PRIORITY[t.prio].title}">P${t.prio}</span>` : '';
        return `
          <div class="row${isParent ? ' parent' : ''}" data-id="${t.id}" data-depth="${depth}"
               style="transform:translateY(${i * ROW_HEIGHT}px);grid-template-columns:${TREE_GRID}">
            <div class="cell"><span class="grip">${icon('grip', 12)}</span><span class="wbs-num">${wbs}</span></div>
            <div class="cell">
              ${Array.from({ length: depth }, () => '<span class="guide" aria-hidden="true"></span>').join('')}
              ${
                isParent
                  ? `<button type="button" class="chev" data-toggle="${t.id}" aria-expanded="${!collapsed}">${icon(collapsed ? 'chevron-right' : 'chevron-down', 14)}</button>`
                  : '<span class="chev-slot"></span>'
              }
              <div class="name-inner">
                ${t.ms ? '<span class="ms">◆</span>' : ''}
                <span class="nm">${esc(t.name)}</span>
                ${isParent && collapsed ? `<span class="chip">${childCount} 项</span>` : ''}
                ${ptag}
              </div>
            </div>
            <div class="cell num">${t.ms ? '—' : `${workdaysInclusive(t.start, t.end)}d`}</div>
            <div class="cell num">${effort ? (Number.isInteger(effort) ? effort : effort.toFixed(1)) : '—'}</div>
            <div class="cell num">${t.progress}%</div>
          </div>`;
      })
      .join('');
    restoreScroll(saved);
    for (const b of el.tree.querySelectorAll('[data-tfilter]')) {
      b.setAttribute('aria-pressed', String(b.dataset.tfilter === state.treeFilter));
    }
  }

  let drawerSig = '';
  function renderDrawer(force = false) {
    const d = state.drawer;
    if (!d) {
      el.drawer.hidden = true;
      el.drawer.innerHTML = '';
      drawerSig = '';
      return;
    }
    const t = idx.byId.get(d.taskId);
    if (!t) {
      state.drawer = null;
      renderDrawer(true);
      return;
    }
    const sig = `${t.id}|${d.draft}|${t.prio}|${state.view}`;
    if (!force && sig === drawerSig) return;
    drawerSig = sig;
    const opts = [{ v: 'none', label: '未分级' }, ...QUADS.map((n) => ({ v: String(n), label: PRIORITY[n].tag }))];
    const hint =
      d.draft === undefined
        ? '未分级:任务会出现在四象限视图的「待分级」托盘里'
        : `${PRIORITY[d.draft].tag} · ${PRIORITY[d.draft].title} — ${PRIORITY[d.draft].hint}`;
    const who = t.who.map((id) => RESOURCE_BY_ID.get(id)).filter(Boolean);
    const active = t.color && TASK_PALETTE.includes(t.color) ? t.color : TASK_PALETTE[0];
    el.drawer.hidden = state.view !== 'priority';
    el.drawer.innerHTML = `
      <div class="dw-head">
        <span class="dw-title">编辑任务</span>
        <span class="dw-wbs">${idx.wbs.get(t.id) ?? ''}</span>
        <span class="dw-spacer"></span>
        <button type="button" class="q-more" data-dw="close" aria-label="关闭">${icon('x', 14)}</button>
      </div>
      <div class="dw-body">
        <section>
          <h4 class="dw-sec-title">基本信息</h4>
          <div class="dw-field"><label>名称</label><input class="input" readonly value="${esc(t.name)}"></div>
          <div class="dw-field">
            <label>优先级 <span class="new-badge">新增</span></label>
            <div class="seg-prio" role="radiogroup" aria-label="优先级">
              ${opts
                .map(
                  (o) =>
                    `<button type="button" role="radio" aria-checked="${String(d.draft) === o.v}" class="${o.v === 'none' ? 'none' : 'p' + o.v}" data-prio="${o.v}">${o.label}</button>`,
                )
                .join('')}
            </div>
            <p class="prio-hint">${hint}</p>
          </div>
          <div class="dw-grid2">
            <div class="dw-field"><label>开始</label><input class="input" readonly value="${t.start}"></div>
            <div class="dw-field"><label>结束</label><input class="input" readonly value="${t.end}"></div>
          </div>
          <div class="dw-grid2">
            <div class="dw-field"><label>工期</label><input class="input" readonly value="${t.ms ? 0 : workdaysInclusive(t.start, t.end)} 天"></div>
            <div class="dw-field"><label>进度</label><input class="input" readonly value="${t.progress}%"></div>
          </div>
        </section>
        <section>
          <h4 class="dw-sec-title">资源分配</h4>
          ${
            who.length
              ? who.map((r) => `<span class="dw-assign">${avatarHtml(r)} ${esc(r.name)} · 50%</span>`).join('')
              : '<p class="dw-note">未分配负责人</p>'
          }
        </section>
        <section>
          <h4 class="dw-sec-title">样式与备注</h4>
          <div class="swatches">${TASK_PALETTE.map((c) => `<span class="swatch" style="background:${c};${c === active ? 'outline:2px solid rgb(var(--color-primary));outline-offset:1px' : ''}"></span>`).join('')}</div>
        </section>
      </div>
      <div class="dw-foot">
        <button type="button" class="btn-danger" data-dw="noop">${icon('trash', 14)} 删除</button>
        <span class="dw-spacer"></span>
        <button type="button" class="btn" data-dw="close">取消</button>
        <button type="button" class="btn-primary" data-dw="save" ${d.draft === t.prio ? 'disabled' : ''}>保存</button>
      </div>`;
    requestAnimationFrame(updateMetrics);
  }

  function renderSelection(source) {
    for (const node of el.matrix.querySelectorAll('.card')) {
      const id = node.dataset.id;
      node.classList.toggle('selected', state.sel.has(id));
      node.classList.toggle('anchor', state.anchor === id);
    }
    if (IS_SPLIT) {
      for (const node of el.treeScroll.querySelectorAll('.row')) {
        const id = node.dataset.id;
        node.classList.toggle('selected', state.sel.has(id));
        node.classList.toggle('anchor', state.anchor === id);
      }
      if (state.anchor && source) {
        if (source === 'tree') cardEl(state.anchor)?.scrollIntoView({ block: 'nearest' });
        if (source === 'matrix') rowEl(state.anchor)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    renderBatch();
  }

  function renderBatch() {
    const n = state.sel.size;
    if (n < 2 || state.view !== 'priority') {
      el.batch.hidden = true;
      return;
    }
    el.batch.hidden = false;
    el.batch.innerHTML = `
      <span class="b-count">已选 ${n} 项</span>
      <button type="button" class="b-primary" data-batch="noop">${icon('users', 13)} 分配负责人</button>
      <button type="button" class="tb compact" data-batch="prio" aria-haspopup="menu">${icon('flag', 13)} 设优先级 ${icon('chevron-down', 12)} <span class="new-badge">新增</span></button>
      <button type="button" class="b-x" data-batch="clear" aria-label="清除选择">${icon('x', 14)}</button>`;
  }

  function renderShell() {
    for (const b of app.querySelectorAll('.toolbar [data-view]')) {
      const on = b.dataset.view === state.view;
      b.classList.toggle('pressed', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const priority = state.view === 'priority';
    el.matrix.hidden = !priority;
    if (el.tree) el.tree.hidden = !priority;
    el.placeholder.hidden = priority;
    // 日期导航只对时间轴有意义(四象限下隐藏);关键路径 / 基线只在任务视图可用。
    for (const g of app.querySelectorAll('[data-view-only]')) {
      g.hidden = g.dataset.viewOnly === 'timeline' ? priority : state.view !== 'task';
    }
    if (!priority && state.drawer) {
      state.drawer = null;
      renderDrawer(true);
    }
    el.undo.disabled = undoStack.length === 0;
  }

  function render() {
    renderShell();
    renderMatrix();
    renderTree();
    renderDrawer();
    renderSelection();
    requestAnimationFrame(updateMetrics);
  }

  function captureScroll() {
    return new Map(scrollables.map((s) => [s, s.scrollTop]));
  }
  function restoreScroll(saved) {
    for (const [s, top] of saved) s.scrollTop = top;
  }

  /** 辅助指标:客观比较两种布局下每个象限有多挤。 */
  function updateMetrics() {
    const q = el.matrix.querySelector('.quad.q1');
    if (!q || el.matrix.hidden) {
      el.metrics.textContent = '';
      return;
    }
    const r = q.getBoundingClientRect();
    const list = q.querySelector('.q-list');
    const fit = Math.max(0, Math.floor((list.clientHeight - 12 + 3) / 31));
    const treeW = el.tree && !el.tree.hidden ? Math.round(el.tree.getBoundingClientRect().width) : 0;
    el.metrics.textContent =
      `单个象限 ${Math.round(r.width)} × ${Math.round(r.height)} px · 每格不滚动可见约 ${fit} 张卡片` +
      (treeW ? ` · 任务树 ${treeW} px` : '');
  }

  // ---- 选择 ----
  function bindSelection(ids, anchor, source) {
    state.sel = new Set(ids);
    state.anchor = anchor;
    if (state.drawer && anchor && state.drawer.taskId !== anchor) {
      state.drawer = { taskId: anchor, draft: idx.byId.get(anchor)?.prio };
      renderDrawer();
    }
    renderSelection(source);
  }
  const selectSingle = (id, source) => bindSelection([id], id, source);
  const clearSelection = (source) => bindSelection([], null, source);
  function toggleSelected(id, source) {
    const s = new Set(state.sel);
    let anchor = state.anchor;
    if (s.has(id)) {
      s.delete(id);
      if (anchor === id) anchor = s.values().next().value ?? null;
    } else {
      s.add(id);
      if (anchor === null) anchor = id;
    }
    bindSelection(s, anchor, source);
  }
  function selectRange(id, source) {
    if (state.anchor === null) {
      selectSingle(id, source);
      return;
    }
    const order = [...el.matrix.querySelectorAll('.card')].map((c) => c.dataset.id);
    const a = order.indexOf(state.anchor);
    const b = order.indexOf(id);
    const ids =
      a === -1 || b === -1
        ? [state.anchor, id]
        : order.slice(Math.min(a, b), Math.max(a, b) + 1);
    bindSelection(ids, state.anchor, source);
  }

  // ---- 优先级变更(唯一会写数据的入口;一次调用 = 一条撤销记录) ----
  function applyPriorityChange(ids, prio) {
    const changed = ids.map((id) => idx.byId.get(id)).filter((t) => t && t.prio !== prio);
    if (changed.length === 0) return false;
    undoStack.push(Object.fromEntries(state.tasks.map((t) => [t.id, t.prio])));
    for (const t of changed) t.prio = prio;
    if (state.drawer && changed.some((t) => t.id === state.drawer.taskId)) {
      state.drawer = { taskId: state.drawer.taskId, draft: prio };
    }
    render();
    const what = prio === undefined ? '设为未分级' : `设为 ${PRIORITY[prio].tag} ${PRIORITY[prio].title}`;
    const message =
      changed.length === 1
        ? `已将「${changed[0].name}」${what}`
        : `已将 ${changed.length} 个任务${prio === undefined ? '设为未分级' : `移入 ${PRIORITY[prio].tag} ${PRIORITY[prio].title}`}`;
    showToast(message, undo);
    return true;
  }

  function undo() {
    const snap = undoStack.pop();
    if (!snap) return;
    for (const t of state.tasks) t.prio = snap[t.id];
    if (state.drawer) state.drawer = { taskId: state.drawer.taskId, draft: idx.byId.get(state.drawer.taskId)?.prio };
    render();
  }

  // ---- 撤销提示 ----
  function showToast(message, onUndo) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.innerHTML = `<span>${esc(message)}</span>${onUndo ? '<button type="button" class="t-undo">撤销</button>' : ''}<button type="button" class="t-x" aria-label="关闭">✕</button>`;
    el.toasts.appendChild(node);
    const remove = () => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 200);
    };
    let timer = setTimeout(remove, 5000);
    node.addEventListener('mouseenter', () => clearTimeout(timer));
    node.addEventListener('mouseleave', () => (timer = setTimeout(remove, 5000)));
    node.querySelector('.t-x').addEventListener('click', remove);
    node.querySelector('.t-undo')?.addEventListener('click', () => {
      onUndo();
      clearTimeout(timer);
      remove();
    });
  }

  // ---- 弹出菜单(右键菜单 / 排序 / 批量设优先级共用一个外壳) ----
  let popup = null;
  const pChip = (v) =>
    v === 'none'
      ? '<span class="p-chip none">—</span>'
      : `<span class="p-chip p${v}">${PRIORITY[v].tag}</span>`;
  const prioOptionsHtml = (current, act) =>
    [{ v: 'none', title: '未分级', hint: '出现在「待分级」托盘' }, ...QUADS.map((n) => ({ v: n, title: PRIORITY[n].title, hint: PRIORITY[n].hint }))]
      .map(
        (o) => `
        <button type="button" role="menuitem" class="menu-item" data-act="${act}" data-value="${o.v}">
          <span class="mi-main">${pChip(o.v)}${o.title}<span class="mi-sub">${o.hint}</span></span>
          <span class="${String(current) === String(o.v) ? 'menu-check' : 'menu-check-space'}">${String(current) === String(o.v) ? icon('check', 14) : ''}</span>
        </button>`,
      )
      .join('');

  function mainMenuHtml(t) {
    const item = (label, act, shortcut, extra = '') =>
      `<button type="button" role="menuitem" class="menu-item${act === 'noop-danger' ? ' danger' : ''}" data-act="${act === 'noop-danger' ? 'noop' : act}"><span class="mi-main">${label}${extra}</span>${shortcut ? `<span class="mi-hint">${shortcut}</span>` : ''}</button>`;
    const cur = t.prio ? `${PRIORITY[t.prio].tag} ›` : '未分级 ›';
    return (
      item('编辑', 'noop') +
      item('重命名', 'noop', 'F2') +
      item(`复制`, 'noop', `${MOD_LABEL}+C`) +
      item(`剪切`, 'noop', `${MOD_LABEL}+X`) +
      item(`粘贴`, 'noop', `${MOD_LABEL}+V`) +
      item(t.ms ? '转为任务' : '转为里程碑', 'noop') +
      item('优先级', 'prio-page', cur, '<span class="new-badge">新增</span>') +
      item('上移', 'noop', 'Alt+↑') +
      item('下移', 'noop', 'Alt+↓') +
      item('缩进', 'noop', 'Tab') +
      item('减少缩进', 'noop', 'Shift+Tab') +
      item('删除', 'noop-danger', 'Delete')
    );
  }

  function openPopup(html, pos) {
    closePopup();
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = html;
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:40';
    backdrop.addEventListener('contextmenu', (e) => e.preventDefault());
    backdrop.addEventListener('mousedown', (e) => {
      if (e.button === 0) closePopup();
    });
    document.body.append(backdrop, menu);
    const rect = menu.getBoundingClientRect();
    let x = pos.x ?? 0;
    let y = pos.y ?? 0;
    if (pos.anchor) {
      const a = pos.anchor.getBoundingClientRect();
      y = a.bottom + 4;
      x = pos.alignRight ? a.right - rect.width : a.left;
      if (y + rect.height > window.innerHeight - 4) y = Math.max(4, a.top - rect.height - 4);
    }
    menu.style.left = `${clamp(x, 4, window.innerWidth - rect.width - 4)}px`;
    menu.style.top = `${clamp(y, 4, window.innerHeight - rect.height - 4)}px`;
    menu.addEventListener('click', onPopupClick);
    popup = { menu, backdrop };
    menu.querySelector('.menu-item:not(:disabled)')?.focus();
  }
  function closePopup() {
    if (!popup) return;
    popup.menu.remove();
    popup.backdrop.remove();
    popup = null;
  }
  function replacePopupContent(html) {
    if (!popup) return;
    const { left, top } = popup.menu.style;
    popup.menu.innerHTML = html;
    const rect = popup.menu.getBoundingClientRect();
    popup.menu.style.left = `${clamp(parseFloat(left), 4, window.innerWidth - rect.width - 4)}px`;
    popup.menu.style.top = `${clamp(parseFloat(top), 4, window.innerHeight - rect.height - 4)}px`;
    popup.menu.querySelector('.menu-item:not(:disabled)')?.focus();
  }

  const SORTS = [
    ['default', '默认(逾期优先)'],
    ['end', '结束日期'],
    ['start', '开始日期'],
    ['progress', '进度(低 → 高)'],
    ['wbs', 'WBS 顺序'],
  ];
  function sortMenuHtml(n) {
    const cur = state.sort[n];
    return (
      `<div class="menu-head">${PRIORITY[n].tag} ${PRIORITY[n].title} · 排序</div><div class="menu-sep"></div>` +
      SORTS.map(
        ([v, label]) =>
          `<button type="button" role="menuitem" class="menu-item" data-act="sort" data-quad="${n}" data-value="${v}"><span class="mi-main">${label}</span><span class="${cur === v ? 'menu-check' : 'menu-check-space'}">${cur === v ? icon('check', 14) : ''}</span></button>`,
      ).join('')
    );
  }

  function onPopupClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || !popup) return;
    const act = btn.dataset.act;
    const value = btn.dataset.value;
    if (act === 'prio-page') {
      const t = idx.byId.get(state.anchor);
      if (t) {
        replacePopupContent(
          `<button type="button" role="menuitem" class="menu-item" data-act="back"><span class="mi-main">${icon('arrow-left', 14)} 优先级</span></button><div class="menu-sep"></div>` +
            prioOptionsHtml(t.prio ?? 'none', 'pick'),
        );
      }
      return;
    }
    if (act === 'back') {
      const t = idx.byId.get(state.anchor);
      if (t) replacePopupContent(mainMenuHtml(t));
      return;
    }
    if (act === 'pick') {
      const t = idx.byId.get(state.anchor);
      closePopup();
      if (t) applyPriorityChange([t.id], value === 'none' ? undefined : Number(value));
      return;
    }
    if (act === 'pick-batch') {
      closePopup();
      applyPriorityChange([...state.sel], value === 'none' ? undefined : Number(value));
      return;
    }
    if (act === 'sort') {
      state.sort[Number(btn.dataset.quad)] = value;
      closePopup();
      renderMatrix();
      return;
    }
    if (act === 'noop') {
      closePopup();
      showToast('该操作在效果图中未模拟');
    }
  }

  function openContextMenu(taskId, x, y) {
    if (state.anchor !== taskId) selectSingle(taskId);
    const t = idx.byId.get(taskId);
    if (!t) return;
    openPopup(mainMenuHtml(t), { x, y });
  }

  // ---- 拖拽(原生 HTML5 DnD,写法对齐 TaskTable:dragover 高亮、dragleave 过滤子元素、Esc 取消) ----
  let drag = null;
  let dropZone = null;
  function setDropZone(zone) {
    if (dropZone === zone) return;
    dropZone?.classList.remove('drop-over');
    dropZone = zone;
    zone?.classList.add('drop-over');
  }
  function cleanupDrag() {
    window.removeEventListener('keydown', onDragKey);
    setDropZone(null);
    if (drag) {
      for (const id of drag.ids) cardEl(id)?.classList.remove('dragging');
      drag.ghost?.remove();
    }
    drag = null;
  }
  function onDragKey(e) {
    if (e.key === 'Escape' && drag) {
      drag.cancelled = true;
      setDropZone(null);
    }
  }

  // ---- 抽屉 ----
  function openDrawer(taskId) {
    const t = idx.byId.get(taskId);
    if (!t) return;
    if (state.anchor !== taskId) selectSingle(taskId);
    state.drawer = { taskId, draft: t.prio };
    renderDrawer();
    requestAnimationFrame(updateMetrics);
  }
  function closeDrawer() {
    state.drawer = null;
    renderDrawer();
    requestAnimationFrame(updateMetrics);
  }

  // ---- 悬浮提示 ----
  let tipTimer = null;
  let tipPoint = { x: 0, y: 0 };
  function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = null;
    el.tip.hidden = true;
  }
  function showTip(card) {
    const t = idx.byId.get(card.dataset.id);
    if (!t || drag) return;
    const who = t.who.map((id) => RESOURCE_BY_ID.get(id)?.name).filter(Boolean);
    const prio = t.prio ? `${PRIORITY[t.prio].tag} ${PRIORITY[t.prio].title}` : '未分级';
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    el.tip.innerHTML = `
      <div class="tip-head"><span class="wbs">${idx.wbs.get(t.id) ?? ''}</span><span class="nm">${esc(t.name)}</span></div>
      <table><tbody>
        ${row('优先级', prio)}
        ${row('负责人', who.length ? esc(who.join('、')) : '<span style="color:rgb(var(--color-fg-muted))">未分配</span>')}
        ${row('日期', `${t.start.slice(5)} → ${t.end.slice(5)}`)}
        ${row('工期', t.ms ? '—' : `${workdaysInclusive(t.start, t.end)} 天`)}
        ${row('进度', `${t.progress}%`)}
      </tbody></table>`;
    el.tip.hidden = false;
    positionTip();
  }
  function positionTip() {
    if (el.tip.hidden) return;
    const rect = el.tip.getBoundingClientRect();
    el.tip.style.left = `${Math.min(tipPoint.x + 12, Math.max(4, window.innerWidth - rect.width - 12))}px`;
    el.tip.style.top = `${Math.max(tipPoint.y - rect.height - 8, 4)}px`;
  }

  // ---- 主题 ----
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    let pref = null;
    try {
      pref = localStorage.getItem(THEME_KEY);
    } catch {
      /* file:// 下 localStorage 可能不可用 */
    }
    const dark = pref ? pref === 'dark' : media.matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    el.themeBtn.innerHTML = `${icon(dark ? 'sun' : 'moon', 13)} 切到${dark ? '亮色' : '暗色'}`;
  }

  // ---- 事件绑定 ----
  function attach() {
    // 视图切换
    app.addEventListener('click', (e) => {
      const v = e.target.closest('[data-view]')?.dataset.view;
      if (v) {
        state.view = v;
        render();
      }
    });

    // ---- 矩阵:选择(mousedown 即生效,这样 dragstart 时选区已就绪,才能整组拖动) ----
    let pendingSingle = null;
    el.matrix.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const card = e.target.closest('.card');
      hideTip();
      if (!card) {
        if (e.target.closest('.q-list, .tray-body')) clearSelection('matrix');
        return;
      }
      const id = card.dataset.id;
      pendingSingle = null;
      if (e.shiftKey) selectRange(id, 'matrix');
      else if (e[MOD_KEY]) toggleSelected(id, 'matrix');
      else if (state.sel.has(id) && state.sel.size > 1) pendingSingle = id; // 先保留选区:可能要整组拖;若只是单击,在 click 里收敛为单选
      else selectSingle(id, 'matrix');
      if (e.shiftKey || e[MOD_KEY]) window.getSelection()?.removeAllRanges();
    });
    el.matrix.addEventListener('click', (e) => {
      if (pendingSingle && e.target.closest('.card')?.dataset.id === pendingSingle) selectSingle(pendingSingle, 'matrix');
      pendingSingle = null;
    });
    el.matrix.addEventListener('dblclick', (e) => {
      const card = e.target.closest('.card');
      if (card) openDrawer(card.dataset.id);
    });
    el.matrix.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      hideTip();
      openContextMenu(card.dataset.id, e.clientX, e.clientY);
    });

    // ---- 矩阵:拖拽 ----
    el.matrix.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id;
      if (!state.sel.has(id)) selectSingle(id, 'matrix');
      const ids = [...state.sel];
      drag = { ids, cancelled: false, ghost: null };
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      if (ids.length > 1) {
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = `${ids.length} 个任务`;
        document.body.appendChild(ghost);
        drag.ghost = ghost;
        e.dataTransfer.setDragImage(ghost, 12, 12);
      }
      // 延后一拍再让源卡片变淡:拖影快照取自 dragstart 时的外观,同步加类会让拖影也跟着变淡。
      setTimeout(() => {
        if (drag) for (const x of drag.ids) cardEl(x)?.classList.add('dragging');
      }, 0);
      hideTip();
      closePopup();
      window.addEventListener('keydown', onDragKey);
    });
    el.matrix.addEventListener('dragover', (e) => {
      const zone = e.target.closest('[data-drop]');
      if (!zone) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = drag && !drag.cancelled ? 'move' : 'none';
      setDropZone(zone);
    });
    el.matrix.addEventListener('dragleave', (e) => {
      const zone = e.target.closest('[data-drop]');
      if (!zone) return;
      // 只在真正离开落点时清除高亮(在子元素之间移动不算)。
      if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
      if (dropZone === zone) setDropZone(null);
    });
    el.matrix.addEventListener('drop', (e) => {
      const zone = e.target.closest('[data-drop]');
      if (!zone) return;
      e.preventDefault();
      const d = drag;
      const target = zone.dataset.drop;
      cleanupDrag();
      if (!d || d.cancelled) return;
      applyPriorityChange(d.ids, target === 'tray' ? undefined : Number(target));
    });
    el.matrix.addEventListener('dragend', cleanupDrag);

    // ---- 矩阵:工具条 / 托盘 / 象限菜单 ----
    el.search?.addEventListener('input', (e) => {
      state.search = e.target.value;
      renderMatrix();
    });
    el.assignee.addEventListener('change', (e) => {
      state.assignee = e.target.value;
      renderMatrix();
    });
    el.showDone.addEventListener('click', () => {
      state.showDone = !state.showDone;
      el.showDone.setAttribute('aria-pressed', String(state.showDone));
      renderMatrix();
    });
    el.trayHead.addEventListener('click', () => {
      if (el.tray.classList.contains('empty')) return;
      state.trayCollapsed = !state.trayCollapsed;
      el.tray.classList.toggle('collapsed', state.trayCollapsed);
      requestAnimationFrame(updateMetrics);
    });
    el.matrix.addEventListener('click', (e) => {
      const sortBtn = e.target.closest('[data-sort-for]');
      if (sortBtn) {
        const n = Number(sortBtn.dataset.sortFor);
        openPopup(sortMenuHtml(n), { anchor: sortBtn, alignRight: true });
        return;
      }
      if (e.target.closest('[data-new-task]')) createTask();
    });
    // 批量操作栏挂在内容区(不在矩阵内),单独绑定。
    el.batch.addEventListener('click', (e) => {
      const act = e.target.closest('[data-batch]')?.dataset.batch;
      if (!act) return;
      if (act === 'clear') clearSelection('matrix');
      else if (act === 'prio') {
        openPopup(
          `<div class="menu-head">将 ${state.sel.size} 个任务设为</div><div class="menu-sep"></div>` +
            prioOptionsHtml('none', 'pick-batch'),
          { anchor: e.target.closest('[data-batch]'), alignRight: true },
        );
      } else showToast('该操作在效果图中未模拟');
    });

    // ---- 抽屉 ----
    el.drawer.addEventListener('click', (e) => {
      const prio = e.target.closest('[data-prio]');
      if (prio && state.drawer) {
        const v = prio.dataset.prio;
        state.drawer.draft = v === 'none' ? undefined : Number(v);
        renderDrawer();
        el.drawer.querySelector(`[data-prio="${v}"]`)?.focus();
        return;
      }
      const act = e.target.closest('[data-dw]')?.dataset.dw;
      if (!act || !state.drawer) return;
      if (act === 'close') closeDrawer();
      else if (act === 'save') {
        const id = state.drawer.taskId;
        applyPriorityChange([id], state.drawer.draft);
        closeDrawer();
      } else if (act === 'noop') showToast('该操作在效果图中未模拟');
    });

    // ---- 悬浮提示 ----
    el.matrix.addEventListener('mouseover', (e) => {
      const card = e.target.closest('.card');
      if (!card || card.contains(e.relatedTarget)) return;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(card), 350);
    });
    el.matrix.addEventListener('mouseout', (e) => {
      const card = e.target.closest('.card');
      if (!card || card.contains(e.relatedTarget)) return;
      hideTip();
    });
    el.matrix.addEventListener('mousemove', (e) => {
      tipPoint = { x: e.clientX, y: e.clientY };
      if (!el.tip.hidden) positionTip();
    });
    for (const s of scrollables) s.addEventListener('scroll', hideTip);

    // ---- 全局键盘 ----
    window.addEventListener('keydown', (e) => {
      const typing = e.target.closest?.('input, select, textarea');
      if (e[MOD_KEY] && !e.shiftKey && !typing && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === 'Enter' && e.target.closest?.('.card')) {
        openDrawer(e.target.closest('.card').dataset.id);
        return;
      }
      if (e.key !== 'Escape') return;
      if (drag) {
        onDragKey(e);
        return;
      }
      if (popup) {
        closePopup();
        return;
      }
      if (state.drawer) closeDrawer();
      else if (state.sel.size) clearSelection('matrix');
    });
    // 菜单内的方向键导航(同 ContextMenu:窗口级监听)
    window.addEventListener('keydown', (e) => {
      if (!popup || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      const items = [...popup.menu.querySelectorAll('.menu-item:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    });

    // ---- 辅助条 ----
    el.themeBtn.addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme !== 'dark';
      try {
        localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
      } catch {
        /* ignore */
      }
      applyTheme();
    });
    app.querySelector('#resetBtn').addEventListener('click', resetData);
    window.addEventListener('resize', () => requestAnimationFrame(updateMetrics));

    // ---- 效果图 B:任务树 ----
    if (IS_SPLIT) attachTree();
  }

  function createTask() {
    const t = {
      id: `n${Date.now()}`,
      name: '新任务',
      parent: null,
      start: state.today,
      end: state.today,
      progress: 0,
      who: [],
      ms: false,
    };
    state.tasks.push(t);
    reindex();
    render();
    selectSingle(t.id, 'tree');
    cardEl(t.id)?.scrollIntoView({ block: 'center' });
    hideTip();
  }

  function resetData() {
    state.tasks = seedTasks(state.today);
    // 任务对象全部换新,必须重建索引:否则后续变更会写到旧对象上,界面不更新。
    reindex();
    state.sel = new Set();
    state.anchor = null;
    state.search = '';
    state.assignee = 'all';
    state.showDone = false;
    state.sort = { 1: 'default', 2: 'default', 3: 'default', 4: 'default' };
    state.trayCollapsed = false;
    state.drawer = null;
    state.collapsed = new Set();
    state.treeFilter = 'none';
    undoStack.length = 0;
    closePopup();
    if (el.search) el.search.value = '';
    if (el.treeSearch) el.treeSearch.value = '';
    el.assignee.value = 'all';
    el.showDone.setAttribute('aria-pressed', 'false');
    render();
  }

  function attachTree() {
    el.treeSearch.addEventListener('input', (e) => {
      state.search = e.target.value;
      renderMatrix();
      renderTree();
    });
    el.tree.addEventListener('click', (e) => {
      if (e.target.closest('[data-new-task]')) {
        createTask();
        return;
      }
      const chev = e.target.closest('[data-toggle]');
      if (chev) {
        const id = chev.dataset.toggle;
        if (state.collapsed.has(id)) state.collapsed.delete(id);
        else state.collapsed.add(id);
        renderTree();
        return;
      }
      const filter = e.target.closest('[data-tfilter]')?.dataset.tfilter;
      if (filter) {
        state.treeFilter = state.treeFilter === filter ? 'none' : filter;
        renderTree();
        return;
      }
      const row = e.target.closest('.row');
      if (row) selectSingle(row.dataset.id, 'tree');
      else if (e.target === el.treeScroll) clearSelection('tree');
    });
    el.tree.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.row');
      if (row && !e.target.closest('[data-toggle]')) openDrawer(row.dataset.id);
    });

    // 树宽拖拽(指针事件 + setPointerCapture,同 ResizeHandle)
    const resizer = el.treeResizer;
    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      resizer.classList.add('active');
      const startX = e.clientX;
      const startW = state.treeWidth;
      const move = (ev) => {
        state.treeWidth = clamp(startW + ev.clientX - startX, TREE_WIDTH.min, TREE_WIDTH.max);
        el.tree.style.width = `${state.treeWidth}px`;
        requestAnimationFrame(updateMetrics);
      };
      const up = () => {
        resizer.classList.remove('active');
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
        resizer.removeEventListener('pointercancel', up);
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', up);
      resizer.addEventListener('pointercancel', up);
    });
    resizer.addEventListener('dblclick', () => {
      state.treeWidth = TREE_WIDTH.default;
      el.tree.style.width = `${state.treeWidth}px`;
      requestAnimationFrame(updateMetrics);
    });
  }

  // ---- 启动 ----
  function init() {
    mount();
    attach();
    applyTheme();
    media.addEventListener('change', applyTheme);
    state.tasks = seedTasks(state.today);
    reindex();
    render();
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => updateMetrics()).observe(el.matrix.querySelector('.quad.q1'));
    }
  }

  init();
})();
