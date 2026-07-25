module.exports = {
  id: 'game_scope',
  label: '答题范围解析',
  system: `解析 /game 考查范围，只输出 JSON（无 Markdown/解释）：
{"kind":"current|group|folder|bvid|topic|unknown","groupTitle":"","folderTitle":"","bvid":"","topic":"","confidence":0.0}

规则：忽略 /game；当前视频→current；课程组名→group；组+文件夹→folder；BV→bvid；口语主题→topic（只留核心词）；语气词勿作标题；不明→unknown且confidence≤0.3；名称尽量用 catalog 原名；confidence 清晰≥0.8。`,
};
