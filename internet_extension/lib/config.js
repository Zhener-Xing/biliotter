/** 扩展默认配置（可被用户设置覆盖） */
const BILI_PET_CONFIG = {
  SCHEMA_VERSION: 1,
  SOURCE: 'bili-pet-bridge',
  PET_BRIDGE_URL: 'http://127.0.0.1:39261/event',

  /** 进度采样 */
  PROGRESS_INTERVAL_MS: 1000,
  /** 同一字幕句重复记录的最小间隔（秒）——按句切换记录即可 */
  SUBTITLE_SYNC_STEP_SEC: 0.5,
  /** 普通事件推送节流 */
  BRIDGE_THROTTLE_MS: 1000,
  /** 字幕上下文：给后续 AI 用（秒） */
  SUBTITLE_CONTEXT_BEFORE_SEC: 20,
  SUBTITLE_CONTEXT_AFTER_SEC: 8,

  ACTION_DEBOUNCE_MS: 400,

  /** 默认用户设置 */
  DEFAULT_SETTINGS: {
    recordingEnabled: true,
    realtimePush: true,
  },
};

globalThis.BILI_PET_CONFIG = BILI_PET_CONFIG;
