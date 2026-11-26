import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "./model";
type Info = { defaultFolder: string; liveFolder: string; backupFolder: string; custom: boolean; setupRequired: boolean };
type Preview = { folder: string; existing: boolean; items: number; records: number; sourceUnavailable?: boolean; initialSetup?: boolean };
export default function StorageSettings({ data, disabled, change, onPending, initialSetup = false }: {
  initialSetup?: boolean;
  data: Snapshot | null;
  disabled: boolean;
  change: (command: string, args: Record<string, unknown>, success: string) => Promise<boolean>;
  onPending: (pending: boolean) => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void invoke<Info>("storage_info").then(setInfo).catch(e => setError(String(e)));
    setPreview(null);
  }, [data?.folder, data?.clock?.generation]);
  async function choose(useDefault: boolean) {
    setError(""); setPreview(null); setWorking(true); onPending(true);
    try {
      const result = await invoke<Preview | null>("choose_storage_folder", {
        useDefault, expectedRevision: data?.storageRevision ?? "",
        clockGeneration: data?.clock?.generation ?? 0,
      });
      setPreview(result);
    } catch(e) { setError(String(e)); }
    finally { setWorking(false); onPending(false); }
  }
  const blocked = disabled || working || !!data?.clock?.simulated || (initialSetup && !info);
  return <section className="storage-settings" aria-label="数据存储设置">
    <div className="storage-card">
      <h2>{initialSetup ? "选择数据文件夹" : "数据存储"}</h2>
      <p className="muted">选择 iCloud Drive 中的专用文件夹，即可交给系统同步；也支持普通本地文件夹。</p>
      <dl>
        <dt>{initialSetup ? "可选的默认位置" : `正式数据位置 · ${info?.custom ? "自选目录" : "本机默认目录"}`}</dt>
        <dd>{info?.liveFolder ?? "正在读取…"}</dd>
        {!initialSetup && <><dt>本机恢复备份</dt><dd>{info?.backupFolder ?? "正在读取…"}</dd></>}
      </dl>
      <div className="storage-actions">
        <button className="primary" disabled={blocked} onClick={() => void choose(false)}>{working ? "正在选择…" : initialSetup ? "选择数据文件夹" : "更改数据文件夹"}</button>
        {initialSetup && <button className="secondary" disabled={blocked} onClick={() => void choose(true)}>使用默认文件夹</button>}
        {info?.custom && <button className="secondary" disabled={blocked} onClick={() => void choose(true)}>恢复默认位置…</button>}
        {!initialSetup && <button className="secondary" disabled={working} onClick={() => void invoke("open_storage_backups").catch(e => setError(String(e)))}>打开本机备份</button>}
      </div>
      {data?.clock?.simulated && <p role="status">当前正在使用模拟日期。请先恢复系统日期，再切换正式数据的位置。</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>
    {preview && <div className="storage-card storage-preview" aria-label="切换预览">
      <h2>{preview.existing ? "打开已有ndaka数据" : initialSetup ? "创建数据文件夹" : "迁移当前数据"}</h2>
      <p className="folder-path">{preview.folder}</p>
      <p>{preview.existing
        ? `目标文件夹包含 ${preview.items} 个项目、${preview.records} 条记录。确认后使用这份数据，不与当前内容合并；原目录仍然保留。`
        : initialSetup ? "确认后在这里创建ndaka的数据文件，之后的打卡和事件都保存在此文件夹。" : `确认后将当前 ${data?.items.length ?? 0} 个项目、${data?.records.length ?? 0} 条记录复制到这里，校验成功后切换。原目录仍然保留。`}</p>
      <p className="muted">{initialSetup ? "已有数据会先校验并备份，再打开；不会自动合并不同数据文件夹。" : "切换前会在本机备份可读取的源数据和目标数据。"}</p>
      {preview.sourceUnavailable && <p role="alert">原数据目录目前不可用，无法备份它的最新内容。这次只打开目标已有数据，原目录和本机历史备份保留。</p>}
      <div className="storage-actions">
        <button className="primary" disabled={blocked} onClick={async () => {
          if(await change("confirm_storage_folder", {}, "存储位置已切换，原数据和本机备份已保留。")) setPreview(null);
        }}>{preview.existing ? "确认使用已有数据" : initialSetup ? "确认并开始使用" : "备份并迁移"}</button>
        <button className="secondary" disabled={blocked} onClick={() => setPreview(null)}>取消</button>
      </div>
    </div>}
    <div className="storage-card">
      <h2>使用 iCloud Drive</h2>
      <ol>
        <li>在 Finder 的 iCloud Drive 中新建一个空文件夹，例如“ndaka”。</li>
        <li>选择刚建的文件夹并确认；已有数据时，可选择打开那份数据。</li>
        <li>在其他电脑上等待文件下载完成，再选择同一个文件夹并打开已有数据。</li>
      </ol>
      <p className="muted">软件显示的是文件保存结果。云端上传、下载由系统处理，此处不显示“已同步”。</p>
      <p className="muted">请避免多台设备同时编辑。保存会检查已到达本机的外部修改并保留本机备份，但不能阻止离线设备稍后产生的同步冲突，也不会自动合并不同版本。</p>
      <p className="muted">目录暂不可用时会停止读写并提示，不会自动创建空数据或悄悄切回默认目录。</p>
    </div>
  </section>;
}
