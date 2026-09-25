from app.services.tags import parse_folder_name, read_audio, suggest_destination
from tests.conftest import make_flac


def test_read_audio(roots):
    p = make_flac(roots["staging"] / "a.flac", artist="A", album="B", tracknumber="1")
    info = read_audio(p)
    assert info["format"] == "FLAC" and info["bit_depth"] == 16 and info["sample_rate"] == 44100
    assert info["artist"] == "A" and info["album"] == "B"


def test_parse_folder_name():
    assert parse_folder_name("Radiohead - OK Computer (1997) [FLAC 24-96]") == ("Radiohead", "OK Computer (1997)")
    assert parse_folder_name("Boards of Canada - 1998 - Music Has the Right") == (
        "Boards of Canada", "Music Has the Right")
    assert parse_folder_name("Kid A") == (None, "Kid A")


def test_suggest_prefers_album_artist_and_existing_folders(roots):
    (roots["library"] / "The Beatles").mkdir()
    files = [make_flac(roots["staging"] / "x" / f"{i}.flac", artist="John", albumartist="the beatles",
                       album="Abbey Road") for i in range(3)]
    s = suggest_destination(files, "Music\\whatever")
    assert s["path"] == "library/The Beatles/Abbey Road"
    assert s["exists"] is False and s["confident"] is True


def test_suggest_falls_back_to_folder_name(roots):
    files = [make_flac(roots["staging"] / "y" / "1.flac")]
    s = suggest_destination(files, "Music\\Artist Name - Great Album (2001) [FLAC]")
    assert s["source"] == "folder" and s["path"] == "library/Artist Name/Great Album (2001)"
