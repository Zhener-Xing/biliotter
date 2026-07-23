const chat = require('./chat');
const notesCollab = require('./notes_collab');
const courseAction = require('./course_action');
const mindmapCourse = require('./mindmap_course');

const PROMPTS = {
  [chat.id]: chat,
  [notesCollab.id]: notesCollab,
  [courseAction.id]: courseAction,
  [mindmapCourse.id]: mindmapCourse,
};

function getSystemPrompt(taskId, opts = {}) {
  const key = String(taskId || '').trim();
  const entry = PROMPTS[key];
  if (entry?.system) return String(entry.system).trim();
  const envKey = `LLM_PROMPT_${key.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;
  if (process.env[envKey]) return String(process.env[envKey]).trim();

  if (opts.fallback) return String(opts.fallback).trim();
  throw new Error(`无对应系统提示词`);
}

module.exports = {
  PROMPTS,
  getSystemPrompt,
};
