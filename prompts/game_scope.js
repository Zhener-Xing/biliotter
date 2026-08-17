module.exports = {
  id: 'game_scope',
  label: '答题范围解析',
  system: `把用户想考的内容对到已有笔记范围。只输出 JSON（不要 Markdown、不要解释）：
{"kind":"current|group|folder|bvid|topic|unknown","groupTitle":"","folderTitle":"","bvid":"","topic":"","confidence":0.0}

用户说法很口语，可能是「考一下线代」「高数的积分」「反向传播那一块」「复习这个视频」。

判定顺序：
1. 当前/这个视频/正在看/本集 → kind=current
2. 能对上 catalog 课程组名/topic/简称（线代=线性代数，高数=高等数学，数分=数学分析，概统=概率论，计网=计算机网络，操统=操作系统）→ kind=group，groupTitle 用 catalog 原名
3. 对上文件夹，或「课程组的某文件夹/某模块」→ kind=folder，填 groupTitle+folderTitle（catalog 原名）
4. 出现 BV 号 → kind=bvid
5. 对不上组/夹，但是具体考点（特征值、反向传播、链表）→ kind=topic，topic 只留核心词
6. 「A的B」：A 是课程组、B 是夹或考点。能确定夹则 folder，否则 groupTitle=A 且 topic=B、kind=topic
7. 实在看不懂 → kind=unknown，confidence≤0.3

禁止：把语气词（吧呢啊呀嘛啦哦）当标题；不要把「考一下/复习/出题」写进 topic；topic 去掉「相关/知识点/内容/方面」等空话。
confidence：能对上 catalog ≥0.85；只能猜 topic ≥0.55；不明 ≤0.3。`,
};
