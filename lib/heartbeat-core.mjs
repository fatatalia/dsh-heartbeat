/**
 * heartbeat-core.mjs — 心跳核心（独立插件，只负责心跳逻辑）
 *
 * 职责边界：
 *  - 只做「定时触发 → 创建独立会话 → 投递心跳 prompt → 法塔 agent 决策 → 归档」。
 *  - 不实现 iMessage 发送：发消息由 iMessage 插件注册的全局 `message` 工具承担，
 *    心跳会话里的法塔 agent 需要发时自然能调到它。
 *
 * 依赖经构造注入（agents/sessions/agentPresets/defaultModel/workspaceRegistry/timer）。
 */
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection } from "@deepseek-ai/dsh-agent";

/** 心跳默认 prompt：极简，只指向 HEARTBEAT.md（业务细节全部由工作区文件承载）。 */
export const DEFAULT_HEARTBEAT_PROMPT =
  "这次是心跳（heartbeat）。请读取当前工作区的 HEARTBEAT.md（如果存在），并严格按照其中的检查清单与发送要求执行。若无需发送：保持静默，仅回复 HEARTBEAT_OK。";

/** 心跳 prompt：自定义优先，否则用默认极简版。 */
function heartbeatPrompt(customPrompt, quietStart, quietEnd) {
  const base = customPrompt?.trim() || DEFAULT_HEARTBEAT_PROMPT;
  return `${base}

（静默时段为 ${quietStart}:00-${quietEnd}:00，若在此时间段则直接回复 HEARTBEAT_OK 不执行检查。）`;
}

/** 从事件取本次心跳区间最后一条纯文本 assistant 回复。 */
function summarizeReply(events, firstSeq) {
  let text = "";
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data.message.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
  }
  return text;
}

/** 心跳运行器。 */
export class HeartbeatRunner {
  constructor({ agents, sessions, agentPresets, defaultModel, workspaceRegistry, timer, log = console }) {
    this.agents = agents;
    this.sessions = sessions;
    this.agentPresets = agentPresets;
    this.defaultModel = defaultModel;
    this.workspaceRegistry = workspaceRegistry;
    this.timer = timer;
    this.log = log;
    this.disposed = false;
    this.timerDisposer = null;
  }

  /** 系统时区当前小时是否在静默时段。 */
  inQuiet(quietStart, quietEnd) {
    if (quietStart == null || quietEnd == null) return false;
    // 直接取系统时区（进程时区 = 系统时区）的本地小时：静默时段按用户本地时间判断。
    // 教训：此前 `getHours() + 8` 假设进程时区未知而叠加 +8，但进程时区实为 +8（CST），
    // 叠加后 16:xx 被误算为 0:xx 落入静默时段；也不应写死 Asia/Shanghai（换时区即失效）。
    const hour = new Date().getHours();
    if (quietStart === quietEnd) return false;
    if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
    return hour >= quietStart || hour < quietEnd; // 跨午夜
  }

  /** 基于 agentPresets 组合 setup（同 iMessage 网关，web 进程 create agent 必需）。
   *  override：配置指定的 provider/model（可空，空则用全局默认）。 */
  async composeSetup(presetId, override) {
    const presets = this.agentPresets;
    const baseSel = this.defaultModel.currentSelection();
    const sel = override
      ? { provider: override.provider || baseSel.provider, model: override.model || baseSel.model }
      : baseSel;
    if (presets === void 0) {
      return {
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: sel, assembled: void 0 });
          return Promise.resolve();
        },
      };
    }
    const resolved = (await presets.resolve(presetId)).id;
    return {
      agentPreset: resolved,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, { current: sel, assembled: void 0 });
        await presets.mount(agentCtx, resolved);
      },
    };
  }

  /** 执行一次心跳。force=true 时忽略静默时段（用于手动触发）。 */
  async runOnce(config, force = false) {
    const { workspace, quietStart, quietEnd, prompt } = config;
    if (!force && this.inQuiet(quietStart, quietEnd)) {
      this.log?.info?.(`heartbeat: 静默时段，跳过`);
      return;
    }
    const id = SessionId(`heartbeat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    this.log?.info?.(`heartbeat: 触发 ${id} workspace=${workspace}${force ? " [手动]" : ""}`);
    try {
      const sel = this.defaultModel.currentSelection();
      const provider = config.provider || sel.provider; // 配置指定 provider 优先，空则全局默认
      const model = config.model || sel.model;
      const composition = await this.composeSetup(undefined, { provider, model });
      const created = await this.agents.create({
        sessionId: id,
        meta: { cwd: workspace, ...(composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }) },
        agentOptions: { provider, model },
        setup: composition.setup,
      });
      const agent = created.agent;
      // turn 级单步超时配置（dsh-turn-guard 读取）：从配置读 stepTimeoutSec，
      // 挂到 agent 上的通用扩展容器 __pluginConfig。无配置/0 → 不挂（turn-guard 不干预）。
      if (agent && !agent.__pluginConfig) {
        try {
          Object.defineProperty(agent, "__pluginConfig", {
            enumerable: false,
            writable: true,
            configurable: true,
            value: {},
          });
        } catch (e) {
          this.log?.warn?.(`heartbeat: 初始化 __pluginConfig 失败: ${e instanceof Error ? e.message : e}`);
        }
      }
      const stepSec = Number(config.stepTimeoutSec) > 0 ? Number(config.stepTimeoutSec) : 0;
      if (agent?.__pluginConfig) {
        if (stepSec > 0) agent.__pluginConfig.turnGuard = { stepSec };
        else delete agent.__pluginConfig.turnGuard;
      }
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({ content: [{ type: "text", text: heartbeatPrompt(prompt, quietStart, quietEnd) }], source: { kind: "user" } }));
      await agent.whenIdle();
      await this.sessions.flush(agent.session);
      const reply = summarizeReply(agent.session.snapshotEvents(), firstSeq).replace(/\s+/g, " ").trim();
      this.log?.info?.(`heartbeat: ${id} 执行完成 reply=${String(reply).slice(0, 100)}`);
      await this.attachWorkspace(id, workspace);
      await this.archive(id);
    } catch (e) {
      this.log?.error?.(`heartbeat: 执行失败 ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 把会话归属到对应 workspace（按 cwd 路径），避免显示在"未分组"。 */
  async attachWorkspace(sessionId, cwd) {
    const registry = this.workspaceRegistry;
    if (registry === void 0) return;
    try {
      let workspace = await registry.resolveByPath(cwd);
      if (workspace === void 0) workspace = await registry.create(cwd);
      await workspace.attachSession(sessionId);
    } catch (e) {
      this.log?.warn?.(`heartbeat: attach workspace ${cwd} 失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 归档心跳会话。 */
  async archive(sessionId) {
    try {
      if (this.workspaceRegistry) await this.workspaceRegistry.archiveSession(sessionId);
      this.log?.info?.(`heartbeat: ${sessionId} 已归档`);
    } catch (e) {
      this.log?.warn?.(`heartbeat: 归档失败 ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 启动心跳循环（timer.interval）。 */
  start(config) {
    if (this.timerDisposer) return;
    const intervalMs = Math.max(5, config.intervalSec ?? 1800) * 1000;
    this.timerDisposer = this.timer.interval(() => {
      if (this.disposed) return;
      this.runOnce(config).catch((e) => this.log?.error?.(`heartbeat: 循环错误 ${e}`));
    }, intervalMs);
    this.log?.info?.(`heartbeat: 已启动，间隔 ${intervalMs}ms，工作区 ${config.workspace}`);
    return this.timerDisposer;
  }

  /** 停止心跳循环。 */
  stop() {
    this.disposed = true;
    try { this.timerDisposer?.(); } catch {}
    this.timerDisposer = null;
  }

  /** 应用最新配置并重启循环（enabled/间隔/工作区>变更自动生效）。 */
  applyConfig(config) {
    this.stop();
    this.disposed = false;
    if (config?.enabled) {
      this.start(config);
    } else {
      this.log?.info?.(`heartbeat: 已禁用（enabled=false）`);
    }
  }
}
