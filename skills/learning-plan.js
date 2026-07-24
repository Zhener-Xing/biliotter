const { completeTask } = require('../llm');
const {
  listCourseGroups,
  createCourseGroup,
  createCourseFolder,
  normalizeBvid,
} = require('../notes-db');
const {
  addToWatchLater: biliAddWatchLater,
  addToDefaultFavorite: biliAddFavorite,
  getRecentWatched,
} = require('../bili-web-api');
const { Skill } = require('./Skill');

const BV_RE = /BV[\w]+/i;
const CONFIRM_TTL_MS = 10 * 60 * 1000;

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》【】\[\]（）()·.•]/g, '')
    .replace(/课程组$/g, '');
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function isAffirmative(q) {
  const s = String(q || '').trim();
  if (s.length > 16) return false;
  return (
    /^(好的?|可以|行|是的?|对|嗯|要|创建|建|建立|新建|确认|确定|ok|yes|y)([！!。.~～]?)$/i.test(
      s
    ) || /^(好的?|可以|行|是的?)[，, ]*(创建|建|建立|新建|确认|吧)?$/.test(s)
  );
}

function isNegative(q) {
  const s = String(q || '').trim();
  if (s.length > 16) return false;
  return /^(不|不要|不用|算了|取消|no|n)([！!。.]?)$/i.test(s);
}

function looksLikeWatchLater(question) {
  const q = String(question || '').trim();
  if (!q) return false;
  if (/^\/watchlater\b/i.test(q)) return true;
  if (looksLikeFavorite(q)) return false;
  if (/稍后再看|待看|晚点看|回头看/.test(q)) {
    return (
      /加入|加进|放进|放到|添加|记下|存(下|一下)?|把/.test(q) ||
      /稍后再看/.test(q)
    );
  }
  return false;
}

function looksLikeFavorite(question) {
  const q = String(question || '').trim();
  if (!q) return false;
  if (/^\/fav(?:orite)?\b/i.test(q)) return true;
  if (/稍后再看/.test(q)) return false;
  if (/我的收藏|收藏夹/.test(q)) return true;
  if (/收藏(这个|一下|下|视频|到)?/.test(q) || /把.*收藏/.test(q)) return true;
  return /加入收藏|加到收藏|放进收藏|放到收藏/.test(q);
}

function formatPlanPreview(plan) {
  const folders = Array.isArray(plan?.folders) ? plan.folders : [];
  const lines = folders
    .slice()
    .sort((a, b) => (Number(a.ord) || 0) - (Number(b.ord) || 0))
    .map((f, i) => {
      const why = String(f.why || '').trim();
      return `${i + 1}. ${String(f.title || '').trim() || '未命名'}${why ? ` — ${why}` : ''}`;
    });
  const summary = String(plan?.summary || '').trim();
  const goal = String(plan?.goal || '').trim();
  const groupTitle = String(plan?.groupTitle || '').trim() || '学习计划';
  const head = goal
    ? `根据「${goal}」，建议课程组「${groupTitle}」，体系如下：`
    : `建议课程组「${groupTitle}」，体系如下：`;
  return [
    head,
    lines.join('\n') || '（暂无模块）',
    summary ? `\n${summary}` : '',
    '\n确认后我会创建课程组及上述文件夹。回复「确认」创建，或告诉我要改什么；「取消」可放弃。',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const foldersIn = Array.isArray(raw.folders) ? raw.folders : [];
  const folders = [];
  const seen = new Set();
  for (let i = 0; i < foldersIn.length; i += 1) {
    const f = foldersIn[i] || {};
    let title = String(f.title || '').trim().replace(/文件夹$/g, '');
    if (!title) continue;
    const key = normalizeName(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    folders.push({
      title,
      ord: Number.isFinite(Number(f.ord)) ? Number(f.ord) : folders.length,
      why: String(f.why || '').trim(),
    });
  }
  folders.sort((a, b) => a.ord - b.ord);
  folders.forEach((f, i) => {
    f.ord = i;
  });
  if (!folders.length) return null;

  let groupTitle = String(raw.groupTitle || '').trim().replace(/课程组$/g, '');
  if (!groupTitle) groupTitle = String(raw.goal || '').trim().slice(0, 16) || '学习计划';

  return {
    goal: String(raw.goal || '').trim() || groupTitle,
    groupTitle,
    topic: String(raw.topic || '').trim(),
    folders,
    summary: String(raw.summary || '').trim(),
  };
}

class LearningPlanSkill extends Skill {
  constructor() {
    super({
      id: 'learning-plan',
      slashCommands: ['/plan', '/watchlater', '/fav', '/favorite'],
    });
    this.session = this.blankSession();
  }

  blankSession() {
    return {
      phase: 'idle',
      plan: null,
      startedAt: null,
    };
  }

  isActive() {
    return this.session.phase === 'preview' || this.session.phase === 'awaiting_goal';
  }

  reset() {
    this.session = this.blankSession();
  }

  resolveVideo(question, videoMeta = {}) {
    const fromMsg = String(question || '').match(BV_RE);
    const bvid =
      normalizeBvid(fromMsg?.[0]) ||
      normalizeBvid(videoMeta?.bvid) ||
      '';
    const title =
      bvid && normalizeBvid(videoMeta?.bvid) === bvid
        ? String(videoMeta?.title || '').trim()
        : '';
    return { bvid, title };
  }

  wantsRecentVideo(question) {
    const q = String(question || '');
    return /最近看|刚(才)?看|上一个视频|最近一个|刚看完|看过的|刚才看的/.test(q);
  }

  async resolveVideoAsync(question, videoMeta = {}) {
    const direct = this.resolveVideo(question, videoMeta);
    if (direct.bvid) return direct;

    if (!this.wantsRecentVideo(question)) {
      return { bvid: '', title: '' };
    }

    const recent = await getRecentWatched(5);
    if (recent.ok && recent.bvid) {
      return { bvid: recent.bvid, title: recent.title || '' };
    }
    return {
      bvid: '',
      title: '',
      historyError: recent.message || '没有观看记录',
      needLogin: recent.error === 'no_csrf',
    };
  }

  async addToWatchLater(question, videoMeta = {}) {
    // 本地 Cookie 不再是硬门槛：写操作优先走插件代发。
    // 仅在本地与插件都不可用时，由具体 API 返回明确错误。
    const resolved = await this.resolveVideoAsync(question, videoMeta);
    if (resolved.needLogin) {
      return {
        handled: true,
        ok: false,
        plan: true,
        message:
          '还读不到观看记录所需的登录态。请重新加载浏览器插件，并打开已登录的 B 站页面后再试。',
      };
    }
    const bvid = resolved.bvid;
    if (!bvid) {
      return {
        handled: true,
        ok: false,
        plan: true,
        message: resolved.historyError
          ? `没法确定要存哪个视频：${resolved.historyError}`
          : '没有检测到视频。请先打开一个 B 站视频，或说「把最近看的视频加入稍后再看」，也可直接发 BV 号。',
      };
    }

    try {
      const result = await biliAddWatchLater(bvid);
      return {
        handled: true,
        ok: Boolean(result.ok),
        plan: true,
        message: result.message || (result.ok ? '已加入稍后再看。' : '加入稍后再看失败。'),
      };
    } catch (err) {
      return {
        handled: true,
        ok: false,
        plan: true,
        message: `加入稍后再看失败：${err?.message || err}`,
      };
    }
  }

  async addToFavorite(question, videoMeta = {}) {
    const resolved = await this.resolveVideoAsync(question, videoMeta);
    if (resolved.needLogin) {
      return {
        handled: true,
        ok: false,
        plan: true,
        message:
          '还读不到观看记录所需的登录态。请重新加载浏览器插件，并打开已登录的 B 站页面后再试。',
      };
    }
    const bvid = resolved.bvid;
    if (!bvid) {
      return {
        handled: true,
        ok: false,
        plan: true,
        message: resolved.historyError
          ? `没法确定要收藏哪个视频：${resolved.historyError}`
          : '没有检测到视频。请先打开一个 B 站视频，或说「把最近看的视频加入收藏」，也可直接发 BV 号。',
      };
    }

    try {
      const result = await biliAddFavorite(bvid);
      return {
        handled: true,
        ok: Boolean(result.ok),
        plan: true,
        message: result.message || (result.ok ? '已加入收藏。' : '加入收藏失败。'),
      };
    } catch (err) {
      return {
        handled: true,
        ok: false,
        plan: true,
        message: `加入收藏失败：${err?.message || err}`,
      };
    }
  }

  async designPlan(goalText, previousPlan = null) {
    const payload = {
      goal: String(goalText || '').trim(),
      previousPlan: previousPlan || undefined,
    };
    const raw = await completeTask('learning_plan', payload, {
      max_tokens: 1400,
      jsonMode: true,
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 25000,
    });
    return normalizePlan(parseJsonObject(raw));
  }

  enterPreview(plan) {
    this.session = {
      phase: 'preview',
      plan,
      startedAt: Date.now(),
    };
    return {
      handled: true,
      ok: true,
      plan: true,
      needsConfirm: true,
      message: formatPlanPreview(plan),
    };
  }

  async createFromPlan(plan) {
    const p = normalizePlan(plan);
    if (!p) {
      return {
        handled: true,
        ok: false,
        plan: true,
        message: '课程体系无效，请再说一次想学什么，例如「/plan 我想学习人工智能」。',
      };
    }

    let groupTitle = p.groupTitle;
    if (!/课程组$/.test(groupTitle)) groupTitle += '课程组';

    const existing = listCourseGroups().find(
      (g) => normalizeName(g.title) === normalizeName(groupTitle)
    );
    if (existing) {
      this.reset();
      return {
        handled: true,
        ok: false,
        plan: true,
        message: `已经有课程组「${existing.title}」了。可以换个名字再说 /plan，或直接去用现有课程组。`,
      };
    }

    const created = createCourseGroup({
      title: groupTitle,
      topic: p.topic || p.goal,
      meta: {
        source: 'learning-plan',
        goal: p.goal,
        generatedAt: Date.now(),
      },
    });
    if (!created.ok || !created.group) {
      return {
        handled: true,
        ok: false,
        plan: true,
        message: `没能创建课程组「${groupTitle}」，请稍后再试。`,
      };
    }

    const folderNames = [];
    for (const f of p.folders) {
      const folder = createCourseFolder(created.group.id, {
        title: f.title,
        ord: f.ord,
      });
      if (folder.ok) folderNames.push(f.title);
    }

    this.reset();
    const list =
      folderNames.length > 0
        ? folderNames.map((n, i) => `${i + 1}. ${n}`).join('\n')
        : '（未建成文件夹）';

    return {
      handled: true,
      ok: true,
      plan: true,
      message: `已创建课程组「${groupTitle}」，并建好以下文件夹：\n${list}`,
    };
  }

  async handlePlanCommand(question) {
    const rest = this.stripCommand(question, '/plan');
    if (!rest) {
      this.session = {
        phase: 'awaiting_goal',
        plan: null,
        startedAt: Date.now(),
      };
      return {
        handled: true,
        ok: true,
        plan: true,
        message:
          '想学什么？直接描述目标即可，例如「我想学习人工智能」或「我想当一名律师」。我会列出课程体系，确认后创建课程组/文件夹。',
      };
    }
    try {
      const plan = await this.designPlan(rest);
      if (!plan) {
        return {
          handled: true,
          ok: false,
          plan: true,
          message: '没能生成课程体系，换个说法再试，例如「/plan 我想学习人工智能」。',
        };
      }
      return this.enterPreview(plan);
    } catch (err) {
      console.warn('[bili-pet] learning plan design failed:', err?.message || err);
      return {
        handled: true,
        ok: false,
        plan: true,
        message: '生成学习计划时出错了，请稍后再试。',
      };
    }
  }

  async handlePreviewTurn(question) {
    if (
      this.session.startedAt &&
      Date.now() - this.session.startedAt > CONFIRM_TTL_MS
    ) {
      this.reset();
      return {
        handled: true,
        ok: false,
        plan: true,
        message: '上次的学习计划已过期。请重新输入 /plan 再说一次目标。',
      };
    }

    if (isNegative(question)) {
      this.reset();
      return {
        handled: true,
        ok: true,
        plan: true,
        message: '好的，已取消。随时可以再输入 /plan。',
      };
    }

    if (isAffirmative(question)) {
      return this.createFromPlan(this.session.plan);
    }

    // Revision: redesign with previous plan + user notes
    try {
      const plan = await this.designPlan(question, this.session.plan);
      if (!plan) {
        return {
          handled: true,
          ok: false,
          plan: true,
          needsConfirm: true,
          message:
            '没理解要怎么改。可以说「把深度学习拆成两章」，或回复「确认」创建、「取消」放弃。',
        };
      }
      return this.enterPreview(plan);
    } catch (err) {
      console.warn('[bili-pet] learning plan revise failed:', err?.message || err);
      return {
        handled: true,
        ok: false,
        plan: true,
        needsConfirm: true,
        message: '修订时出错了。可以再试一次，或回复「确认」/「取消」。',
      };
    }
  }

  async handleAwaitingGoal(question) {
    const q = String(question || '').trim();
    if (!q) return { handled: false };
    if (isNegative(q)) {
      this.reset();
      return {
        handled: true,
        ok: true,
        plan: true,
        message: '好的，已取消。',
      };
    }
    try {
      const plan = await this.designPlan(q);
      if (!plan) {
        return {
          handled: true,
          ok: false,
          plan: true,
          message: '没能生成课程体系，再说具体一点，例如「我想学习人工智能」。',
        };
      }
      return this.enterPreview(plan);
    } catch (err) {
      console.warn('[bili-pet] learning plan goal failed:', err?.message || err);
      return {
        handled: true,
        ok: false,
        plan: true,
        message: '生成学习计划时出错了，请稍后再试。',
      };
    }
  }

  /**
   * @param {string} question
   * @param {{ bvid?: string | null, title?: string }} [videoMeta]
   */
  async tryHandle(question, videoMeta = {}, _ctx = {}) {
    const q = String(question || '').trim();
    if (!q) return { handled: false };

    const slash = this.parseSlash(q);

    if (
      slash === '/fav' ||
      slash === '/favorite' ||
      (slash !== '/plan' && looksLikeFavorite(q))
    ) {
      return this.addToFavorite(q, videoMeta);
    }

    if (slash === '/watchlater' || (slash !== '/plan' && looksLikeWatchLater(q))) {
      return this.addToWatchLater(q, videoMeta);
    }

    if (slash === '/plan') {
      return this.handlePlanCommand(q);
    }

    if (this.session.phase === 'preview') {
      return this.handlePreviewTurn(q);
    }

    if (this.session.phase === 'awaiting_goal') {
      return this.handleAwaitingGoal(q);
    }

    return { handled: false };
  }
}

const learningPlanSkill = new LearningPlanSkill();

async function tryHandlePlanChat(question, videoMeta = {}, ctx = {}) {
  return learningPlanSkill.tryHandle(question, videoMeta, ctx);
}

module.exports = {
  LearningPlanSkill,
  learningPlanSkill,
  tryHandlePlanChat,
};
