"""Safe filesystem operations for the explorer.

Every path coming from the browser is a *virtual path* like ``library/Artist/Album`` or ``staging/x``.
`resolve()` maps it onto a configured root and refuses anything that escapes it (``..``, absolute
paths, symlinks pointing elsewhere). All writes first pass `check_writable()`, which refuses to touch
anything while the USB drive is not mounted.
"""

import contextlib
import os
import shutil
import threading
import unicodedata
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from app.config import get_settings

ROOT_KEYS = ("library", "staging")
AUDIO_EXTS = {".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".aiff", ".aif", ".alac", ".wma",
              ".ape", ".wv", ".dsf", ".dff"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
HIDDEN_NAMES = {"thumbs.db", "desktop.ini", ".ds_store"}
STRICT_FS = {"exfat", "vfat", "msdos", "ntfs", "ntfs3", "fuseblk"}
STRICT_FORBIDDEN = set(':?*"<>|\\')
COPY_CHUNK = 1024 * 1024


class FsError(Exception):
    def __init__(self, status: int, message: str, detail: object = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.detail = detail


# ---------------------------------------------------------------------------------------------- paths

def roots() -> dict[str, Path]:
    s = get_settings()
    return {"library": s.library_root, "staging": s.staging_root}


def split_vpath(vpath: str) -> tuple[str, list[str]]:
    parts = [p for p in vpath.replace("\\", "/").split("/") if p != ""]
    if not parts or parts[0] not in ROOT_KEYS:
        raise FsError(400, f"Unknown location: {vpath!r}")
    rest = parts[1:]
    for p in rest:
        if p in (".", "..") or "\0" in p:
            raise FsError(400, "Invalid path.")
    return parts[0], rest


def resolve(vpath: str, must_exist: bool = True) -> Path:
    key, rest = split_vpath(vpath)
    root = roots()[key]
    candidate = root.joinpath(*rest)
    real_root = root.resolve()
    real = candidate.resolve()
    if real != real_root and real_root not in real.parents:
        raise FsError(403, "Path is outside the allowed folders.")
    if must_exist and not candidate.exists():
        raise FsError(404, "That item no longer exists.")
    return candidate


def to_vpath(path: Path) -> str:
    real = path.resolve() if path.exists() else path.parent.resolve() / path.name
    for key, root in roots().items():
        r = root.resolve()
        if real == r:
            return key
        if r in real.parents:
            return key + "/" + real.relative_to(r).as_posix()
    raise FsError(403, "Path is outside the allowed folders.")


def is_root(path: Path) -> bool:
    return any(path.resolve() == r.resolve() for r in roots().values())


def is_within(child: Path, parent: Path) -> bool:
    c, p = child.resolve(), parent.resolve()
    return c == p or p in c.parents


# ------------------------------------------------------------------------------------- storage guard

def storage_status() -> dict:
    s = get_settings()
    marker_ok = s.mount_marker is None or s.mount_marker.exists()
    missing = [k for k, r in roots().items() if not r.is_dir()]
    if not s.trash_root.is_dir():
        missing.append("trash")
    ok = marker_ok and not missing
    reason = None
    if not marker_ok:
        reason = "The library drive does not appear to be mounted (marker file missing). Writes are disabled."
    elif missing:
        reason = f"Missing folders: {', '.join(missing)}. Writes are disabled."
    usage = None
    with contextlib.suppress(OSError):
        du = shutil.disk_usage(s.library_root)
        usage = {"total": du.total, "used": du.used, "free": du.free}
    return {"ok": ok, "reason": reason, "disk": usage, "fs_type": fs_type()}


def check_writable() -> None:
    status = storage_status()
    if not status["ok"]:
        raise FsError(503, status["reason"])


@lru_cache
def _fs_type_for(path: str) -> str:
    best, best_type = "", "unknown"
    try:
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                mnt = parts[1].replace("\\040", " ")
                if (path == mnt or path.startswith(mnt.rstrip("/") + "/")) and len(mnt) > len(best):
                    best, best_type = mnt, parts[2]
    except OSError:
        pass
    return best_type


def fs_type() -> str:
    return _fs_type_for(str(get_settings().library_root.resolve()))


def strict_names() -> bool:
    return fs_type() in STRICT_FS


# -------------------------------------------------------------------------------------------- names

def _truncate_bytes(name: str, limit: int = 255) -> str:
    if len(name.encode()) <= limit:
        return name
    stem, ext = os.path.splitext(name)
    if len(ext.encode()) > 16:
        stem, ext = name, ""
    budget = limit - len(ext.encode())
    encoded = stem.encode()[:budget]
    return encoded.decode(errors="ignore").rstrip() + ext


def sanitize_name(name: str, strict: bool | None = None) -> str:
    """Make an automatically generated name (e.g. from tags) safe to use as a single path component."""
    if strict is None:
        strict = strict_names()
    name = unicodedata.normalize("NFC", name)
    name = "".join("_" if (c in "/\0" or ord(c) < 32) else c for c in name)
    if strict:
        name = "".join("_" if c in STRICT_FORBIDDEN else c for c in name).rstrip(" .")
    name = _truncate_bytes(name.strip())
    if name in ("", ".", ".."):
        name = "_"
    return name


def validate_user_name(name: str) -> str:
    """Validate a name typed by the user (rename / new folder)."""
    name = unicodedata.normalize("NFC", name).strip()
    if name in ("", ".", ".."):
        raise FsError(400, "Please enter a name.")
    if "/" in name or "\0" in name:
        raise FsError(400, "Names cannot contain '/'.")
    if strict_names():
        bad = sorted({c for c in name if c in STRICT_FORBIDDEN})
        if bad or name.endswith("."):
            raise FsError(400, f"This drive's filesystem does not allow: {' '.join(bad) or 'trailing dots'}")
    if len(name.encode()) > 255:
        raise FsError(400, "Name is too long.")
    return name


def unique_name(directory: Path, name: str, style: str = "number") -> str:
    """Return a name not present in `directory`: 'x (2).flac' or 'x (copy).flac'."""
    if not (directory / name).exists():
        return name
    path = Path(name)
    stem, ext = (path.stem, path.suffix) if not (directory / name).is_dir() else (name, "")
    n = 2
    while True:
        if style == "copy":
            label = " (copy)" if n == 2 else f" (copy {n - 1})"
        else:
            label = f" ({n})"
        candidate = _truncate_bytes(f"{stem}{label}{ext}")
        if not (directory / candidate).exists():
            return candidate
        n += 1


# ------------------------------------------------------------------------------------ path locking

class PathLocks:
    """Prevents two operations (or an operation and an active download) touching overlapping paths."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._busy: list[Path] = []
        self.download_dirs: set[Path] = set()

    @staticmethod
    def _overlap(a: Path, b: Path) -> bool:
        return a == b or a in b.parents or b in a.parents

    @contextlib.contextmanager
    def hold(self, paths: Iterable[Path]) -> Iterator[None]:
        wanted = [p.resolve() for p in paths]
        with self._lock:
            for w in wanted:
                for d in self.download_dirs:
                    if w == d or d in w.parents or w in d.parents:
                        raise FsError(409, "A download is still writing to this folder. Wait for it to finish.")
                for b in self._busy:
                    if self._overlap(w, b):
                        raise FsError(409, "Another operation is using this item. Try again in a moment.")
            self._busy.extend(wanted)
        try:
            yield
        finally:
            with self._lock:
                for w in wanted:
                    self._busy.remove(w)


locks = PathLocks()


# ----------------------------------------------------------------------------------------- listing

def entry_kind(name: str, is_dir: bool) -> str:
    if is_dir:
        return "dir"
    ext = os.path.splitext(name)[1].lower()
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in IMAGE_EXTS:
        return "image"
    return "file"


def is_hidden(name: str) -> bool:
    return name.startswith(".") or name.lower() in HIDDEN_NAMES


def describe(path: Path) -> dict:
    st = path.stat()
    is_dir = path.is_dir()
    return {
        "name": path.name,
        "path": to_vpath(path),
        "is_dir": is_dir,
        "size": 0 if is_dir else st.st_size,
        "mtime": st.st_mtime,
        "kind": entry_kind(path.name, is_dir),
    }


def list_dir(vpath: str, show_hidden: bool = False) -> dict:
    path = resolve(vpath)
    if not path.is_dir():
        raise FsError(400, "Not a folder.")
    root_real = _root_of(path)
    entries = []
    with os.scandir(path) as it:
        for de in it:
            if not show_hidden and is_hidden(de.name):
                continue
            try:
                is_dir = de.is_dir()
                st = de.stat()
            except OSError:
                continue  # broken symlink etc.
            if de.is_symlink() and not is_within(Path(de.path), root_real):
                continue  # never expose symlinks that point outside the allowed folders
            entries.append({
                "name": de.name,
                "path": f"{vpath.rstrip('/')}/{de.name}",
                "is_dir": is_dir,
                "size": 0 if is_dir else st.st_size,
                "mtime": st.st_mtime,
                "kind": entry_kind(de.name, is_dir),
            })
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].casefold()))
    return {"path": vpath.rstrip("/"), "entries": entries}


def _root_of(path: Path) -> Path:
    for r in roots().values():
        if is_within(path, r):
            return r.resolve()
    raise FsError(403, "Path is outside the allowed folders.")


def tree_size(path: Path) -> tuple[int, int]:
    """(bytes, file count) for a file or folder."""
    if path.is_file():
        return path.stat().st_size, 1
    total = count = 0
    for dirpath, _dirs, files in os.walk(path):
        for f in files:
            with contextlib.suppress(OSError):
                total += os.lstat(os.path.join(dirpath, f)).st_size
                count += 1
    return total, count


# -------------------------------------------------------------------------------------- mutations

def mkdir(parent_vpath: str, name: str) -> dict:
    check_writable()
    parent = resolve(parent_vpath)
    if not parent.is_dir():
        raise FsError(400, "Not a folder.")
    name = validate_user_name(name)
    target = parent / name
    with locks.hold([parent]):
        if target.exists():
            raise FsError(409, f"'{name}' already exists here.")
        target.mkdir()
    return describe(target)


def makedirs(vpath: str) -> Path:
    """Create a folder path (used when filing into a suggested folder that doesn't exist yet)."""
    check_writable()
    key, rest = split_vpath(vpath)
    path = roots()[key]
    for part in rest:
        path = path / sanitize_name(part)
    resolve(to_vpath(path), must_exist=False)
    path.mkdir(parents=True, exist_ok=True)
    return path


def rename(vpath: str, new_name: str) -> dict:
    check_writable()
    src = resolve(vpath)
    if is_root(src):
        raise FsError(400, "The top-level folders cannot be renamed.")
    new_name = validate_user_name(new_name)
    if new_name == src.name:
        return describe(src)
    dst = src.parent / new_name
    with locks.hold([src, src.parent]):
        case_only = new_name.casefold() == src.name.casefold()
        if dst.exists() and not (case_only and os.path.samefile(src, dst)):
            raise FsError(409, f"'{new_name}' already exists here.")
        if case_only:
            # Two-step rename so it works on case-insensitive filesystems too.
            tmp = src.parent / f".lm-rename-{os.getpid()}-{threading.get_ident()}"
            os.rename(src, tmp)
            os.rename(tmp, dst)
        else:
            os.rename(src, dst)
    return describe(dst)


@dataclass
class Operation:
    """A (possibly long-running) copy/move with progress, cancellable between chunks."""
    id: str
    kind: str  # "copy" | "move"
    total_bytes: int = 0
    done_bytes: int = 0
    current: str = ""
    cancelled: bool = False
    finished: bool = False
    error: str | None = None
    results: list[dict] = field(default_factory=list)

    def public(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "total_bytes": self.total_bytes, "done_bytes": self.done_bytes,
            "current": self.current, "finished": self.finished, "cancelled": self.cancelled,
            "error": self.error, "results": self.results,
        }


class Cancelled(Exception):
    pass


def _copy_file(src: Path, dst: Path, op: Operation | None, on_progress: Callable[[], None] | None) -> None:
    try:
        with open(src, "rb") as fin, open(dst, "xb") as fout:
            while True:
                if op and op.cancelled:
                    raise Cancelled()
                chunk = fin.read(COPY_CHUNK)
                if not chunk:
                    break
                fout.write(chunk)
                if op:
                    op.done_bytes += len(chunk)
                    if on_progress:
                        on_progress()
        shutil.copystat(src, dst)
        if dst.stat().st_size != src.stat().st_size:
            raise FsError(500, f"Copy verification failed for {src.name}.")
    except BaseException:
        with contextlib.suppress(OSError):
            dst.unlink()
        raise


def _copy_tree(src: Path, dst: Path, op: Operation | None, on_progress: Callable[[], None] | None) -> None:
    if src.is_dir():
        dst.mkdir()
        for child in sorted(src.iterdir()):
            _copy_tree(child, dst / child.name, op, on_progress)
        shutil.copystat(src, dst)
    else:
        if op:
            op.current = src.name
        _copy_file(src, dst, op, on_progress)


def _same_device(a: Path, b: Path) -> bool:
    try:
        return a.stat().st_dev == b.stat().st_dev
    except OSError:
        return False


def plan_transfer(sources: list[str], dest_vpath: str, mode: str) -> tuple[Path, list[Path], list[dict]]:
    """Validate a copy/move and report name conflicts in the destination."""
    if mode not in ("copy", "move"):
        raise FsError(400, "Unknown operation.")
    dest = resolve(dest_vpath)
    if not dest.is_dir():
        raise FsError(400, "Destination is not a folder.")
    srcs: list[Path] = []
    conflicts = []
    seen: set[str] = set()
    for v in sources:
        src = resolve(v)
        if is_root(src):
            raise FsError(400, "The top-level folders cannot be moved or copied.")
        if src.is_dir() and is_within(dest, src):
            raise FsError(400, f"Cannot put '{src.name}' inside itself.")
        if src.name in seen:
            raise FsError(400, f"Two selected items are both named '{src.name}'.")
        seen.add(src.name)
        srcs.append(src)
        if src.parent.resolve() == dest.resolve():
            continue  # same folder: move is a no-op, copy makes "(copy)"
        existing = dest / src.name
        if existing.exists():
            conflicts.append({"name": src.name, "existing": _conflict_info(existing),
                              "incoming": _conflict_info(src)})
    return dest, srcs, conflicts


def _conflict_info(path: Path) -> dict:
    st = path.stat()
    size = tree_size(path)[0] if path.is_dir() else st.st_size
    from app.services.tags import quick_quality

    return {"is_dir": path.is_dir(), "size": size, "mtime": st.st_mtime,
            "quality": None if path.is_dir() else quick_quality(path)}


def execute_transfer(
    dest: Path,
    srcs: list[Path],
    mode: str,
    resolutions: dict[str, str],
    op: Operation,
    trash_existing: Callable[[Path], None],
    on_progress: Callable[[], None] | None = None,
) -> None:
    """Perform a planned transfer. `resolutions` maps conflicting names to replace|keep_both|skip."""
    check_writable()
    op.total_bytes = sum(tree_size(s)[0] for s in srcs)
    with locks.hold([dest, *srcs]):
        for src in srcs:
            if op.cancelled:
                op.results.append({"source": to_vpath(src), "status": "cancelled"})
                continue
            same_dir = src.parent.resolve() == dest.resolve()
            if same_dir and mode == "move":
                op.results.append({"source": to_vpath(src), "status": "skipped", "reason": "same folder"})
                continue
            name = src.name
            target = dest / name
            if same_dir:
                name = unique_name(dest, name, style="copy")
                target = dest / name
            elif target.exists():
                choice = resolutions.get(src.name, "ask")
                if choice == "skip":
                    op.results.append({"source": to_vpath(src), "status": "skipped", "reason": "exists"})
                    continue
                if choice == "keep_both":
                    name = unique_name(dest, name)
                    target = dest / name
                elif choice == "replace":
                    trash_existing(target)
                else:
                    raise FsError(409, f"'{name}' already exists in the destination.")
            source_vpath = to_vpath(src)
            try:
                if mode == "move" and _same_device(src, dest):
                    os.rename(src, target)
                    op.done_bytes += tree_size(target)[0]
                else:
                    _copy_tree(src, target, op, on_progress)
                    if mode == "move":
                        if src.is_dir():
                            shutil.rmtree(src)
                        else:
                            src.unlink()
            except Cancelled:
                # Sources are only removed after a complete copy, so the partial target can go.
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    with contextlib.suppress(OSError):
                        target.unlink()
                op.results.append({"source": source_vpath, "status": "cancelled"})
                continue
            op.results.append({"source": source_vpath, "status": "done", "target": to_vpath(target),
                               "renamed": name != src.name})
            if on_progress:
                on_progress()
