"""Show how a Piper voice pronounces text, as IPA (command tool, JSONL protocol).

Reads request.json (argv[-1]); needs only the voice CONFIG (<voice>.onnx.json), never the ONNX model,
so it is cheap and deterministic. Stdout carries protocol lines only.

  {"type":"progress","fraction":0.5,"message":"..."}
  {"type":"result","result":{"results":[{"text":"...","sentences":["..."],"ipa":"..."}]}}
  {"type":"error","error":{"type":"invalid-input","detail":"..."}}
"""

import json
import sys
import traceback
from pathlib import Path

from piper import PiperConfig, PiperVoice


class InputError(Exception):
    """A problem with the request itself (reported as invalid-input)."""


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message):
    emit({"type": "log", "message": str(message)})


def progress(fraction, message=None):
    event = {"type": "progress", "fraction": fraction}
    if message is not None:
        event["message"] = message
    emit(event)


def voice_dirs(request):
    """Configured voice folders as Paths (missing folders are ignored later)."""
    return [Path(d) for d in ((request.get("config") or {}).get("voicesDirs") or [])]


def available_voices(dirs):
    """Every <name>.onnx in the voice folders, sorted, without the extension."""
    names = set()
    for folder in dirs:
        try:
            for entry in folder.iterdir():
                if entry.is_file() and entry.name.endswith(".onnx"):
                    names.add(entry.name[: -len(".onnx")])
        except OSError:
            continue
    return sorted(names)


def resolve_voice_config(request):
    """Find the voice config to read. @returns (config_path, name)."""
    inp = request["input"]
    name = inp.get("voice")
    dirs = voice_dirs(request)
    if name:
        for folder in dirs:
            model = folder / f"{name}.onnx"
            config = folder / f"{name}.onnx.json"
            if model.is_file() and config.is_file():
                return config, name
        found = ", ".join(available_voices(dirs)) or "none"
        raise InputError(f"unknown voice {name}; available: {found}")
    raw = inp.get("voice_file")
    if not raw:
        raise InputError("one of voice or voice_file is required")
    model = Path(raw)
    config = Path(str(model) + ".json")
    if not model.is_file():
        raise InputError(f"voice file not found: {raw}")
    if not config.is_file():
        raise InputError(f"missing voice config {config.name} next to {model.name}")
    stem = model.name[: -len(".onnx")] if model.name.endswith(".onnx") else model.stem
    return config, stem


def load_phonemizer(config_path):
    """A PiperVoice with the config only: phonemization never touches the ONNX session."""
    config_dict = json.loads(Path(config_path).read_text(encoding="utf-8"))
    return PiperVoice(session=None, config=PiperConfig.from_dict(config_dict))


def phonemize_text(voice, text):
    """@returns {"text", "sentences", "ipa"} with each sentence a joined phoneme string."""
    sentences = ["".join(phonemes) for phonemes in voice.phonemize(text)]
    return {"text": text, "sentences": sentences, "ipa": " ".join(sentences)}


def main():
    request = json.loads(Path(sys.argv[-1]).read_text(encoding="utf-8"))
    inp = request["input"]
    config_path, voice_name = resolve_voice_config(request)
    texts = inp["texts"]

    log(f"phonemizing with {voice_name} ({config_path})")
    voice = load_phonemizer(config_path)
    progress(0, f"{len(texts)} text(s) with {voice_name}")

    results = []
    for index, text in enumerate(texts):
        results.append(phonemize_text(voice, text))
        progress((index + 1) / len(texts), f"{index + 1}/{len(texts)}")

    emit({"type": "result", "result": {"results": results}})


if __name__ == "__main__":
    try:
        main()
    except InputError as error:
        emit({"type": "error", "error": {"type": "invalid-input", "detail": str(error)}})
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 - any other failure is a tool failure
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "error": {"type": "tool-failed", "detail": f"{type(error).__name__}: {error}"}})
        sys.exit(1)
