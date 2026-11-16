import StorageSettings from "./StorageSettings";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

import FocusEditor from "./FocusEditor";
import YearOverview from "./YearOverview";
import EventManager from "./EventManager";
import DateDebugPanel from "./DateDebugPanel";
import EventTimeline from "./EventTimeline";
import HistoryDetail from "./HistoryDetail";
import ExtraCheckInPanel from "./ExtraCheckInPanel";
import ScheduleExceptionControls from "./ScheduleExceptionControls";
import {
  canRecord,
  isSkipped,
  isExtra,
  repeatOn,
  isScheduled,
  repeatLabel,
  effectiveEnd,
  eventPhase,
  missingLabel,
  quality,
  tone,
} from "./model";
import type { Entry, Focus, Snapshot, ExceptionAction } from "./model";

const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDate = (s: string) => new Date(`${s}T12:00:00`);
const prettyDate = (s: string) =>
  parseDate(s).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

function EntryCard({
  item,
  entry,
  disabled,
  save,
  today,
  onManageEvent,
  onException,
}: {
  item: Focus;
  today: string;
  onManageEvent?: () => void;
  onException?: (action: ExceptionAction) => Promise<boolean>;
  entry?: Entry;
  disabled: boolean;
  save: (status: string, note: string) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<string>(entry?.status ?? "");
  const [note, setNote] = useState(entry?.note ?? "");
  useEffect(() => {
    setStatus(entry?.status ?? "");
    setNote(entry?.note ?? "");
  }, [entry?.updatedAt]);
  const selectedState = item.states.some((s) => s.id === status) ? status : "";
  const selectedIndex = item.states.findIndex((s) => s.id === selectedState);
  const dirty =
    selectedState !== entry?.status ||
    note !== (entry?.note ?? "") ||
    (!!entry &&
      selectedIndex >= 0 &&
      (item.states[selectedIndex].label !== entry.statusLabel ||
        Math.abs(
          quality(selectedIndex, item.states.length, item.bestFirst) -
            entry.quality,
        ) > 0.000001));
  return (
    <section className="entry-card">
      <div className="card-heading">
        <h2>{item.name}</h2>
        <span className="badge" style={entry ? tone(entry.quality) : undefined}>
          {entry ? `已记录 · ${entry.statusLabel}` : "今天还没记录"}
        </span>
      </div>
      {!item.event && (
        <p className="entry-repeat-summary">
          {repeatLabel(item, today)}
          {isExtra(item, today) ? " · 本次额外添加" : ""}
          {!isScheduled(item, today) && entry ? " · 今天已有的记录保留" : ""}
        </p>
      )}
      {item.event && (
        <div className="entry-event-info">
          <span className="badge">事件 · {eventPhase(item, today).label}</span>
          <p>{item.event.description}</p>
          <small>
            {item.event.startDate} 开始 ·{" "}
            {effectiveEnd(item)
              ? `${effectiveEnd(item)} 结束（含当天）`
              : "持续记录，直到手动结束"}
          </small>
          <button type="button" className="folder-link" onClick={onManageEvent}>
            管理事件 / 结束或延期 →
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (selectedState) void save(selectedState, note);
        }}
      >
        <fieldset disabled={disabled}>
          <legend>今天的情况</legend>
          <div className="status-options">
            {item.states.map((s, index) => (
              <label
                key={s.id}
                className={`status-choice ${selectedState === s.id ? "chosen" : ""}`}
                style={
                  selectedState === s.id
                    ? tone(quality(index, item.states.length, item.bestFirst))
                    : undefined
                }
              >
                <input
                  type="radio"
                  name={`status-${item.id}`}
                  value={s.id}
                  checked={selectedState === s.id}
                  onChange={() => setStatus(s.id)}
                />
                <span
                  className="choice-dot"
                  style={tone(
                    quality(index, item.states.length, item.bestFirst),
                  )}
                />
                {s.label}
              </label>
            ))}
          </div>
          <label htmlFor={`note-${item.id}`}>
            补充记录<span>选填 · 最多 2000 字</span>
          </label>
          <textarea
            id={`note-${item.id}`}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`记录一下今天的${item.name}，比如具体情况、原因或感受……`}
          />
          <div className="form-bottom">
            <span className="muted">
              {entry
                ? `上次保存 ${new Date(entry.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
                : "选择状态后保存，每项独立记录"}
            </span>
            <button
              className="primary"
              type="submit"
              disabled={disabled || !selectedState || !dirty}
            >
              {entry ? (dirty ? "保存修改" : "已保存") : "保存记录"}
            </button>
          </div>
        </fieldset>
      </form>
      {!item.event && onException && (
        <ScheduleExceptionControls
          item={item}
          date={today}
          entry={entry}
          disabled={disabled}
          change={onException}
        />
      )}
    </section>
  );
}
function App() {
  const [page, setPage] = useState<"today" | "overview" | "manage" | "events" | "storage">(
    "today",
  );
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [storagePending, setStoragePending] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [debugOpen, setDebugOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState("");
  const [confirmId, setConfirmId] = useState("");
  const [filter, setFilter] = useState("all");
  const [scope, setScope] = useState<"all" | "focus" | "events">("all");
  const [view, setView] = useState<"month" | "year">("month");
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [selected, setSelected] = useState<{ id: string; date: string } | null>(
    null,
  );
  const mutating = useRef(false);
  const revision = useRef(0);
  const lastSnapshot = useRef<Snapshot | null>(null);
  const applySnapshot = useCallback((value: Snapshot) => {
    const previous = lastSnapshot.current;
    if (
      !previous ||
      previous.today !== value.today ||
      previous.clock?.simulated !== value.clock?.simulated
    ) {
      const target = parseDate(value.today);
      setMonth((current) =>
        !previous ||
        previous.clock?.simulated !== value.clock?.simulated ||
        dateKey(current).slice(0, 7) === previous.today.slice(0, 7)
          ? new Date(target.getFullYear(), target.getMonth(), 1)
          : current,
      );
    }
    lastSnapshot.current = value;
    setData(value);
  }, []);
  const refresh = useCallback(
    async (reason = "manual") => {
      if (mutating.current) return;
      const ticket = ++revision.current;
      if (reason === "startup" || reason === "manual") setLoading(true);
      try {
        const value = await invoke<Snapshot>("load_check_ins", { reason });
        if (ticket === revision.current) {
          const old = lastSnapshot.current;
          if (old?.storageRevision && old.folder === value.folder && old.storageRevision !== value.storageRevision && reason !== "manual" && old.clock?.simulated === value.clock?.simulated) {
            setExternalChange(true);
            return;
          }
          if (reason === "manual" && old?.storageRevision !== value.storageRevision) setReloadKey(k => k + 1);
          setExternalChange(false);
          applySnapshot(value);
          setError("");
        }
      } catch (e) {
        if (ticket === revision.current) setError(String(e));
      } finally {
        if (ticket === revision.current) setLoading(false);
      }
    },
    [applySnapshot],
  );
  useEffect(() => {
    void refresh("startup");
    const focus = () => void refresh("focus");
    window.addEventListener("focus", focus);
    let midnightTimer: number;
    const armMidnight = () => {
      const now = new Date();
      const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        0,
        150,
      );
      midnightTimer = window.setTimeout(() => {
        void refresh("midnight");
        armMidnight();
      }, next.getTime() - now.getTime());
    };
    armMidnight();
    return () => {
      window.removeEventListener("focus", focus);
      window.clearTimeout(midnightTimer);
    };
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(
      () => void refresh("timer"),
      debugOpen ? 5000 : 60000,
    );
    return () => window.clearInterval(timer);
  }, [refresh, debugOpen]);
  async function action(
    command: string,
    args: Record<string, unknown>,
    success: string,
  ): Promise<boolean> {
    if (mutating.current) return false;
    mutating.current = true;
    ++revision.current;
    setBusy(true);
    setLoading(false);
    setError("");
    setMessage("");
    try {
      const value = await invoke<Snapshot>(command, {
        ...args,
        clockGeneration: lastSnapshot.current?.clock?.generation ?? 0,
        expectedRevision: lastSnapshot.current?.storageRevision ?? "",
      });
      applySnapshot(value);
      setExternalChange(false);
      if (command === "set_debug_date" || command === "confirm_storage_folder") {
        if(command === "set_debug_date") setPage("today");
        setEditingId("");
        setConfirmId("");
        setSelected(null);
        setFilter("all");
        setScope("all");
        const target = parseDate(value.today);
        setMonth(new Date(target.getFullYear(), target.getMonth(), 1));
      }
      setMessage(success);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  const today = data?.today ?? dateKey(new Date());
  const items = data?.items ?? [];
  const records = data?.records ?? [];
  const focusItems = items.filter((i) => !i.event);
  const active = focusItems.filter((i) => !i.archived);
  const dailyFocus = active.filter(
    (i) =>
      !isSkipped(i, today) &&
      (canRecord(i, today) ||
        records.some((r) => r.itemId === i.id && r.date === today)),
  );
  const skippedToday = active.filter((i) => isSkipped(i, today));
  const hasExtraCandidates = active.some((i) =>
    ["weekly", "monthly"].includes(repeatOn(i, today).kind),
  );
  const changeException = (item: Focus, date: string, kind: ExceptionAction) =>
    action(
      "set_check_in_exception",
      {
        itemId: item.id,
        date,
        action: kind,
        expectedSkipped: isSkipped(item, date),
        expectedExtra: isExtra(item, date),
      },
      `「${item.name}」${date} ${kind === "skip" ? "已跳过，原记录保留" : kind === "unskip" ? "已撤销跳过" : kind === "add" ? "已额外添加一次" : "已取消额外添加"}。`,
    );
  const openRecordDate = (id: string, date: string) => {
    const value = parseDate(date);
    setMonth(new Date(value.getFullYear(), value.getMonth(), 1));
    setSelected({ id, date });
    setFilter(id);
    setScope("focus");
    setView("month");
    setPage("overview");
  };
  const dailyEvents = items.filter((i) => i.event && canRecord(i, today));
  const dailyItems = [...dailyFocus, ...dailyEvents];
  const filterItems = items.filter(
    (i) => scope === "all" || (scope === "events" ? !!i.event : !i.event),
  );
  const recorded = dailyItems.filter((i) =>
    records.some((r) => r.itemId === i.id && r.date === today),
  ).length;
  const monthKey = dateKey(month).slice(0, 7);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const periodKey = view === "year" ? String(month.getFullYear()) : monthKey;
  const end = view === "year" ? `${periodKey}-12-31` : `${monthKey}-${days}`;
  const periodEntries = records.filter((r) => r.date.startsWith(periodKey));
  const periodStart =
    view === "year" ? `${periodKey}-01-01` : `${periodKey}-01`;
  const relevant = filterItems.filter(
    (i) =>
      (!i.archived &&
        (i.event
          ? i.event.startDate <= end &&
            (effectiveEnd(i) ?? today) >= periodStart &&
            i.event.startDate <= (effectiveEnd(i) ?? today)
          : i.createdOn <= end)) ||
      periodEntries.some((r) => r.itemId === i.id),
  );
  const shown = relevant.filter((i) => filter === "all" || i.id === filter);
  const visibleRecords = periodEntries.filter((r) =>
    shown.some((i) => i.id === r.itemId && !isSkipped(i, r.date)),
  );
  const entryMap = new Map(records.map((r) => [`${r.itemId}:${r.date}`, r]));
  const selection =
    selected &&
    shown.some((i) => i.id === selected.id) &&
    selected.date.startsWith(periodKey)
      ? selected
      : shown.length
        ? {
            id: shown[0].id,
            date: today.startsWith(periodKey)
              ? today
              : view === "year"
                ? `${periodKey}-01-01`
                : `${periodKey}-01`,
          }
        : null;
  const selectedItem = items.find((i) => i.id === selection?.id);
  const selectedEntry = selection
    ? entryMap.get(`${selection.id}:${selection.date}`)
    : undefined;
  function moveMonth(delta: number) {
    setMonth(
      new Date(
        month.getFullYear() + (view === "year" ? delta : 0),
        month.getMonth() + (view === "month" ? delta : 0),
        1,
      ),
    );
    setSelected(null);
  }
  async function openFolder() {
    try {
      await invoke("open_records_folder");
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">日</span>
          <div>
            日日记<small>把关注，变成日常。</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {(
            [
              { id: "today", icon: "◉", label: "今日" },
              { id: "overview", icon: "▦", label: "概览" },
            ] as const
          ).map((p) => (
            <button
              key={p.id}
              className={`nav ${page === p.id ? "active" : ""}`}
              aria-current={page === p.id ? "page" : undefined}
              onClick={() => {
                setPage(p.id);
                setMessage("");
              }}
            >
              <span aria-hidden="true">{p.icon}</span>
              {p.label}
            </button>
          ))}
          <div className="nav-management">
            <button
              className={`nav nav-parent ${page === "manage" || page === "events" || page === "storage" ? "active" : ""}`}
              onClick={() => {
                setPage("manage");
                setMessage("");
              }}
            >
              <span aria-hidden="true">⚙</span>管理
            </button>
            <div className="nav-subitems" role="group" aria-label="管理子项">
              {(
                [
                  { id: "manage", label: "打卡" },
                  { id: "events", label: "事件" },
                  { id: "storage", label: "数据存储" },
                ] as const
              ).map((p) => (
                <button
                  key={p.id}
                  className={`nav-subitem ${page === p.id ? "active" : ""}`}
                  aria-current={page === p.id ? "page" : undefined}
                  onClick={() => {
                    setPage(p.id);
                    setMessage("");
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </nav>
        <div className="sidebar-bottom">
          <button
            className="debug-toggle"
            aria-expanded={debugOpen}
            onClick={() => {
              setDebugOpen(!debugOpen);
              if (!debugOpen) void refresh();
            }}
          >
            ⌁ {debugOpen ? "收起日期调试" : "日期调试"}
          </button>
          <span className="local-dot" />
          {data?.clock?.simulated ? "模拟记录（独立目录）" : "记录保存在数据文件夹"}
          <button className="folder-link" onClick={openFolder}>
            打开记录文件夹 ↗
          </button>
          <p className="folder-path" title={data?.folder}>
            {data?.folder ?? "正在读取存储位置…"}
          </p>
        </div>
      </aside>
      <main
        key={`${data?.clock?.simulated ? "debug" : "live"}:${data?.clock?.generation ?? 0}:${reloadKey}`}
      >
        <header>
          <div>
            <p className="eyebrow">
              DAILY LOG /{" "}
              {page === "manage"
                ? "管理 / 打卡"
                : page === "events"
                  ? "管理 / 事件"
                  : page === "storage" ? "管理 / 数据存储" : page.toUpperCase()}
            </p>
            <h1>
              {page === "today"
                ? "今天，照顾好每一件小事。"
                : page === "overview"
                  ? "每个关注点，都有自己的轨迹。"
                  : page === "events"
                    ? "每一段经历，都值得被记录。"
                    : page === "storage" ? "让记录，跟着你。" : "把在意的事，放进日常。"}
            </h1>
            <p className="subtitle">
              {page === "today"
                ? prettyDate(today)
                : page === "overview"
                  ? view === "month"
                    ? "长期关注按天展示，事件以连续时间条展示。点击可查看记录。"
                    : "回看全年：长期关注使用日格，事件使用连续时间条。"
                  : page === "events"
                    ? "为短期的事设定起止日期，每天留下进展，结束后保留回忆。"
                    : page === "storage" ? "管理数据位置，连接你的 iCloud Drive 文件夹。" : "添加你想关注的内容；移除后保留历史，也可以随时恢复。"}
            </p>
          </div>
          <button
            className="secondary"
            disabled={loading || busy || storagePending}
            onClick={() => void refresh()}
          >
            {loading ? "读取中…" : "刷新记录"}
          </button>
        </header>
        {(page === "manage" || page === "events" || page === "storage") && (
          <div className="management-tabs" role="group" aria-label="管理分类">
            <button
              aria-pressed={page === "manage"}
              onClick={() => {
                setPage("manage");
                setMessage("");
              }}
            >
              打卡
            </button>
            <button
              aria-pressed={page === "events"}
              onClick={() => {
                setPage("events");
                setMessage("");
              }}
            >
              事件
            </button>
            <button aria-pressed={page === "storage"} onClick={() => { setPage("storage"); setMessage(""); }}>数据存储</button>
          </div>
        )}
        {externalChange && <div className="debug-mode-notice" role="alert">数据文件已被外部修改，尚未替换当前表单。请先复制未保存的内容，再点击“刷新记录”载入最新数据。</div>}
        {page === "storage" && <StorageSettings data={data} disabled={busy || storagePending} change={action} onPending={(v) => { setStoragePending(v); mutating.current = v; }} />}
        {data?.clock?.simulated && (
          <div className="debug-mode-notice" role="status">
            正在使用模拟日期 <strong>{data.today}</strong> ·
            所有修改写入测试副本
            <button
              disabled={busy || loading}
              onClick={() =>
                void action(
                  "set_debug_date",
                  { date: null },
                  "已恢复系统日期和真实记录。",
                )
              }
            >
              退出模拟
            </button>
          </div>
        )}
        {debugOpen && data?.clock && (
          <DateDebugPanel
            data={data}
            disabled={busy || loading}
            refresh={() => void refresh()}
            onDate={(date) =>
              action(
                "set_debug_date",
                { date },
                date
                  ? `已切换到模拟日期 ${date}，当前使用测试副本。`
                  : "已恢复系统日期和真实记录。",
              )
            }
          />
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {message && (
          <div className="notice success" role="status">
            {message}
          </div>
        )}
        {page === "today" && (
          <>
            <div className="daily-progress">
              <div>
                <strong>
                  {recorded}
                  <span> / {dailyItems.length}</span>
                </strong>
                <span> 个内容已记录</span>
              </div>
              <div className="daily-links">
                {hasExtraCandidates && (
                  <button
                    className="secondary"
                    disabled={busy || loading}
                    onClick={() => setExtraOpen(!extraOpen)}
                  >
                    ＋ 额外添加一次
                  </button>
                )}
                <button className="secondary" onClick={() => setPage("manage")}>
                  管理
                </button>
                <button className="secondary" onClick={() => setPage("events")}>
                  事件 →
                </button>
              </div>
            </div>
            {extraOpen && (
              <ExtraCheckInPanel
                items={active}
                today={today}
                disabled={busy || loading}
                close={() => setExtraOpen(false)}
                openDate={openRecordDate}
                add={(item, date) => changeException(item, date, "add")}
              />
            )}
            {skippedToday.length > 0 && (
              <section className="skipped-today" aria-label="今日已跳过">
                <h2>
                  今日已跳过 <small>{skippedToday.length}</small>
                </h2>
                {skippedToday.map((item) => (
                  <div key={item.id}>
                    <span>
                      {item.name}
                      {records.some(
                        (r) => r.itemId === item.id && r.date === today,
                      ) && <small> · 原记录保留</small>}
                    </span>
                    <button
                      className="secondary"
                      disabled={busy || loading}
                      onClick={() =>
                        void changeException(item, today, "unskip")
                      }
                    >
                      恢复今天
                    </button>
                  </div>
                ))}
              </section>
            )}
            {!dailyItems.length ? (
              <div className="empty-state">
                <div className="check-mark">＋</div>
                <h2>
                  {items.length ? "今天没有待记录的内容" : "从一件在意的事开始"}
                </h2>
                <p>
                  打卡项会按重复计划出现，事件会在有效日期内出现。你也可以在管理中添加新的内容。
                </p>
                <button
                  className="primary"
                  disabled={!data || loading}
                  onClick={() => setPage("manage")}
                >
                  {items.length ? "查看管理" : "添加第一个关注项"}
                </button>
              </div>
            ) : dailyFocus.length ? (
              <div className="entry-grid">
                {dailyFocus.map((item) => (
                  <EntryCard
                    key={`${today}:${item.id}`}
                    item={item}
                    today={today}
                    onException={(kind) => changeException(item, today, kind)}
                    entry={entryMap.get(`${item.id}:${today}`)}
                    disabled={busy || loading || !data}
                    save={(status, note) =>
                      action(
                        "save_check_in",
                        { itemId: item.id, status, note, expectedDate: today },
                        `「${item.name}」今天的记录已保存。`,
                      )
                    }
                  />
                ))}
              </div>
            ) : null}
            {dailyEvents.length > 0 && (
              <section className="daily-events">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">EVENTS / TODAY</p>
                    <h2>
                      今日事件 <small>{dailyEvents.length}</small>
                    </h2>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => setPage("events")}
                  >
                    管理事件 →
                  </button>
                </div>
                <div className="entry-grid">
                  {dailyEvents.map((item) => (
                    <EntryCard
                      key={`${today}:${item.id}`}
                      item={item}
                      today={today}
                      onManageEvent={() => setPage("events")}
                      entry={entryMap.get(`${item.id}:${today}`)}
                      disabled={busy || loading || !data}
                      save={(status, note) =>
                        action(
                          "save_check_in",
                          {
                            itemId: item.id,
                            status,
                            note,
                            expectedDate: today,
                          },
                          `「${item.name}」今天的事件记录已保存。`,
                        )
                      }
                    />
                  ))}
                </div>
              </section>
            )}
            <p className="footnote">
              每项独立记录。事件在起始日和结束日当天均可记录；以电脑本地日期为准。
            </p>
          </>
        )}
        {page === "events" && (
          <EventManager
            items={items}
            records={records}
            today={today}
            disabled={busy || loading || !data}
            action={action}
            goRecord={() => setPage("today")}
          />
        )}
        {page === "manage" && (
          <>
            <FocusEditor
              key={editingId || "new"}
              item={focusItems.find((i) => i.id === editingId)}
              today={today}
              disabled={busy || loading || !data}
              cancel={() => setEditingId("")}
              save={async (name, states, bestFirst, _details, repeat) => {
                const ok = await action(
                  editingId ? "update_focus_states" : "add_focus",
                  editingId
                    ? { itemId: editingId, states, bestFirst, repeat }
                    : { name, states, bestFirst, repeat },
                  editingId
                    ? "打卡设置已保存，之前的计划和记录保留。"
                    : "打卡项已添加，会在计划日期显示。",
                );
                if (ok && editingId) setEditingId("");
                return ok;
              }}
            />
            <section className="management-card">
              <h2>
                正在关注 <small>{active.length}</small>
              </h2>
              {!active.length && (
                <p className="muted">还没有关注项，在上方添加一个吧。</p>
              )}
              {active.map((item) => (
                <div className="manage-row" key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      开始于 {item.createdOn} · {item.states.length} 个状态
                    </small>
                    <p className="manage-repeat-summary">
                      {repeatLabel(item, today)}
                    </p>
                    <div className="state-swatches">
                      {item.states.map((state, index) => (
                        <span
                          key={state.id}
                          className="mini-state"
                          style={tone(
                            quality(index, item.states.length, item.bestFirst),
                          )}
                        >
                          {state.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  {confirmId === item.id ? (
                    <div className="remove-confirm">
                      <span>移除后保留历史记录</span>
                      <button
                        className="danger-link"
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await action(
                              "archive_focus",
                              { itemId: item.id, archived: true },
                              `已移除「${item.name}」，历史记录保留。`,
                            )
                          )
                            setConfirmId("");
                        }}
                      >
                        确认移除
                      </button>
                      <button
                        className="secondary"
                        onClick={() => setConfirmId("")}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <div className="manage-actions">
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(item.id);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        编辑
                      </button>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => setConfirmId(item.id)}
                      >
                        移除
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
            <section className="management-card">
              <h2>
                已移除{" "}
                <small>{focusItems.filter((i) => i.archived).length}</small>
              </h2>
              <p className="muted">
                这些内容不再出现在“今日”中。已有记录仍可在对应月份查看。
              </p>
              {focusItems
                .filter((i) => i.archived)
                .map((item) => (
                  <div className="manage-row" key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <small>
                        {records.filter((r) => r.itemId === item.id).length}{" "}
                        条历史记录
                      </small>
                    </div>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          "archive_focus",
                          { itemId: item.id, archived: false },
                          `已恢复「${item.name}」。`,
                        )
                      }
                    >
                      恢复关注
                    </button>
                  </div>
                ))}
            </section>
          </>
        )}
        {page === "overview" && (
          <>
            <div
              className="overview-view-switch"
              role="group"
              aria-label="概览范围"
            >
              <button
                aria-pressed={view === "month"}
                onClick={() => {
                  if (view === "year" && selection) {
                    const date = parseDate(selection.date);
                    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
                  }
                  setView("month");
                }}
              >
                月度
              </button>
              <button
                aria-pressed={view === "year"}
                onClick={() => setView("year")}
              >
                年度
              </button>
            </div>
            <div className="month-toolbar">
              <h2>
                {month.getFullYear()} 年
                {view === "month" ? ` ${month.getMonth() + 1} 月` : ""}
              </h2>
              <div className="month-controls">
                <button
                  aria-label={view === "month" ? "上个月" : "上一年"}
                  onClick={() => moveMonth(-1)}
                >
                  ‹
                </button>
                <button
                  onClick={() => {
                    const now = parseDate(today);
                    setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                    setSelected(null);
                  }}
                >
                  {view === "month" ? "本月" : "今年"}
                </button>
                <button
                  aria-label={view === "month" ? "下个月" : "下一年"}
                  onClick={() => moveMonth(1)}
                >
                  ›
                </button>
              </div>
            </div>
            <div className="overview-date-jump">
              <label htmlFor="overview-date">定位日期</label>
              <input
                id="overview-date"
                type="date"
                value={selection?.date ?? today}
                onChange={(e) => {
                  const date = e.target.value;
                  if (!date) return;
                  const target = parseDate(date);
                  setMonth(
                    new Date(target.getFullYear(), target.getMonth(), 1),
                  );
                  const item = selectedItem ?? filterItems[0];
                  setSelected(item ? { id: item.id, date } : null);
                }}
              />
              <span className="muted">
                选择日期可修改历史记录，也可提前安排跳过或额外打卡。
              </span>
            </div>
            <div className="overview-filter">
              <label htmlFor="overview-scope">内容范围</label>
              <select
                id="overview-scope"
                value={scope}
                onChange={(e) => {
                  const next = e.target.value as "all" | "focus" | "events";
                  setScope(next);
                  setFilter("all");
                  const candidates = items.filter(
                    (i) =>
                      next === "all" ||
                      (next === "events" ? !!i.event : !i.event),
                  );
                  const target =
                    candidates.find((i) => i.id === selection?.id) ??
                    candidates[0];
                  setSelected(
                    target
                      ? { id: target.id, date: selection?.date ?? today }
                      : null,
                  );
                }}
              >
                <option value="all">全部内容</option>
                <option value="focus">长期关注</option>
                <option value="events">事件</option>
              </select>
              <label htmlFor="focus-filter">查看内容</label>
              <select
                id="focus-filter"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  const target =
                    e.target.value === "all"
                      ? (selectedItem ?? filterItems[0])
                      : items.find((i) => i.id === e.target.value);
                  setSelected(
                    target
                      ? { id: target.id, date: selection?.date ?? today }
                      : null,
                  );
                }}
              >
                <option value="all">全部</option>
                {filterItems.map((i) => (
                  <option value={i.id} key={i.id}>
                    {i.event ? "事件 · " : ""}
                    {i.name}
                    {i.archived ? "（已移除）" : ""}
                  </option>
                ))}
              </select>
              <span className="muted">统计按“记录内容 × 日期”计算</span>
            </div>
            <div className="stats overview-stats">
              <div>
                <span>已记录</span>
                <strong>
                  {visibleRecords.length}
                  <small>条</small>
                </strong>
              </div>
              <div>
                <span>涉及内容</span>
                <strong>
                  {new Set(visibleRecords.map((r) => r.itemId)).size}
                  <small>个</small>
                </strong>
              </div>
              <div>
                <span>有记录的天数</span>
                <strong>
                  {new Set(visibleRecords.map((r) => r.date)).size}
                  <small>天</small>
                </strong>
              </div>
            </div>
            {shown.length ? (
              <>
                {view === "month" ? (
                  <section className="matrix-card">
                    <div
                      className="matrix-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label="月度内容记录表，可横向滚动"
                    >
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">记录内容 / 日期</th>
                            {Array.from({ length: days }, (_, i) => (
                              <th
                                key={i}
                                scope="col"
                                className={
                                  `${monthKey}-${String(i + 1).padStart(2, "0")}` ===
                                  today
                                    ? "date-today"
                                    : ""
                                }
                              >
                                {i + 1}
                              </th>
                            ))}
                            <th scope="col">记录数</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.map((item) => (
                            <tr key={item.id}>
                              <th scope="row">
                                {item.name}
                                {item.event && <small>事件</small>}
                                {item.archived && <small>已移除</small>}
                              </th>
                              {item.event ? (
                                <td
                                  colSpan={days}
                                  className="event-timeline-td"
                                >
                                  <EventTimeline
                                    item={item}
                                    records={periodEntries}
                                    start={`${monthKey}-01`}
                                    end={`${monthKey}-${days}`}
                                    today={today}
                                    selection={selection}
                                    onSelect={setSelected}
                                    scale="month"
                                  />
                                </td>
                              ) : (
                                Array.from({ length: days }, (_, i) => {
                                  const date = `${monthKey}-${String(i + 1).padStart(2, "0")}`;
                                  const entry = isSkipped(item, date)
                                    ? undefined
                                    : entryMap.get(`${item.id}:${date}`);
                                  const unavailable =
                                    !isScheduled(item, date) ||
                                    date > today ||
                                    date < item.createdOn ||
                                    (!!effectiveEnd(item) &&
                                      date > effectiveEnd(item)!);
                                  return (
                                    <td key={date}>
                                      <button
                                        className={`matrix-cell ${isSkipped(item, date) ? "skipped-day" : ""} ${unavailable && !entry ? "unavailable" : ""} ${selection?.id === item.id && selection.date === date ? "cell-selected" : ""}`}
                                        style={
                                          entry
                                            ? tone(entry.quality)
                                            : undefined
                                        }
                                        title={
                                          entry
                                            ? entry.statusLabel
                                            : missingLabel(item, date, today)
                                        }
                                        aria-label={`${item.name} ${date} ${entry ? entry.statusLabel : missingLabel(item, date, today)}`}
                                        aria-pressed={
                                          selection?.id === item.id &&
                                          selection.date === date
                                        }
                                        onClick={() =>
                                          setSelected({ id: item.id, date })
                                        }
                                      >
                                        {entry
                                          ? Array.from(entry.statusLabel)[0]
                                          : isSkipped(item, date)
                                            ? "↷"
                                            : unavailable
                                            ? "·"
                                            : "—"}
                                      </button>
                                    </td>
                                  );
                                })
                              )}
                              <td className="row-total">
                                {
                                  periodEntries.filter(
                                    (r) =>
                                      r.itemId === item.id &&
                                      !isSkipped(item, r.date),
                                  ).length
                                }
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="matrix-legend">
                      <span>
                        <i style={tone(0)}>差</i>较差
                      </span>
                      <span
                        className="gradient-bar"
                        aria-label="从红到绿渐变"
                      />
                      <span>
                        <i style={tone(1)}>好</i>较好
                      </span>
                      <span>
                        <i>↷</i>已跳过
                      </span>
                      <span>
                        <i>—</i>未记录
                      </span>
                      <span>
                        <i className="unavailable">·</i>无需打卡 / 未开始 /
                        已结束 / 未来
                      </span>
                    </div>
                    <div className="item-legends">
                      {shown.map((item) => (
                        <div key={item.id}>
                          <strong>{item.name}</strong>
                          <div className="state-swatches">
                            {item.states.map((state, index) => (
                              <span
                                key={state.id}
                                className="mini-state"
                                style={tone(
                                  quality(
                                    index,
                                    item.states.length,
                                    item.bestFirst,
                                  ),
                                )}
                              >
                                {state.label}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                      <p className="muted">
                        以上为当前状态配置。历史格子的名称和颜色保留记录当时的含义。
                      </p>
                    </div>
                  </section>
                ) : (
                  <YearOverview
                    year={month.getFullYear()}
                    items={shown}
                    records={visibleRecords}
                    today={today}
                    selection={selection}
                    onSelect={setSelected}
                  />
                )}
                {selection && selectedItem && (
                  <HistoryDetail
                    key={`${selection.id}:${selection.date}`}
                    item={selectedItem}
                    date={selection.date}
                    today={today}
                    entry={selectedEntry}
                    disabled={busy || loading}
                    changeException={(kind) =>
                      changeException(selectedItem, selection.date, kind)
                    }
                    save={(
                      status,
                      note,
                      keepOriginalStatus,
                      expectedUpdatedAt,
                    ) =>
                      action(
                        "save_history_check_in",
                        {
                          edit: {
                            itemId: selectedItem.id,
                            date: selection.date,
                            status,
                            note,
                            keepOriginalStatus,
                            expectedUpdatedAt,
                          },
                        },
                        `已保存「${selectedItem.name}」在 ${selection.date} 的记录。`,
                      )
                    }
                  />
                )}
              </>
            ) : (
              <div className="empty-state">
                <h2>{view === "month" ? "这个月" : "这一年"}还没有相关记录</h2>
                <p>可以切换时间、选择其他关注项，或者去添加一个新的关注项。</p>
                <button className="primary" onClick={() => setPage("manage")}>
                  管理
                </button>
              </div>
            )}
            <p className="footnote">
              {view === "month"
                ? "横向滚动可查看整个月。"
                : "年度视图展示全年每日记录，可切换年份。"}
              打卡项点击日格，事件点击时间条，可查看当天状态和备注。
            </p>
          </>
        )}
      </main>
    </div>
  );
}
export default App;
