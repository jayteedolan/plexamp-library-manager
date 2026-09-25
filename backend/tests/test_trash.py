from datetime import timedelta

import pytest

from app.models import TrashItem, utcnow
from app.services import fs, trash


def test_delete_restore_roundtrip(roots, db):
    album = roots["library"] / "Artist" / "Album"
    album.mkdir(parents=True)
    (album / "01.flac").write_bytes(b"x" * 10)
    items = trash.delete_paths(db, ["library/Artist/Album"])
    assert not album.exists()
    assert items[0].original_path == "library/Artist/Album" and items[0].size == 10

    # Parent folder removed meanwhile: restore recreates it.
    (roots["library"] / "Artist").rmdir()
    restored = trash.restore(db, items[0].id)
    assert restored == "library/Artist/Album"
    assert (album / "01.flac").exists()
    assert trash.list_items(db) == []


def test_restore_conflict_options(roots, db):
    f = roots["library"] / "song.mp3"
    f.write_bytes(b"old")
    item = trash.delete_paths(db, ["library/song.mp3"])[0]
    f.write_bytes(b"new")
    with pytest.raises(fs.FsError) as e:
        trash.restore(db, item.id)
    assert e.value.status == 409
    assert trash.restore(db, item.id, "keep_both") == "library/song (2).mp3"
    assert f.read_bytes() == b"new"


def test_roots_cannot_be_deleted(roots, db):
    with pytest.raises(fs.FsError):
        trash.delete_paths(db, ["library"])


def test_purge_older_than(roots, db):
    (roots["library"] / "a").write_bytes(b"1")
    (roots["library"] / "b").write_bytes(b"2")
    old, new = trash.delete_paths(db, ["library/a", "library/b"])
    db.get(TrashItem, old.id).deleted_at = utcnow() - timedelta(days=31)
    db.commit()
    assert trash.purge_older_than(db, 30) == 1
    assert [i.id for i in trash.list_items(db)] == [new.id]
    assert not (roots["trash"] / old.id).exists()
