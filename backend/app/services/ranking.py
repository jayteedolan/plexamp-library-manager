"""Quality tiers and grouping of Soulseek search responses into album cards.

Tier 1: lossless (FLAC/ALAC/WAV/AIFF/APE/WavPack; 24-bit and 16-bit rank equally)
Tier 2: high-bitrate lossy (MP3 320 / V0, AAC/Ogg/Opus >= 256)
Tier 3: lower-bitrate lossy
Tier 4: unknown bitrate
Within a tier: free upload slot, then upload speed, then queue length, then completeness.
"""

import hashlib
from collections import Counter

LOSSLESS = {"flac", "wav", "aiff", "aif", "ape", "wv", "alac"}
LOSSY = {"mp3", "m4a", "aac", "ogg", "opus", "wma", "mpc"}
AUDIO = LOSSLESS | LOSSY
TIER_NAMES = {1: "lossless", 2: "high", 3: "low", 4: "unknown"}


def split_remote(filename: str) -> tuple[str, str]:
    norm = filename.replace("\\", "/")
    if "/" in norm:
        d, n = norm.rsplit("/", 1)
        return filename[: len(d)], n
    return "", filename


def extension(name: str, ext_field: str | None = None) -> str:
    if ext_field:
        return ext_field.lower().lstrip(".")
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def file_quality(f: dict) -> tuple[int | None, str | None]:
    """(tier, label) for a single slskd file entry; (None, None) for non-audio files."""
    _, name = split_remote(f.get("filename", ""))
    ext = extension(name, f.get("extension"))
    if ext not in AUDIO:
        return None, None
    bitrate = f.get("bitRate")
    depth = f.get("bitDepth")
    rate = f.get("sampleRate")
    vbr = f.get("isVariableBitRate")
    fmt = ext.upper()
    if ext in LOSSLESS or (ext == "m4a" and depth):
        if ext == "m4a":
            fmt = "ALAC"
        if depth and rate:
            return 1, f"{fmt} {depth}/{rate / 1000:g}"
        return 1, fmt
    if not bitrate:
        return 4, f"{fmt} ?"
    if ext == "mp3" and vbr:
        label = "MP3 V0" if bitrate >= 220 else f"MP3 VBR ~{bitrate}"
        return (2 if bitrate >= 220 else 3), label
    if (ext == "mp3" and bitrate >= 315) or (ext != "mp3" and bitrate >= 256):
        return 2, f"{fmt} {bitrate}"
    return 3, f"{fmt} {bitrate}"


def group_id(username: str, directory: str) -> str:
    return hashlib.sha1(f"{username}\0{directory}".encode()).hexdigest()[:16]


def _file_entry(f: dict, locked: bool) -> dict:
    _, name = split_remote(f.get("filename", ""))
    tier, label = file_quality(f)
    return {
        "filename": f.get("filename", ""),
        "name": name,
        "size": int(f.get("size") or 0),
        "ext": extension(name, f.get("extension")),
        "bitrate": f.get("bitRate"),
        "bit_depth": f.get("bitDepth"),
        "sample_rate": f.get("sampleRate"),
        "length": f.get("length"),
        "is_audio": tier is not None,
        "tier": tier,
        "quality": label,
        "locked": locked,
    }


def build_groups(responses: list[dict], index=None) -> list[dict]:
    groups: dict[str, dict] = {}
    for resp in responses:
        user = resp.get("username", "")
        entries = [(f, False) for f in resp.get("files") or []] + [(f, True) for f in resp.get("lockedFiles") or []]
        for f, locked in entries:
            directory, _ = split_remote(f.get("filename", ""))
            gid = group_id(user, directory)
            g = groups.get(gid)
            if g is None:
                folder_parts = [p for p in directory.replace("\\", "/").split("/") if p]
                g = groups[gid] = {
                    "id": gid,
                    "username": user,
                    "directory": directory,
                    "folder_name": folder_parts[-1] if folder_parts else directory or "(root)",
                    "parent_name": folder_parts[-2] if len(folder_parts) >= 2 else None,
                    "has_free_slot": bool(resp.get("hasFreeUploadSlot")),
                    "upload_speed": int(resp.get("uploadSpeed") or 0),
                    "queue_length": int(resp.get("queueLength") or 0),
                    "files": [],
                }
            g["files"].append(_file_entry(f, locked))

    result = []
    for g in groups.values():
        audio = [f for f in g["files"] if f["is_audio"]]
        if not audio:
            continue
        g["files"].sort(key=lambda f: (not f["is_audio"], f["name"].casefold()))
        tiers = Counter(f["tier"] for f in audio)
        top = max(tiers.values())
        g["tier"] = min(t for t, c in tiers.items() if c == top)  # dominant tier, better one on ties
        labels = Counter(f["quality"] for f in audio if f["tier"] == g["tier"])
        g["quality"] = labels.most_common(1)[0][0]
        g["tier_name"] = TIER_NAMES[g["tier"]]
        g["mixed"] = len({f["ext"] for f in audio}) > 1
        g["audio_count"] = len(audio)
        g["total_size"] = sum(f["size"] for f in g["files"])
        g["audio_size"] = sum(f["size"] for f in audio)
        g["locked"] = all(f["locked"] for f in audio)
        g["in_library"] = index.match(g["directory"], len(audio)) if index is not None else None
        result.append(g)
    result.sort(key=sort_key)
    return result


def sort_key(g: dict) -> tuple:
    return (g["tier"], not g["has_free_slot"], -g["upload_speed"], g["queue_length"], -g["audio_count"])
