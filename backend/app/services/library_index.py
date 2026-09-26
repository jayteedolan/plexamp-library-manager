"""Normalized index of (artist, album) pairs already in the library, for "In library" hints."""

import os
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from app.services import fs

_EDITION = re.compile(
    r"[\[(][^\])]*(deluxe|edition|remaster|expanded|anniversary|bonus|flac|mp3|320|bit|khz|web|vinyl|cd|"
    r"\d{4})[^\])]*[\])]",
    re.I,
)
_YEAR_PREFIX = re.compile(r"^\(?\d{4}\)?\s*[-–.]?\s*")
_NON_ALNUM = re.compile(r"[^0-9a-z]+")


def normalize(name: str | None) -> str:
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = s.replace("&", " and ")
    s = _EDITION.sub(" ", s)
    s = _YEAR_PREFIX.sub("", s.strip())
    s = _NON_ALNUM.sub(" ", s).strip()
    if s.endswith(" the"):  # "Beatles, The"
        s = s[:-4].strip()
    if s.startswith("the "):
        s = s[4:]
    return s.replace(" ", "")


def find_existing_folder(base: Path, name: str) -> str | None:
    """Existing sub-folder of `base` whose name matches `name` ignoring case/punctuation/'The'."""
    target = normalize(name)
    if not target or not base.is_dir():
        return None
    try:
        with os.scandir(base) as it:
            for de in it:
                if de.is_dir() and normalize(de.name) == target:
                    return de.name
    except OSError:
        return None
    return None


def _count_audio(folder: Path) -> int:
    count = 0
    for _dp, _dn, files in os.walk(folder):
        count += sum(1 for f in files if fs.entry_kind(f, False) == "audio")
    return count


def _live_track_count(artist: str | None, album: str | None) -> int | None:
    """Audio files currently on disk in the matching artist/album folder, or None if it's gone."""
    library_root = fs.roots()["library"]
    artist_dir = find_existing_folder(library_root, artist) if artist else None
    if artist and artist_dir is None:
        return None
    base = library_root / artist_dir if artist_dir else library_root
    album_dir = find_existing_folder(base, album) if album else None
    if album and album_dir is None:
        return None
    try:
        return _count_audio(base / album_dir) if album_dir else _count_audio(base)
    except OSError:
        return None


@dataclass
class LibraryIndex:
    albums: dict[tuple[str, str], int] = field(default_factory=dict)  # (artist, album) -> track count
    albums_by_title: dict[str, list[str]] = field(default_factory=dict)  # album -> artists
    source: str = "none"

    def add(self, artist: str | None, album: str | None, tracks: int) -> None:
        a, b = normalize(artist), normalize(album)
        if not b:
            return
        key = (a, b)
        self.albums[key] = max(self.albums.get(key, 0), tracks)
        self.albums_by_title.setdefault(b, []).append(a)

    def match(self, remote_folder: str, audio_count: int) -> str | None:
        """Return 'full', 'partial' or None for a remote folder path like 'Music\\Artist\\Album (2001)'.

        The cached index (from Plex, or the filesystem) only reflects what it saw at the last scan
        or rebuild -- it doesn't know about files deleted since through the explorer, since that
        doesn't trigger a Plex scan. So once a name match is found, this checks the *current* library
        folder before answering: an emptied-out or removed album folder is never reported as in the
        library, however stale the cached count says otherwise.
        """
        from app.services.tags import parse_folder_name

        parts = [p for p in remote_folder.replace("\\", "/").split("/") if p]
        if not parts:
            return None
        folder = parts[-1]
        # Folders like "CD1" / "Disc 2" belong to the parent album.
        if re.fullmatch(r"(cd|disc|disk)\s*\d+", folder, re.I) and len(parts) >= 2:
            parts = parts[:-1]
            folder = parts[-1]
        candidates: list[tuple[str | None, str | None]] = []
        artist, album = parse_folder_name(folder)
        if artist:
            candidates.append((artist, album))
        if len(parts) >= 2:
            candidates.append((parts[-2], album or folder))
        for cand_artist, cand_album in candidates:
            result = self.match_release(cand_artist, cand_album, audio_count)
            if result:
                return result
        return None

    def match_release(self, artist: str | None, album: str | None, track_count: int) -> str | None:
        """'full', 'partial' or None for a known artist/album name pair (e.g. from Spotify)."""
        key = (normalize(artist), normalize(album))
        if not key[1] or key not in self.albums:
            return None
        have = _live_track_count(artist, album)
        if not have:  # folder doesn't currently exist, or is empty -- not really "in library"
            return None
        return "partial" if track_count and have < track_count else "full"


_index = LibraryIndex()


def current() -> LibraryIndex:
    return _index


def build_from_filesystem(library_root: Path) -> LibraryIndex:
    idx = LibraryIndex(source="filesystem")
    if not library_root.is_dir():
        return idx
    with os.scandir(library_root) as artists:
        for artist in artists:
            if not artist.is_dir() or fs.is_hidden(artist.name):
                continue
            try:
                with os.scandir(artist.path) as albums:
                    for album in albums:
                        if not album.is_dir() or fs.is_hidden(album.name):
                            continue
                        count = _count_audio(Path(album.path))
                        if count:  # an emptied-out album folder isn't a known album any more
                            idx.add(artist.name, album.name, count)
            except OSError:
                continue
    return idx


def build_from_plex(albums: list[dict]) -> LibraryIndex:
    idx = LibraryIndex(source="plex")
    for a in albums:
        idx.add(a.get("parentTitle"), a.get("title"), int(a.get("leafCount") or 0))
    return idx


def replace(idx: LibraryIndex) -> None:
    global _index
    _index = idx
