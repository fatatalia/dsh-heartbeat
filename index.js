/**
 * dsh-heartbeat — host 半部分（独立插件）
 *
 * 职责：定时触发心跳 → 创建独立会话投心跳 prompt → 法塔 agent 依 HEARTBEAT.md
 * 决策（要发则调 iMessage 插件的全局 message 工具）→ 完成后归档会话。
 *
 * 本插件不实现 iMessage 发送（那归 iMessage 插件）；只负责心跳节奏与会话生命周期。
 */
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { HeartbeatRunner } from "./lib/heartbeat-core.mjs";

export const name = "dsh-heartbeat";

// 配置 remote（typert/settings）+ 心跳（agents/agentPresets/sessions/workspaceRegistry/timer）。
export const inject = ["typert", "agents", "agentDefaultModel", "agentPresets", "sessions", "workspaceRegistry", "timer", "llm"];

// 插件自身 config（settingsPath 指向 $DSH_HOME/settings.yaml）。
//
// 2026-09-24 适配 dsh 0.1.7：`ctx.settings.register()` 已被移除，原 `heartbeat`
// settings namespace 的数据 schema 直接并入插件自己的 Config。带 `.volatile()` 的
// 字段出现在设置页可热改；改动由 loader 直接提交进运行中的引用对象（不重载插件），
// 并广播 `loader/volatile-update`。`.default()` 等价于原来的 `base`（运行时兜底，
// 不写入磁盘）。profile 条目 id 必须与插件名一致（`dsh-heartbeat`）。
export const Config = z.object({
  settingsPath: z.string().default(join(homedir(), ".dsh", "settings.yaml")),
  enabled: z.boolean().default(true).volatile(),
  intervalSec: z.number().default(1800).volatile(),
  workspace: z.string().default(join(homedir(), "dsh", "default")).volatile(),
  quietStart: z.number().default(22).volatile(),
  quietEnd: z.number().default(7).volatile(),
  provider: z.string().default("").volatile(),
  model: z.string().default("").volatile(),
  prompt: z.string().default("").volatile(),
  /**
   * 思考等级：off/low/medium/high/max，空串 = 跟随 provider 默认。
   * 2026-09-11 加：此前心跳的 reasoningEffort 由 provider 层 `reasoning: high` 隐式兜底，
   * 设置页无从调整；现在显式配置、默认 high、保存即热生效。
   */
  reasoningEffort: z.string().default("high").volatile(),
  /** turn 级单步超时（秒）：step 超过该时长被 dsh-turn-guard 强制 cancel；不配/0 = 不限制（默认）。 */
  stepTimeoutSec: z.number().default(0).volatile(),
});

// ── Typert wire schemas（宽松 parse） ───────────────────────────────────────
function parseObj() {
  // 0.1.7：typert strict codec 必须有 create() 工厂（gateway 走 codec.create().parse(v)）。
  const parse = (value) => { if (typeof value !== "object" || value === null) throw new Error("expected object"); return value; };
  return { parse, create: () => ({ parse }) };
}
const getResultSchema = parseObj();
const setPayloadSchema = parseObj();
const setResultSchema = parseObj();

/** Typert MANIFEST：getConfig / setConfig。 */
const MANIFEST = {
  package: "dsh-heartbeat",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-heartbeat#heartbeat/getConfig",
      service: "heartbeat",
      namespace: "heartbeat",
      method: "getConfig",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-heartbeat#HeartbeatConfig", schema: getResultSchema, create: () => getResultSchema },
    },
    {
      id: "dsh-heartbeat#heartbeat/listProviders",
      service: "heartbeat",
      namespace: "heartbeat",
      method: "listProviders",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-heartbeat#ProviderList", schema: getResultSchema, create: () => getResultSchema },
    },
    {
      id: "dsh-heartbeat#heartbeat/listModels",
      service: "heartbeat",
      namespace: "heartbeat",
      method: "listModels",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-heartbeat#ProviderParam", schema: getResultSchema, create: () => getResultSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-heartbeat#ModelList", schema: getResultSchema, create: () => getResultSchema },
    },
    {
      id: "dsh-heartbeat#heartbeat/setConfig",
      service: "heartbeat",
      namespace: "heartbeat",
      method: "setConfig",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-heartbeat#SetPayload", schema: setPayloadSchema, create: () => setPayloadSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-heartbeat#SetResult", schema: setResultSchema, create: () => setResultSchema },
    },
    {
      id: "dsh-heartbeat#heartbeat/trigger",
      service: "heartbeat",
      namespace: "heartbeat",
      method: "trigger",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-heartbeat#TriggerResult", schema: setResultSchema, create: () => setResultSchema },
    },
  ],
  model: { services: [], events: [], objects: [] },
};

/** Remote service：读写心跳配置 + 手动触发。 */
class HeartbeatService extends TypertRemoteService {
  constructor(ctx, scope) {
    super(ctx, "heartbeat");
    this.scope = scope;
    this.llm = ctx.get("llm");
    this.runner = null; // apply 中注入
  }

  /** 可用 provider 目录。返回裸值，Typert 自动包装 ok/value。 */
  async listProviders() {
    const list = await this.llm?.listProviders?.() ?? [];
    return list.map((p) => ({ id: p.provider ?? p.id, name: p.name ?? p.provider ?? p.id }));
  }

  /**
   * 指定 provider 的模型列表。附带给每个模型带上它支持的思考等级（设置页下拉用）。
   * llm.listModels 只回 id/name，能力元数据要走 resolveModelInfo；逐个查询是本地目录
   * 查询（无网络），失败则该项不带 efforts（客户端回落标准五档）。
   */
  async listModels(payload) {
    const provider = typeof payload?.provider === "string" ? payload.provider : "";
    if (!provider) throw new Error("provider 必填");
    const list = await this.llm?.listModels?.(provider) ?? [];
    const resolve = this.llm?.resolveModelInfo;
    const out = [];
    for (const m of list) {
      const item = { id: m.id, name: m.name ?? m.id };
      if (typeof resolve === "function") {
        try {
          const info = await resolve.call(this.llm, provider, m.id);
          const reasoning = info?.reasoning;
          if (reasoning !== void 0) {
            item.efforts = reasoning.efforts.map((e) => e.id);
            if (reasoning.defaultEffort !== void 0) item.defaultEffort = reasoning.defaultEffort;
          }
        } catch { /* 能力未知：留空，客户端用标准档位兜底 */ }
      }
      out.push(item);
    }
    return out;
  }
  getConfig() {
    const snap = this.scope.get();
    return {
      enabled: snap?.enabled ?? true,
      intervalSec: snap?.intervalSec ?? 1800,
      workspace: snap?.workspace ?? join(homedir(), "dsh", "default"),
      quietStart: snap?.quietStart ?? 22,
      quietEnd: snap?.quietEnd ?? 7,
      provider: typeof snap?.provider === "string" ? snap.provider : "",
      model: typeof snap?.model === "string" ? snap.model : "",
      prompt: typeof snap?.prompt === "string" ? snap.prompt : "",
      reasoningEffort: typeof snap?.reasoningEffort === "string" ? snap.reasoningEffort : "high",
      stepTimeoutSec: typeof snap?.stepTimeoutSec === "number" && snap.stepTimeoutSec > 0 ? snap.stepTimeoutSec : 0,
      writable: true,
    };
  }
  async setConfig(payload) {
    const patch = {};
    for (const k of ["enabled", "intervalSec", "workspace", "quietStart", "quietEnd", "provider", "model", "prompt", "reasoningEffort", "stepTimeoutSec"]) {
      if (payload?.[k] !== undefined) patch[k] = payload[k];
    }
    if (Object.keys(patch).length === 0) return { ok: true };
    await this.scope.update(patch);
    return { ok: true };
  }
  /** 手动触发一次心跳（忽略静默时段）。 */
  async trigger() {
    if (!this.runner) return { ok: false };
    const snap = this.scope.get();
    await this.runner.runOnce(runnerConfig(snap), true);
    return { ok: true };
  }
}

/** 从配置生成心跳运行参数。 */
function runnerConfig(snap) {
  return {
    enabled: snap?.enabled ?? true,
    workspace: snap?.workspace ?? join(homedir(), "dsh", "default"),
    intervalSec: snap?.intervalSec ?? 1800,
    quietStart: snap?.quietStart ?? 22,
    quietEnd: snap?.quietEnd ?? 7,
    provider: typeof snap?.provider === "string" ? snap.provider : "",
    model: typeof snap?.model === "string" ? snap.model : "",
    prompt: typeof snap?.prompt === "string" ? snap.prompt : "",
    reasoningEffort: typeof snap?.reasoningEffort === "string" ? snap.reasoningEffort : "high",
    stepTimeoutSec: typeof snap?.stepTimeoutSec === "number" && snap.stepTimeoutSec > 0 ? snap.stepTimeoutSec : 0,
  };
}

export function apply(ctx, config) {
  const Logger = ctx.logger;
  // 本地时间戳（时区跟随系统，如 Asia/Shanghai +08）。曾用 toISOString() 输出 UTC，
  // 本地 16:xx 显示 08:xxZ 造成误解。
  const ts = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const log = {
    info: (m) => { console.log(`[${ts()}] [hb] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[${ts()}] [hb:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[${ts()}] [hb:err] ${m}`); try { Logger?.error?.(m); } catch {} },
  };

  // 0.1.7：配置即插件 Config 的 volatile 字段，不再有 settings scope。
  // 这里适配出等价的 scope 外壳，语义与原来一致：
  //   get()    → 读运行中的引用值（volatile 变更由 loader 直接写入引用，永远最新）
  //   update() → 经 configEditor 写回当前 profile 的条目 config
  //   watch()  → 监听 loader/volatile-update（配置热改时触发）
  const scope = {
    get: () => ({
      enabled: config.enabled.get(),
      intervalSec: config.intervalSec.get(),
      workspace: config.workspace.get(),
      quietStart: config.quietStart.get(),
      quietEnd: config.quietEnd.get(),
      provider: config.provider.get(),
      model: config.model.get(),
      prompt: config.prompt.get(),
      reasoningEffort: config.reasoningEffort.get(),
      stepTimeoutSec: config.stepTimeoutSec.get(),
    }),
    async update(patch) {
      const editor = ctx.get("configEditor");
      const entry = ctx.fiber?.entry;
      if (!editor || entry === undefined) return;
      await editor.edit(entry, (current) => ({ ...current, ...patch }));
    },
    watch(cb) {
      ctx.on("loader/volatile-update", () => { cb(); });
    },
  };
  const service = new HeartbeatService(ctx, scope);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-heartbeat: typert manifest");

  // 心跳 runner（用默认配置启动；配置变更重启生效）。
  const runner = new HeartbeatRunner({
    agents: ctx.get("agents"),
    sessions: ctx.get("sessions"),
    agentPresets: ctx.get("agentPresets"),
    defaultModel: ctx.get("agentDefaultModel"),
    workspaceRegistry: ctx.get("workspaceRegistry"),
    timer: ctx.get("timer"),
    llm: ctx.get("llm"),
    log,
  });
  service.runner = runner;
  // 初始：按当前配置启动。
  let currentConfig = runnerConfig(scope.get());
  log.info(`heartbeat: 插件已加载（0.1.7 volatile 配置）enabled=${currentConfig.enabled} 间隔=${currentConfig.intervalSec}s 工作区=${currentConfig.workspace} 思考等级=${currentConfig.reasoningEffort || "(provider 默认)"}`);
  if (scope.get()?.enabled) runner.start(currentConfig);
  else log.info("heartbeat: enabled=false，未启动");

  // 配置变更自动生效：watch 到变化就重启循环（含 enabled 开关、间隔、工作区）。
  scope.watch(() => {
    try {
      const snap = scope.get();
      const next = runnerConfig(snap);
      // 逐字段比较：runner 的 timer 闭包捕获的是启动时那份 config，任何字段变了都得
      // applyConfig 重起循环才生效。此前漏了 prompt / stepTimeoutSec（改提示词不生效的
      // 隐性 bug），2026-09-11 补上 reasoningEffort 时一并补齐。
      const changed = next.enabled !== currentConfig.enabled
        || next.intervalSec !== currentConfig.intervalSec
        || next.workspace !== currentConfig.workspace
        || next.quietStart !== currentConfig.quietStart
        || next.quietEnd !== currentConfig.quietEnd
        || next.provider !== currentConfig.provider
        || next.model !== currentConfig.model
        || next.prompt !== currentConfig.prompt
        || next.reasoningEffort !== currentConfig.reasoningEffort
        || next.stepTimeoutSec !== currentConfig.stepTimeoutSec;
      if (!changed) return;
      currentConfig = next;
      runner.applyConfig(next);
      log.info(`heartbeat: 配置已自动生效 enabled=${next.enabled} 间隔=${next.intervalSec}s 工作区=${next.workspace} 思考等级=${next.reasoningEffort || "(provider 默认)"}`);
    } catch (e) {
      log.error(`heartbeat: watch 处理失败 ${e instanceof Error ? e.message : e}`);
    }
  });

  ctx.on("dispose", () => runner.stop());
  log.info("heartbeat 插件已加载，工作区=" + currentConfig.workspace + " 间隔=" + currentConfig.intervalSec + "s");
}
