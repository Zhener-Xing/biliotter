'use strict';

/**
 * Shared ops gate: extension alive + sessionLoggedIn + mounted uid + first-pull ready.
 * Used by canva (IPC) and launcher/server (HTTP).
 */

let opsReady = false;
/** True while background purge remounts a non-active uid (avoid serving wrong DB). */
let foreignPurgeActive = false;

function setAccountOpsReady(ready) {
  opsReady = Boolean(ready);
  return opsReady;
}

function isAccountOpsReady() {
  return opsReady && !foreignPurgeActive;
}

function setForeignPurgeActive(active) {
  foreignPurgeActive = Boolean(active);
  return foreignPurgeActive;
}

function isForeignPurgeActive() {
  return foreignPurgeActive;
}

function gateMessage(error) {
  switch (String(error || '')) {
    case 'extension_offline':
      return '浏览器插件未在线，请打开扩展并保持 B 站登录';
    case 'waiting_auth':
    case 'waiting_auth_uid_match':
    case 'auth_failed':
    case 'not_logged_in':
      return '正在用 B 站登录态连接云端…';
    case 'waiting_cookie':
      return '请打开已登录的 bilibili.com，以便同步知识库';
    case 'cloud_disabled':
      return '未配置云端，无法使用好友功能';
    case 'syncing':
    case 'pull_timeout':
    case 'pull_error':
      return '正在同步知识库，请稍候…';
    case 'not_bound':
    default:
      return '请先登录 B 站账号';
  }
}

module.exports = {
  setAccountOpsReady,
  isAccountOpsReady,
  setForeignPurgeActive,
  isForeignPurgeActive,
  gateMessage,
};
