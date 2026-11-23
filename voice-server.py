"""
Local Hebrew speech-to-text for the WhatsApp bot (voice messages -> text).

* Model: ivrit.ai Whisper (Hebrew fine-tuned) via faster-whisper - runs on THIS computer,
  voice messages never leave it.
* Speaks the OpenAI API: POST /v1/audio/transcriptions (multipart: file, model, language)
  -> {"text": "..."}  so the bot only needs TRANSCRIBE_URL=http://127.0.0.1:8090/v1
* Listens on 127.0.0.1 only.

Started automatically by the bot's launch scripts when voice\\venv exists (scriptsinstall-voice.ps1).
"""
import json
import os
import sys
import tempfile
import threading
import time
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("VOICE_PORT", "8090"))
MODEL_ID = os.environ.get("VOICE_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")
MAX_BYTES = 40 * 1024 * 1024

_model = None
_model_info = {"device": None, "error": None}
_lock = threading.Lock()


def _add_cuda_dll_dirs():
    """pip's nvidia-cublas / nvidia-cudnn wheels put their DLLs here - make Windows find them."""
    if os.name != "nt":
        return
    import site
    for base in site.getsitepackages() + [site.getusersitepackages()]:
        for sub in ("nvidia/cublas/bin", "nvidia/cudnn/bin"):
            d = os.path.join(base, sub)
            if os.path.isdir(d):
                try:
                    os.add_dll_directory(d)
                    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                except OSError:
                    pass


def load_model():
    global _model
    _add_cuda_dll_dirs()
    from faster_whisper import WhisperModel
    attempts = [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]
    if os.environ.get("VOICE_DEVICE", "").lower() == "cpu":
        attempts = [("cpu", "int8")]
    last = None
    for device, compute in attempts:
        try:
            m = WhisperModel(MODEL_ID, device=device, compute_type=compute)
            _model = m
            _model_info.update(device=f"{device}/{compute}", error=None)
            print(f"[voice] model {MODEL_ID} loaded on {device} ({compute})", flush=True)
            return
        except Exception as err:  # noqa: BLE001 - try the next option
            last = err
            print(f"[voice] {device}/{compute} not available: {err}", flush=True)
    _model_info["error"] = str(last)
    raise RuntimeError(f"could not load the model: {last}")


def transcribe(path, language="he"):
    with _lock:  # one at a time - keeps GPU memory predictable
        segments, _info = _model.transcribe(path, language=language or "he", beam_size=5, vad_filter=True)
        return " ".join(s.text.strip() for s in segments).strip()


def parse_multipart(content_type, body):
    msg = BytesParser(policy=email_policy).parsebytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    fields, files = {}, {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename:
            files[name] = (filename, payload)
        elif name:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, files


class Handler(BaseHTTPRequestHandler):
    server_version = "bot-voice/1.0"

    def _json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # quieter log
        sys.stdout.write("[voice] %s\n" % (fmt % args))

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/v1/models"):
            return self._json(200, {"ok": _model is not None, "model": MODEL_ID, **_model_info,
                                    "data": [{"id": MODEL_ID, "object": "model"}]})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/audio/transcriptions", "/audio/transcriptions"):
            return self._json(404, {"error": "not found"})
        if _model is None:
            return self._json(503, {"error": {"message": "model is still loading" if not _model_info["error"] else _model_info["error"]}})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self._json(413, {"error": {"message": "file too large or empty"}})
        body = self.rfile.read(length)
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            return self._json(400, {"error": {"message": "multipart/form-data expected"}})
        fields, files = parse_multipart(ctype, body)
        if "file" not in files:
            return self._json(400, {"error": {"message": "no file"}})
        filename, data = files["file"]
        suffix = os.path.splitext(filename)[1] or ".ogg"
        fd, tmp = tempfile.mkstemp(suffix=suffix)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            t0 = time.time()
            text = transcribe(tmp, fields.get("language") or "he")
            print(f"[voice] {len(data)//1024} KB -> {len(text)} chars in {time.time() - t0:.1f}s", flush=True)
            return self._json(200, {"text": text})
        except Exception as err:  # noqa: BLE001
            return self._json(500, {"error": {"message": str(err)}})
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[voice] listening on http://{HOST}:{PORT}/v1 (model {MODEL_ID})", flush=True)
    threading.Thread(target=lambda: (load_model() if os.environ.get("VOICE_FAKE") != "1" else None), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
