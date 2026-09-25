from app.services import library_index, ranking


def f(name, size=1000, **kw):
    return {"filename": name, "size": size, **kw}


def resp(user, files, free=True, speed=1000, queue=0, locked=None):
    return {"username": user, "files": files, "lockedFiles": locked or [], "hasFreeUploadSlot": free,
            "uploadSpeed": speed, "queueLength": queue}


def test_file_quality_tiers():
    assert ranking.file_quality(f("a\\x.flac", bitDepth=24, sampleRate=96000)) == (1, "FLAC 24/96")
    assert ranking.file_quality(f("a\\x.flac")) == (1, "FLAC")
    assert ranking.file_quality(f("a\\x.mp3", bitRate=320)) == (2, "MP3 320")
    assert ranking.file_quality(f("a\\x.mp3", bitRate=245, isVariableBitRate=True)) == (2, "MP3 V0")
    assert ranking.file_quality(f("a\\x.mp3", bitRate=192)) == (3, "MP3 192")
    assert ranking.file_quality(f("a\\x.mp3")) == (4, "MP3 ?")
    assert ranking.file_quality(f("a\\cover.jpg")) == (None, None)


def test_grouping_and_sort_order():
    responses = [
        resp("fast_mp3", [f("Music\\Artist - Album\\01.mp3", bitRate=320), f("Music\\Artist - Album\\02.mp3",
                                                                             bitRate=320)], speed=9_000_000),
        resp("slow_flac", [f("Share\\Album\\01.flac", bitDepth=16, sampleRate=44100),
                           f("Share\\Album\\cover.jpg")], speed=100),
        resp("busy_flac", [f("x\\Album\\01.flac")], free=False, speed=5_000_000),
        resp("fast_flac", [f("y\\Album\\01.flac"), f("y\\Album\\02.flac")], speed=5_000_000),
        resp("only_images", [f("z\\Scans\\a.jpg")]),
    ]
    groups = ranking.build_groups(responses)
    assert [g["username"] for g in groups] == ["fast_flac", "slow_flac", "busy_flac", "fast_mp3"]
    slow = groups[1]
    assert slow["folder_name"] == "Album" and slow["audio_count"] == 1 and len(slow["files"]) == 2
    assert slow["quality"] == "FLAC 16/44.1"
    assert groups[-1]["quality"] == "MP3 320"


def test_mixed_folder_and_locked():
    groups = ranking.build_groups([
        resp("u", [f("d\\1.flac"), f("d\\2.flac"), f("d\\3.mp3", bitRate=320)], locked=[f("e\\1.flac")]),
    ])
    by_dir = {g["directory"]: g for g in groups}
    assert by_dir["d"]["mixed"] is True and by_dir["d"]["tier"] == 1
    assert by_dir["e"]["locked"] is True


def _make_album(roots, artist: str, album: str, track_count: int) -> None:
    d = roots["library"] / artist / album
    d.mkdir(parents=True)
    for i in range(track_count):
        (d / f"{i}.flac").touch()


def test_in_library_hint(roots):
    _make_album(roots, "The Beatles", "Abbey Road", 17)
    _make_album(roots, "Radiohead", "OK Computer", 5)
    idx = library_index.LibraryIndex()
    idx.add("The Beatles", "Abbey Road", 17)
    idx.add("Radiohead", "OK Computer", 5)
    assert idx.match("Music\\Beatles, The\\Abbey Road (2019 Remaster) [FLAC]", 17) == "full"
    assert idx.match("stuff\\The Beatles - Abbey Road (1969) [24bit]", 17) == "full"
    assert idx.match("Radiohead\\OK Computer\\CD1", 12) == "partial"
    assert idx.match("Radiohead\\Kid A", 10) is None
    groups = ranking.build_groups([resp("u", [f("Radiohead\\OK Computer\\01.flac")])], idx)
    assert groups[0]["in_library"] == "full"


def test_in_library_hint_ignores_stale_cache_for_emptied_folder(roots):
    # The album folder still exists but every track was deleted (e.g. via the explorer, which
    # doesn't trigger a Plex rescan) -- the cached count says 1, but the real folder is empty.
    (roots["library"] / "Brakence" / "Ready Or Not").mkdir(parents=True)
    idx = library_index.LibraryIndex()
    idx.add("Brakence", "Ready Or Not", 1)
    assert idx.match("Music\\Brakence - Ready Or Not", 1) is None


def test_in_library_hint_ignores_stale_cache_for_removed_folder(roots):
    # The whole album folder is gone, but the cached index (built before the delete) still knows it.
    idx = library_index.LibraryIndex()
    idx.add("Brakence", "Gone Album", 1)
    assert idx.match("Music\\Brakence - Gone Album", 1) is None


def test_build_from_filesystem_skips_empty_albums(roots):
    _make_album(roots, "Real Artist", "Real Album", 3)
    (roots["library"] / "Empty Artist" / "Empty Album").mkdir(parents=True)
    idx = library_index.build_from_filesystem(roots["library"])
    assert idx.match("x\\Real Artist - Real Album", 3) == "full"
    assert idx.match("x\\Empty Artist - Empty Album", 1) is None


def test_normalize():
    n = library_index.normalize
    assert n("The Beatles") == n("Beatles, The") == n("beatles")
    assert n("Sigur Rós") == n("Sigur Ros")
    assert n("Abbey Road (Super Deluxe Edition)") == n("Abbey Road")
    assert n("Simon & Garfunkel") == n("Simon and Garfunkel")
