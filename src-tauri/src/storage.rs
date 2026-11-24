//! User-selected file storage. Settings and recovery copies always stay local.
use super::*;
use fs2::FileExt;
use sha2::{Digest, Sha256};
use tauri_plugin_dialog::DialogExt;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    folder: Option<PathBuf>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Info {
    pub default_folder: String,
    pub live_folder: String,
    pub backup_folder: String,
    pub custom: bool,
    pub setup_required: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Preview {
    folder: String,
    existing: bool,
    source_unavailable: bool,
    initial_setup: bool,
    items: usize,
    records: usize,
}
pub(super) struct Pending {
    folder: PathBuf,
    source: PathBuf,
    source_revision: String,
    target_bytes: Option<Vec<u8>>,
    is_default: bool,
    source_unavailable: bool,
    initial_setup: bool,
}
fn settings(root: &Path) -> Result<Settings, String> {
    match fs::read(root.join("storage-settings.json")) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("存储设置损坏，原数据未改动：{e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("无法读取存储设置：{e}")),
    }
}
fn setup_required(root: &Path) -> Result<bool, String> {
    settings(root)?;
    if root.join("storage-settings.json").is_file() {
        return Ok(false);
    }
    let legacy = workspace_dir(root, false);
    if legacy.join("state.json").exists() {
        return Ok(false);
    }
    match fs::read_dir(&legacy) {
        Ok(entries) => {
            for entry in entries {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().and_then(|s| s.to_str()) == Some("json")
                    && path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .is_some_and(valid_date)
                {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(format!("无法检查已有数据：{e}")),
    }
}
pub(super) fn live_folder(root: &Path) -> Result<PathBuf, String> {
    Ok(settings(root)?
        .folder
        .unwrap_or_else(|| workspace_dir(root, false)))
}
pub(super) fn info(root: &Path) -> Result<Info, String> {
    let config = settings(root)?;
    let default = workspace_dir(root, false);
    Ok(Info {
        default_folder: default.to_string_lossy().into(),
        live_folder: config
            .folder
            .as_ref()
            .unwrap_or(&default)
            .to_string_lossy()
            .into(),
        backup_folder: root.join("storage-backups").to_string_lossy().into(),
        custom: config.folder.is_some(),
        setup_required: setup_required(root)?,
    })
}
pub(super) fn directory(root: &Path, simulated: bool) -> Result<PathBuf, String> {
    if setup_required(root)? {
        return Err("请先设置数据文件夹，再开始记录。".into());
    }
    if simulated {
        let path = workspace_dir(root, true);
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        return Ok(path);
    }
    let config = settings(root)?;
    if let Some(path) = config.folder {
        // Never create a replacement empty dataset if a cloud folder is missing/offline.
        require_file(&path)?;
        Ok(path)
    } else {
        let path = workspace_dir(root, false);
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        Ok(path)
    }
}
pub(super) fn read_current(root: &Path, simulated: bool) -> Result<Store, String> {
    let folder = directory(root, simulated)?;
    read_store_impl(&folder, simulated || settings(root)?.folder.is_none())
}
fn require_file(folder: &Path) -> Result<(), String> {
    if !folder.is_dir() || !folder.join("state.json").is_file() {
        return Err("数据目录或 state.json 暂不可用。请在 Finder 中确认已下载，或重新连接目录，再刷新；不会自动创建空数据。可在设置 → 数据存储中切换位置。".into());
    }
    Ok(())
}
fn bytes(folder: &Path) -> Result<Vec<u8>, String> {
    fs::read(folder.join("state.json")).map_err(|e| format!("无法读取记录，请确认文件已下载：{e}"))
}
fn hash(folder: &Path, data: &[u8]) -> Result<String, String> {
    let mut digest = Sha256::new();
    digest.update(
        fs::canonicalize(folder)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .as_bytes(),
    );
    digest.update([0]);
    digest.update(data);
    Ok(format!("{:x}", digest.finalize()))
}
pub(super) fn revision(folder: &Path) -> Result<String, String> {
    hash(folder, &bytes(folder)?)
}
pub(super) fn revision_for_store(folder: &Path, store: &Store) -> Result<String, String> {
    let data = bytes(folder)?;
    let actual: Store = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    if serde_json::to_value(&actual).map_err(|e| e.to_string())?
        != serde_json::to_value(store).map_err(|e| e.to_string())?
    {
        return Err("读取期间数据发生变化，请重试。".into());
    }
    hash(folder, &data)
}
fn ensure_revision(folder: &Path, expected: &str) -> Result<(), String> {
    if revision(folder)? != expected {
        return Err(
            "数据已被其他设备或程序修改，本次未覆盖。请先复制未保存的内容，再点击刷新记录。".into(),
        );
    }
    Ok(())
}
fn backup(root: &Path, contents: &[u8], reason: &str) -> Result<(), String> {
    let parent = root.join("storage-backups");
    fs::create_dir_all(&parent).map_err(|e| format!("无法创建本地备份：{e}"))?;
    let path = parent.join(format!(
        "{}-{reason}.json",
        Local::now().format("%Y%m%d-%H%M%S-%f")
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("无法保存本地备份：{e}"))?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("备份失败，操作已取消：{e}"))
}
fn save_settings(root: &Path, folder: Option<PathBuf>) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(&Settings { folder }).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    tmp.write_all(&data)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    tmp.persist(root.join("storage-settings.json"))
        .map_err(|e| format!("切换存储设置失败，原位置仍然有效：{e}"))?;
    Ok(())
}
fn local_lock(folder: &Path) -> Result<fs::File, String> {
    let f = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(folder.join(".daily-log.lock"))
        .map_err(|e| format!("无法锁定数据目录：{e}"))?;
    f.try_lock_exclusive()
        .map_err(|_| "另一个日日记实例正在保存，请稍后重试。".to_string())?;
    Ok(f)
}
pub(super) fn guarded_write(
    root: &Path,
    folder: &Path,
    store: &Store,
    expected: &str,
) -> Result<(), String> {
    validate(store)?;
    let _lock = local_lock(folder)?;
    if let Err(error) = ensure_revision(folder, expected) {
        let draft = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
        backup(root, &draft, "unsaved-conflict")?;
        return Err(format!("{error} 本次修改副本已保存在本机备份中。"));
    }
    let original = bytes(folder)?;
    backup(root, &original, "before-save")?;
    ensure_revision(folder, expected)?;
    write_store(folder, store)
}
fn preview(
    root: &Path,
    folder: &Path,
    source: &Path,
    expected: &str,
    is_default: bool,
) -> Result<(Preview, Pending), String> {
    let initial_setup = setup_required(root)?;
    let folder = fs::canonicalize(folder).map_err(|e| format!("无法访问选择的目录：{e}"))?;
    let source_unavailable = bytes(source).is_err();
    let source = fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    if folder == source && !initial_setup {
        return Err("这已经是当前存储目录。".into());
    }
    let local = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if folder.starts_with(&local) && !(is_default && folder == workspace_dir(&local, false)) {
        return Err("请选择应用私有数据目录以外的文件夹，调试和备份目录不能用于同步。".into());
    }
    let target_bytes = match fs::read(folder.join("state.json")) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // An apparently empty cloud placeholder directory is not a new dataset.
            if fs::read_dir(&folder)
                .map_err(|e| e.to_string())?
                .any(|entry| {
                    entry.map_or(true, |e| {
                        e.file_name() != ".daily-log.lock" && e.file_name() != ".DS_Store"
                    })
                })
            {
                return Err("所选文件夹没有可读取的 state.json，但包含其他文件。请等待下载完成，或选择一个空的专用文件夹。".into());
            }
            None
        }
        Err(e) => return Err(format!("无法读取目标数据，请确认文件已下载：{e}")),
    };
    // Validate without migrating or otherwise touching the selected folder.
    let (items, records) = if let Some(ref b) = target_bytes {
        let staging = tempfile::tempdir().map_err(|e| e.to_string())?;
        fs::write(staging.path().join("state.json"), b).map_err(|e| e.to_string())?;
        let store = read_store(staging.path())?;
        (store.items.len(), store.records.len())
    } else {
        (0, 0)
    };
    if source_unavailable && target_bytes.is_none() && !initial_setup {
        return Err(
            "原数据暂不可用，不能迁移到空目录。请恢复原目录，或选择已有日日记数据的文件夹。".into(),
        );
    }
    // Validate readability and writability without replacing user files.
    tempfile::NamedTempFile::new_in(&folder).map_err(|e| format!("所选目录不可写：{e}"))?;
    Ok((
        Preview {
            folder: folder.to_string_lossy().into(),
            existing: target_bytes.is_some(),
            source_unavailable: source_unavailable && !initial_setup,
            initial_setup,
            items,
            records,
        },
        Pending {
            folder,
            source,
            source_revision: expected.into(),
            target_bytes,
            is_default,
            source_unavailable,
            initial_setup,
        },
    ))
}
fn confirm(root: &Path, pending: &Pending, expected: &str) -> Result<(), String> {
    if pending.initial_setup != setup_required(root)? {
        return Err("数据存储配置已变化，请刷新后重新选择目录。".into());
    }
    if pending.source_revision != expected {
        return Err("预览后源数据已变化，请重新选择目录。".into());
    }
    let active = live_folder(root)?;
    // Permit recovery from an unavailable source only when opening existing valid data.
    if fs::canonicalize(&active).unwrap_or(active) != pending.source {
        return Err("存储位置已变化，请重新选择。".into());
    }
    let _source_lock = if pending.source_unavailable {
        None
    } else {
        Some(local_lock(&pending.source)?)
    };
    if pending.source_unavailable {
        if bytes(&pending.source).is_ok() {
            return Err("原目录已恢复可用，请重新选择以备份最新数据。".into());
        }
    } else {
        ensure_revision(&pending.source, expected)?;
    }
    let _target_lock = local_lock(&pending.folder)?;
    let now = match fs::read(pending.folder.join("state.json")) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if now != pending.target_bytes {
        return Err("目标数据在预览后发生变化，本次未覆盖，请重新选择。".into());
    }
    if !pending.source_unavailable {
        let original = bytes(&pending.source)?;
        backup(root, &original, "before-switch")?;
    }
    if let Some(ref target) = now {
        backup(root, target, "target-before-open")?;
        read_store_impl(&pending.folder, false)?;
    } else {
        let store = if pending.initial_setup {
            Store {
                version: 6,
                ..Default::default()
            }
        } else {
            read_store_impl(&pending.source, false)?
        };
        // Create only if absent, even if a remote file appears after the preview.
        let data = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
        let mut tmp =
            tempfile::NamedTempFile::new_in(&pending.folder).map_err(|e| e.to_string())?;
        tmp.write_all(&data)
            .and_then(|_| tmp.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        tmp.persist_noclobber(pending.folder.join("state.json"))
            .map_err(|e| format!("迁移未覆盖任何已有文件：{e}"))?;
        if bytes(&pending.folder)? != data {
            return Err("迁移校验失败，仍使用原目录。".into());
        }
    }
    if !pending.source_unavailable {
        ensure_revision(&pending.source, expected)?;
    }
    save_settings(
        root,
        if pending.is_default {
            None
        } else {
            Some(pending.folder.clone())
        },
    )
}
#[tauri::command]
pub(super) fn storage_info(app: tauri::AppHandle) -> Result<Info, String> {
    info(&app.path().app_data_dir().map_err(|e| e.to_string())?)
}
#[tauri::command]
pub(super) async fn choose_storage_folder(
    app: tauri::AppHandle,
    use_default: bool,
    expected_revision: String,
    clock_generation: u64,
    lock: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Option<Preview>, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let folder = if use_default {
        let p = workspace_dir(&root, false);
        fs::create_dir_all(&p).map_err(|e| e.to_string())?;
        p
    } else {
        let handle = app.clone();
        let chosen = tauri::async_runtime::spawn_blocking(move || {
            handle
                .dialog()
                .file()
                .set_title("选择日日记数据文件夹（可选 iCloud Drive 中的专用文件夹）")
                .blocking_pick_folder()
        })
        .await
        .map_err(|e| e.to_string())?;
        match chosen {
            Some(p) => p.into_path().map_err(|e| e.to_string())?,
            None => return Ok(None),
        }
    };
    let mut state = lock.lock().map_err(|e| e.to_string())?;
    ensure_clock(&state, clock_generation)?;
    if state.date_override.is_some() {
        return Err("请先恢复系统日期，再切换正式数据的存储位置。".into());
    }
    let source = live_folder(&root)?;
    if bytes(&source).is_ok() {
        ensure_revision(&source, &expected_revision)?;
    }
    let (view, pending) = preview(&root, &folder, &source, &expected_revision, use_default)?;
    state.pending_storage = Some(pending);
    Ok(Some(view))
}
#[tauri::command]
pub(super) fn confirm_storage_folder(
    app: tauri::AppHandle,
    expected_revision: String,
    clock_generation: u64,
    lock: tauri::State<'_, Mutex<RuntimeState>>,
) -> Result<Snapshot, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut state = lock.lock().map_err(|e| e.to_string())?;
    ensure_clock(&state, clock_generation)?;
    if state.date_override.is_some() {
        return Err("请先恢复系统日期。".into());
    }
    let pending = state
        .pending_storage
        .as_ref()
        .ok_or("请先选择存储文件夹。")?;
    confirm(&root, pending, &expected_revision)?;
    state.pending_storage = None;
    state.generation += 1;
    let folder = directory(&root, false)?;
    snapshot(&folder, read_store_impl(&folder, false)?, &state)
}
#[tauri::command]
pub(super) fn open_storage_backups(app: tauri::AppHandle) -> Result<(), String> {
    let folder = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("storage-backups");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(folder.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf, Store) {
        let root = tempfile::tempdir().unwrap();
        save_settings(root.path(), None).unwrap();
        let source = directory(root.path(), false).unwrap();
        let mut store = read_store(&source).unwrap();
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
            "原始记录".into(),
            "2026-11-15".into(),
            "2026-11-15",
        )
        .unwrap();
        write_store(&source, &store).unwrap();
        (root, source, store)
    }
    #[test]
    fn empty_folder_migration_preserves_bytes_and_local_backup_and_restarts() {
        let (root, source, _) = fixture();
        let target = tempfile::tempdir().unwrap();
        let old = bytes(&source).unwrap();
        let rev = revision(&source).unwrap();
        let (view, pending) = preview(root.path(), target.path(), &source, &rev, false).unwrap();
        assert!(!view.existing);
        assert!(!target.path().join("state.json").exists());
        confirm(root.path(), &pending, &rev).unwrap();
        assert_eq!(bytes(target.path()).unwrap(), old);
        assert_eq!(bytes(&source).unwrap(), old);
        assert_eq!(
            directory(root.path(), false).unwrap(),
            fs::canonicalize(target.path()).unwrap()
        );
        let backups: Vec<_> = fs::read_dir(root.path().join("storage-backups"))
            .unwrap()
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(backups[0].as_ref().unwrap().path()).unwrap(), old);
        let (_, restore) = preview(
            root.path(),
            &source,
            target.path(),
            &revision(target.path()).unwrap(),
            true,
        )
        .unwrap();
        confirm(root.path(), &restore, &revision(target.path()).unwrap()).unwrap();
        assert!(!info(root.path()).unwrap().custom);
    }
    #[test]
    fn existing_data_is_previewed_without_writes_then_opened_without_merging() {
        let (root, source, _) = fixture();
        let target = tempfile::tempdir().unwrap();
        let old_store = serde_json::json!({"version":5,"items":[],"records":[]});
        let old = serde_json::to_vec(&old_store).unwrap();
        fs::write(target.path().join("state.json"), &old).unwrap();
        let rev = revision(&source).unwrap();
        let (view, pending) = preview(root.path(), target.path(), &source, &rev, false).unwrap();
        assert!(view.existing);
        assert_eq!(view.records, 0);
        assert_eq!(bytes(target.path()).unwrap(), old);
        assert!(!target.path().join("state-v5.backup.json").exists());
        confirm(root.path(), &pending, &rev).unwrap();
        assert!(read_store(target.path()).unwrap().items.is_empty());
        assert_eq!(read_store(&source).unwrap().records.len(), 1);
        assert_eq!(
            fs::read(target.path().join("state-v5.backup.json")).unwrap(),
            old
        );
    }
    #[test]
    fn stale_source_or_target_never_changes_settings_or_overwrites_target() {
        let (root, source, mut store) = fixture();
        let target = tempfile::tempdir().unwrap();
        let rev = revision(&source).unwrap();
        let (_, pending) = preview(root.path(), target.path(), &source, &rev, false).unwrap();
        store.records[0].note = "另一台设备".into();
        write_store(&source, &store).unwrap();
        assert!(confirm(root.path(), &pending, &rev).is_err());
        assert!(!target.path().join("state.json").exists());
        assert!(!info(root.path()).unwrap().custom);
        let current = revision(&source).unwrap();
        let (_, pending) = preview(root.path(), target.path(), &source, &current, false).unwrap();
        fs::write(target.path().join("state.json"), b"new remote file").unwrap();
        assert!(confirm(root.path(), &pending, &current).is_err());
        assert_eq!(bytes(target.path()).unwrap(), b"new remote file");
        assert!(!info(root.path()).unwrap().custom);
    }
    #[test]
    fn guarded_save_rejects_remote_changes_and_backs_up_successful_save() {
        let (root, source, mut store) = fixture();
        let rev = revision(&source).unwrap();
        let original = bytes(&source).unwrap();
        store.records[0].note = "更新".into();
        guarded_write(root.path(), &source, &store, &rev).unwrap();
        let updated = bytes(&source).unwrap();
        assert_ne!(original, updated);
        assert!(guarded_write(root.path(), &source, &store, &rev).is_err());
        assert_eq!(bytes(&source).unwrap(), updated);
        assert!(
            fs::read_dir(root.path().join("storage-backups"))
                .unwrap()
                .any(|entry| fs::read(entry.unwrap().path()).unwrap() == original)
        );
        // A mismatched read may not expose new bytes as the old store's revision.
        let mut stale = store;
        stale.records[0].note = "陈旧表单".into();
        assert!(revision_for_store(&source, &stale).is_err());
    }
    #[test]
    fn missing_cloud_data_does_not_create_empty_store_and_can_recover_existing_data() {
        let (root, source, _) = fixture();
        let cloud = tempfile::tempdir().unwrap();
        save_settings(root.path(), Some(cloud.path().join("missing"))).unwrap();
        assert!(directory(root.path(), false).is_err());
        assert!(!cloud.path().join("missing").exists());
        let empty = tempfile::tempdir().unwrap();
        assert!(
            preview(
                root.path(),
                empty.path(),
                &cloud.path().join("missing"),
                "",
                false
            )
            .is_err()
        );
        let (_, pending) = preview(
            root.path(),
            &source,
            &cloud.path().join("missing"),
            "",
            true,
        )
        .unwrap();
        assert!(pending.source_unavailable);
        confirm(root.path(), &pending, "").unwrap();
        assert!(!info(root.path()).unwrap().custom);
        assert_eq!(read_store(&source).unwrap().records.len(), 1);
    }
    #[test]
    fn invalid_or_placeholder_folders_are_rejected_and_debug_remains_local() {
        let (root, source, _) = fixture();
        let target = tempfile::tempdir().unwrap();
        fs::write(target.path().join(".state.json.icloud"), "placeholder").unwrap();
        let rev = revision(&source).unwrap();
        assert!(preview(root.path(), target.path(), &source, &rev, false).is_err());
        fs::write(target.path().join("state.json"), "broken").unwrap();
        assert!(preview(root.path(), target.path(), &source, &rev, false).is_err());
        assert_eq!(bytes(target.path()).unwrap(), b"broken");
        fs::remove_file(target.path().join(".state.json.icloud")).unwrap();
        fs::remove_file(target.path().join("state.json")).unwrap();
        let (_, pending) = preview(root.path(), target.path(), &source, &rev, false).unwrap();
        confirm(root.path(), &pending, &rev).unwrap();
        let cloud_before = bytes(target.path()).unwrap();
        prepare_debug_store(root.path()).unwrap();
        let debug = directory(root.path(), true).unwrap();
        assert_eq!(debug, workspace_dir(root.path(), true));
        let mut simulated = read_store(&debug).unwrap();
        simulated.records[0].note = "调试".into();
        guarded_write(root.path(), &debug, &simulated, &revision(&debug).unwrap()).unwrap();
        assert_eq!(bytes(target.path()).unwrap(), cloud_before);
    }
    #[test]
    fn fresh_install_requires_choice_and_preview_does_not_initialize_data() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source = workspace_dir(root.path(), false);
        assert!(info(root.path()).unwrap().setup_required);
        assert!(read_current(root.path(), false).is_err());
        assert!(!source.exists());
        let (view, _cancelled) = preview(root.path(), target.path(), &source, "", false).unwrap();
        assert!(view.initial_setup);
        assert!(!view.source_unavailable);
        assert!(!target.path().join("state.json").exists());
        assert!(!root.path().join("storage-settings.json").exists());
        assert!(setup_required(root.path()).unwrap());
    }
    #[test]
    fn first_setup_creates_custom_folder_only_after_confirmation_and_survives_restart() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source = workspace_dir(root.path(), false);
        let (_, pending) = preview(root.path(), target.path(), &source, "", false).unwrap();
        confirm(root.path(), &pending, "").unwrap();
        assert!(!setup_required(root.path()).unwrap());
        let loaded = read_current(root.path(), false).unwrap();
        assert_eq!(loaded.version, 6);
        assert!(loaded.items.is_empty() && loaded.records.is_empty());
        assert_eq!(
            directory(root.path(), false).unwrap(),
            fs::canonicalize(target.path()).unwrap()
        );
        assert!(!source.exists());
    }
    #[test]
    fn first_setup_can_explicitly_select_the_default_folder() {
        let root = tempfile::tempdir().unwrap();
        let folder = workspace_dir(root.path(), false);
        fs::create_dir_all(&folder).unwrap();
        let (_, pending) = preview(root.path(), &folder, &folder, "", true).unwrap();
        confirm(root.path(), &pending, "").unwrap();
        assert!(!info(root.path()).unwrap().setup_required);
        assert!(!info(root.path()).unwrap().custom);
        assert!(folder.join("state.json").exists());
        assert!(root.path().join("storage-settings.json").exists());
        assert!(read_current(root.path(), false).unwrap().items.is_empty());
    }
    #[test]
    fn first_setup_opens_existing_data_without_merging_or_changing_records() {
        let (other_root, original_folder, _) = fixture();
        let original = bytes(&original_folder).unwrap();
        let root = tempfile::tempdir().unwrap();
        let source = workspace_dir(root.path(), false);
        let (view, pending) = preview(root.path(), &original_folder, &source, "", false).unwrap();
        assert!(view.existing && view.initial_setup);
        assert_eq!(view.records, 1);
        confirm(root.path(), &pending, "").unwrap();
        assert_eq!(bytes(&original_folder).unwrap(), original);
        assert_eq!(
            read_current(root.path(), false).unwrap().records[0].note,
            "原始记录"
        );
        assert!(!setup_required(root.path()).unwrap());
        assert!(!source.exists());
        assert_eq!(
            read_current(other_root.path(), false)
                .unwrap()
                .records
                .len(),
            1
        );
    }
    #[test]
    fn legacy_data_is_recognized_and_first_setup_rejects_a_stale_target() {
        let root = tempfile::tempdir().unwrap();
        let source = workspace_dir(root.path(), false);
        fs::create_dir_all(&source).unwrap();
        let store = read_store(&source).unwrap();
        assert!(!setup_required(root.path()).unwrap());
        assert_eq!(
            read_current(root.path(), false).unwrap().records,
            store.records
        );
        fs::remove_file(source.join("state.json")).unwrap();
        fs::write(
            source.join("2026-11-12.json"),
            r#"{"date":"2026-11-12","createdAt":"2026-11-12T12:00:00+08:00","note":"旧日志"}"#,
        )
        .unwrap();
        assert!(!setup_required(root.path()).unwrap());
        assert_eq!(
            read_current(root.path(), false).unwrap().records[0].note,
            "旧日志"
        );
        let fresh = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let (_, pending) = preview(
            fresh.path(),
            target.path(),
            &workspace_dir(fresh.path(), false),
            "",
            false,
        )
        .unwrap();
        fs::write(target.path().join("state.json"), "remote data appeared").unwrap();
        assert!(confirm(fresh.path(), &pending, "").is_err());
        assert_eq!(bytes(target.path()).unwrap(), b"remote data appeared");
        assert!(setup_required(fresh.path()).unwrap());
    }
}
