/**
 * dsh-heartbeat — client 半部分（配置页，浏览器 bundle）
 *
 * 注册 `settings.section`，渲染心跳配置：总开关 / 间隔(秒) / 工作区路径 / 静默时段。
 * 数据经 Typert remote（getConfig/setConfig）读写，落盘 settings.yaml 的 heartbeat 段。
 */
window.__ModuleLoader__.load({
  id: "dsh-heartbeat",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const S = require("react/jsx-runtime");

    const identity = (value) => value;
    const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: identity } });

    const CONTRIBUTION = {
      package: "dsh-heartbeat",
      descriptors: [
        { id: "dsh-heartbeat#heartbeat/getConfig", service: "heartbeat", namespace: "heartbeat", method: "getConfig", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-heartbeat#HeartbeatConfig") },
        { id: "dsh-heartbeat#heartbeat/listProviders", service: "heartbeat", namespace: "heartbeat", method: "listProviders", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-heartbeat#ProviderList") },
        { id: "dsh-heartbeat#heartbeat/listModels", service: "heartbeat", namespace: "heartbeat", method: "listModels", invocation: { kind: "direct" }, parameters: [{ name: "payload", wire: "payload", source: "json", codec: codec("dsh-heartbeat#ProviderParam") }], result: codec("dsh-heartbeat#ModelList") },
        { id: "dsh-heartbeat#heartbeat/setConfig", service: "heartbeat", namespace: "heartbeat", method: "setConfig", invocation: { kind: "direct" }, parameters: [{ name: "payload", wire: "payload", source: "json", codec: codec("dsh-heartbeat#SetPayload") }], result: codec("dsh-heartbeat#SetResult") },
        { id: "dsh-heartbeat#heartbeat/trigger", service: "heartbeat", namespace: "heartbeat", method: "trigger", invocation: { kind: "direct" }, parameters: [], result: codec("dsh-heartbeat#TriggerResult") },
      ],
    };

    /** 数字输入行。 */
    function NumField({ label, value, min, onChange, disabled, hint }) {
      return S.jsxs("div", { style: { margin: "10px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
        S.jsx("label", { style: { flex: "0 0 180px", fontWeight: 500 }, children: label }),
        S.jsx("input", {
          type: "number", min, value, disabled,
          onChange: (e) => onChange(Number(e.target.value)),
          style: { width: 140, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)" },
        }),
        hint ? S.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", marginLeft: 8 }, children: hint }) : null,
      ] });
    }

    function HeartbeatSection(props) {
      const { getConfig, setConfig, trigger, listProviders, listModels } = props;
      const [cfg, setCfg] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(false);
      const [saved, setSaved] = React.useState(false);
      const [loadTick, setLoadTick] = React.useState(0);
      const [providers, setProviders] = React.useState([]);
      const [models, setModels] = React.useState([]);
      const [triggering, setTriggering] = React.useState(false);
      const [triggered, setTriggered] = React.useState(false);

      React.useEffect(() => {
        let current = true;
        setLoading((prev) => prev || cfg === null);
        Promise.resolve().then(() => getConfig()).then((c) => {
          if (!current) return;
          setCfg(c || {});
          setLoading(false);
        }, () => { if (current) { setLoading(false); setError(true); } });
        return () => { current = false; };
      }, [getConfig, loadTick]);

      // 加载可用 provider 目录；provider 变化时加载其模型列表。
      React.useEffect(() => {
        let current = true;
        Promise.resolve().then(() => listProviders()).then((list) => { if (current) setProviders(list || []); }).catch(() => {});
        return () => { current = false; };
      }, [listProviders, loadTick]);
      React.useEffect(() => {
        let current = true;
        if (!cfg?.provider) { setModels([]); return () => { current = false; }; }
        setModels(null);
        Promise.resolve().then(() => listModels({ provider: cfg.provider })).then((list) => { if (current) setModels(list || []); }).catch(() => { if (current) setModels([]); });
        return () => { current = false; };
      }, [listModels, cfg?.provider, loadTick]);

      if (loading) return S.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "正在读取心跳配置…" });
      if (error || !cfg) return S.jsxs("div", { children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: "读取配置失败" }),
        S.jsx("button", { onClick: () => { setError(false); setLoading(true); setLoadTick((t) => t + 1); }, children: "重试" }),
      ] });

      const writable = cfg.writable;
      const set = (field, v) => setCfg((c) => ({ ...c, [field]: v }));

      const save = () => {
        Promise.resolve().then(() => setConfig({
          enabled: !!cfg.enabled, intervalSec: cfg.intervalSec, workspace: cfg.workspace,
          quietStart: cfg.quietStart, quietEnd: cfg.quietEnd, provider: cfg.provider, model: cfg.model,
          prompt: typeof cfg.prompt === "string" ? cfg.prompt : "",
        })).then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); }).catch((e) => console.error("heartbeat save failed", e));
      };

      return S.jsxs("div", { style: { maxWidth: 640, fontFamily: "inherit", fontSize: 14, lineHeight: 1.6 }, children: [
        S.jsx("p", { style: { color: "var(--dsw-alias-label-secondary)", margin: "0 0 12px" },
          children: "心跳：定期触发法塔依工作区 HEARTBEAT.md 检查，由法塔决定是否主动发送 iMessage。每次心跳使用独立会话，完成后自动归档。" }),
        S.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: writable ? "pointer" : "default", marginBottom: 6 }, children: [
          S.jsx("input", { type: "checkbox", checked: !!cfg.enabled, disabled: !writable, onChange: (e) => set("enabled", e.target.checked) }),
          S.jsx("span", { children: "启用心跳" }),
        ] }),
        S.jsx(NumField, { label: "心跳间隔（秒）", value: cfg.intervalSec, min: 30, onChange: (v) => set("intervalSec", v), disabled: !writable, hint: "每 N 秒检查一次该不该心跳" }),
        S.jsxs("div", { style: { margin: "10px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
          S.jsx("label", { style: { flex: "0 0 180px", fontWeight: 500 }, children: "心跳工作区路径" }),
          S.jsx("input", { value: cfg.workspace, disabled: !writable, onChange: (e) => set("workspace", e.target.value),
            style: { flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)" } }),
        ] }),
        S.jsx(NumField, { label: "静默时段开始（时）", value: cfg.quietStart, min: 0, max: 23, onChange: (v) => set("quietStart", v), disabled: !writable }),
        S.jsx(NumField, { label: "静默时段结束（时）", value: cfg.quietEnd, min: 0, max: 23, onChange: (v) => set("quietEnd", v), disabled: !writable }),
        S.jsxs("div", { style: { margin: "10px 0", display: "flex", flexDirection: "column", gap: 6 }, children: [
          S.jsx("label", { style: { fontWeight: 500 }, children: "心跳提示词（留空用默认）" }),
          S.jsx("textarea", { value: cfg.prompt ?? "", disabled: !writable, rows: 4,
            onChange: (e) => set("prompt", e.target.value),
            placeholder: "默认：这次是心跳（heartbeat）。请读取当前工作区的 HEARTBEAT.md（如果存在），并严格按照其中的检查清单与发送要求执行。若无需发送：保持静默，仅回复 HEARTBEAT_OK。",
            style: { width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)", fontFamily: "inherit", fontSize: 13, resize: "vertical" } }),
          S.jsx("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 }, children: "自定义提示词会替代默认值；建议保留「读取 HEARTBEAT.md 并严格照做」的核心指令。" }),
        ] }),
        S.jsxs("div", { style: { margin: "10px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
          S.jsx("label", { style: { flex: "0 0 180px", fontWeight: 500 }, children: "Provider" }),
          S.jsx("select", { value: cfg.provider ?? "", disabled: !writable, onChange: (e) => { set("provider", e.target.value); set("model", ""); }, style: { flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)" }, children: [
            S.jsx("option", { value: "", children: "（全局默认）" }),
            ...providers.map((p) => S.jsx("option", { key: p.id, value: p.id, children: `${p.name} (${p.id})` })),
          ] }),
        ] }),
        S.jsxs("div", { style: { margin: "10px 0", display: "flex", alignItems: "center", gap: 10 }, children: [
          S.jsx("label", { style: { flex: "0 0 180px", fontWeight: 500 }, children: "模型" }),
          S.jsx("select", { value: cfg.model ?? "", disabled: !writable || !cfg.provider, onChange: (e) => set("model", e.target.value), style: { flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)" }, children: [
            S.jsx("option", { value: "", children: "（全局默认）" }),
            ...(models || []).map((m) => S.jsx("option", { key: m.id, value: m.id, children: m.name })),
          ] }),
        ] }),
        S.jsxs("div", { style: { marginTop: 16, display: "flex", gap: 8 }, children: [
          S.jsx("button", { type: "button", disabled: !writable, onClick: save, style: { padding: "6px 14px", borderRadius: 8, fontWeight: 500, cursor: writable ? "pointer" : "default" }, children: saved ? "✓ 已保存" : "保存" }),
          S.jsx("button", { type: "button", onClick: () => { setTriggering(true); Promise.resolve().then(() => trigger()).then(() => { setTriggering(false); setTriggered(true); setTimeout(() => setTriggered(false), 3000); }).catch(() => setTriggering(false)); }, style: { padding: "6px 14px", borderRadius: 8, cursor: "pointer" }, children: triggeringText(triggering) }),
          S.jsx("button", { type: "button", onClick: () => setLoadTick((t) => t + 1), style: { padding: "6px 14px", borderRadius: 8, cursor: "pointer" }, children: "放弃修改" }),
        ] }),
        S.jsxs("div", { style: { marginTop: 10 }, children: [
          S.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)", margin: 0 }, children: triggered ? "已触发一次心跳，可在会话列表/归档中观察。" : "心跳：正则按间隔触发；「立即心跳」可手动触发一次（法塔按 HEARTBEAT.md 决策是否发送）。" }),
        ] }),
      ] });
    }
    function triggeringText(busy) { return busy ? "触发电…" : "立即心跳一次"; }

    const inject = ["slots", "remote"];

    function apply(ctx) {
      const mount = ctx.remote.$mount(CONTRIBUTION);
      const callRemote = async (method, ...args) => {
        await mount;
        const remote = ctx.get("remote.heartbeat");
        const result = await remote[method](...args);
        if (!result || !result.ok) throw new Error(`heartbeat.${method} failed`);
        return result.value;
      };
      const getConfig = () => callRemote("getConfig");
      const listProviders = () => callRemote("listProviders");
      const listModels = (payload) => callRemote("listModels", payload);
      const setConfig = (payload) => callRemote("setConfig", payload);
      const trigger = () => callRemote("trigger");
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "heartbeat", order: 25, label: () => "心跳", inject: () => ({ getConfig, setConfig, trigger, listProviders, listModels }) },
        HeartbeatSection,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
