"""Long-lived local text-to-speech worker for screenpilot.

Node spawns `python tts_worker.py`, writes one JSON object per line to stdin and
reads one JSON object per line from stdout (UTF-8, flushed after every write).
The model stays loaded between requests; only one model is resident at a time.

stdout is reserved for the protocol: the real stdout is duplicated for replies and
fd 1 / sys.stdout are pointed at stderr, so library prints cannot corrupt it.
Logs and progress go to stderr.

Startup (nothing heavy is imported; torch and the model libraries load lazily):
  -> {"ready": true, "protocol": 1}

Requests (every request carries an `id`, echoed in the reply):
  {"id":1,"cmd":"synth","model":"voicetut"|"namaa","voice":str|null,"lang":"ar"|"en"|null,
   "text":"...","speed":1.0,"out":"/abs/x.wav"}
     -> {"id":1,"ok":true,"duration":3.21,"sr":24000}
     -> {"id":1,"ok":false,"kind":"oom"|"missing"|"bad-voice"|"bad-lang"|"other","error":"..."}
  {"id":2,"cmd":"voices"}  -> {"id":2,"ok":true,"models":[{name,langs,voices,installed}]}
  {"id":3,"cmd":"doctor"}  -> {"id":3,"ok":true,python,torch,cuda,gpu,vram_total_gb,device,models}
  {"id":4,"cmd":"quit"}    -> {"id":4,"ok":true}, then exit 0 (stdin EOF also exits 0)

Unknown cmd and malformed JSON lines get an ok:false/kind:"other" reply; the loop keeps running.

Environment: SCREENPILOT_LOCAL_DEVICE = auto (default) | cuda | cpu | mps.
"""

from __future__ import annotations

import gc
import importlib.util
import io
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable

PROTOCOL = 1
ARABIC_RE = re.compile("[؀-ۿ]")

VOICETUT_REPO = "mohammedaly22/VoiceTut-TTS"
NAMAA_REPO = "NAMAA-Space/NAMAA-Egyptian-TTS"
NAMAA_FILE = "t3_mtl23ls_v2.safetensors"
CHATTERBOX_REPO = "ResembleAI/chatterbox"
HIGGS_TOKENIZER_REPO = "eustlb/higgs-audio-v2-tokenizer"

OOM_MESSAGE = (
    "Out of GPU memory. Set SCREENPILOT_LOCAL_DEVICE=cpu (slower) "
    "or use model voicetut (needs less memory)."
)
MISSING_MESSAGE = (
    "Model library not installed in this Python (run: screenpilot voice-setup <model>)"
)

_proto_out: Any = None  # the real stdout, used only for protocol replies


class SynthError(Exception):
    """A request failure with a protocol `kind`."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


def log(message: str) -> None:
    print(f"[tts_worker] {message}", file=sys.stderr, flush=True)


def reply(obj: dict[str, Any]) -> None:
    _proto_out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _proto_out.flush()


# ----------------------------------------------------------------- helpers


def has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def detect_lang(text: str) -> str:
    return "ar" if ARABIC_RE.search(text) else "en"


def cached_file(repo: str, filename: str) -> str | None:
    """Path of a file in the local HF cache, or None. Never downloads."""
    try:
        from huggingface_hub import try_to_load_from_cache

        found = try_to_load_from_cache(repo, filename)
        return found if isinstance(found, str) else None
    except Exception:
        return None


def torch_cuda_oom_types() -> tuple[type, ...]:
    if "torch" not in sys.modules:
        return ()
    torch = sys.modules["torch"]
    oom = getattr(torch.cuda, "OutOfMemoryError", None)
    return (oom,) if oom else ()


def classify(exc: BaseException) -> tuple[str, str]:
    if isinstance(exc, SynthError):
        return exc.kind, str(exc)
    if isinstance(exc, ImportError):  # includes ModuleNotFoundError
        return "missing", f"{MISSING_MESSAGE} [{exc}]"
    if isinstance(exc, torch_cuda_oom_types()) or "out of memory" in str(exc).lower():
        return "oom", OOM_MESSAGE
    return "other", f"{type(exc).__name__}: {exc}"


def resolve_device() -> str:
    want = os.environ.get("SCREENPILOT_LOCAL_DEVICE", "auto").strip().lower() or "auto"
    if want not in ("auto", "cuda", "cpu", "mps"):
        raise SynthError(
            "other", f"SCREENPILOT_LOCAL_DEVICE={want!r} is invalid (use auto, cuda, cpu or mps)."
        )
    import torch

    cuda_ok = torch.cuda.is_available()
    mps_ok = bool(getattr(torch.backends, "mps", None)) and torch.backends.mps.is_available()
    if want == "auto":
        return "cuda" if cuda_ok else "mps" if mps_ok else "cpu"
    if want == "cuda" and not cuda_ok:
        raise SynthError("other", "SCREENPILOT_LOCAL_DEVICE=cuda but CUDA is not available; use auto or cpu.")
    if want == "mps" and not mps_ok:
        raise SynthError("other", "SCREENPILOT_LOCAL_DEVICE=mps but MPS is not available; use auto or cpu.")
    return want


def torch_no_grad() -> Any:
    import torch

    return torch.no_grad()


def clear_lru_caches() -> None:
    """Library methods decorated with @lru_cache keep `self` (the whole model) alive."""
    for obj in gc.get_objects():
        if type(obj).__name__ == "_lru_cache_wrapper":
            try:
                obj.cache_clear()
            except Exception:
                pass


def free_accelerator_memory() -> None:
    clear_lru_caches()
    gc.collect()
    if sys.platform.startswith("linux"):
        try:  # hand freed host memory back to the OS before the next model loads
            import ctypes

            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass
    if "torch" in sys.modules:
        torch = sys.modules["torch"]
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        try:
            mps = getattr(torch, "mps", None)
            if mps is not None and torch.backends.mps.is_available():
                mps.empty_cache()
        except Exception:
            pass


def write_wav(path: str, wav: Any, sr: int) -> float:
    import numpy as np
    import soundfile as sf

    data = np.asarray(wav, dtype=np.float32).reshape(-1)
    if data.size == 0:
        raise SynthError("other", "The model returned no audio for this text.")
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_name(out.name + ".part")
    sf.write(str(part), np.clip(data, -1.0, 1.0), sr, subtype="PCM_16", format="WAV")
    os.replace(part, out)
    return data.size / sr


# ----------------------------------------------------------------- adapters


class Adapter:
    """One TTS model. Subclasses implement load/synth; the rest is shared."""

    name = ""
    langs: list[str] = []
    module = ""

    def installed(self) -> bool:
        return has_module(self.module)

    def voices(self) -> list[str]:
        return ["default"]

    def check(self, voice: str | None, lang: str) -> str | None:
        """Validate a request without loading the model; returns the canonical voice."""
        return None

    def weights(self) -> tuple[bool, str]:
        raise NotImplementedError

    def load(self, device: str) -> None:
        raise NotImplementedError

    def synth(self, text: str, voice: str | None, lang: str, speed: float) -> tuple[Any, int]:
        raise NotImplementedError

    def unload(self) -> None:
        pass


class VoiceTutAdapter(Adapter):
    name = "voicetut"
    langs = ["ar", "en"]
    module = "voicetut_tts"

    def __init__(self) -> None:
        self.tts: Any = None

    def _references(self) -> str | None:
        found = cached_file(VOICETUT_REPO, "reference_speakers/references.json")
        if found:
            return found
        try:
            from huggingface_hub import snapshot_download

            snap = snapshot_download(
                VOICETUT_REPO, allow_patterns=["reference_speakers/*"], local_files_only=True
            )
            cand = os.path.join(snap, "reference_speakers", "references.json")
            if os.path.exists(cand):
                return cand
        except Exception:
            pass
        try:  # speakers bundled next to a source install of the package
            spec = importlib.util.find_spec(self.module)
            if spec and spec.origin:
                cand = os.path.join(
                    os.path.dirname(spec.origin), os.pardir, "reference_speakers", "references.json"
                )
                if os.path.exists(cand):
                    return os.path.normpath(cand)
        except Exception:
            pass
        return None

    def voices(self) -> list[str]:
        path = self._references()
        if not path:
            return []
        try:
            with open(path, encoding="utf-8") as f:
                return [str(e["speaker_name"]) for e in json.load(f)]
        except Exception as exc:
            log(f"could not read speakers from {path}: {exc}")
            return []

    def check(self, voice: str | None, lang: str) -> str | None:
        names = self.voices()
        if not voice:
            return names[0] if names else None
        for n in names:
            if n.lower() == voice.lower():
                return n
        if not names:
            return voice  # cannot list speakers here; let the model decide
        raise SynthError("bad-voice", f"Unknown voice {voice!r} for voicetut. Valid voices: {', '.join(names)}.")

    def weights(self) -> tuple[bool, str]:
        main = cached_file(VOICETUT_REPO, "model.safetensors")
        refs = cached_file(VOICETUT_REPO, "reference_speakers/references.json")
        tok = cached_file(HIGGS_TOKENIZER_REPO, "model.safetensors")
        missing = [
            label
            for label, path in (
                (f"{VOICETUT_REPO}/model.safetensors", main),
                (f"{VOICETUT_REPO}/reference_speakers", refs),
                (f"{HIGGS_TOKENIZER_REPO}/model.safetensors", tok),
            )
            if not path
        ]
        if missing:
            return False, "not in the Hugging Face cache: " + ", ".join(missing)
        return True, "cached: " + os.path.dirname(main)  # type: ignore[arg-type]

    def load(self, device: str) -> None:
        from voicetut_tts import VoiceTutTTS

        kwargs: dict[str, Any] = {}
        refs = self._references()
        if refs:
            kwargs["references"] = refs
        dtype = "float16" if device == "cuda" else "float32"
        self.tts = VoiceTutTTS.from_pretrained(VOICETUT_REPO, device=device, dtype=dtype, **kwargs)

    def synth(self, text: str, voice: str | None, lang: str, speed: float) -> tuple[Any, int]:
        speaker = voice
        if not speaker:
            speakers = self.tts.list_speakers()
            speaker = speakers[0].speaker_name if speakers else None
        extra = {} if abs(speed - 1.0) < 1e-6 else {"speed": speed}
        wav = self.tts.synthesize(text, speaker=speaker, language=lang, **extra)
        return wav, int(self.tts.sampling_rate)

    def unload(self) -> None:
        self.tts = None


class NamaaAdapter(Adapter):
    name = "namaa"
    langs = ["ar"]
    module = "chatterbox"

    def __init__(self) -> None:
        self.model: Any = None

    def check(self, voice: str | None, lang: str) -> str | None:
        if lang != "ar":
            raise SynthError("bad-lang", "namaa speaks Egyptian Arabic only; use model voicetut for English lines")
        return None

    def weights(self) -> tuple[bool, str]:
        parts = (
            (NAMAA_REPO, NAMAA_FILE),
            (CHATTERBOX_REPO, "s3gen.pt"),
            (CHATTERBOX_REPO, "t3_mtl23ls_v2.safetensors"),
            (CHATTERBOX_REPO, "ve.pt"),
        )
        missing = [f"{r}/{f}" for r, f in parts if not cached_file(r, f)]
        if missing:
            return False, "not in the Hugging Face cache: " + ", ".join(missing)
        return True, f"cached: {NAMAA_REPO} fine-tune on top of {CHATTERBOX_REPO}"

    def load(self, device: str) -> None:
        from huggingface_hub import snapshot_download

        namaa = os.path.join(snapshot_download(NAMAA_REPO, allow_patterns=[NAMAA_FILE]), NAMAA_FILE)
        try:
            self.model = self._load_lean(device, namaa)
        except (AttributeError, TypeError, KeyError) as exc:
            # chatterbox internals changed: use its public loader (needs ~2 GB more host RAM).
            log(f"lean namaa load unavailable ({exc!r}); falling back to from_pretrained")
            self.model = self._load_public(device, namaa)

    @staticmethod
    def _stream_t3(t3: Any, path: str) -> None:
        """Copy the fine-tuned T3 weights in one tensor at a time (no 2 GB state dict)."""
        from safetensors import safe_open

        params = t3.state_dict()
        with safe_open(path, framework="pt", device="cpu") as f:
            keys = set(f.keys())
            if keys != set(params):
                diff = sorted(keys ^ set(params))[:5]
                raise RuntimeError(f"NAMAA checkpoint does not match the Chatterbox T3 (e.g. {diff})")
            with torch_no_grad():
                for key in keys:
                    params[key].copy_(f.get_tensor(key))
        t3.eval()

    def _load_public(self, device: str, namaa: str) -> Any:
        from chatterbox import mtl_tts

        model = mtl_tts.ChatterboxMultilingualTTS.from_pretrained(device=device)
        self._stream_t3(model.t3, namaa)
        return model

    def _load_lean(self, device: str, namaa: str) -> Any:
        """ChatterboxMultilingualTTS.from_local minus the base T3 checkpoint.

        The stock loader reads the 2 GB base T3 only for NAMAA to overwrite it, which
        peaks near 5 GB of host RAM. Here T3 is built directly on the device and filled
        from the NAMAA file, and the other parts load exactly as chatterbox does.
        """
        import torch
        from chatterbox import mtl_tts as m
        from huggingface_hub import snapshot_download

        base = Path(
            snapshot_download(
                CHATTERBOX_REPO,
                revision="main",
                allow_patterns=["ve.pt", "s3gen.pt", "grapheme_mtl_merged_expanded_v1.json", "conds.pt", "Cangjie5_TC.json"],
            )
        )
        map_location = torch.device("cpu") if device in ("cpu", "mps") else None
        ve = m.VoiceEncoder()
        ve.load_state_dict(torch.load(base / "ve.pt", map_location=map_location, weights_only=True))
        ve.to(device).eval()
        with torch.device(device):
            t3 = m.T3(m.T3Config.multilingual())
        self._stream_t3(t3, namaa)
        s3gen = m.S3Gen()
        s3gen.load_state_dict(torch.load(base / "s3gen.pt", map_location=map_location, weights_only=True))
        s3gen.to(device).eval()
        tokenizer = m.MTLTokenizer(str(base / "grapheme_mtl_merged_expanded_v1.json"))
        conds = None
        if (base / "conds.pt").exists():
            conds = m.Conditionals.load(base / "conds.pt", map_location=map_location).to(device)
        return m.ChatterboxMultilingualTTS(t3, s3gen, ve, tokenizer, device, conds=conds)

    def synth(self, text: str, voice: str | None, lang: str, speed: float) -> tuple[Any, int]:
        # voice and speed are ignored: single voice, no speed control in Chatterbox.
        wav = self.model.generate(text, language_id="ar")
        return wav.squeeze().detach().float().cpu().numpy(), int(self.model.sr)

    def unload(self) -> None:
        self.model = None


ADAPTERS: dict[str, Callable[[], Adapter]] = {
    "voicetut": VoiceTutAdapter,
    "namaa": NamaaAdapter,
}


# ----------------------------------------------------------------- worker


class Worker:
    def __init__(self) -> None:
        self.adapters: dict[str, Adapter] = {name: make() for name, make in ADAPTERS.items()}
        self.current: Adapter | None = None
        self.device: str | None = None

    def drop_model(self) -> None:
        if self.current is not None:
            log(f"unloading {self.current.name}")
            self.current.unload()
            self.current = None
        free_accelerator_memory()

    def ensure(self, adapter: Adapter) -> None:
        device = resolve_device()
        if self.current is adapter and self.device == device:
            return
        self.drop_model()
        log(f"loading {adapter.name} on {device} ...")
        t0 = time.time()
        try:
            adapter.load(device)
        except BaseException:
            adapter.unload()
            free_accelerator_memory()
            raise
        self.current, self.device = adapter, device
        log(f"loaded {adapter.name} in {time.time() - t0:.1f}s{vram_note()}")

    def synth(self, req: dict[str, Any]) -> dict[str, Any]:
        name = req.get("model")
        adapter = self.adapters.get(name) if isinstance(name, str) else None
        if adapter is None:
            raise SynthError("other", f"Unknown model {name!r}. Available: {', '.join(self.adapters)}.")
        text = req.get("text")
        if not isinstance(text, str) or not text.strip():
            raise SynthError("other", "text is empty.")
        out = req.get("out")
        if not isinstance(out, str) or not out:
            raise SynthError("other", "out (output wav path) is required.")
        lang = req.get("lang") or detect_lang(text)
        if lang not in ("ar", "en"):
            raise SynthError("bad-lang", f"Unsupported lang {lang!r}. Use ar or en.")
        voice = adapter.check(req.get("voice"), lang)
        try:
            speed = float(req.get("speed") or 1.0)
        except (TypeError, ValueError):
            raise SynthError("other", "speed must be a number.")

        self.ensure(adapter)
        reset_peak()
        t0 = time.time()
        wav, sr = adapter.synth(text, voice, lang, speed)
        took = time.time() - t0
        duration = write_wav(out, wav, sr)
        log(f"{adapter.name} {lang} {duration:.2f}s audio in {took:.2f}s (rtf {took / duration:.2f}){vram_note(peak=True)}")
        return {"duration": round(duration, 3), "sr": sr}

    def voices(self) -> dict[str, Any]:
        return {
            "models": [
                {"name": a.name, "langs": a.langs, "voices": a.voices(), "installed": a.installed()}
                for a in self.adapters.values()
            ]
        }

    def doctor(self) -> dict[str, Any]:
        info: dict[str, Any] = {
            "python": ".".join(str(p) for p in sys.version_info[:3]),
            "torch": None,
            "cuda": False,
            "gpu": None,
            "vram_total_gb": None,
            "device": "cpu",
        }
        if has_module("torch"):
            try:
                import torch

                info["torch"] = torch.__version__
                if torch.cuda.is_available():
                    props = torch.cuda.get_device_properties(0)
                    info.update(cuda=True, gpu=props.name, vram_total_gb=round(props.total_memory / 2**30, 2))
                elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                    info["gpu"] = "Apple GPU (MPS)"
                info["device"] = resolve_device()
            except SynthError as exc:
                info["device_error"] = str(exc)
            except Exception as exc:
                log(f"torch probe failed: {exc}")
        models: dict[str, Any] = {}
        for a in self.adapters.values():
            has_weights, detail = a.weights()
            if not a.installed():
                detail = f"python package {a.module!r} not importable; {detail}"
            models[a.name] = {"installed": a.installed(), "weights": has_weights, "detail": detail}
        info["models"] = models
        return info

    def handle(self, req: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """Returns (reply body without id/ok, should_quit)."""
        cmd = req.get("cmd")
        if cmd == "synth":
            return self.synth(req), False
        if cmd == "voices":
            return self.voices(), False
        if cmd == "doctor":
            return self.doctor(), False
        if cmd == "quit":
            return {}, True
        raise SynthError("other", "unknown cmd")


def reset_peak() -> None:
    if "torch" in sys.modules:
        try:
            if sys.modules["torch"].cuda.is_available():
                sys.modules["torch"].cuda.reset_peak_memory_stats()
        except Exception:
            pass


def vram_note(peak: bool = False) -> str:
    if "torch" not in sys.modules:
        return ""
    try:
        torch = sys.modules["torch"]
        if not torch.cuda.is_available():
            return ""
        cur = torch.cuda.memory_allocated() / 2**30
        if peak:
            return f" | vram now {cur:.2f} GB, peak {torch.cuda.max_memory_allocated() / 2**30:.2f} GB"
        return f" | vram {cur:.2f} GB"
    except Exception:
        return ""


def main() -> int:
    global _proto_out
    # Keep the real stdout for the protocol; anything else that writes to fd 1 or
    # sys.stdout (library prints, C extensions) lands on stderr instead.
    _proto_out = io.TextIOWrapper(
        os.fdopen(os.dup(1), "wb", buffering=0), encoding="utf-8", newline="\n", write_through=True
    )
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass
    stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace")

    worker = Worker()
    reply({"ready": True, "protocol": PROTOCOL})

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        req_id: Any = None
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("request must be a JSON object")
            req_id = req.get("id")
        except ValueError as exc:
            reply({"id": None, "ok": False, "kind": "other", "error": f"malformed request: {exc}"})
            continue
        try:
            body, quit_now = worker.handle(req)
            reply({"id": req_id, "ok": True, **body})
            if quit_now:
                return 0
        except BaseException as exc:  # never let one request kill the loop
            if isinstance(exc, KeyboardInterrupt):
                raise
            kind, message = classify(exc)
            if kind == "oom":
                worker.drop_model()
            if kind == "other" and not isinstance(exc, SynthError):
                import traceback

                traceback.print_exc()
            reply({"id": req_id, "ok": False, "kind": kind, "error": message})
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except KeyboardInterrupt:
        code = 130
    sys.exit(code)
