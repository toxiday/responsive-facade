"""The RFB1 month file round-trips: bits, lux rounding and clamping, missing Radiance."""

import numpy as np
import pytest

from bake import config, format as fmt


@pytest.fixture()
def tmp_dir():
    d = config.assert_writable(config.TMP / "test_format")
    d.mkdir(parents=True, exist_ok=True)
    yield d
    for p in d.iterdir():
        p.unlink()
    d.rmdir()


def test_bit_order_is_wall_row_col_lsb_first():
    b = np.zeros(2048, dtype=np.uint8)
    b[0] = 1                 # S, row 0, col 0 -> byte 0, bit 0
    b[512 + 33] = 1          # N, row 1, col 1 -> bit 545 -> byte 68, bit 1
    data = fmt.pack_bits(b)
    assert len(data) == 256 and data[0] == 0b1 and data[68] == 0b10
    assert (fmt.unpack_bits(data) == b).all()


def test_month_round_trip(tmp_dir):
    rng = np.random.default_rng(1)
    n_slots, n_states = 3, 4
    records = []
    for s in range(n_slots):
        row = []
        for k in range(n_states):
            binary = (rng.random(2048) < 0.3).astype(np.uint8)
            sur = rng.random(1024) * 5000
            rad = None if (s, k) == (1, 2) else rng.random(1024) * 80000   # some clamp
            row.append((binary, sur, rad))
        records.append(row)
    path = tmp_dir / "12.bin"
    size = fmt.write_month(path, 12, 0, records)
    assert size == 32 + n_slots * n_states * fmt.RECORD_BYTES
    back = fmt.read_month(path)
    assert (back["month"], back["n_slots"], back["n_states"]) == (12, n_slots, n_states)
    assert back["flags"] & fmt.FLAG_RADIANCE
    for s in range(n_slots):
        for k in range(n_states):
            binary, sur, rad = records[s][k]
            assert (back["facades"][s, k] == binary).all()
            assert np.abs(back["lux_surrogate"][s, k] - sur).max() <= 0.5
            if rad is None:
                assert np.isnan(back["lux_radiance"][s, k]).all()
            else:
                want = np.minimum(np.rint(rad), 65534)
                assert (back["lux_radiance"][s, k] == want).all()


def test_corruption_is_detected(tmp_dir):
    rec = [[(np.zeros(2048), np.zeros(1024), None)]]
    path = tmp_dir / "01.bin"
    fmt.write_month(path, 1, 0, rec)
    data = bytearray(path.read_bytes())
    data[100] ^= 0xFF
    path.write_bytes(bytes(data))
    with pytest.raises(ValueError):
        fmt.read_month(path)
