"""Reading audio tags / stream info with mutagen, and suggesting a library destination."""

import contextlib
import re
from collections import Counter
from pathlib import Path

from app.services import fs


def _first(tags, *keys: str) -> str | None:
    if not tags:
        return None
    for k in keys:
        with contextlib.suppress(KeyError, ValueError, TypeError):
            v = tags.get(k)
            if v:
                value = v[0] if isinstance(v, list) else v
                value = str(value).strip()
                if value:
                    return value
    return None


def read_audio(path: Path) -> dict | None:
    try:
        import mutagen

        f = mutagen.File(path, easy=True)
    except Exception:
        return None
    if f is None:
        return None
    info = getattr(f, "info", None)
    tags = f.tags
    result = {
        "format": path.suffix.lower().lstrip(".").upper(),
        "duration": round(getattr(info, "length", 0) or 0, 1),
        "bitrate": int((getattr(info, "bitrate", 0) or 0) / 1000) or None,
        "sample_rate": getattr(info, "sample_rate", None),
        "bit_depth": getattr(info, "bits_per_sample", None),
        "channels": getattr(info, "channels", None),
        "artist": _first(tags, "artist"),
        "album_artist": _first(tags, "albumartist", "album artist"),
        "album": _first(tags, "album"),
        "title": _first(tags, "title"),
        "track": _first(tags, "tracknumber"),
        "disc": _first(tags, "discnumber"),
        "date": _first(tags, "date", "year"),
        "genre": _first(tags, "genre"),
    }
    return result


def quality_label(fmt: str, bitrate: int | None, bit_depth: int | None, sample_rate: int | None) -> str:
    fmt = fmt.upper()
    if fmt in ("FLAC", "ALAC", "WAV", "AIFF", "AIF", "APE", "WV"):
        if bit_depth and sample_rate:
            return f"{fmt} {bit_depth}/{sample_rate / 1000:g}"
        return fmt
    if bitrate:
        return f"{fmt} {bitrate}"
    return fmt


def quick_quality(path: Path) -> str | None:
    if fs.entry_kind(path.name, False) != "audio":
        return None
    a = read_audio(path)
    if not a:
        return None
    return quality_label(a["format"], a["bitrate"], a["bit_depth"], a["sample_rate"])


_YEAR_PREFIX = re.compile(r"^\(?\d{4}\)?\s*[-–.]\s*")
_BRACKETS = re.compile(r"\s*[\[(][^\])]*(flac|mp3|320|v0|24|16|bit|khz|web|cd|vinyl)[^\])]*[\])]", re.I)


def parse_folder_name(folder: str) -> tuple[str | None, str | None]:
    """Guess (artist, album) from a folder name like 'Artist - Album (2001) [FLAC]'."""
    name = _BRACKETS.sub("", folder).strip()
    if " - " in name:
        artist, album = name.split(" - ", 1)
        album = _YEAR_PREFIX.sub("", album.strip())
        return artist.strip() or None, album.strip() or None
    return None, _YEAR_PREFIX.sub("", name).strip() or None


def suggest_destination(files: list[Path], remote_folder: str, library_index=None) -> dict:
    """Suggest `library/<Artist>/<Album>` for a set of downloaded files.

    Uses the most common album-artist/artist and album tags; falls back to the remote folder name.
    Reuses an existing artist/album folder whose name matches ignoring case and punctuation.
    """
    artists: Counter[str] = Counter()
    albums: Counter[str] = Counter()
    for f in files:
        if fs.entry_kind(f.name, False) != "audio" or not f.exists():
            continue
        a = read_audio(f)
        if not a:
            continue
        artist = a["album_artist"] or a["artist"]
        if artist:
            artists[artist] += 1
        if a["album"]:
            albums[a["album"]] += 1

    source = "tags"
    artist = artists.most_common(1)[0][0] if artists else None
    album = albums.most_common(1)[0][0] if albums else None
    parts = [p for p in remote_folder.replace("\\", "/").split("/") if p]
    if not artist or not album:
        source = "folder"
        f_artist, f_album = parse_folder_name(parts[-1] if parts else "")
        if not f_artist and len(parts) >= 2:
            f_artist = parts[-2]
        artist = artist or f_artist
        album = album or f_album
    confident = bool(artist and album) and source == "tags" and len(albums) <= 1

    from app.services.library_index import find_existing_folder

    library_root = fs.roots()["library"]
    segs: list[str] = []
    artist_dir = None
    if artist:
        artist_dir = find_existing_folder(library_root, artist) or fs.sanitize_name(artist)
        segs.append(artist_dir)
    if album:
        base = library_root / artist_dir if artist_dir else library_root
        segs.append(find_existing_folder(base, album) or fs.sanitize_name(album))
    vpath = "/".join(["library", *segs])
    exists = (library_root.joinpath(*segs)).is_dir()
    return {"artist": artist, "album": album, "path": vpath, "exists": exists, "source": source,
            "confident": confident}
