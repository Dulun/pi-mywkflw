# pi-mywkflw

一个独立的 Pi Leader / Worker / Reviewer 工作流扩展。

## 功能

- `/mywkflw` 依次选择 Leader、Worker、Reviewer 模型
- 模型选择按供应商分层，并支持关键词搜索
- Leader 留在前台，Worker 和 Reviewer 在后台运行
- 默认最多 3 轮顺序 review，不并行启动 Reviewer
- Worker 默认使用 `max` thinking
- 工作流规则全部内置
- 不依赖 `/issue`、`/shipp`、`/mileader-cmddpsk` 或其他 prompt 文件

后台子代理使用 Pi 已有的 `subagent` 工具；如本机尚未安装 `pi-subagents`，先安装它：

```bash
pi install npm:pi-subagents
```

## 安装

```bash
pi install git:github.com/Dulun/pi-mywkflw
```

安装后重载 Pi：

```text
/reload
/mywkflw
```

也可以直接带任务启动：

```text
/mywkflw 实现用户登录功能
```

## 本地开发

```bash
pi -e ./extensions/mywkflw.ts
```

## 模型限制

如果 `pi-subagents` 的 `modelScope` 开启了严格限制，Worker 和 Reviewer 必须选择允许列表中的模型。
