import os

import pytest

from app.services import fs


def test_resolve_rejects_traversal_and_unknown_roots(roots):
    with pytest.raises(fs.FsError) as e:
        fs.resolve("library/../../etc")
    assert e.value.status == 400
    with pytest.raises(fs.FsError):
        fs.resolve("/etc/passwd")
    with pytest.raises(fs.FsError):
        fs.resolve("trash/x")


def test_resolve_rejects_symlink_escape(roots, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, roots["library"] / "sneaky")
    with pytest.raises(fs.FsError) as e:
        fs.resolve("library/sneaky")
    assert e.value.status == 403
    assert all(e["name"] != "sneaky" for e in fs.list_dir("library")["entries"])


def test_list_dir_hides_system_files(roots):
    (roots["library"] / "Artist").mkdir()
    (roots["library"] / ".DS_Store").touch()
    (roots["library"] / "Thumbs.db").touch()
    names = [e["name"] for e in fs.list_dir("library")["entries"]]
    assert names == ["Artist"]
    assert len(fs.list_dir("library", show_hidden=True)["entries"]) == 3


def test_mkdir_rename_and_case_only_rename(roots):
    fs.mkdir("library", "beatles")
    with pytest.raises(fs.FsError) as e:
        fs.mkdir("library", "beatles")
    assert e.value.status == 409
    with pytest.raises(fs.FsError):
        fs.mkdir("library", "a/b")
    out = fs.rename("library/beatles", "Beatles")
    assert out["path"] == "library/Beatles"
    assert (roots["library"] / "Beatles").is_dir()
    with pytest.raises(fs.FsError):
        fs.rename("library", "x")


def test_writes_blocked_when_drive_not_mounted(roots):
    roots["marker"].unlink()
    assert fs.storage_status()["ok"] is False
    with pytest.raises(fs.FsError) as e:
        fs.mkdir("library", "x")
    assert e.value.status == 503


def _op(kind="move"):
    return fs.Operation(id="t", kind=kind)


def test_transfer_conflicts_and_resolutions(roots):
    lib, stg = roots["library"], roots["staging"]
    (lib / "Album").mkdir()
    (lib / "Album" / "01.flac").write_bytes(b"old")
    (stg / "01.flac").write_bytes(b"new!")
    (stg / "02.flac").write_bytes(b"two")

    dest, srcs, conflicts = fs.plan_transfer(["staging/01.flac", "staging/02.flac"], "library/Album", "move")
    assert [c["name"] for c in conflicts] == ["01.flac"]
    assert conflicts[0]["existing"]["size"] == 3 and conflicts[0]["incoming"]["size"] == 4

    trashed = []
    op = _op()
    fs.execute_transfer(dest, srcs, "move", {"01.flac": "keep_both"}, op, trashed.append)
    assert sorted(p.name for p in (lib / "Album").iterdir()) == ["01 (2).flac", "01.flac", "02.flac"]
    assert not trashed

    (stg / "02.flac").write_bytes(b"newer")
    dest, srcs, _ = fs.plan_transfer(["staging/02.flac"], "library/Album", "move")
    fs.execute_transfer(dest, srcs, "move", {"02.flac": "replace"}, _op(), lambda p: (trashed.append(p), p.unlink()))
    assert (lib / "Album" / "02.flac").read_bytes() == b"newer"
    assert len(trashed) == 1

    (stg / "01.flac").write_bytes(b"x")
    dest, srcs, _ = fs.plan_transfer(["staging/01.flac"], "library/Album", "move")
    op = _op()
    fs.execute_transfer(dest, srcs, "move", {"01.flac": "skip"}, op, trashed.append)
    assert op.results[0]["status"] == "skipped" and (stg / "01.flac").exists()


def test_transfer_rejects_moving_folder_into_itself(roots):
    (roots["library"] / "A" / "B").mkdir(parents=True)
    with pytest.raises(fs.FsError):
        fs.plan_transfer(["library/A"], "library/A/B", "move")


def test_copy_into_same_folder_makes_copy_name(roots):
    (roots["library"] / "x.mp3").write_bytes(b"abc")
    dest, srcs, conflicts = fs.plan_transfer(["library/x.mp3"], "library", "copy")
    assert conflicts == []
    fs.execute_transfer(dest, srcs, "copy", {}, _op("copy"), lambda p: None)
    assert (roots["library"] / "x (copy).mp3").read_bytes() == b"abc"


def test_copy_folder_tree_and_cancel(roots):
    src = roots["staging"] / "Album"
    src.mkdir()
    for i in range(3):
        (src / f"{i}.flac").write_bytes(os.urandom(2048))
    dest, srcs, _ = fs.plan_transfer(["staging/Album"], "library", "copy")
    fs.execute_transfer(dest, srcs, "copy", {}, _op("copy"), lambda p: None)
    assert sorted(p.name for p in (roots["library"] / "Album").iterdir()) == ["0.flac", "1.flac", "2.flac"]

    op = _op("copy")
    op.cancelled = True
    dest, srcs, _ = fs.plan_transfer(["staging/Album"], "library/Album", "copy")
    fs.execute_transfer(dest, srcs, "copy", {}, op, lambda p: None)
    assert op.results[0]["status"] == "cancelled"
    assert not (roots["library"] / "Album" / "Album").exists()


def test_download_lock_blocks_operations(roots):
    d = roots["staging"] / "Incoming"
    d.mkdir()
    fs.locks.download_dirs = {d.resolve()}
    with pytest.raises(fs.FsError) as e:
        fs.rename("staging/Incoming", "Other")
    assert e.value.status == 409


def test_sanitize_and_unique_names(roots):
    assert fs.sanitize_name("AC/DC") == "AC_DC"
    assert fs.sanitize_name('What? "Now": <x>', strict=True) == "What_ _Now__ _x_"
    assert fs.sanitize_name("Trailing. ", strict=True) == "Trailing"
    assert fs.sanitize_name("..") == "_"
    long = "a" * 300 + ".flac"
    out = fs.sanitize_name(long)
    assert out.endswith(".flac") and len(out.encode()) <= 255
    (roots["library"] / "t.flac").touch()
    (roots["library"] / "t (2).flac").touch()
    assert fs.unique_name(roots["library"], "t.flac") == "t (3).flac"
