/** chat attachments — contract: docs/contracts-v3.md → "attachments" */

export interface Attachment {
  path: string;
  mime: string;
  bytes: number;
}

export interface PickedFile {
  file: File;
  /** relative path: `name` or `dir/sub/name` for folders */
  path: string;
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 200;
export const MAX_REQUEST_BYTES = 100 * 1024 * 1024;

const root = (conv: string) => `/api/workspace/${encodeURIComponent(conv)}`;

/** raw bytes for previews (images inline, everything else as a download) */
export const rawUrl = (conv: string, path: string) =>
  `${root(conv)}/raw?path=${encodeURIComponent(path)}`;

export const isImageMime = (mime: string) => /^image\/(png|jpe?g|webp|gif)$/i.test(mime);

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} b` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} kb` : `${(n / 1024 / 1024).toFixed(1)} mb`;

export interface UploadHandle {
  promise: Promise<Attachment[]>;
  abort: () => void;
}

function parseAttachments(raw: unknown): Attachment[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    if (typeof o.path !== "string") return [];
    return [
      {
        path: o.path,
        mime: typeof o.mime === "string" ? o.mime : "application/octet-stream",
        bytes: typeof o.bytes === "number" ? o.bytes : 0
      }
    ];
  });
}

/** one XHR per file so each chip gets real upload progress */
export function uploadFile(
  conv: string,
  picked: PickedFile,
  onProgress: (fraction: number) => void
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<Attachment[]>((resolve, reject) => {
    xhr.open("POST", `${root(conv)}/upload`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText || "null");
      } catch {
        /* non-json */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(parseAttachments(body));
        return;
      }
      const detail =
        body && typeof body === "object"
          ? ((body as Record<string, unknown>).error ?? (body as Record<string, unknown>).detail)
          : null;
      reject(
        new Error(
          xhr.status === 413
            ? "too large for upload"
            : typeof detail === "string" && detail
              ? detail.toLowerCase()
              : `upload failed (${xhr.status})`
        )
      );
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    const fd = new FormData();
    fd.append("file", picked.file, picked.path);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

/** files from an <input type=file> (folders via webkitdirectory keep webkitRelativePath) */
export const pickedFromList = (list: FileList | null): PickedFile[] =>
  list ? [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name })) : [];

/**
 * Files + folders from a drop. Entries must be taken synchronously inside the
 * drop handler (the DataTransfer is neutered after the event), so call this there.
 */
export function pickedFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntry => e != null);
  const loose = [...dt.files];
  if (entries.length === 0) return Promise.resolve(loose.map((file) => ({ file, path: file.name })));

  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > MAX_FILES) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej)
      );
      out.push({ file, path: `${prefix}${file.name}` });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
          reader.readEntries(res, rej)
        );
        if (batch.length === 0) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
        if (out.length > MAX_FILES) return;
      }
    }
  };
  return (async () => {
    for (const e of entries) await walk(e, "");
    return out;
  })();
}
