---
name: research-note
description: 汇总资料并保留可核验来源，形成研究笔记。
metadata:
  petrichor:
    title: 研究笔记
    target: assistant
    dependencies: [knowledge, research, writer]
    tools: [knowledge.read, writer.save_artifact]
---
先确定问题、范围和输出形式。读取关键来源，记录来源链接或内部引用。
区分来源明确支持的事实、推断与未核实项。来源冲突时分别呈现，不自行填补缺失事实。
按问题组织笔记，结尾列出仍需补充的资料。用户要求保存时，使用已有的资料保存工具。
