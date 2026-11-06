"""Synthesize voice-over lines with Piper (command tool, JSONL protocol).

Reads request.json (argv[-1]) and writes one 16-bit mono WAV per line into request["out_dir"].
Stdout carries the protocol lines only; everything else is a log line.

  {"type":"progress","fraction":0.5,"message":"..."}
  {"type":"result","result":{...},"outputs":[{"name":"line-001.wav"}]}
  {"type":"error","error":{"type":"invalid-input","detail":"..."}}
"""

import json
import sys
import traceback
import wave
from pathlib import Path

import numpy as np
from piper import PiperVoice, SynthesisConfig

TAIL_S = 0.03
SYNTHESIS_KEYS = ("length_scale", "noise_scale", "noise_w_scale")


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


def resolve_voice(request):
    """Find the voice to load. @returns (model_path, config_path, name)."""
    inp = request["input"]
    name = inp.get("voice")
    dirs = voice_dirs(request)
    if name:
        for folder in dirs:
            model = folder / f"{name}.onnx"
            config = folder / f"{name}.onnx.json"
            if model.is_file() and config.is_file():
                return model, config, name
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
    return model, config, stem


def line_name(line, index):
    """Output file stem for one line: the explicit name, else line-001, line-002, ..."""
    name = line.get("name")
    if not name:
        return f"line-{index + 1:03d}"
    if name in (".", ".."):
        raise InputError(f'line name "{name}" is not a usable file name')
    return name


def wav_seconds_and_speech_end(path, threshold_db):
    """(seconds, speech_end_s) of a 16-bit PCM WAV: last sample above the threshold, plus 0.03 s."""
    with wave.open(str(path), "rb") as wav:
        rate = wav.getframerate()
        frames = wav.getnframes()
        width = wav.getsampwidth()
        channels = wav.getnchannels()
        raw = wav.readframes(frames)
    seconds = frames / rate if rate else 0.0
    if width == 1:
        samples = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 3:
        triplets = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        values = triplets[:, 0] | (triplets[:, 1] << 8) | (triplets[:, 2] << 16)
        values = np.where(values >= 1 << 23, values - (1 << 24), values)
        samples = values.astype(np.float32) / 8388608.0
    elif width == 4:
        samples = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        return seconds, 0.0
    if channels > 1:
        samples = samples.reshape(-1, channels).max(axis=1)
    threshold = 10 ** (threshold_db / 20.0)
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if loud.size == 0:
        return seconds, 0.0
    end = min(seconds, (float(loud[-1]) + 1.0) / rate + TAIL_S)
    return seconds, end


def synthesis_config(inp):
    """SynthesisConfig with only the fields the request actually set."""
    kwargs = {}
    for key in SYNTHESIS_KEYS:
        if inp.get(key) is not None:
            kwargs[key] = float(inp[key])
    if inp.get("speaker") is not None:
        kwargs["speaker_id"] = int(inp["speaker"])
    if inp.get("volume") is not None:
        kwargs["volume"] = float(inp["volume"])
    if inp.get("normalize_audio") is not None:
        kwargs["normalize_audio"] = bool(inp["normalize_audio"])
    return SynthesisConfig(**kwargs)


def main():
    request = json.loads(Path(sys.argv[-1]).read_text(encoding="utf-8"))
    inp = request["input"]
    out_dir = Path(request["out_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)

    model_path, config_path, voice_name = resolve_voice(request)
    lines = inp["lines"]
    syn_config = synthesis_config(inp)
    threshold_db = float(inp.get("speech_end_threshold_db", -40))

    stems = [line_name(line, i) for i, line in enumerate(lines)]
    if len(set(stems)) != len(stems):
        raise InputError("line names must be unique")

    log(f"loading voice {voice_name} from {model_path}")
    voice = PiperVoice.load(str(model_path), config_path=str(config_path))
    sample_rate = voice.config.sample_rate
    progress(0, f"{len(lines)} line(s) with {voice_name}")

    results = []
    outputs = []
    for index, line in enumerate(lines):
        stem = stems[index]
        file_name = f"{stem}.wav"
        target = out_dir / file_name
        with wave.open(str(target), "wb") as wav:
            voice.synthesize_wav(line["text"], wav, syn_config=syn_config)
        seconds, speech_end = wav_seconds_and_speech_end(target, threshold_db)
        results.append(
            {
                "name": stem,
                "file": file_name,
                "text": line["text"],
                "seconds": round(seconds, 3),
                "speech_end_s": round(speech_end, 3),
            }
        )
        outputs.append({"name": file_name})
        log(f"{file_name}: {seconds:.3f} s (speech ends {speech_end:.3f} s)")
        progress((index + 1) / len(lines), f"{index + 1}/{len(lines)} {file_name}")

    emit(
        {
            "type": "result",
            "result": {"voice": voice_name, "sample_rate": sample_rate, "lines": results},
            "outputs": outputs,
        }
    )


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
