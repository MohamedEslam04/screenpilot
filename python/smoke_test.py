"""Smoke test for tts_worker.py: spawns it like screenpilot's Node code does.

Run with the Python that has the TTS libraries, e.g. on the dev machine:

  HF_HOME=/data/tts-spike/cache/hf HF_HUB_OFFLINE=1 TMPDIR=/data/tts-spike/tmp \\
  XDG_CACHE_HOME=/data/tts-spike/cache/xdg /data/tts-spike/venv/bin/python python/smoke_test.py

Env: SMOKE_OUT_DIR (default /data/tts-spike/test-out), SMOKE_CUDA=0 to skip the cuda checks.
Worker stderr is streamed to the terminal so load times and VRAM peaks are visible.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = Path(os.environ.get("SMOKE_OUT_DIR", "/data/tts-spike/test-out"))
EXPECT_CUDA = os.environ.get("SMOKE_CUDA", "1") != "0"

AR = "أهلاً بيك! هنفتح التطبيق ونعمل أول مشروع."
AR2 = "دوس على زرار الإضافة، وبعدها اكتب اسم المشروع."
EN = "Let's open the app and create our first project."

failures: list[str] = []


def check(cond: bool, label: str, detail: str = "") -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  ({detail})" if detail else ""), flush=True)
    if not cond:
        failures.append(label)


class Worker:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, str(HERE / "tts_worker.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.raw_stdout: list[bytes] = []
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stderr(self) -> None:
        assert self.proc.stderr
        for line in self.proc.stderr:
            sys.stderr.write("      | " + line.decode("utf-8", "replace"))
            sys.stderr.flush()

    def read(self) -> dict:
        assert self.proc.stdout
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("worker closed stdout")
        self.raw_stdout.append(line)
        return json.loads(line.decode("utf-8"))

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def call(self, **req) -> dict:
        self.send_raw((json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8"))
        return self.read()


def wav_info(path: Path) -> tuple[float, int, int]:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate(), w.getframerate(), w.getnchannels()


def synth(w: Worker, rid: int, model: str, text: str, name: str, **kw) -> tuple[dict, Path, float]:
    out = OUT / name
    out.unlink(missing_ok=True)
    t0 = time.time()
    r = w.call(id=rid, cmd="synth", model=model, voice=kw.get("voice"), lang=kw.get("lang"),
               text=text, speed=1.0, out=str(out))
    return r, out, time.time() - t0


def check_synth(r: dict, out: Path, rid: int, label: str) -> None:
    check(r.get("id") == rid and r.get("ok") is True, f"{label}: ok reply", json.dumps(r, ensure_ascii=False))
    if not r.get("ok"):
        return
    check(out.exists() and not Path(str(out) + ".part").exists(), f"{label}: wav written, no .part left")
    dur, sr, ch = wav_info(out)
    check(2.0 <= dur <= 6.0, f"{label}: duration in 2-6 s", f"{dur:.2f}s")
    check(abs(dur - r["duration"]) < 0.05, f"{label}: reply duration matches file", f"{r['duration']} vs {dur:.3f}")
    check(sr == r["sr"] and ch == 1, f"{label}: sr and mono match", f"sr={sr} ch={ch}")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    w = Worker()
    t0 = time.time()
    ready = w.read()
    print(f"ready line after {time.time() - t0:.2f}s: {ready}")
    check(ready == {"ready": True, "protocol": 1}, "ready line")

    print("voices")
    r = w.call(id=2, cmd="voices")
    by_name = {m["name"]: m for m in r.get("models", [])}
    check(r.get("ok") and set(by_name) == {"voicetut", "namaa"}, "voices lists both models")
    check(len(by_name.get("voicetut", {}).get("voices", [])) >= 19, "voicetut has >= 19 voices",
          str(len(by_name.get("voicetut", {}).get("voices", []))))
    check(by_name.get("voicetut", {}).get("langs") == ["ar", "en"] and by_name["namaa"]["voices"] == ["default"],
          "langs and namaa voices")
    check(all(m["installed"] for m in by_name.values()), "both installed")

    print("doctor")
    r = w.call(id=3, cmd="doctor")
    print("  ", json.dumps(r, ensure_ascii=False))
    check(r.get("ok") is True, "doctor ok")
    if EXPECT_CUDA:
        check(r.get("cuda") is True and r.get("device") == "cuda", "doctor: cuda true, device cuda")
    check(all(m["weights"] for m in r.get("models", {}).values()) and len(r.get("models", {})) == 2,
          "doctor: weights found in cache (nothing downloaded)")
    check(isinstance(r.get("python"), str), "doctor: python version")

    print("synth voicetut")
    r, out, took = synth(w, 10, "voicetut", AR, "smoke_voicetut_ar.wav", voice="Sarah")
    check_synth(r, out, 10, "voicetut ar (incl. model load)")
    print(f"  round trip incl. load: {took:.1f}s")
    r, out, took = synth(w, 11, "voicetut", EN, "smoke_voicetut_en.wav", voice="sarah", lang="en")
    check_synth(r, out, 11, "voicetut en voice sarah (case-insensitive)")
    print(f"  round trip: {took:.1f}s")
    r, out, took = synth(w, 12, "voicetut", AR2, "smoke_voicetut_ar_nullvoice.wav")
    check_synth(r, out, 12, "voicetut ar default voice, lang auto")
    r, out, _ = synth(w, 13, "voicetut", AR2, "smoke_voicetut_ar_fast.wav", voice="Ahmed")
    check_synth(r, out, 13, "voicetut ar voice Ahmed")

    print("validation errors (no model load)")
    r, _, _ = synth(w, 20, "voicetut", EN, "smoke_bad.wav", voice="Nobody")
    check(r.get("ok") is False and r.get("kind") == "bad-voice" and "Sarah" in r.get("error", ""),
          "unknown voice -> bad-voice listing names", r.get("error", "")[:60])
    r, _, _ = synth(w, 21, "voicetut", EN, "smoke_bad.wav", lang="fr")
    check(r.get("kind") == "bad-lang", "unsupported lang -> bad-lang")
    r, _, _ = synth(w, 22, "nope", EN, "smoke_bad.wav")
    check(r.get("ok") is False and r.get("kind") == "other", "unknown model -> other")
    r, _, _ = synth(w, 23, "namaa", EN, "smoke_bad.wav", lang="en")
    check(r.get("kind") == "bad-lang" and "Egyptian Arabic only" in r.get("error", ""), "namaa lang en -> bad-lang")
    r, _, _ = synth(w, 24, "namaa", EN, "smoke_bad.wav")
    check(r.get("kind") == "bad-lang", "namaa, English text auto-detected -> bad-lang")

    print("synth namaa after voicetut (model swap)")
    r, out, took = synth(w, 30, "namaa", AR, "smoke_namaa_ar.wav")
    check_synth(r, out, 30, "namaa ar after voicetut")
    print(f"  round trip incl. swap and load: {took:.1f}s")
    r, out, took = synth(w, 31, "namaa", AR2, "smoke_namaa_ar2.wav", voice="whatever", lang="ar")
    check_synth(r, out, 31, "namaa ar second line (voice ignored)")
    print(f"  round trip: {took:.1f}s")
    r, out, took = synth(w, 32, "voicetut", AR, "smoke_voicetut_ar_back.wav", voice="Sarah")
    check_synth(r, out, 32, "voicetut again after namaa (swap back)")

    print("robustness")
    w.send_raw(b"this is not json\n")
    r = w.read()
    check(r.get("id") is None and r.get("ok") is False and r.get("kind") == "other", "malformed line -> error reply")
    w.send_raw(b"[1,2]\n")
    r = w.read()
    check(r.get("ok") is False and r.get("id") is None, "non-object JSON -> error reply")
    r = w.call(id=40, cmd="frobnicate")
    check(r == {"id": 40, "ok": False, "kind": "other", "error": "unknown cmd"}, "unknown cmd")
    r = w.call(id=41, cmd="voices")
    check(r.get("ok") is True and r.get("id") == 41, "worker still alive after bad input")

    print("quit")
    r = w.call(id=99, cmd="quit")
    check(r == {"id": 99, "ok": True}, "quit reply")
    try:
        code = w.proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        w.proc.kill()
        code = -1
    check(code == 0, "exit code 0", str(code))

    bad = []
    for raw in w.raw_stdout:
        try:
            json.loads(raw.decode("utf-8"))
        except Exception:
            bad.append(raw)
    check(not bad and bool(w.raw_stdout), "stdout held only JSON lines", f"{len(w.raw_stdout)} lines")

    print("stdin EOF")
    w2 = Worker()
    w2.read()
    assert w2.proc.stdin
    w2.proc.stdin.close()
    try:
        code = w2.proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        w2.proc.kill()
        code = -1
    check(code == 0, "stdin EOF exits 0", str(code))

    print()
    if failures:
        print(f"FAILED {len(failures)}: " + "; ".join(failures))
        return 1
    print("ALL OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
