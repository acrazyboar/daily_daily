use chrono::{Datelike, Local};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Focus {
    id: String,
    name: String,
    created_on: String,
    archived: bool,
    states: Vec<Choice>,
    best_first: bool,
    #[serde(default)]
    event: Option<EventInfo>,
    #[serde(default)]
    repeat_rules: Vec<RepeatVersion>,
    #[serde(default)]
    skipped_dates: Vec<String>,
    #[serde(default)]
    extra_dates: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum RepeatRule {
    #[default]
    Daily,
    Weekly {
        weekdays: Vec<u32>,
    },
    Monthly {
        days: Vec<u32>,
    },
    Once {
        date: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepeatVersion {
    from: String,
    rule: RepeatRule,
}
fn validate_repeat(rule: &RepeatRule) -> Result<(), String> {
    let valid = match rule {
        RepeatRule::Daily => true,
        RepeatRule::Weekly { weekdays } => {
            !weekdays.is_empty()
                && weekdays.iter().all(|d| (1..=7).contains(d))
                && weekdays
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == weekdays.len()
        }
        RepeatRule::Monthly { days } => {
            !days.is_empty()
                && days.iter().all(|d| (1..=31).contains(d))
                && days.iter().collect::<std::collections::HashSet<_>>().len() == days.len()
        }
        RepeatRule::Once { date } => valid_date(date),
    };
    if !valid {
        return Err("重复规则无效：请选择至少一个有效的星期、月内日期或固定日期。".into());
    }
    Ok(())
}
fn repeat_on(item: &Focus, date: &str) -> RepeatRule {
    item.repeat_rules
        .iter()
        .filter(|v| v.from.as_str() <= date)
        .max_by(|a, b| a.from.cmp(&b.from))
        .map(|v| v.rule.clone())
        .unwrap_or_default()
}
fn base_scheduled(item: &Focus, date: &str) -> bool {
    if item.event.is_some() {
        return true;
    }
    let Ok(parsed) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return false;
    };
    match repeat_on(item, date) {
        RepeatRule::Daily => true,
        RepeatRule::Weekly { weekdays } => {
            weekdays.contains(&parsed.weekday().number_from_monday())
        }
        RepeatRule::Monthly { days } => days.contains(&parsed.day()),
        RepeatRule::Once { date: fixed } => fixed == date,
    }
}
fn is_skipped(item: &Focus, date: &str) -> bool {
    item.event.is_none() && item.skipped_dates.iter().any(|d| d == date)
}
fn is_scheduled(item: &Focus, date: &str) -> bool {
    if item.event.is_some() {
        return true;
    }
    !is_skipped(item, date)
        && (item.extra_dates.iter().any(|d| d == date) || base_scheduled(item, date))
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ExceptionAction {
    Skip,
    Unskip,
    Add,
    RemoveAdd,
}
fn set_exception(
    store: &mut Store,
    id: &str,
    date: &str,
    action: ExceptionAction,
    expected_skipped: bool,
    expected_extra: bool,
) -> Result<(), String> {
    let has_record = store
        .records
        .iter()
        .any(|r| r.item_id == id && r.date == date);
    let item = store
        .items
        .iter_mut()
        .find(|i| i.id == id)
        .ok_or("找不到打卡项。")?;
    if item.event.is_some() {
        return Err("事件请使用起止日期管理。".into());
    }
    if !valid_date(date) || date < item.created_on.as_str() {
        return Err("请选择创建日期之后的有效日期（含创建当天）。".into());
    }
    let skipped = item.skipped_dates.iter().any(|d| d == date);
    let extra = item.extra_dates.iter().any(|d| d == date);
    if skipped != expected_skipped || extra != expected_extra {
        return Err("这一天的安排已变化，请刷新后再试。".into());
    }
    if item.archived && matches!(action, ExceptionAction::Skip | ExceptionAction::Add) {
        return Err("请先恢复这个打卡项，再调整日期安排。".into());
    }
    match action {
        ExceptionAction::Skip => {
            if !base_scheduled(item, date) && !extra && !has_record {
                return Err("这一天原本无需打卡。".into());
            }
            if !skipped {
                item.skipped_dates.push(date.into());
            }
        }
        ExceptionAction::Unskip => {
            item.skipped_dates.retain(|d| d != date);
        }
        ExceptionAction::Add => {
            if !matches!(
                repeat_on(item, date),
                RepeatRule::Weekly { .. } | RepeatRule::Monthly { .. }
            ) {
                return Err("仅每周或每月重复的打卡项支持额外添加。".into());
            }
            if base_scheduled(item, date) {
                return Err("这一天已在原计划中，无需额外添加；如已跳过，请恢复。".into());
            }
            if !extra {
                item.extra_dates.push(date.into());
            }
        }
        ExceptionAction::RemoveAdd => {
            if has_record {
                return Err("这一天已有记录，可以选择跳过，记录会保留。".into());
            }
            item.extra_dates.retain(|d| d != date);
        }
    }
    item.skipped_dates.sort();
    item.extra_dates.sort();
    Ok(())
}
#[tauri::command]
fn set_check_in_exception(
    app: tauri::AppHandle,
    item_id: String,
    date: String,
    action: ExceptionAction,
    expected_skipped: bool,
    expected_extra: bool,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    mutate(&app, &lock, clock_generation, |store, _today| {
        set_exception(
            store,
            &item_id,
            &date,
            action,
            expected_skipped,
            expected_extra,
        )
    })
}
fn update_repeat(
    store: &mut Store,
    id: &str,
    mut repeat: RepeatRule,
    date: &str,
) -> Result<(), String> {
    validate_repeat(&repeat)?;
    if let RepeatRule::Weekly { weekdays } = &mut repeat {
        weekdays.sort_unstable();
    }
    if let RepeatRule::Monthly { days } = &mut repeat {
        days.sort_unstable();
    }
    let item = store
        .items
        .iter_mut()
        .find(|i| i.id == id)
        .ok_or("找不到打卡项。")?;
    if item.event.is_some() {
        return Err("事件不使用打卡重复规则。".into());
    }
    if repeat_on(item, date) == repeat {
        return Ok(());
    }
    if let RepeatRule::Once { date: fixed } = &repeat {
        if fixed.as_str() < date {
            return Err("新的固定日期不能早于今天。".into());
        }
    }
    item.repeat_rules.retain(|v| v.from != date);
    item.repeat_rules.push(RepeatVersion {
        from: date.into(),
        rule: repeat,
    });
    item.repeat_rules.sort_by(|a, b| a.from.cmp(&b.from));
    Ok(())
}
fn validate_scheduled(item: &Focus, date: &str, has_record: bool) -> Result<(), String> {
    if is_skipped(item, date) {
        return Err("这一天已跳过，请先恢复再记录。".into());
    }
    if !has_record && !is_scheduled(item, date) {
        return Err("这一天不在该打卡项的重复计划内，无需打卡。".into());
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventInfo {
    description: String,
    start_date: String,
    end_date: Option<String>,
    ended_on: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventDraft {
    name: String,
    description: String,
    start_date: String,
    end_date: Option<String>,
    states: Vec<Choice>,
    best_first: bool,
}
fn event_recordable(event: &EventInfo, date: &str) -> bool {
    date >= event.start_date.as_str()
        && event.end_date.as_deref().is_none_or(|end| date <= end)
        && event.ended_on.as_deref().is_none_or(|end| date <= end)
}
fn validate_event(event: &EventInfo) -> Result<(), String> {
    if !valid_date(&event.start_date)
        || event.description.chars().count() > 2000
        || event
            .end_date
            .as_deref()
            .is_some_and(|end| !valid_date(end) || end < event.start_date.as_str())
        || event.ended_on.as_deref().is_some_and(|end| {
            !valid_date(end)
                || !event_recordable(
                    &EventInfo {
                        ended_on: None,
                        ..event.clone()
                    },
                    end,
                )
        })
    {
        return Err("事件日期无效：结束日期不能早于起始日期，简介最多 2000 字。".into());
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    id: String,
    label: String,
}
fn default_choices() -> Vec<Choice> {
    [("missed", "未完成"), ("partial", "一般"), ("done", "完成")]
        .into_iter()
        .map(|(id, label)| Choice {
            id: id.into(),
            label: label.into(),
        })
        .collect()
}
fn quality(index: usize, count: usize, best_first: bool) -> f64 {
    if count == 1 {
        return 0.5;
    }
    let value = index as f64 / (count - 1) as f64;
    if best_first { 1.0 - value } else { value }
}
fn validate_choices(states: &[Choice]) -> Result<(), String> {
    if states.is_empty() {
        return Err("请至少添加一个状态。".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut labels = std::collections::HashSet::new();
    for state in states {
        if state.id.trim().is_empty() || !ids.insert(&state.id) {
            return Err("状态标识无效或重复。".into());
        }
        if state.label.trim().is_empty()
            || state.label.chars().count() > 30
            || !labels.insert(state.label.trim())
        {
            return Err("状态名称需为 1–30 字，同一关注项内不能重名。".into());
        }
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Entry {
    item_id: String,
    date: String,
    status: String,
    status_label: String,
    quality: f64,
    note: String,
    updated_at: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Store {
    version: u32,
    items: Vec<Focus>,
    records: Vec<Entry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    today: String,
    folder: String,
    items: Vec<Focus>,
    records: Vec<Entry>,
    clock: ClockInfo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Legacy {
    date: String,
    created_at: String,
    note: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClockChange {
    at: String,
    kind: String,
    from: String,
    to: String,
    reason: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClockInfo {
    simulated: bool,
    system_date: String,
    system_time: String,
    checked_at: String,
    reason: String,
    checks: u64,
    generation: u64,
    changes: Vec<ClockChange>,
}
#[derive(Default)]
struct RuntimeState {
    date_override: Option<String>,
    previous_date: Option<String>,
    previous_system: Option<String>,
    checked_at: String,
    reason: String,
    checks: u64,
    generation: u64,
    changes: Vec<ClockChange>,
}
impl RuntimeState {
    fn date(&self) -> String {
        self.date_override.clone().unwrap_or_else(today)
    }
    fn log(&mut self, kind: &str, from: String, to: String, reason: &str) {
        self.changes.insert(
            0,
            ClockChange {
                at: Local::now().to_rfc3339(),
                kind: kind.into(),
                from,
                to,
                reason: reason.into(),
            },
        );
        self.changes.truncate(50);
    }
    fn observe(&mut self, reason: &str) {
        self.observe_dates(today(), self.date(), reason);
    }
    fn observe_dates(&mut self, system: String, effective: String, reason: &str) {
        self.checked_at = Local::now().to_rfc3339();
        self.reason = reason.into();
        self.checks += 1;
        if self
            .previous_system
            .as_ref()
            .is_some_and(|old| old != &system)
        {
            self.log(
                "system",
                self.previous_system.clone().unwrap(),
                system.clone(),
                reason,
            );
        }
        if self.previous_date.as_ref() != Some(&effective) {
            let old = self
                .previous_date
                .clone()
                .unwrap_or_else(|| "首次检查".into());
            if self.previous_date.is_some() {
                self.generation += 1;
            }
            self.log("date", old, effective.clone(), reason);
        }
        self.previous_system = Some(system);
        self.previous_date = Some(effective);
    }
    fn set_override(&mut self, date: Option<String>) {
        let old_mode = if self.date_override.is_some() {
            "模拟日期"
        } else {
            "系统日期"
        };
        let new_mode = if date.is_some() {
            "模拟日期"
        } else {
            "系统日期"
        };
        self.date_override = date;
        self.generation += 1;
        if old_mode != new_mode {
            self.log("mode", old_mode.into(), new_mode.into(), "debug");
        }
        self.observe("debug");
    }
    fn info(&self) -> ClockInfo {
        let now = Local::now();
        ClockInfo {
            simulated: self.date_override.is_some(),
            system_date: now.format("%Y-%m-%d").to_string(),
            system_time: now.to_rfc3339(),
            checked_at: self.checked_at.clone(),
            reason: self.reason.clone(),
            checks: self.checks,
            generation: self.generation,
            changes: self.changes.clone(),
        }
    }
}
fn workspace_dir(root: &Path, simulated: bool) -> PathBuf {
    root.join(if simulated {
        "debug-check-ins"
    } else {
        "check-ins"
    })
}
fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}
fn records_dir(app: &tauri::AppHandle, simulated: bool) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let folder = workspace_dir(&root, simulated);
    fs::create_dir_all(&folder).map_err(|e| format!("无法创建记录文件夹：{e}"))?;
    Ok(folder)
}
fn valid_date(date: &str) -> bool {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == date)
}
fn validate(store: &Store) -> Result<(), String> {
    if store.version != 6 {
        return Err("数据版本不受支持，请勿覆盖原文件。".into());
    }
    let mut ids = std::collections::HashSet::new();
    for item in &store.items {
        validate_choices(&item.states)?;
        for dates in [&item.skipped_dates, &item.extra_dates] {
            if dates.iter().any(|d| !valid_date(d) || d < &item.created_on)
                || dates.iter().collect::<std::collections::HashSet<_>>().len() != dates.len()
            {
                return Err("单日打卡安排包含无效日期或重复日期。".into());
            }
        }
        if item.event.is_some() && (!item.skipped_dates.is_empty() || !item.extra_dates.is_empty())
        {
            return Err("事件不能包含打卡的单日例外。".into());
        }
        let mut previous: Option<&str> = None;
        for version in &item.repeat_rules {
            validate_repeat(&version.rule)?;
            if !valid_date(&version.from)
                || version.from < item.created_on
                || previous.is_some_and(|p| p >= version.from.as_str())
            {
                return Err("重复规则的生效日期无效。".into());
            }
            if let RepeatRule::Once { date } = &version.rule {
                if date < &version.from {
                    return Err("固定日期不能早于规则生效日期。".into());
                }
            }
            previous = Some(&version.from);
        }
        if let Some(event) = &item.event {
            validate_event(event)?;
        }
        if item.id.is_empty()
            || item.name.trim().is_empty()
            || !valid_date(&item.created_on)
            || !ids.insert(&item.id)
        {
            return Err("关注项数据无效，请检查 state.json。".into());
        }
    }
    let mut keys = std::collections::HashSet::new();
    for record in &store.records {
        if record.status.is_empty()
            || record.status_label.trim().is_empty()
            || !record.quality.is_finite()
            || !(0.0..=1.0).contains(&record.quality)
            || !ids.contains(&record.item_id)
            || !valid_date(&record.date)
            || store
                .items
                .iter()
                .find(|i| i.id == record.item_id)
                .and_then(|i| i.event.as_ref())
                .is_some_and(|event| !event_recordable(event, &record.date))
            || chrono::DateTime::parse_from_rfc3339(&record.updated_at).is_err()
            || !keys.insert((&record.item_id, &record.date))
        {
            return Err("打卡数据无效，请检查 state.json。".into());
        }
    }
    Ok(())
}
fn write_store(folder: &Path, store: &Store) -> Result<(), String> {
    validate(store)?;
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(folder).map_err(|e| e.to_string())?;
    tmp.write_all(&bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| format!("保存失败：{e}"))?;
    tmp.persist(folder.join("state.json"))
        .map_err(|e| format!("保存失败：{e}"))?;
    Ok(())
}
fn read_store(folder: &Path) -> Result<Store, String> {
    let path = folder.join("state.json");
    match fs::read(&path) {
        Ok(bytes) => {
            let mut raw: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|e| format!("state.json 损坏，请备份并修复：{e}"))?;
            let source_version = raw["version"].as_u64().ok_or("数据版本无效。")?;
            let migrate = (2..=5).contains(&source_version);
            if source_version == 2 {
                let items = raw["items"].as_array_mut().ok_or("关注项数据损坏。")?;
                for item in items {
                    if !item.is_object() {
                        return Err("关注项数据损坏。".into());
                    }
                    item["states"] =
                        serde_json::to_value(default_choices()).map_err(|e| e.to_string())?;
                    item["bestFirst"] = false.into();
                }
                for record in raw["records"].as_array_mut().ok_or("记录数据损坏。")? {
                    if !record.is_object() {
                        return Err("记录数据损坏。".into());
                    }
                    let (label, value) = match record["status"].as_str() {
                        Some("done") => ("完成", 1.0),
                        Some("partial") => ("一般", 0.5),
                        Some("missed") => ("未完成", 0.0),
                        _ => return Err("旧记录包含未知状态，请先检查原文件。".into()),
                    };
                    record["statusLabel"] = label.into();
                    record["quality"] = value.into();
                }
                raw["version"] = 3.into();
            }
            if raw["version"] == 3 {
                raw["version"] = 4.into();
            }
            if raw["version"] == 4 {
                raw["version"] = 5.into();
            }
            if raw["version"] == 5 {
                raw["version"] = 6.into();
            }
            let store: Store =
                serde_json::from_value(raw).map_err(|e| format!("数据格式无效：{e}"))?;
            validate(&store)?;
            if migrate {
                let mut backup =
                    tempfile::NamedTempFile::new_in(folder).map_err(|e| e.to_string())?;
                backup
                    .write_all(&bytes)
                    .and_then(|_| backup.as_file().sync_all())
                    .map_err(|e| e.to_string())?;
                match backup
                    .persist_noclobber(folder.join(format!("state-v{source_version}.backup.json")))
                {
                    Ok(_) => {}
                    Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(format!("无法备份旧记录：{e}")),
                }
                write_store(folder, &store)?;
            }
            return Ok(store);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("无法读取数据：{e}")),
    }
    let mut store = Store {
        version: 6,
        ..Default::default()
    };
    // One-time migration. Original daily JSON files remain untouched as backups.
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let key = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if !valid_date(key) {
            continue;
        }
        let record: Legacy = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("旧记录损坏 {}：{e}", path.display()))?;
        if record.date != key {
            return Err(format!("旧记录日期不匹配：{}", path.display()));
        }
        store.records.push(Entry {
            item_id: "legacy".into(),
            date: record.date,
            status: "done".into(),
            status_label: "完成".into(),
            quality: 1.0,
            note: record.note,
            updated_at: record.created_at,
        });
    }
    if let Some(first) = store.records.iter().map(|r| &r.date).min() {
        store.items.push(Focus {
            id: "legacy".into(),
            name: "原每日打卡".into(),
            created_on: first.clone(),
            archived: true,
            states: default_choices(),
            best_first: false,
            event: None,
            repeat_rules: Vec::new(),
            skipped_dates: Vec::new(),
            extra_dates: Vec::new(),
        });
    }
    write_store(folder, &store)?;
    Ok(store)
}
fn snapshot(folder: &Path, store: Store, state: &RuntimeState) -> Snapshot {
    Snapshot {
        today: state.date(),
        folder: folder.to_string_lossy().into_owned(),
        items: store.items,
        records: store.records,
        clock: state.info(),
    }
}
fn ensure_clock(state: &RuntimeState, generation: u64) -> Result<(), String> {
    if state.generation != generation {
        return Err("日期或调试模式已变化，请刷新后重试。".into());
    }
    Ok(())
}
fn mutate(
    app: &tauri::AppHandle,
    lock: &Mutex<RuntimeState>,
    clock_generation: u64,
    action: impl FnOnce(&mut Store, &str) -> Result<(), String>,
) -> Result<Snapshot, String> {
    let mut state = lock.lock().map_err(|e| e.to_string())?;
    state.observe("operation");
    ensure_clock(&state, clock_generation)?;
    let folder = records_dir(app, state.date_override.is_some())?;
    let mut store = read_store(&folder)?;
    action(&mut store, &state.date())?;
    write_store(&folder, &store)?;
    Ok(snapshot(&folder, store, &state))
}
#[tauri::command]
fn load_check_ins(
    app: tauri::AppHandle,
    reason: Option<String>,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    let mut state = lock.lock().map_err(|e| e.to_string())?;
    let reason = match reason.as_deref() {
        Some("timer") => "timer",
        Some("focus") => "focus",
        Some("midnight") => "midnight",
        Some("startup") => "startup",
        _ => "manual",
    };
    state.observe(reason);
    let folder = records_dir(&app, state.date_override.is_some())?;
    Ok(snapshot(&folder, read_store(&folder)?, &state))
}
fn prepare_debug_store(root: &Path) -> Result<(), String> {
    let debug = workspace_dir(root, true);
    fs::create_dir_all(&debug).map_err(|e| e.to_string())?;
    if !debug.join("state.json").exists() {
        let live = workspace_dir(root, false);
        fs::create_dir_all(&live).map_err(|e| e.to_string())?;
        write_store(&debug, &read_store(&live)?)?;
    }
    Ok(())
}
#[tauri::command]
fn set_debug_date(
    app: tauri::AppHandle,
    date: Option<String>,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    if date
        .as_ref()
        .is_some_and(|d| !valid_date(d) || d.as_str() < "0001-01-01" || d.as_str() > "9999-12-31")
    {
        return Err("请选择有效的模拟日期。".into());
    }
    let mut state = lock.lock().map_err(|e| e.to_string())?;
    state.observe("debug-request");
    ensure_clock(&state, clock_generation)?;
    if date.is_some() {
        prepare_debug_store(&app.path().app_data_dir().map_err(|e| e.to_string())?)?;
    }
    let folder = records_dir(&app, date.is_some())?;
    let store = read_store(&folder)?;
    state.set_override(date);
    Ok(snapshot(&folder, store, &state))
}
fn add_item_on(
    store: &mut Store,
    name: String,
    states: Vec<Choice>,
    best_first: bool,
    date: &str,
) -> Result<(), String> {
    validate_choices(&states)?;
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 30 {
        return Err("名称请填写 1–30 字。".into());
    }
    if store
        .items
        .iter()
        .any(|i| i.event.is_none() && !i.archived && i.name == name)
    {
        return Err("已经有同名的关注项了。".into());
    }
    store.items.push(Focus {
        id: format!(
            "{}-{}",
            Local::now().timestamp_nanos_opt().unwrap_or_default(),
            std::process::id()
        ),
        name,
        created_on: date.into(),
        archived: false,
        states: states
            .into_iter()
            .map(|s| Choice {
                id: s.id,
                label: s.label.trim().into(),
            })
            .collect(),
        best_first,
        event: None,
        repeat_rules: Vec::new(),
        skipped_dates: Vec::new(),
        extra_dates: Vec::new(),
    });
    Ok(())
}
#[tauri::command]
fn add_focus(
    app: tauri::AppHandle,
    name: String,
    states: Vec<Choice>,
    best_first: bool,
    repeat: RepeatRule,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    mutate(&app, &lock, clock_generation, |store, date| {
        validate_repeat(&repeat)?;
        if let RepeatRule::Once { date: fixed } = &repeat {
            if fixed.as_str() < date {
                return Err("固定日期不能早于今天。".into());
            }
        }
        add_item_on(store, name, states, best_first, date)?;
        let id = store.items.last().unwrap().id.clone();
        update_repeat(store, &id, repeat, date)
    })
}
fn update_choices(
    store: &mut Store,
    item_id: &str,
    states: Vec<Choice>,
    best_first: bool,
) -> Result<(), String> {
    validate_choices(&states)?;
    let item = store
        .items
        .iter_mut()
        .find(|i| i.id == item_id)
        .ok_or("找不到关注项。")?;
    item.states = states
        .into_iter()
        .map(|s| Choice {
            id: s.id,
            label: s.label.trim().into(),
        })
        .collect();
    item.best_first = best_first;
    Ok(())
}
#[tauri::command]
fn update_focus_states(
    app: tauri::AppHandle,
    item_id: String,
    states: Vec<Choice>,
    best_first: bool,
    repeat: Option<RepeatRule>,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    mutate(&app, &lock, clock_generation, |store, date| {
        if let Some(rule) = repeat {
            update_repeat(store, &item_id, rule, date)?;
        }
        update_choices(store, &item_id, states, best_first)
    })
}
fn archive_item(store: &mut Store, item_id: &str, archived: bool) -> Result<(), String> {
    let item = store
        .items
        .iter()
        .find(|i| i.id == item_id)
        .ok_or("找不到关注项。")?;
    if item.event.is_some() {
        return Err("事件请使用结束操作。".into());
    }
    if !archived
        && store
            .items
            .iter()
            .any(|i| i.id != item_id && i.event.is_none() && !i.archived && i.name == item.name)
    {
        return Err("已有同名关注项，请先移除同名项再恢复。".into());
    }
    store
        .items
        .iter_mut()
        .find(|i| i.id == item_id)
        .unwrap()
        .archived = archived;
    Ok(())
}
#[tauri::command]
fn archive_focus(
    app: tauri::AppHandle,
    item_id: String,
    archived: bool,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    mutate(&app, &lock, clock_generation, |store, _date| {
        archive_item(store, &item_id, archived)
    })
}
fn validate_record_date(item: &Focus, record_date: &str, current_date: &str) -> Result<(), String> {
    if !valid_date(record_date) || record_date > current_date {
        return Err("只能记录今天或之前的有效日期。".into());
    }
    if record_date < item.created_on.as_str() {
        return Err("记录日期不能早于创建日期。".into());
    }
    if item
        .event
        .as_ref()
        .is_some_and(|event| !event_recordable(event, record_date))
    {
        return Err("所选日期不在事件的起止日期内。".into());
    }
    Ok(())
}
fn status_snapshot(item: &Focus, status: &str) -> Result<(String, f64), String> {
    let index = item
        .states
        .iter()
        .position(|s| s.id == status)
        .ok_or("该状态已被修改或移除，请刷新后重新选择。")?;
    Ok((
        item.states[index].label.clone(),
        quality(index, item.states.len(), item.best_first),
    ))
}
fn put_entry(store: &mut Store, record: Entry) {
    if let Some(old) = store
        .records
        .iter_mut()
        .find(|r| r.item_id == record.item_id && r.date == record.date)
    {
        *old = record;
    } else {
        store.records.push(record);
    }
}
fn save_entry_on(
    store: &mut Store,
    item_id: String,
    status: String,
    note: String,
    expected_date: String,
    date: &str,
) -> Result<(), String> {
    if expected_date != date {
        return Err("日期已变化，请刷新后重新记录，备注仍保留。".into());
    }
    if note.chars().count() > 2000 {
        return Err("备注不能超过 2000 字。".into());
    }
    let item = store
        .items
        .iter()
        .find(|i| i.id == item_id && !i.archived)
        .ok_or("该关注项已移除，请刷新。")?;
    validate_record_date(item, &expected_date, date)?;
    validate_scheduled(
        item,
        &expected_date,
        store
            .records
            .iter()
            .any(|r| r.item_id == item_id && r.date == expected_date),
    )?;
    let (status_label, quality) = status_snapshot(item, &status)?;
    let record = Entry {
        item_id: item_id.clone(),
        date: expected_date.clone(),
        status,
        status_label,
        quality,
        note: note.trim().into(),
        updated_at: Local::now().to_rfc3339(),
    };
    put_entry(store, record);
    Ok(())
}
#[tauri::command]
fn save_check_in(
    app: tauri::AppHandle,
    item_id: String,
    status: String,
    note: String,
    expected_date: String,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    mutate(&app, &lock, clock_generation, |store, date| {
        save_entry_on(store, item_id, status, note, expected_date, date)
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEdit {
    item_id: String,
    date: String,
    status: String,
    note: String,
    keep_original_status: bool,
    expected_updated_at: Option<String>,
}
fn save_history_entry_on(
    store: &mut Store,
    edit: HistoryEdit,
    current_date: &str,
) -> Result<(), String> {
    if edit.note.chars().count() > 2000 {
        return Err("备注不能超过 2000 字。".into());
    }
    let item = store
        .items
        .iter()
        .find(|i| i.id == edit.item_id)
        .ok_or("找不到记录内容。")?;
    validate_record_date(item, &edit.date, current_date)?;
    let old = store
        .records
        .iter()
        .find(|r| r.item_id == edit.item_id && r.date == edit.date);
    validate_scheduled(item, &edit.date, old.is_some())?;
    if old.map(|r| r.updated_at.as_str()) != edit.expected_updated_at.as_deref() {
        return Err("这条记录已发生变化，请取消编辑并刷新后再试，当前内容尚未覆盖。".into());
    }
    if item.archived && edit.date == current_date && old.is_none() {
        return Err("已移除的打卡项不能新增今天的记录。".into());
    }
    let (status_label, quality) = if edit.keep_original_status {
        let prior = old
            .filter(|r| r.status == edit.status)
            .ok_or("没有可保留的原状态，请重新选择。")?;
        (prior.status_label.clone(), prior.quality)
    } else {
        status_snapshot(item, &edit.status)?
    };
    put_entry(
        store,
        Entry {
            item_id: edit.item_id,
            date: edit.date,
            status: edit.status,
            status_label,
            quality,
            note: edit.note.trim().into(),
            updated_at: Local::now().to_rfc3339(),
        },
    );
    Ok(())
}
#[tauri::command]
fn save_history_check_in(
    app: tauri::AppHandle,
    edit: HistoryEdit,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    mutate(&app, &lock, clock_generation, |store, date| {
        save_history_entry_on(store, edit, date)
    })
}
fn add_event_item(store: &mut Store, draft: EventDraft) -> Result<(), String> {
    let name = draft.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 30 {
        return Err("事件名称请填写 1–30 字。".into());
    }
    validate_choices(&draft.states)?;
    let event = EventInfo {
        description: draft.description.trim().into(),
        start_date: draft.start_date,
        end_date: draft.end_date,
        ended_on: None,
    };
    validate_event(&event)?;
    store.items.push(Focus {
        id: format!(
            "event-{}-{}",
            Local::now().timestamp_nanos_opt().unwrap_or_default(),
            std::process::id()
        ),
        name,
        created_on: event.start_date.clone(),
        archived: false,
        states: draft
            .states
            .into_iter()
            .map(|s| Choice {
                id: s.id,
                label: s.label.trim().into(),
            })
            .collect(),
        best_first: draft.best_first,
        event: Some(event),
        repeat_rules: Vec::new(),
        skipped_dates: Vec::new(),
        extra_dates: Vec::new(),
    });
    Ok(())
}
#[tauri::command]
fn add_event(
    app: tauri::AppHandle,
    draft: EventDraft,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    mutate(&app, &lock, clock_generation, |store, _date| {
        add_event_item(store, draft)
    })
}
fn finish_event_item(store: &mut Store, item_id: &str, date: &str) -> Result<(), String> {
    let event = store
        .items
        .iter_mut()
        .find(|i| i.id == item_id)
        .and_then(|i| i.event.as_mut())
        .ok_or("找不到事件。")?;
    if !valid_date(date) || event.ended_on.is_some() || !event_recordable(event, date) {
        return Err("事件尚未开始或已经结束，请刷新查看。".into());
    }
    event.ended_on = Some(date.into());
    Ok(())
}
#[tauri::command]
fn finish_event(
    app: tauri::AppHandle,
    item_id: String,
    expected_date: String,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    mutate(&app, &lock, clock_generation, |store, date| {
        if expected_date != date {
            return Err("日期已变化，请刷新后重试。".into());
        }
        finish_event_item(store, &item_id, date)
    })
}
fn extend_event_item(
    store: &mut Store,
    item_id: &str,
    end_date: String,
    date: &str,
) -> Result<(), String> {
    let event = store
        .items
        .iter_mut()
        .find(|i| i.id == item_id)
        .and_then(|i| i.event.as_mut())
        .ok_or("找不到事件。")?;
    let old_end = event
        .end_date
        .as_deref()
        .ok_or("此事件未设置结束日期，无需延期。")?;
    if event.ended_on.is_some() {
        return Err("手动结束的事件不能延期。".into());
    }
    if !valid_date(&end_date) || end_date.as_str() <= old_end || end_date.as_str() < date {
        return Err("延期日期必须晚于原结束日期，且不能早于今天。".into());
    }
    event.end_date = Some(end_date);
    Ok(())
}
#[tauri::command]
fn extend_event(
    app: tauri::AppHandle,
    item_id: String,
    end_date: String,
    expected_date: String,
    clock_generation: u64,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    mutate(&app, &lock, clock_generation, |store, date| {
        if expected_date != date {
            return Err("日期已变化，请刷新后重试。".into());
        }
        extend_event_item(store, &item_id, end_date, date)
    })
}
#[tauri::command]
fn open_records_folder(
    app: tauri::AppHandle,
    lock: tauri::State<Mutex<RuntimeState>>,
) -> Result<(), String> {
    let state = lock.lock().map_err(|e| e.to_string())?;
    app.opener()
        .open_path(
            records_dir(&app, state.date_override.is_some())?
                .to_string_lossy()
                .as_ref(),
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(RuntimeState::default()))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_check_ins,
            set_debug_date,
            set_check_in_exception,
            add_focus,
            add_event,
            finish_event,
            extend_event,
            archive_focus,
            update_focus_states,
            save_check_in,
            save_history_check_in,
            open_records_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
#[cfg(test)]
fn add_item(
    store: &mut Store,
    name: String,
    states: Vec<Choice>,
    best_first: bool,
) -> Result<(), String> {
    add_item_on(store, name, states, best_first, &today())
}
#[cfg(test)]
fn save_entry(
    store: &mut Store,
    item_id: String,
    status: String,
    note: String,
    expected_date: String,
) -> Result<(), String> {
    save_entry_on(store, item_id, status, note, expected_date, &today())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clock_monitors_midnight_month_year_rollback_and_caps_logs() {
        let mut state = RuntimeState::default();
        state.observe_dates("2026-12-31".into(), "2026-12-31".into(), "startup");
        let generation = state.generation;
        state.observe_dates("2027-01-01".into(), "2027-01-01".into(), "midnight");
        assert!(ensure_clock(&state, generation).is_err());
        assert_eq!(state.changes[0].from, "2026-12-31");
        assert_eq!(state.changes[0].to, "2027-01-01");
        assert_eq!(state.changes[0].reason, "midnight");
        state.observe_dates("2027-01-01".into(), "2026-12-30".into(), "debug");
        assert_eq!(state.changes[0].to, "2026-12-30");
        let count = state.changes.len();
        state.observe_dates("2027-01-01".into(), "2026-12-30".into(), "timer");
        assert_eq!(state.changes.len(), count);
        assert_eq!(state.checks, 4);
        for day in 0..80 {
            state.log("date", day.to_string(), (day + 1).to_string(), "debug");
        }
        assert_eq!(state.changes.len(), 50);
    }
    #[test]
    fn same_day_mode_switch_invalidates_stale_writes_and_restart_uses_real_date() {
        let mut state = RuntimeState::default();
        state.observe("startup");
        let old = state.generation;
        state.set_override(Some(today()));
        assert!(state.info().simulated);
        assert!(ensure_clock(&state, old).is_err());
        let mock_generation = state.generation;
        state.set_override(None);
        assert!(!state.info().simulated);
        assert!(ensure_clock(&state, mock_generation).is_err());
        assert!(RuntimeState::default().date_override.is_none());
    }
    #[test]
    fn simulated_records_use_backend_clock_and_do_not_change_live_files() {
        let root = tempfile::tempdir().unwrap();
        let live = workspace_dir(root.path(), false);
        fs::create_dir_all(&live).unwrap();
        let mut original = read_store(&live).unwrap();
        add_item_on(
            &mut original,
            "睡眠".into(),
            default_choices(),
            false,
            "2026-01-01",
        )
        .unwrap();
        write_store(&live, &original).unwrap();
        let original_bytes = fs::read(live.join("state.json")).unwrap();
        let focus_id = original.items[0].id.clone();
        assert!(
            save_entry_on(
                &mut original,
                focus_id,
                "done".into(),
                "".into(),
                "2025-12-31".into(),
                "2025-12-31"
            )
            .is_err()
        );
        prepare_debug_store(root.path()).unwrap();
        let debug = workspace_dir(root.path(), true);
        assert_ne!(debug, live);
        let mut simulated = read_store(&debug).unwrap();
        add_event_item(
            &mut simulated,
            event_draft("2026-01-02", Some("2026-01-03")),
        )
        .unwrap();
        let event = simulated.items.last().unwrap().id.clone();
        assert!(
            save_entry_on(
                &mut simulated,
                event.clone(),
                "done".into(),
                "".into(),
                "2026-01-01".into(),
                "2026-01-01"
            )
            .is_err()
        );
        assert!(
            save_entry_on(
                &mut simulated,
                event.clone(),
                "done".into(),
                "".into(),
                "2026-01-01".into(),
                "2026-01-02"
            )
            .is_err()
        );
        save_entry_on(
            &mut simulated,
            event.clone(),
            "done".into(),
            "模拟写入".into(),
            "2026-01-02".into(),
            "2026-01-02",
        )
        .unwrap();
        finish_event_item(&mut simulated, &event, "2026-01-02").unwrap();
        assert!(
            save_entry_on(
                &mut simulated,
                event,
                "done".into(),
                "".into(),
                "2026-01-03".into(),
                "2026-01-03"
            )
            .is_err()
        );
        write_store(&debug, &simulated).unwrap();
        prepare_debug_store(root.path()).unwrap();
        assert_eq!(read_store(&debug).unwrap().records[0].date, "2026-01-02");
        assert_eq!(fs::read(live.join("state.json")).unwrap(), original_bytes);
        assert!(read_store(&live).unwrap().records.is_empty());
    }
    #[test]
    fn weekly_monthly_and_once_schedules_handle_real_calendar_dates() {
        let mut store = Store {
            version: 6,
            ..Default::default()
        };
        add_item_on(
            &mut store,
            "运动".into(),
            default_choices(),
            false,
            "2026-11-01",
        )
        .unwrap();
        let id = store.items[0].id.clone();
        update_repeat(
            &mut store,
            &id,
            RepeatRule::Weekly {
                weekdays: vec![3, 1],
            },
            "2026-11-15",
        )
        .unwrap();
        assert!(is_scheduled(&store.items[0], "2026-11-14"));
        assert!(!is_scheduled(&store.items[0], "2026-11-15"));
        assert!(is_scheduled(&store.items[0], "2026-11-16"));
        assert!(!is_scheduled(&store.items[0], "2026-11-17"));
        assert!(is_scheduled(&store.items[0], "2026-11-18"));
        update_repeat(
            &mut store,
            &id,
            RepeatRule::Monthly { days: vec![31] },
            "2026-11-19",
        )
        .unwrap();
        assert!(!is_scheduled(&store.items[0], "2026-11-30"));
        assert!(is_scheduled(&store.items[0], "2026-12-31"));
        update_repeat(
            &mut store,
            &id,
            RepeatRule::Once {
                date: "2027-01-02".into(),
            },
            "2027-01-01",
        )
        .unwrap();
        assert!(!is_scheduled(&store.items[0], "2027-01-01"));
        assert!(is_scheduled(&store.items[0], "2027-01-02"));
        assert!(!is_scheduled(&store.items[0], "2027-01-03"));
        add_item_on(
            &mut store,
            "月底".into(),
            default_choices(),
            false,
            "2024-01-01",
        )
        .unwrap();
        let leap = store.items[1].id.clone();
        update_repeat(
            &mut store,
            &leap,
            RepeatRule::Monthly { days: vec![29] },
            "2024-01-01",
        )
        .unwrap();
        assert!(is_scheduled(&store.items[1], "2024-02-29"));
        assert!(!is_scheduled(&store.items[1], "2025-02-28"));
        for bad in [
            RepeatRule::Weekly { weekdays: vec![] },
            RepeatRule::Weekly { weekdays: vec![0] },
            RepeatRule::Weekly {
                weekdays: vec![1, 1],
            },
            RepeatRule::Monthly { days: vec![32] },
            RepeatRule::Once {
                date: "2026-02-30".into(),
            },
        ] {
            assert!(validate_repeat(&bad).is_err());
        }
        assert!(
            update_repeat(
                &mut store,
                &id,
                RepeatRule::Once {
                    date: "2026-11-10".into()
                },
                "2026-11-15"
            )
            .is_err()
        );
    }
    #[test]
    fn repeat_changes_preserve_previous_plans_and_existing_off_day_records() {
        let folder = tempfile::tempdir().unwrap();
        let mut store = read_store(folder.path()).unwrap();
        add_item_on(
            &mut store,
            "运动".into(),
            default_choices(),
            false,
            "2026-11-01",
        )
        .unwrap();
        let id = store.items[0].id.clone();
        save_entry_on(
            &mut store,
            id.clone(),
            "done".into(),
            "原先是每天".into(),
            "2026-11-15".into(),
            "2026-11-15",
        )
        .unwrap();
        update_repeat(
            &mut store,
            &id,
            RepeatRule::Weekly { weekdays: vec![1] },
            "2026-11-15",
        )
        .unwrap();
        assert!(!is_scheduled(&store.items[0], "2026-11-15"));
        save_entry_on(
            &mut store,
            id.clone(),
            "partial".into(),
            "已有记录可修正".into(),
            "2026-11-15".into(),
            "2026-11-15",
        )
        .unwrap();
        assert!(
            save_entry_on(
                &mut store,
                id.clone(),
                "done".into(),
                "".into(),
                "2026-11-17".into(),
                "2026-11-17"
            )
            .is_err()
        );
        save_entry_on(
            &mut store,
            id.clone(),
            "done".into(),
            "周一记录".into(),
            "2026-11-16".into(),
            "2026-11-16",
        )
        .unwrap();
        save_history_entry_on(
            &mut store,
            history_edit(&id, "2026-11-14", "done", "旧的每日计划可补记", None, false),
            "2026-11-18",
        )
        .unwrap();
        assert!(
            save_history_entry_on(
                &mut store,
                history_edit(&id, "2026-11-17", "done", "休息日不能补记", None, false),
                "2026-11-18"
            )
            .is_err()
        );
        update_repeat(
            &mut store,
            &id,
            RepeatRule::Monthly { days: vec![20] },
            "2026-11-18",
        )
        .unwrap();
        assert!(is_scheduled(&store.items[0], "2026-11-16"));
        assert!(!is_scheduled(&store.items[0], "2026-11-18"));
        assert!(is_scheduled(&store.items[0], "2026-11-20"));
        write_store(folder.path(), &store).unwrap();
        let loaded = read_store(folder.path()).unwrap();
        assert_eq!(loaded.records, store.records);
        assert_eq!(
            repeat_on(&loaded.items[0], "2026-11-16"),
            RepeatRule::Weekly { weekdays: vec![1] }
        );
    }
    #[test]
    fn v4_repeat_migration_preserves_data_and_defaults_to_daily() {
        let folder = tempfile::tempdir().unwrap();
        let mut store = read_store(folder.path()).unwrap();
        add_item_on(
            &mut store,
            "睡眠".into(),
            default_choices(),
            false,
            "2026-11-01",
        )
        .unwrap();
        let id = store.items[0].id.clone();
        save_entry_on(
            &mut store,
            id,
            "done".into(),
            "已有记录".into(),
            "2026-11-14".into(),
            "2026-11-14",
        )
        .unwrap();
        let mut raw = serde_json::to_value(&store).unwrap();
        raw["version"] = 4.into();
        for item in raw["items"].as_array_mut().unwrap() {
            item.as_object_mut().unwrap().remove("repeatRules");
        }
        let bytes = serde_json::to_vec(&raw).unwrap();
        fs::write(folder.path().join("state.json"), &bytes).unwrap();
        let loaded = read_store(folder.path()).unwrap();
        assert_eq!(loaded.version, 6);
        assert_eq!(loaded.records, store.records);
        assert_eq!(repeat_on(&loaded.items[0], "2026-11-15"), RepeatRule::Daily);
        assert!(is_scheduled(&loaded.items[0], "2026-11-16"));
        assert_eq!(
            fs::read(folder.path().join("state-v4.backup.json")).unwrap(),
            bytes
        );
        assert_eq!(read_store(folder.path()).unwrap().records, store.records);
    }
    fn history_edit(
        id: &str,
        date: &str,
        status: &str,
        note: &str,
        prior: Option<&Entry>,
        keep: bool,
    ) -> HistoryEdit {
        HistoryEdit {
            item_id: id.into(),
            date: date.into(),
            status: status.into(),
            note: note.into(),
            keep_original_status: keep,
            expected_updated_at: prior.map(|r| r.updated_at.clone()),
        }
    }
    #[test]
    fn history_updates_exact_day_preserves_retired_state_and_rejects_conflicts() {
        let folder = tempfile::tempdir().unwrap();
        let mut store = read_store(folder.path()).unwrap();
        add_item_on(
            &mut store,
            "睡眠".into(),
            default_choices(),
            false,
            "2026-11-01",
        )
        .unwrap();
        let id = store.items[0].id.clone();
        save_history_entry_on(
            &mut store,
            history_edit(&id, "2026-11-10", "done", "最初记录", None, false),
            "2026-11-14",
        )
        .unwrap();
        save_history_entry_on(
            &mut store,
            history_edit(&id, "2026-11-11", "partial", "相邻日期", None, false),
            "2026-11-14",
        )
        .unwrap();
        let original = store.records[0].clone();
        let neighbor = store.records[1].clone();
        update_choices(
            &mut store,
            &id,
            vec![Choice {
                id: "new".into(),
                label: "新状态".into(),
            }],
            false,
        )
        .unwrap();
        archive_item(&mut store, &id, true).unwrap();
        save_history_entry_on(
            &mut store,
            history_edit(
                &id,
                "2026-11-10",
                "done",
                "修改历史备注",
                Some(&original),
                true,
            ),
            "2026-11-14",
        )
        .unwrap();
        assert_eq!(store.records.len(), 2);
        assert_eq!(store.records[0].status_label, "完成");
        assert_eq!(store.records[0].quality, 1.0);
        assert_eq!(store.records[0].note, "修改历史备注");
        assert_eq!(store.records[1], neighbor);
        assert!(
            save_history_entry_on(
                &mut store,
                history_edit(&id, "2026-11-10", "done", "不应覆盖", Some(&original), true),
                "2026-11-14"
            )
            .is_err()
        );
        assert!(
            save_history_entry_on(
                &mut store,
                history_edit(&id, "2026-11-10", "new", "重复补记", None, false),
                "2026-11-14"
            )
            .is_err()
        );
        let latest = store.records[0].clone();
        save_history_entry_on(
            &mut store,
            history_edit(&id, "2026-11-10", "new", "采用新状态", Some(&latest), false),
            "2026-11-14",
        )
        .unwrap();
        assert_eq!(store.records[0].status_label, "新状态");
        assert_eq!(store.records[0].quality, 0.5);
        write_store(folder.path(), &store).unwrap();
        assert_eq!(read_store(folder.path()).unwrap().records, store.records);
    }
    #[test]
    fn historical_backfill_rejects_future_precreation_and_outside_event_dates() {
        let mut store = Store {
            version: 6,
            ..Default::default()
        };
        add_item_on(
            &mut store,
            "打卡".into(),
            default_choices(),
            false,
            "2026-11-01",
        )
        .unwrap();
        let id = store.items[0].id.clone();
        for date in ["2026-11-15", "2026-10-31", "2026-11-31"] {
            assert!(
                save_history_entry_on(
                    &mut store,
                    history_edit(&id, date, "done", "", None, false),
                    "2026-11-14"
                )
                .is_err()
            );
        }
        add_event_item(&mut store, event_draft("2026-11-03", Some("2026-11-10"))).unwrap();
        let event = store.items[1].id.clone();
        finish_event_item(&mut store, &event, "2026-11-08").unwrap();
        assert!(
            save_history_entry_on(
                &mut store,
                history_edit(&event, "2026-11-02", "done", "", None, false),
                "2026-11-14"
            )
            .is_err()
        );
        assert!(
            save_history_entry_on(
                &mut store,
                history_edit(&event, "2026-11-09", "done", "", None, false),
                "2026-11-14"
            )
            .is_err()
        );
        save_history_entry_on(
            &mut store,
            history_edit(&event, "2026-11-08", "done", "结束当天补记", None, false),
            "2026-11-14",
        )
        .unwrap();
        assert_eq!(store.records.len(), 1);
        assert_eq!(store.records[0].date, "2026-11-08");
        assert!(
            save_entry_on(
                &mut store,
                id,
                "done".into(),
                "".into(),
                "2026-11-13".into(),
                "2026-11-14"
            )
            .is_err()
        );
    }
    #[test]
    fn historical_debug_writes_stay_in_test_copy() {
        let root = tempfile::tempdir().unwrap();
        let live = workspace_dir(root.path(), false);
        fs::create_dir_all(&live).unwrap();
        let mut store = read_store(&live).unwrap();
        add_item_on(
            &mut store,
            "睡眠".into(),
            default_choices(),
            false,
            "2026-11-01",
        )
        .unwrap();
        write_store(&live, &store).unwrap();
        let original = fs::read(live.join("state.json")).unwrap();
        prepare_debug_store(root.path()).unwrap();
        let debug = workspace_dir(root.path(), true);
        let mut simulated = read_store(&debug).unwrap();
        let id = simulated.items[0].id.clone();
        save_history_entry_on(
            &mut simulated,
            history_edit(&id, "2026-11-12", "done", "模拟补记", None, false),
            "2026-11-14",
        )
        .unwrap();
        write_store(&debug, &simulated).unwrap();
        assert_eq!(read_store(&debug).unwrap().records.len(), 1);
        set_exception(
            &mut simulated,
            &id,
            "2026-11-12",
            ExceptionAction::Skip,
            false,
            false,
        )
        .unwrap();
        update_repeat(
            &mut simulated,
            &id,
            RepeatRule::Weekly {
                weekdays: vec![1, 2, 3, 4, 5],
            },
            "2026-11-14",
        )
        .unwrap();
        set_exception(
            &mut simulated,
            &id,
            "2026-11-21",
            ExceptionAction::Add,
            false,
            false,
        )
        .unwrap();
        write_store(&debug, &simulated).unwrap();
        let reloaded = read_store(&debug).unwrap();
        assert!(is_skipped(&reloaded.items[0], "2026-11-12"));
        assert!(is_scheduled(&reloaded.items[0], "2026-11-21"));
        assert_eq!(fs::read(live.join("state.json")).unwrap(), original);
    }
    fn event_draft(start: &str, end: Option<&str>) -> EventDraft {
        EventDraft {
            name: "短期计划".into(),
            description: "每天记录进展".into(),
            start_date: start.into(),
            end_date: end.map(str::to_string),
            states: default_choices(),
            best_first: false,
        }
    }
    #[test]
    fn event_dates_are_inclusive_and_unscheduled_events_continue() {
        let event = EventInfo {
            description: "".into(),
            start_date: "2026-11-13".into(),
            end_date: Some("2026-11-16".into()),
            ended_on: None,
        };
        assert!(!event_recordable(&event, "2026-11-12"));
        assert!(event_recordable(&event, "2026-11-13"));
        assert!(event_recordable(&event, "2026-11-16"));
        assert!(!event_recordable(&event, "2026-11-17"));
        let open = EventInfo {
            end_date: None,
            ..event.clone()
        };
        assert!(event_recordable(&open, "2029-02-28"));
        let ended = EventInfo {
            ended_on: Some("2026-11-14".into()),
            ..open
        };
        assert!(event_recordable(&ended, "2026-11-14"));
        assert!(!event_recordable(&ended, "2026-11-15"));
        let mut store = Store {
            version: 6,
            ..Default::default()
        };
        assert!(add_event_item(&mut store, event_draft("2026-11-16", Some("2026-11-13"))).is_err());
        assert!(add_event_item(&mut store, event_draft("2026-02-30", None)).is_err());
        assert!(store.items.is_empty());
    }
    #[test]
    fn event_recording_finish_extension_and_restart_preserve_history() {
        let folder = tempfile::tempdir().unwrap();
        let mut store = read_store(folder.path()).unwrap();
        let date = today();
        let next = (Local::now().date_naive() + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        add_event_item(&mut store, event_draft(&date, Some(&date))).unwrap();
        let id = store.items[0].id.clone();
        save_entry(
            &mut store,
            id.clone(),
            "partial".into(),
            "事件第一天".into(),
            date.clone(),
        )
        .unwrap();
        let original = store.records[0].clone();
        assert!(extend_event_item(&mut store, &id, date.clone(), &date).is_err());
        extend_event_item(&mut store, &id, next.clone(), &date).unwrap();
        assert_eq!(store.records[0], original);
        assert!(event_recordable(
            store.items[0].event.as_ref().unwrap(),
            &next
        ));
        finish_event_item(&mut store, &id, &date).unwrap();
        assert!(!event_recordable(
            store.items[0].event.as_ref().unwrap(),
            &next
        ));
        assert!(extend_event_item(&mut store, &id, next.clone(), &date).is_err());
        assert!(finish_event_item(&mut store, &id, &date).is_err());
        save_entry(
            &mut store,
            id.clone(),
            "done".into(),
            "当天结束后仍可记录".into(),
            date.clone(),
        )
        .unwrap();
        write_store(folder.path(), &store).unwrap();
        let loaded = read_store(folder.path()).unwrap();
        assert_eq!(loaded.records, store.records);
        assert_eq!(
            loaded.items[0].event.as_ref().unwrap().ended_on,
            Some(date.clone())
        );
        add_event_item(&mut store, event_draft(&next, None)).unwrap();
        let future = store.items.last().unwrap().id.clone();
        assert!(
            save_entry(
                &mut store,
                future.clone(),
                "done".into(),
                "".into(),
                date.clone()
            )
            .is_err()
        );
        assert!(finish_event_item(&mut store, &future, &date).is_err());
        let prior = (Local::now().date_naive() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        add_event_item(&mut store, event_draft(&prior, Some(&prior))).unwrap();
        let expired = store.items.last().unwrap().id.clone();
        assert!(
            save_entry(
                &mut store,
                expired.clone(),
                "done".into(),
                "".into(),
                date.clone()
            )
            .is_err()
        );
        extend_event_item(&mut store, &expired, date.clone(), &date).unwrap();
        save_entry(
            &mut store,
            expired,
            "done".into(),
            "延期后继续".into(),
            date,
        )
        .unwrap();
    }
    #[test]
    fn v3_migration_preserves_long_term_items_and_backs_up_original() {
        let folder = tempfile::tempdir().unwrap();
        let mut store = read_store(folder.path()).unwrap();
        add_item(&mut store, "睡眠".into(), default_choices(), false).unwrap();
        let id = store.items[0].id.clone();
        save_entry(&mut store, id, "done".into(), "原有记录".into(), today()).unwrap();
        let mut raw = serde_json::to_value(&store).unwrap();
        raw["version"] = 3.into();
        for item in raw["items"].as_array_mut().unwrap() {
            item.as_object_mut().unwrap().remove("event");
        }
        let bytes = serde_json::to_vec(&raw).unwrap();
        fs::write(folder.path().join("state.json"), &bytes).unwrap();
        let migrated = read_store(folder.path()).unwrap();
        assert_eq!(migrated.version, 6);
        assert!(migrated.items[0].event.is_none());
        assert_eq!(migrated.records, store.records);
        assert_eq!(
            fs::read(folder.path().join("state-v3.backup.json")).unwrap(),
            bytes
        );
        assert_eq!(read_store(folder.path()).unwrap().records, store.records);
    }
    #[test]
    fn custom_states_order_and_history_survive_configuration_changes() {
        let folder = tempfile::tempdir().unwrap();
        let mut store = read_store(folder.path()).unwrap();
        let states: Vec<Choice> = ["极差", "差", "一般", "好", "非常好"]
            .iter()
            .enumerate()
            .map(|(i, label)| Choice {
                id: format!("sleep-{i}"),
                label: (*label).into(),
            })
            .collect();
        add_item(&mut store, "睡眠".into(), states.clone(), false).unwrap();
        let id = store.items[0].id.clone();
        for (i, expected) in [0.0, 0.25, 0.5, 0.75, 1.0].iter().enumerate() {
            save_entry(
                &mut store,
                id.clone(),
                format!("sleep-{i}"),
                "".into(),
                today(),
            )
            .unwrap();
            assert_eq!(store.records[0].quality, *expected);
        }
        let original = store.records[0].clone();
        let mut reversed = states.clone();
        reversed.reverse();
        update_choices(&mut store, &id, reversed, true).unwrap();
        assert_eq!(store.records[0], original);
        save_entry(&mut store, id.clone(), "sleep-4".into(), "".into(), today()).unwrap();
        assert_eq!(store.records[0].quality, 1.0);
        update_choices(
            &mut store,
            &id,
            vec![Choice {
                id: "only".into(),
                label: "休息日".into(),
            }],
            false,
        )
        .unwrap();
        assert_eq!(store.records[0].status_label, "非常好");
        assert!(save_entry(&mut store, id.clone(), "sleep-4".into(), "".into(), today()).is_err());
        write_store(folder.path(), &store).unwrap();
        assert_eq!(read_store(folder.path()).unwrap().records[0].quality, 1.0);
        save_entry(&mut store, id, "only".into(), "".into(), today()).unwrap();
        assert_eq!(store.records[0].quality, 0.5);
        assert!(update_choices(&mut store, "missing", states.clone(), false).is_err());
        assert!(validate_choices(&[]).is_err());
        assert!(
            validate_choices(&[
                Choice {
                    id: "1".into(),
                    label: "重复".into()
                },
                Choice {
                    id: "2".into(),
                    label: "重复".into()
                }
            ])
            .is_err()
        );
    }
    #[test]
    fn v2_migration_backs_up_preserves_records_and_is_repeatable() {
        let folder = tempfile::tempdir().unwrap();
        let original = serde_json::json!({"version":2,"items":[{"id":"sleep","name":"睡眠","createdOn":"2026-11-12","archived":false}],"records":[
            {"itemId":"sleep","date":"2026-11-12","status":"partial","note":"保留备注","updatedAt":"2026-11-12T22:00:00+08:00"}]});
        let bytes = serde_json::to_vec(&original).unwrap();
        fs::write(folder.path().join("state.json"), &bytes).unwrap();
        let store = read_store(folder.path()).unwrap();
        assert_eq!(store.version, 6);
        assert_eq!(store.items[0].states.len(), 3);
        assert_eq!(store.records[0].status_label, "一般");
        assert_eq!(store.records[0].quality, 0.5);
        assert_eq!(store.records[0].note, "保留备注");
        assert_eq!(
            fs::read(folder.path().join("state-v2.backup.json")).unwrap(),
            bytes
        );
        assert_eq!(read_store(folder.path()).unwrap().records, store.records);
        let mut broken = original;
        broken["records"][0]["status"] = "unknown".into();
        let broken_bytes = serde_json::to_vec(&broken).unwrap();
        fs::write(folder.path().join("state.json"), &broken_bytes).unwrap();
        assert!(read_store(folder.path()).is_err());
        assert_eq!(
            fs::read(folder.path().join("state.json")).unwrap(),
            broken_bytes
        );
    }
    #[test]
    fn multiple_items_updates_archive_restore_and_persistence() {
        let folder = tempfile::tempdir().unwrap();
        let mut store = read_store(folder.path()).unwrap();
        add_item(&mut store, "睡眠".into(), default_choices(), false).unwrap();
        add_item(&mut store, "饮食".into(), default_choices(), false).unwrap();
        assert!(add_item(&mut store, "睡眠".into(), default_choices(), false).is_err());
        let sleep = store.items[0].id.clone();
        let diet = store.items[1].id.clone();
        save_entry(
            &mut store,
            sleep.clone(),
            "partial".into(),
            "睡了6小时".into(),
            today(),
        )
        .unwrap();
        save_entry(&mut store, diet, "missed".into(), "".into(), today()).unwrap();
        save_entry(
            &mut store,
            sleep.clone(),
            "done".into(),
            "午睡补充 🌱".into(),
            today(),
        )
        .unwrap();
        assert_eq!(store.records.len(), 2);
        assert!(
            save_entry(
                &mut store,
                sleep.clone(),
                "done".into(),
                "".into(),
                "2000-01-01".into()
            )
            .is_err()
        );
        archive_item(&mut store, &sleep, true).unwrap();
        assert!(save_entry(&mut store, sleep.clone(), "done".into(), "".into(), today()).is_err());
        write_store(folder.path(), &store).unwrap();
        let mut loaded = read_store(folder.path()).unwrap();
        assert_eq!(loaded.records, store.records);
        assert!(loaded.items[0].archived);
        archive_item(&mut loaded, &sleep, false).unwrap();
        write_store(folder.path(), &loaded).unwrap();
        assert!(!read_store(folder.path()).unwrap().items[0].archived);
        fs::write(folder.path().join("state.json"), "broken").unwrap();
        assert!(read_store(folder.path()).is_err());
        assert_eq!(
            fs::read_to_string(folder.path().join("state.json")).unwrap(),
            "broken"
        );
    }
    #[test]
    fn migrates_legacy_once_without_changing_original() {
        let folder = tempfile::tempdir().unwrap();
        let old =
            r#"{"date":"2026-11-12","createdAt":"2026-11-12T22:00:00+08:00","note":"旧备注"}"#;
        fs::write(folder.path().join("2026-11-12.json"), old).unwrap();
        let store = read_store(folder.path()).unwrap();
        assert_eq!(store.records[0].note, "旧备注");
        assert!(store.items[0].archived);
        assert_eq!(read_store(folder.path()).unwrap().records.len(), 1);
        assert_eq!(
            fs::read_to_string(folder.path().join("2026-11-12.json")).unwrap(),
            old
        );
    }
    #[test]
    fn schedule_exceptions_preserve_rules_records_and_restore_extra_days() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = read_store(dir.path()).unwrap();
        add_item_on(
            &mut store,
            "工作".into(),
            default_choices(),
            false,
            "2026-11-01",
        )
        .unwrap();
        let id = store.items[0].id.clone();
        update_repeat(
            &mut store,
            &id,
            RepeatRule::Weekly {
                weekdays: vec![1, 2, 3, 4, 5],
            },
            "2026-11-01",
        )
        .unwrap();
        let rules = serde_json::to_value(&store.items[0].repeat_rules).unwrap();
        save_entry_on(
            &mut store,
            id.clone(),
            "done".into(),
            "保留备注".into(),
            "2026-11-16".into(),
            "2026-11-16",
        )
        .unwrap();
        let records = store.records.clone();
        set_exception(
            &mut store,
            &id,
            "2026-11-16",
            ExceptionAction::Skip,
            false,
            false,
        )
        .unwrap();
        assert!(!is_scheduled(&store.items[0], "2026-11-16"));
        assert!(is_scheduled(&store.items[0], "2026-11-23"));
        assert!(
            save_entry_on(
                &mut store,
                id.clone(),
                "partial".into(),
                "改写".into(),
                "2026-11-16".into(),
                "2026-11-16"
            )
            .is_err()
        );
        assert_eq!(store.records, records);
        assert!(
            set_exception(
                &mut store,
                &id,
                "2026-11-16",
                ExceptionAction::Unskip,
                false,
                false
            )
            .is_err()
        );
        set_exception(
            &mut store,
            &id,
            "2026-11-16",
            ExceptionAction::Unskip,
            true,
            false,
        )
        .unwrap();
        assert!(is_scheduled(&store.items[0], "2026-11-16"));
        set_exception(
            &mut store,
            &id,
            "2026-11-21",
            ExceptionAction::Add,
            false,
            false,
        )
        .unwrap();
        assert!(is_scheduled(&store.items[0], "2026-11-21"));
        assert!(!is_scheduled(&store.items[0], "2026-11-28"));
        set_exception(
            &mut store,
            &id,
            "2026-11-21",
            ExceptionAction::Skip,
            false,
            true,
        )
        .unwrap();
        assert!(!is_scheduled(&store.items[0], "2026-11-21"));
        set_exception(
            &mut store,
            &id,
            "2026-11-21",
            ExceptionAction::Unskip,
            true,
            true,
        )
        .unwrap();
        assert!(is_scheduled(&store.items[0], "2026-11-21"));
        set_exception(
            &mut store,
            &id,
            "2026-11-21",
            ExceptionAction::RemoveAdd,
            false,
            true,
        )
        .unwrap();
        assert!(!is_scheduled(&store.items[0], "2026-11-21"));
        assert_eq!(
            serde_json::to_value(&store.items[0].repeat_rules).unwrap(),
            rules
        );
        assert_eq!(store.records, records);
        write_store(dir.path(), &store).unwrap();
        assert_eq!(read_store(dir.path()).unwrap().records, records);
    }
    #[test]
    fn extra_dates_require_recurring_off_days_and_preserve_recorded_occurrences() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = read_store(dir.path()).unwrap();
        add_item_on(
            &mut store,
            "月计划".into(),
            default_choices(),
            false,
            "2026-11-01",
        )
        .unwrap();
        let id = store.items[0].id.clone();
        assert!(
            set_exception(
                &mut store,
                &id,
                "2026-11-21",
                ExceptionAction::Add,
                false,
                false
            )
            .is_err()
        );
        update_repeat(
            &mut store,
            &id,
            RepeatRule::Monthly { days: vec![1] },
            "2026-11-01",
        )
        .unwrap();
        for date in ["2026-11-01", "2026-10-31", "2026-02-30"] {
            assert!(
                set_exception(&mut store, &id, date, ExceptionAction::Add, false, false).is_err()
            );
        }
        set_exception(
            &mut store,
            &id,
            "2026-11-21",
            ExceptionAction::Add,
            false,
            false,
        )
        .unwrap();
        save_entry_on(
            &mut store,
            id.clone(),
            "done".into(),
            "调休工作".into(),
            "2026-11-21".into(),
            "2026-11-21",
        )
        .unwrap();
        assert!(
            set_exception(
                &mut store,
                &id,
                "2026-11-21",
                ExceptionAction::RemoveAdd,
                false,
                true
            )
            .is_err()
        );
        assert!(is_scheduled(&store.items[0], "2026-11-21"));
        set_exception(
            &mut store,
            &id,
            "2026-11-21",
            ExceptionAction::Skip,
            false,
            true,
        )
        .unwrap();
        assert_eq!(store.records[0].note, "调休工作");
    }
    #[test]
    fn v5_migration_preserves_repeat_history_and_backs_up_original() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = read_store(dir.path()).unwrap();
        add_item_on(
            &mut store,
            "旧计划".into(),
            default_choices(),
            false,
            "2026-11-01",
        )
        .unwrap();
        let id = store.items[0].id.clone();
        update_repeat(
            &mut store,
            &id,
            RepeatRule::Weekly {
                weekdays: vec![1, 3, 5],
            },
            "2026-11-10",
        )
        .unwrap();
        let mut raw = serde_json::to_value(&store).unwrap();
        raw["version"] = 5.into();
        for item in raw["items"].as_array_mut().unwrap() {
            item.as_object_mut().unwrap().remove("skippedDates");
            item.as_object_mut().unwrap().remove("extraDates");
        }
        let original = serde_json::to_vec(&raw).unwrap();
        fs::write(dir.path().join("state.json"), &original).unwrap();
        let migrated = read_store(dir.path()).unwrap();
        assert_eq!(migrated.version, 6);
        assert_eq!(
            serde_json::to_value(&migrated.items).unwrap(),
            serde_json::to_value(&store.items).unwrap()
        );
        assert_eq!(migrated.records, store.records);
        assert_eq!(
            fs::read(dir.path().join("state-v5.backup.json")).unwrap(),
            original
        );
    }
}
