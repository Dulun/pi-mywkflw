import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_TYPE = "mywkflw.config";
const REVIEW_ROUNDS = 3 as const;

type ModelLike = Model<any>;

type WorkflowConfig = {
	version: 1;
	leader: string;
	worker: string;
	reviewer: string;
	reviewRounds: typeof REVIEW_ROUNDS;
	sequentialReview: true;
};

type ModelScope = {
	globalAllow: string[];
	roleAllow: string[];
};

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function modelRef(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

function withThinking(model: string, level: string): string {
	return model.endsWith(`:${level}`) ? model : `${model}:${level}`;
}

function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function readJson(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return asRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

function readModelScope(ctx: ExtensionContext, role: string): ModelScope | undefined {
	const userSettings = readJson(join(agentDir(), "settings.json"));
	let scope: unknown = asRecord(asRecord(userSettings)?.subagents)?.modelScope;

	if (ctx.isProjectTrusted()) {
		const projectSettings = readJson(join(ctx.cwd, ".pi", "settings.json"));
		const projectSubagents = asRecord(projectSettings?.subagents);
		if (projectSubagents && Object.prototype.hasOwnProperty.call(projectSubagents, "modelScope")) {
			scope = projectSubagents.modelScope;
		}
	}

	const scopeRecord = asRecord(scope);
	if (!scopeRecord) return undefined;

	const roleRecord = asRecord(asRecord(scopeRecord.agents)?.[role]);
	const enforced = scopeRecord.enforce === true || roleRecord?.enforce === true;
	if (!enforced) return undefined;

	const globalAllow = strings(scopeRecord.allow);
	const roleAllow = strings(roleRecord?.allow);
	return globalAllow.length > 0 || roleAllow.length > 0 ? { globalAllow, roleAllow } : undefined;
}

function globMatches(value: string, pattern: string): boolean {
	if (pattern === "inherit") return false;
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

function scopeError(ctx: ExtensionContext, role: string, ref: string): string | undefined {
	const scope = readModelScope(ctx, role);
	if (!scope) return undefined;

	if (scope.globalAllow.length > 0 && !scope.globalAllow.some((pattern) => globMatches(ref, pattern))) {
		return `${role} 模型不在当前 modelScope.allow 中：${ref}`;
	}
	if (scope.roleAllow.length > 0 && !scope.roleAllow.some((pattern) => globMatches(ref, pattern))) {
		return `${role} 模型不在当前 modelScope.agents.${role}.allow 中：${ref}`;
	}
	return undefined;
}

function isWorkflowConfig(value: unknown): value is WorkflowConfig {
	const data = asRecord(value);
	return (
		data?.version === 1 &&
		typeof data.leader === "string" &&
		typeof data.worker === "string" &&
		typeof data.reviewer === "string" &&
		data.reviewRounds === REVIEW_ROUNDS &&
		data.sequentialReview === true
	);
}

function loadWorkflowConfig(ctx: ExtensionContext): WorkflowConfig | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type === "custom" && entry.customType === CONFIG_TYPE && isWorkflowConfig(entry.data)) {
			return entry.data;
		}
	}
	return undefined;
}

function buildGuidance(config: WorkflowConfig): string {
	const leader = oneLine(config.leader);
	const worker = oneLine(config.worker);
	const reviewer = oneLine(config.reviewer);

	return [
		"你正在运行独立版 mywkflw；本工作流不依赖任何外部 prompt、skill 或其他扩展。你是前台 Leader，用户只和你对话；实现代码、测试、文档和配置修改必须交给后台 Worker。",
		`本次模型阵型：Leader=${leader}；Worker=${worker}；Reviewer=${reviewer}。`,
		`Worker 固定调用形态：subagent {agent:"worker", model:"${withThinking(worker, "max")}", context:"fresh", async:true, task:"<自包含任务书>"}。同一时刻只允许一个 writer 写同一工作区。`,
		`Reviewer 固定调用形态：优先 agent:"ship-reviewer"，不可用时 agent:"reviewer"；model:"${reviewer}"；context:"fresh"；async:true；只读。`,
		`Review 默认最多 ${config.reviewRounds} 轮，不是必须凑满；Reviewer 必须顺序执行，绝不并行。不要用 runs.all 同时发起 Reviewer；必须等待上一轮完成、Leader 核实并完成必要修复/验证后，再发下一轮。P0/P1 阻塞，P2 仅在不涉安全/隐私/数据丢失、有兜底且已记录跟踪项时书面豁免，P3/NIT 不阻塞。`,
		"Leader 负责理解需求、拆解、派活、监督、亲自验证、终审和向用户汇报；不要亲自实现代码，除非抽查 diff 或一行级紧急小修。用户问进度时，用 subagent status/fleet 查询后台状态。",
		"开工前必须读取仓库 AGENTS.md、README.md 和相关 docs，检查 git 分支/worktree/status，并确定真实验证命令。数据库 migration 只能 fix-forward，绝不改已迁移产物。",
		"每份 Worker 任务书必须自包含：目标与依据、文件领地、上游契约、验收命令、红线、回报格式；同一时刻只允许一个 writer 修改同一工作区。",
		"实现类任务：先实现，再由 Leader 亲自全量验证；验证全绿后进行独立只读 review，修复阻塞项后重验，最多 3 轮。只有用户明确要求且仓库规则允许时才 commit、push 或创建 PR。",
		"Issue 类任务：只调研并产出一个前后一致、自包含的 Issue；创建前完成查重和正文自查，不改代码、不评论、不把未决定事项伪装成已确定事实。",
		"所有子代理失败、扩展加载失败或验证失败都必须如实报告，不得静默切换执行协议或伪造成功状态。",
	].join("\n");
}

function availableModels(ctx: ExtensionContext): Map<string, ModelLike> {
	const source =
		ctx.scopedModels.length > 0
			? ctx.scopedModels.map((entry) => entry.model)
			: ctx.modelRegistry.getAvailable();
	const models = new Map<string, ModelLike>();

	for (const model of source) {
		const ref = modelRef(model);
		models.set(ref, model);
	}
	if (models.size === 0 && ctx.model) {
		models.set(modelRef(ctx.model), ctx.model);
	}
	return new Map([...models.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export default function myWorkflow(pi: ExtensionAPI) {
	let activeConfig: WorkflowConfig | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		if (!activeConfig) {
			ctx.ui.setStatus("mywkflw", undefined);
			return;
		}
		ctx.ui.setStatus(
			"mywkflw",
			`mywkflw · L ${activeConfig.leader} · W ${activeConfig.worker} · R ${activeConfig.reviewer}`,
		);
	}

	pi.on("session_start", (_event, ctx) => {
		activeConfig = loadWorkflowConfig(ctx);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		if (activeConfig) {
			event.systemPromptOptions.sections.mywkflw = buildGuidance(activeConfig);
		}
	});

	pi.registerCommand("mywkflw", {
		description: "选择 Leader、Worker、Reviewer 模型并启动顺序 review 工作流",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/mywkflw 需要交互式 UI；当前模式没有可用的模型选择对话框。", "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Leader 正在工作，请等待当前回合结束后再初始化 mywkflw。", "warning");
				return;
			}

			const models = availableModels(ctx);
			if (models.size === 0) {
				ctx.ui.notify("没有可用模型。请先检查认证或用 /list-models 查看模型。", "error");
				return;
			}
			const options = [...models.keys()];
			const select = async (title: string): Promise<string | undefined> => ctx.ui.select(title, options);

			const leader = await select("选择 Leader 模型（前台会话）");
			if (!leader) {
				ctx.ui.notify("已取消 mywkflw 初始化。", "info");
				return;
			}

			const worker = await select("选择 Worker 模型（后台实现，默认 max thinking）");
			if (!worker) {
				ctx.ui.notify("已取消 mywkflw 初始化。", "info");
				return;
			}
			const workerError = scopeError(ctx, "worker", worker);
			if (workerError) {
				ctx.ui.notify(`${workerError}。请修改选择或调整 subagents.modelScope。`, "error");
				return;
			}

			const reviewer = await select("选择 Reviewer 模型（后台顺序只读评审）");
			if (!reviewer) {
				ctx.ui.notify("已取消 mywkflw 初始化。", "info");
				return;
			}
			const reviewerError = scopeError(ctx, "reviewer", reviewer);
			if (reviewerError) {
				ctx.ui.notify(`${reviewerError}。请修改选择或调整 subagents.modelScope。`, "error");
				return;
			}

			const leaderModel = models.get(leader);
			if (!leaderModel) {
				ctx.ui.notify(`找不到所选 Leader 模型：${leader}`, "error");
				return;
			}

			const previousConfig = activeConfig;
			const previousModel = ctx.model;
			const nextConfig: WorkflowConfig = {
				version: 1,
				leader,
				worker,
				reviewer,
				reviewRounds: REVIEW_ROUNDS,
				sequentialReview: true,
			};

			try {
				if (!(await pi.setModel(leaderModel))) {
					ctx.ui.notify(`Leader 模型认证不可用，未切换：${leader}`, "error");
					return;
				}
				activeConfig = nextConfig;
				pi.appendEntry(CONFIG_TYPE, nextConfig);
				updateStatus(ctx);
			} catch (error) {
				activeConfig = previousConfig;
				if (previousModel) await pi.setModel(previousModel);
				ctx.ui.notify(`mywkflw 初始化失败：${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			ctx.ui.notify(
				[`mywkflw 已就绪（最多 ${REVIEW_ROUNDS} 轮顺序 review）`, `Leader: ${leader}`, `Worker: ${worker}`, `Reviewer: ${reviewer}`].join("\n"),
				"info",
			);

			if (!ctx.isIdle()) {
				ctx.ui.notify("配置已保存，但当前会话变忙；请等待空闲后直接发送任务。", "warning");
				return;
			}

			const task = args.trim();
			pi.sendUserMessage(
				task
					? `mywkflw 已初始化。请按内置 Leader 工作流处理以下任务：\n\n${task}`
					: "mywkflw 已初始化。请先询问我本次要处理的任务；收到任务后按内置 Leader 工作流执行。",
			);
		},
	});
}
