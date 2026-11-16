import { useEffect, useState } from "react";
import { canRecord, effectiveEnd, eventPhase } from "./model";
import type { Snapshot } from "./model";
const reasons: Record<string, string> = {
  startup: "启动",
  timer: "自动检查",
  focus: "窗口聚焦",
  midnight: "本地午夜",
  manual: "手动刷新",
  operation: "保存操作",
  debug: "模拟切换",
  "debug-request": "调试请求",
};
const localTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
function shift(date: string, days: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
export default function DateDebugPanel({
  data,
  disabled,
  onDate,
  refresh,
}: {
  data: Snapshot;
  disabled: boolean;
  onDate: (date: string | null) => Promise<boolean>;
  refresh: () => void;
}) {
  const [date, setDate] = useState(data.today);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => setDate(data.today), [data.today]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const clock = data.clock;
  const events = data.items.filter((i) => i.event);
  return (
    <section id="date-debug-panel" className="date-debug-panel" aria-label="日期调试面板">
      <div className="debug-heading">
        <div>
          <p className="eyebrow">DATE MONITOR</p>
          <h2>日期调试</h2>
        </div>
        <span className={`badge ${clock.simulated ? "debug-mode-badge" : ""}`}>
          {clock.simulated ? "模拟模式 · 独立数据" : "系统日期 · 真实记录"}
        </span>
      </div>
      <div className="debug-clock-grid">
        <div>
          <span>系统日期（后端）</span>
          <strong>{clock.systemDate}</strong>
        </div>
        <div>
          <span>应用当前日期</span>
          <strong>{data.today}</strong>
        </div>
        <div>
          <span>本机现在</span>
          <strong>{now.toLocaleTimeString("zh-CN", { hour12: false })}</strong>
        </div>
      </div>
      <p className="debug-check-info">
        上次检查：{localTime(clock.checkedAt)} ·{" "}
        {reasons[clock.reason] ?? clock.reason} · 共 {clock.checks} 次
      </p>
      <form
        className="debug-date-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onDate(date);
        }}
      >
        <label htmlFor="debug-date">模拟日期</label>
        <div>
          <input
            id="debug-date"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={disabled}
            required
          />
          <button
            type="submit"
            className="primary"
            disabled={disabled || !date}
          >
            {clock.simulated ? "应用模拟日期" : "进入模拟模式"}
          </button>
        </div>
      </form>
      <div className="debug-actions">
        <button
          className="secondary"
          disabled={disabled || data.today <= "0001-01-01"}
          onClick={() => void onDate(shift(data.today, -1))}
        >
          前一天
        </button>
        <button
          className="secondary"
          disabled={disabled || data.today >= "9999-12-31"}
          onClick={() => void onDate(shift(data.today, 1))}
        >
          后一天
        </button>
        <button className="secondary" disabled={disabled} onClick={refresh}>
          立即检查
        </button>
        <button
          className="secondary"
          disabled={disabled || !clock.simulated}
          onClick={() => void onDate(null)}
        >
          恢复系统日期
        </button>
      </div>
      <p className="debug-help">
        打开面板后每 5
        秒检查，窗口聚焦和本地午夜也会检查。模拟日期由后端统一生效，影响记录与事件判断，不修改电脑时间。
      </p>
      <p className="debug-help">
        首次模拟会复制真实数据到测试目录，后续沿用测试副本。模拟写入仅保存在该目录；恢复系统日期会回到真实记录，重启也会退出模拟。
      </p>
      <p className="debug-folder">当前目录：{data.folder}</p>
      <details className="debug-events" open>
        <summary>事件观察（{events.length}）</summary>
        {events.length ? (
          <div className="debug-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>事件</th>
                  <th>起始</th>
                  <th>结束</th>
                  <th>状态</th>
                  <th>今天可记录</th>
                </tr>
              </thead>
              <tbody>
                {events.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.event!.startDate}</td>
                    <td>{effectiveEnd(item) ?? "未设置"}</td>
                    <td>{eventPhase(item, data.today).label}</td>
                    <td>{canRecord(item, data.today) ? "是" : "否"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            当前目录中还没有事件，可创建事件后观察起止日期的变化。
          </p>
        )}
      </details>
      <details className="debug-changes" open>
        <summary>日期变化日志（最近 50 条）</summary>
        <ul aria-label="日期变化日志">
          {clock.changes.map((change, index) => (
            <li key={`${change.at}-${index}`}>
              <time>{localTime(change.at)}</time>
              <strong>
                {change.kind === "mode"
                  ? "模式切换"
                  : change.kind === "system"
                    ? "系统日期变化"
                    : "应用日期变化"}
              </strong>
              <span>
                {change.from} → {change.to}
              </span>
              <small>{reasons[change.reason] ?? change.reason}</small>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
