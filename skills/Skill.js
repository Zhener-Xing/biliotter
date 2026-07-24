class Skill {
  /**
   * @param {{ id: string, slashCommands?: string[] }} opts
   */
  constructor({ id, slashCommands = [] } = {}) {
    this.id = String(id || '').trim();
    this.slashCommands = (Array.isArray(slashCommands) ? slashCommands : [])
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * @param {string} question
   * @returns {string | null} leading slash token, e.g. "/plan"
   */
  parseSlash(question) {
    const q = String(question || '').trim();
    if (!q.startsWith('/')) return null;
    return q.split(/\s+/)[0].toLowerCase();
  }

  /**
   * @param {string} question
   * @returns {boolean}
   */
  matchesSlash(question) {
    const slash = this.parseSlash(question);
    return Boolean(slash && this.slashCommands.includes(slash));
  }

  /**
   * Strip a known slash command so the remainder can be treated as intent text.
   * @param {string} question
   * @param {string} [command]
   */
  stripCommand(question, command) {
    const cmd = String(command || this.slashCommands[0] || '').trim();
    if (!cmd) return String(question || '').trim();
    const re = new RegExp(`^\\${cmd}\\b`, 'i');
    return String(question || '')
      .trim()
      .replace(re, '')
      .trim();
  }

  isActive() {
    return false;
  }

  reset() {}

  /**
   * @param {string} question
   * @param {{ bvid?: string | null, title?: string }} [videoMeta]
   * @param {{ history?: Array<{ role: string, content: string }> }} [ctx]
   * @returns {Promise<{ handled: boolean, ok?: boolean, message?: string, [key: string]: any }>}
   */
  async tryHandle(_question, _videoMeta = {}, _ctx = {}) {
    return { handled: false };
  }
}

module.exports = { Skill };
