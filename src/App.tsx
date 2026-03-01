import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import zhCN from "./i18n/zh_cn.json";
import enUS from "./i18n/en_us.json";
import "./App.css";

type ToolId =
  | "audioMorph"
  | "quickTransImg"
  | "smartImageSquish"
  | "vExtractor"
  | "videoXpress";

type FileKind = "audio" | "image" | "video";

type Lang = "zh" | "en";

type Messages = typeof zhCN;

const locales: Record<Lang, Messages> = {
  zh: zhCN,
  en: enUS,
};

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("audioMorph");
  const [files, setFiles] = useState<string[]>([]);
  const [targetFormat, setTargetFormat] = useState("mp3");
  const [imageExt, setImageExt] = useState("webp");
  const [maxSize, setMaxSize] = useState("0");
  const [squishMode, setSquishMode] = useState<"1" | "2" | "3" | "4">("2");
  const [extractMode, setExtractMode] = useState<"1" | "2" | "3">("1");
  const [videoMode, setVideoMode] = useState<
    "1" | "2" | "3" | "4" | "5" | "6"
  >("1");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [showFileList, setShowFileList] = useState(false);
  const [lang, setLang] = useState<Lang>("zh");
  const logRef = useRef<HTMLDivElement | null>(null);
  const messages = locales[lang];
  const t = (key: keyof Messages | string) =>
    (messages as Record<string, string>)[key as string] ?? key;

  const tools: ToolId[] = [
    "audioMorph",
    "quickTransImg",
    "smartImageSquish",
    "vExtractor",
    "videoXpress",
  ];

  type DragDropPayload = { paths: string[] };

  useEffect(() => {
    let unlistenDrop: (() => void) | undefined;
    let unlistenEnter: (() => void) | undefined;
    let unlistenLeave: (() => void) | undefined;

    listen<DragDropPayload>("tauri://drag-drop", (event) => {
      const payload = event.payload;
      const paths = Array.isArray((payload as any).paths)
        ? (payload as any).paths
        : (payload as any);
      if (Array.isArray(paths) && paths.length) {
        setFiles(paths as string[]);
      }
      setDragActive(false);
    })
      .then((dispose) => {
        unlistenDrop = dispose;
      })
      .catch(() => {});

    listen("tauri://drag-enter", () => {
      setDragActive(true);
    })
      .then((dispose) => {
        unlistenEnter = dispose;
      })
      .catch(() => {});

    listen("tauri://drag-leave", () => {
      setDragActive(false);
    })
      .then((dispose) => {
        unlistenLeave = dispose;
      })
      .catch(() => {});

    return () => {
      if (unlistenDrop) unlistenDrop();
      if (unlistenEnter) unlistenEnter();
      if (unlistenLeave) unlistenLeave();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("ffmpeg-log", (event) => {
      setLog((prev) =>
        prev ? `${prev}\n${event.payload}` : event.payload,
      );
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(() => {});
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [log]);

  function fileKindFor(tool: ToolId): FileKind {
    if (tool === "quickTransImg" || tool === "smartImageSquish") {
      return "image";
    }
    if (tool === "videoXpress" || tool === "vExtractor") {
      return "video";
    }
    return "audio";
  }

  async function handlePickFiles() {
    const kind = fileKindFor(activeTool);
    const filters =
      kind === "audio"
        ? [
            {
              name: "音频",
              extensions: ["mp3", "m4a", "aac", "flac", "wav", "ogg"],
            },
          ]
        : kind === "image"
        ? [
            {
              name: "图像",
              extensions: ["jpg", "jpeg", "png", "webp", "avif", "bmp"],
            },
          ]
        : [
            {
              name: "视频",
              extensions: ["mp4", "mov", "mkv", "avi", "webm"],
            },
          ];

    const result = await open({
      multiple: true,
      directory: false,
      filters,
    });

    if (!result) {
      return;
    }

    setFiles(Array.isArray(result) ? (result as string[]) : [result as string]);
  }

  async function handleRun() {
    if (!files.length) {
      setLog(t("common.selectFilesFirst"));
      return;
    }
    setBusy(true);
    setLog("");
    try {
      if (activeTool === "audioMorph") {
        await invoke("audio_morph", {
          files,
          target_format: targetFormat,
        });
      } else if (activeTool === "quickTransImg") {
        await invoke("quick_trans_img", {
          files,
          target_ext: imageExt,
        });
      } else if (activeTool === "smartImageSquish") {
        const parsedMax = parseInt(maxSize, 10);
        await invoke("smart_image_squish", {
          files,
          max_size_kb: Number.isNaN(parsedMax) ? 0 : parsedMax,
          mode: parseInt(squishMode, 10),
        });
      } else if (activeTool === "vExtractor") {
        await invoke("v_extractor", {
          files,
          choice: parseInt(extractMode, 10),
        });
      } else if (activeTool === "videoXpress") {
        await invoke("video_xpress", {
          files,
          mode: parseInt(videoMode, 10),
        });
      }
      setLog(t("common.done"));
      setFiles([]);
      setShowFileList(false);
    } catch (error) {
      if (error instanceof Error) {
        setLog(error.message);
      } else {
        setLog(String(error));
      }
    } finally {
      setBusy(false);
    }
  }

  function renderFileSummary() {
    if (!files.length) {
      return (
        <span className="file-summary">
          {t("common.noFiles")}
        </span>
      );
    }
    if (files.length === 1) {
      return (
        <span className="file-summary">
          {t("common.fileSinglePrefix")}
          {files[0].split(/[/\\]/).pop()}
        </span>
      );
    }
    return (
      <span className="file-summary">
        {t("common.fileMultiPrefix").replace(
          "{count}",
          String(files.length),
        )}
        {files[0].split(/[/\\]/).pop()}
      </span>
    );
  }

  function renderFileListPanel() {
    if (files.length <= 1) {
      return null;
    }
    return (
      <div className="file-list-panel">
        <button
          type="button"
          className="file-list-toggle"
          onClick={() => setShowFileList((v) => !v)}
        >
          {showFileList ? t("common.fileListHide") : t("common.fileListShow")}
        </button>
        {showFileList && (
          <div className="file-list">
            {files.map((f, idx) => (
              <div key={f} className="file-list-item">
                <span className="file-list-index">{idx + 1}.</span>
                <span className="file-list-name">
                  {f.split(/[/\\]/).pop()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderPreview() {
    if (!files.length) {
      return null;
    }
    const primary = files[0];
    const kind = fileKindFor(activeTool);
    if (kind === "image") {
      return (
        <div className="preview-panel">
          <img
            className="preview-media"
            src={convertFileSrc(primary)}
            alt=""
          />
        </div>
      );
    }
    if (kind === "video") {
      return (
        <div className="preview-panel">
          <video
            className="preview-media"
            src={convertFileSrc(primary)}
            controls
            muted
          />
        </div>
      );
    }
    return (
      <div className="preview-panel preview-placeholder">
        {t("common.audioPreviewHint")}
      </div>
    );
  }

  function renderActivePanel() {
    if (activeTool === "audioMorph") {
      return (
        <>
          <div className="panel-header">
            <div>
              <h2>{t("audioMorph.panelTitle")}</h2>
              <p className="panel-subtitle">{t("audioMorph.panelSubtitle")}</p>
            </div>
            <div className="panel-meta">
              {t("audioMorph.panelMeta")}
            </div>
          </div>
          <div className="panel-body">
            <div className="field-row">
              <label className="field-label">
                {t("audioMorph.targetFormat")}
              </label>
              <select
                className="field-control"
                value={targetFormat}
                onChange={(e) => setTargetFormat(e.target.value)}
              >
                <option value="mp3">MP3</option>
                <option value="m4a">AAC / M4A</option>
                <option value="ogg">OGG</option>
                <option value="wav">WAV</option>
              </select>
            </div>
            <div className="field-row file-row">
              <button
                type="button"
                className="button secondary"
                onClick={handlePickFiles}
                disabled={busy}
              >
                {t("audioMorph.pickFiles")}
              </button>
              {renderFileSummary()}
            </div>
            <div className={dragActive ? "drop-zone active" : "drop-zone"}>
              {t("common.dropHint")}
            </div>
            {renderFileListPanel()}
            {renderPreview()}
          </div>
        </>
      );
    }

    if (activeTool === "quickTransImg") {
      return (
        <>
          <div className="panel-header">
            <div>
              <h2>{t("quickTransImg.panelTitle")}</h2>
              <p className="panel-subtitle">
                {t("quickTransImg.panelSubtitle")}
              </p>
            </div>
            <div className="panel-meta">
              {t("quickTransImg.panelMeta")}
            </div>
          </div>
          <div className="panel-body">
            <div className="field-row">
              <label className="field-label">
                {t("quickTransImg.targetSuffix")}
              </label>
              <select
                className="field-control"
                value={imageExt}
                onChange={(e) => setImageExt(e.target.value)}
              >
                <option value="jpg">JPG</option>
                <option value="png">PNG</option>
                <option value="webp">WebP</option>
                <option value="bmp">BMP</option>
              </select>
            </div>
            <div className="field-row file-row">
              <button
                type="button"
                className="button secondary"
                onClick={handlePickFiles}
                disabled={busy}
              >
                {t("quickTransImg.pickFiles")}
              </button>
              {renderFileSummary()}
            </div>
            <div className={dragActive ? "drop-zone active" : "drop-zone"}>
              {t("common.dropHint")}
            </div>
            {renderFileListPanel()}
            {renderPreview()}
          </div>
        </>
      );
    }

    if (activeTool === "smartImageSquish") {
      return (
        <>
          <div className="panel-header">
            <div>
              <h2>{t("smartImageSquish.panelTitle")}</h2>
              <p className="panel-subtitle">
                {t("smartImageSquish.panelSubtitle")}
              </p>
            </div>
            <div className="panel-meta">
              {t("smartImageSquish.panelMeta")}
            </div>
          </div>
          <div className="panel-body">
            <div className="field-row">
              <label className="field-label">
                {t("smartImageSquish.maxSize")}
              </label>
              <div className="inline-input">
                <input
                  className="field-control"
                  value={maxSize}
                  onChange={(e) => setMaxSize(e.target.value)}
                  inputMode="numeric"
                  placeholder="0"
                />
                <span className="inline-addon">
                  {t("smartImageSquish.maxSizeHint")}
                </span>
              </div>
            </div>
            <div className="field-row">
              <label className="field-label">
                {t("smartImageSquish.mode")}
              </label>
              <select
                className="field-control"
                value={squishMode}
                onChange={(e) =>
                  setSquishMode(e.target.value as "1" | "2" | "3" | "4")
                }
              >
                <option value="1">{t("smartImageSquish.mode1")}</option>
                <option value="2">{t("smartImageSquish.mode2")}</option>
                <option value="3">{t("smartImageSquish.mode3")}</option>
                <option value="4">{t("smartImageSquish.mode4")}</option>
              </select>
            </div>
            <div className="field-row file-row">
              <button
                type="button"
                className="button secondary"
                onClick={handlePickFiles}
                disabled={busy}
              >
                {t("smartImageSquish.pickFiles")}
              </button>
              {renderFileSummary()}
            </div>
            <div className={dragActive ? "drop-zone active" : "drop-zone"}>
              {t("common.dropHint")}
            </div>
            {renderFileListPanel()}
            {renderPreview()}
          </div>
        </>
      );
    }

    if (activeTool === "vExtractor") {
      return (
        <>
          <div className="panel-header">
            <div>
              <h2>{t("vExtractor.panelTitle")}</h2>
              <p className="panel-subtitle">{t("vExtractor.panelSubtitle")}</p>
            </div>
            <div className="panel-meta">
              {t("vExtractor.panelMeta")}
            </div>
          </div>
          <div className="panel-body">
            <div className="field-row">
              <label className="field-label">
                {t("vExtractor.preset")}
              </label>
              <select
                className="field-control"
                value={extractMode}
                onChange={(e) =>
                  setExtractMode(e.target.value as "1" | "2" | "3")
                }
              >
                <option value="1">{t("vExtractor.mode1")}</option>
                <option value="2">{t("vExtractor.mode2")}</option>
                <option value="3">{t("vExtractor.mode3")}</option>
              </select>
            </div>
            <div className="field-row file-row">
              <button
                type="button"
                className="button secondary"
                onClick={handlePickFiles}
                disabled={busy}
              >
                {t("vExtractor.pickFiles")}
              </button>
              {renderFileSummary()}
            </div>
            <div className={dragActive ? "drop-zone active" : "drop-zone"}>
              {t("common.dropHint")}
            </div>
            {renderFileListPanel()}
            {renderPreview()}
          </div>
        </>
      );
    }

    return (
      <>
        <div className="panel-header">
          <div>
            <h2>{t("videoXpress.panelTitle")}</h2>
            <p className="panel-subtitle">{t("videoXpress.panelSubtitle")}</p>
          </div>
          <div className="panel-meta">
            {t("videoXpress.panelMeta")}
          </div>
        </div>
        <div className="panel-body">
          <div className="field-row">
            <label className="field-label">
              {t("videoXpress.mode")}
            </label>
            <select
              className="field-control"
              value={videoMode}
              onChange={(e) =>
                setVideoMode(
                  e.target.value as "1" | "2" | "3" | "4" | "5" | "6",
                )
              }
            >
              <option value="1">{t("videoXpress.mode1")}</option>
              <option value="2">{t("videoXpress.mode2")}</option>
              <option value="3">{t("videoXpress.mode3")}</option>
              <option value="4">{t("videoXpress.mode4")}</option>
              <option value="5">{t("videoXpress.mode5")}</option>
              <option value="6">{t("videoXpress.mode6")}</option>
            </select>
          </div>
          <div className="field-row file-row">
            <button
              type="button"
              className="button secondary"
              onClick={handlePickFiles}
              disabled={busy}
            >
              {t("videoXpress.pickFiles")}
            </button>
            {renderFileSummary()}
          </div>
          <div className={dragActive ? "drop-zone active" : "drop-zone"}>
            {t("common.dropHint")}
          </div>
          {renderFileListPanel()}
          {renderPreview()}
        </div>
      </>
    );
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="title-block">
          <h1>FFmpeg Automation Studio</h1>
          <p className="subtitle">
            {t("app.subtitle")}
          </p>
        </div>
        <div className="header-meta">
          <span className="badge">{t("app.badgeScripts")}</span>
          <span className="badge">{t("app.badgeUnified")}</span>
          <div className="lang-switch">
            <button
              type="button"
              className={lang === "zh" ? "lang-btn active" : "lang-btn"}
              onClick={() => setLang("zh")}
            >
              {t("app.langZh")}
            </button>
            <button
              type="button"
              className={lang === "en" ? "lang-btn active" : "lang-btn"}
              onClick={() => setLang("en")}
            >
              {t("app.langEn")}
            </button>
          </div>
        </div>
      </header>
      <main className="app-main">
        <section className="tool-list">
          {tools.map((tool) => (
            <button
              key={tool}
              type="button"
              className={
                tool === activeTool ? "tool-card active" : "tool-card"
              }
              onClick={() => setActiveTool(tool)}
              disabled={busy && tool !== activeTool}
            >
              <div className="tool-card-label">
                {t(`${tool}.cardLabel`)}
              </div>
              <div className="tool-card-en">
                {t(`${tool}.cardEn`)}
              </div>
              <div className="tool-card-desc">
                {t(`${tool}.cardDesc`)}
              </div>
            </button>
          ))}
        </section>
        <section className="tool-panel">
          {renderActivePanel()}
          <div className="panel-footer">
            <div className="footer-left">
              <button
                type="button"
                className="button primary"
                onClick={handleRun}
                disabled={busy}
              >
                {busy ? t("common.processing") : t("common.run")}
              </button>
            </div>
            <div className="log-area" ref={logRef}>
              {log && <span className="log-text">{log}</span>}
              {!log && (
                <span className="log-placeholder">
                  {t("common.defaultHint")}
                </span>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
