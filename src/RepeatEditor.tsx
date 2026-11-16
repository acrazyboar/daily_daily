import type { RepeatRule } from "./model";
export default function RepeatEditor({
  rule,
  onChange,
  today,
  minimumDate,
  editing,
}: {
  rule: RepeatRule;
  onChange: (rule: RepeatRule) => void;
  today: string;
  minimumDate: string;
  editing: boolean;
}) {
  const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
  return (
    <section className="repeat-editor" aria-label="重复设置">
      <label htmlFor="repeat-kind">重复（Repeat）</label>
      <select
        id="repeat-kind"
        value={rule.kind}
        onChange={(e) => {
          const kind = e.target.value;
          onChange(
            kind === "weekly"
              ? { kind, weekdays: [1, 2, 3, 4, 5] }
              : kind === "monthly"
                ? { kind, days: [Number(today.slice(8)) || 1] }
                : kind === "once"
                  ? { kind, date: today }
                  : { kind: "daily" },
          );
        }}
      >
        <option value="daily">每天</option>
        <option value="weekly">每周指定星期</option>
        <option value="monthly">每月指定日期</option>
        <option value="once">固定日期 · 仅一次</option>
      </select>
      {rule.kind === "daily" && (
        <p className="muted">每天都可以记录，新的一天会显示当天的打卡。</p>
      )}
      {rule.kind === "weekly" && (
        <>
          <div className="repeat-weekdays">
            {weekdays.map((day, index) => {
              const value = index + 1;
              const selected = rule.weekdays.includes(value);
              return (
                <label key={day} className={selected ? "repeat-selected" : ""}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() =>
                      onChange({
                        kind: "weekly",
                        weekdays: selected
                          ? rule.weekdays.filter((d) => d !== value)
                          : [...rule.weekdays, value].sort((a, b) => a - b),
                      })
                    }
                  />
                  周{day}
                </label>
              );
            })}
          </div>
          <p className="muted">
            只在勾选的星期显示，无需打卡的日期不会计作漏填。
          </p>
        </>
      )}
      {rule.kind === "monthly" && (
        <>
          <div
            className="repeat-month-days"
            role="group"
            aria-label="每月打卡日期"
          >
            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
              <button
                type="button"
                key={day}
                aria-label={`每月 ${day} 日`}
                aria-pressed={rule.days.includes(day)}
                onClick={() =>
                  onChange({
                    kind: "monthly",
                    days: rule.days.includes(day)
                      ? rule.days.filter((d) => d !== day)
                      : [...rule.days, day].sort((a, b) => a - b),
                  })
                }
              >
                {day}
              </button>
            ))}
          </div>
          <p className="muted">
            每月只在所选日期显示；没有该日期的月份会跳过，例如 2 月没有 30 日和
            31 日。
          </p>
        </>
      )}
      {rule.kind === "once" && (
        <>
          <label htmlFor="repeat-once-date">打卡日期</label>
          <input
            id="repeat-once-date"
            type="date"
            min={minimumDate}
            value={rule.date}
            onChange={(e) => onChange({ kind: "once", date: e.target.value })}
            required
          />
          <p className="muted">只在这个日期显示一次，之后不会每天重新出现。</p>
        </>
      )}
      {editing && (
        <p className="repeat-history-hint">
          重复规则的调整从今天开始生效，之前的计划和记录保留。
        </p>
      )}
    </section>
  );
}
