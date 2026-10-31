import os
import secrets
import shutil
import smtplib
import string
import subprocess
import time
import uuid
from email.message import EmailMessage
from pathlib import Path
from threading import Lock, Semaphore, Thread
from dotenv import load_dotenv

from fastapi import BackgroundTasks, Cookie, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image
from pillow_heif import register_heif_opener
from pydantic import BaseModel, EmailStr

register_heif_opener()  # obsługa HEIC w Pillow (odczyt i zapis)
load_dotenv()
# ---------- KONFIGURACJA ----------
GMAIL_USER = os.environ["GMAIL_USER"]                 # np. twojadres@gmail.com
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]   # hasło aplikacji z Google (16 znaków)
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000").rstrip("/")  # bez ukośnika na końcu
COOKIE_NAME = "session"
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") == "1"  # 1 = cookie tylko przez HTTPS; na lokalnym http ustaw 0

MAX_USERS = 30                  # maks. zalogowanych osób naraz
MAX_SESSIONS_PER_IP = int(os.environ.get("MAX_SESSIONS_PER_IP", 5))  # maks. sesji z jednego IP
AUTH_PER_MIN = 10               # maks. żądań /auth/* na minutę z jednego IP
MAX_FILES = 5                   # maks. aktywnych plików na użytkownika
MAX_SIZE = 100 * 1024 * 1024    # 100 MB na plik wejściowy
MAX_OUT = 200 * 1024 * 1024     # 200 MB na plik wynikowy
MAX_PIXELS = 50_000_000         # maks. rozmiar obrazu w pikselach
TOKEN_TTL = 30 * 60             # token ważny 30 min
OTP_TTL = 10 * 60               # kod ważny 10 min
FILE_TTL = 10 * 60              # pliki kasowane po 10 min
OTP_ALPHABET = string.ascii_uppercase + string.digits

# WHITELISTA: jedyne dozwolone formaty (i ich rodzaj). Konwersja tylko w obrębie rodzaju.
KIND = {
    "jpg": "image", "png": "image", "gif": "image", "heic": "image",
    "mp3": "audio", "wav": "audio", "flac": "audio",
    "mp4": "video", "mov": "video",
}
IMG_FORMAT = {"jpg": "JPEG", "png": "PNG", "gif": "GIF", "heic": "HEIF"}
DEMUXER = {"mp3": "mp3", "wav": "wav", "flac": "flac", "mp4": "mov", "mov": "mov"}  # ffmpeg nie zgaduje formatu
HEIC_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1"}

slots = Semaphore(3)  # maks. 3 konwersje naraz (ffmpeg jest ciężki)

STORAGE = Path("storage")
shutil.rmtree(STORAGE, ignore_errors=True)  # po restarcie metadane znikają, więc czyścimy dysk
STORAGE.mkdir()

# ---------- STAN W PAMIĘCI (działa tylko przy 1 workerze) ----------
otps = {}        # email -> {"code", "expires", "sent", "tries"}
sessions = {}    # token -> {"email", "expires", "ip"}
files = {}       # file_id -> {"owner": email, "path", "format", "expires"}
ip_hits = {}     # ip -> [czasy ostatnich żądań /auth/*]
converting = set()  # e-maile, które mają teraz trwającą konwersję
lock = Lock()

app = FastAPI()


# ---------- STRAŻNIK ŻĄDAŃ (działa PRZED parsowaniem ciała żądania) ----------
@app.middleware("http")
async def guard(request: Request, call_next):
    if request.method in ("POST", "DELETE"):  # ochrona CSRF: żądania zmieniające stan tylko z naszego frontendu
        if request.headers.get("origin") != FRONTEND_ORIGIN:
            return JSONResponse({"detail": "Niedozwolony origin"}, status_code=403)
    if request.method == "POST":
        is_upload = request.url.path == "/convert"
        limit = MAX_SIZE + 1_000_000 if is_upload else 10_000
        n = request.headers.get("content-length", "0")
        if "transfer-encoding" in request.headers or not n.isdigit() or int(n) > limit:
            return JSONResponse({"detail": "Nieprawidłowy rozmiar żądania"}, status_code=413)
        if is_upload:  # bez ważnego tokenu serwer nawet nie zaczyna przyjmować pliku
            token = request.cookies.get(COOKIE_NAME, "")
            with lock:
                cleanup()
                ok = token in sessions
            if not ok:
                return JSONResponse({"detail": "Brak dostępu lub sesja wygasła"}, status_code=401)
    return await call_next(request)


# CORS dodany PO strażniku, żeby był warstwą zewnętrzną (odpowiedzi 401/413 też mają nagłówki CORS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
    allow_credentials=True,  # przeglądarka może wysyłać cookie (origin jest konkretny, nie "*")
)


# ---------- POMOCNICZE ----------
def cleanup():
    """Usuwa wygasłe kody, sesje, pliki (z dysku) i stare liczniki IP. Wywoływać pod lockiem."""
    now = time.time()
    for d in (otps, sessions):
        for k in [k for k, v in d.items() if v["expires"] < now]:
            del d[k]
    for i in [i for i, f in files.items() if f["expires"] < now]:
        files.pop(i)["path"].unlink(missing_ok=True)
    for ip in [ip for ip, h in ip_hits.items() if not h or h[-1] < now - 60]:
        del ip_hits[ip]


def janitor():
    while True:  # pliki znikają po 10 min nawet gdy nikt nie wysyła żądań
        time.sleep(30)
        with lock:
            cleanup()


Thread(target=janitor, daemon=True).start()


def client_ip(request: Request):
    return request.client.host if request.client else "?"


def rate_limit(request: Request):
    """Limit żądań /auth/* na minutę z jednego IP."""
    ip, now = client_ip(request), time.time()
    with lock:
        hits = [t for t in ip_hits.get(ip, []) if now - t < 60]
        if len(hits) >= AUTH_PER_MIN:
            raise HTTPException(429, "Za dużo żądań, spróbuj za chwilę")
        hits.append(now)
        ip_hits[ip] = hits


def normalize_email(email: str):
    """Gmail ignoruje kropki i część po '+', więc a.b+x@gmail.com to ta sama skrzynka co ab@gmail.com."""
    local, domain = email.lower().split("@")
    if domain in ("gmail.com", "googlemail.com"):
        local, domain = local.split("+")[0].replace(".", ""), "gmail.com"
    return f"{local}@{domain}"


def user_file_count(email):  # wołać pod lockiem
    return sum(1 for f in files.values() if f["owner"] == email)


def detect(h: bytes):
    """Rozpoznaje format po pierwszych bajtach (nie ufamy rozszerzeniu)."""
    if h[:3] == b"\xff\xd8\xff":
        return "jpg"
    if h[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if h[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if h[:4] == b"fLaC":
        return "flac"
    if h[:4] == b"RIFF" and h[8:12] == b"WAVE":
        return "wav"
    if h[:3] == b"ID3" or (len(h) > 1 and h[0] == 0xFF and h[1] & 0xE0 == 0xE0):
        return "mp3"
    if h[4:8] == b"ftyp":
        brand = h[8:12]
        if brand in HEIC_BRANDS:
            return "heic"
        return "mov" if brand == b"qt  " else "mp4"
    return None


def convert_file(src: Path, dst: Path, kind: str, ext: str, target: str):
    if kind == "image":
        img = Image.open(src, formats=["JPEG", "PNG", "GIF", "HEIF"])  # tylko dozwolone dekodery
        if img.width * img.height > MAX_PIXELS:
            raise ValueError("obraz za duży")
        img.load()
        if target in ("jpg", "heic") and img.mode != "RGB":
            img = img.convert("RGB")
        img.save(dst, format=IMG_FORMAT[target])
    else:  # audio / video przez ffmpeg
        args = ["-vn"] if kind == "audio" else ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]
        r = subprocess.run(
            ["ffmpeg", "-nostdin", "-y",
             "-protocol_whitelist", "file",   # ffmpeg nie otworzy sieci ani innych protokołów
             "-f", DEMUXER[ext],              # wymuszony format wejścia (bez zgadywania po treści)
             "-i", str(src), *args,
             "-fs", str(MAX_OUT + 1),         # twardy limit rozmiaru wyniku
             str(dst)],
            capture_output=True, timeout=600,
        )
        if r.returncode != 0:
            raise ValueError("ffmpeg error")


def send_mail(to, code):
    msg = EmailMessage()
    msg["From"] = GMAIL_USER
    msg["To"] = to
    msg["Subject"] = "Twój kod logowania"
    msg.set_content(f"Twój jednorazowy kod: {code}\nWażny 10 minut.")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
        smtp.send_message(msg)


def current_session(token: str = Cookie(default="", alias=COOKIE_NAME)):
    with lock:
        cleanup()
        s = sessions.get(token)
    if not s:
        raise HTTPException(401, "Brak dostępu lub sesja wygasła")
    return s


def own_file(file_id, s):
    """Zwraca plik tylko jeśli należy do zalogowanego użytkownika. Cudzy = 404 (nie zdradzamy, że istnieje)."""
    with lock:
        f = files.get(file_id)
    if not f or f["owner"] != s["email"]:
        raise HTTPException(404, "Nie znaleziono pliku")
    return f


# ---------- LOGOWANIE ----------
class EmailIn(BaseModel):
    email: EmailStr


class VerifyIn(BaseModel):
    email: EmailStr
    code: str


@app.post("/auth/request-otp", dependencies=[Depends(rate_limit)])
def request_otp(body: EmailIn, bg: BackgroundTasks):
    email = normalize_email(body.email)
    with lock:
        cleanup()
        old = otps.get(email)
        if old and time.time() - old["sent"] < 60:
            raise HTTPException(429, "Odczekaj minutę przed kolejnym kodem")
        code = "".join(secrets.choice(OTP_ALPHABET) for _ in range(10))
        otps[email] = {"code": code, "expires": time.time() + OTP_TTL, "sent": time.time(), "tries": 0}
    bg.add_task(send_mail, body.email, code)
    return {"message": "Kod wysłany na podany adres"}


@app.post("/auth/verify-otp", dependencies=[Depends(rate_limit)])
def verify_otp(body: VerifyIn, request: Request, response: Response):
    email, ip = normalize_email(body.email), client_ip(request)
    with lock:
        cleanup()
        otp = otps.get(email)
        if not otp:
            raise HTTPException(400, "Niepoprawny lub wygasły kod")
        otp["tries"] += 1
        if otp["tries"] > 5:
            del otps[email]
            raise HTTPException(400, "Za dużo prób, poproś o nowy kod")
        if not secrets.compare_digest(otp["code"].encode(), body.code.strip().upper().encode()):
            raise HTTPException(400, "Niepoprawny lub wygasły kod")
        del otps[email]  # kod jednorazowy

        # jedna sesja na osobę; pliki są przypisane do e-maila, więc logowanie ich nie kasuje
        for t in [t for t, s in sessions.items() if s["email"] == email]:
            del sessions[t]
        if len(sessions) >= MAX_USERS:
            raise HTTPException(503, "Serwer zajęty (limit 30 osób), spróbuj za chwilę")
        if sum(1 for s in sessions.values() if s["ip"] == ip) >= MAX_SESSIONS_PER_IP:
            raise HTTPException(429, "Za dużo sesji z tego adresu IP")

        token = secrets.token_urlsafe(32)
        sessions[token] = {"email": email, "expires": time.time() + TOKEN_TTL, "ip": ip}
    # token trafia do cookie HttpOnly, więc JavaScript na stronie nigdy go nie zobaczy
    response.set_cookie(COOKIE_NAME, token, max_age=TOKEN_TTL, httponly=True,
                        secure=COOKIE_SECURE, samesite="strict", path="/")
    return {"expires_in": TOKEN_TTL}


@app.post("/auth/logout")
def logout(response: Response, token: str = Cookie(default="", alias=COOKIE_NAME)):
    with lock:
        sessions.pop(token, None)
    response.delete_cookie(COOKIE_NAME, path="/", secure=COOKIE_SECURE, httponly=True, samesite="strict")
    return {"message": "Wylogowano"}


@app.get("/auth/me")
def me(s=Depends(current_session)):
    """Czy sesja (cookie) jest ważna? Frontend woła to po odświeżeniu strony."""
    return {"email": s["email"], "expires_in": int(s["expires"] - time.time())}


# ---------- PLIKI ----------
@app.post("/convert")
def convert(file: UploadFile = File(...), target: str = Form(...), s=Depends(current_session)):
    email = s["email"]
    target = target.lower()
    ext = Path(file.filename or "").suffix.lstrip(".").lower()
    if ext not in KIND or target not in KIND or KIND[ext] != KIND[target]:
        raise HTTPException(400, "Niedozwolony format lub konwersja między różnymi rodzajami plików")

    with lock:  # jedna konwersja naraz na użytkownika + limit 5 plików (bez wyścigów)
        if email in converting:
            raise HTTPException(429, "Poprzednia konwersja jeszcze trwa")
        if user_file_count(email) >= MAX_FILES:
            raise HTTPException(429, "Limit 5 plików, usuń któryś (DELETE /files/{id}) lub poczekaj")
        converting.add(email)

    file_id = uuid.uuid4().hex  # nazwy na dysku nie pochodzą od użytkownika
    src = STORAGE / f"{file_id}.in"
    dst = STORAGE / f"{file_id}.{target}"
    try:
        size = 0
        with open(src, "wb") as out:  # zapis kawałkami na dysk, bez trzymania całości w RAM
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_SIZE:
                    raise HTTPException(413, "Plik za duży (max 100 MB)")
                out.write(chunk)

        with open(src, "rb") as f:
            if detect(f.read(16)) != ext:
                raise HTTPException(400, "Zawartość pliku nie pasuje do formatu")

        try:
            with slots:
                convert_file(src, dst, KIND[ext], ext, target)
            if dst.stat().st_size > MAX_OUT:
                raise ValueError("wynik za duży")
        except Exception:
            raise HTTPException(400, "Nie udało się skonwertować pliku (lub wynik jest za duży)")

        with lock:
            files[file_id] = {"owner": email, "path": dst, "format": target, "expires": time.time() + FILE_TTL}
    except Exception:
        dst.unlink(missing_ok=True)
        raise
    finally:
        src.unlink(missing_ok=True)  # oryginał nie jest przechowywany
        with lock:
            converting.discard(email)
    return {"file_id": file_id, "format": target, "expires_in": FILE_TTL}


@app.get("/files")
def list_files(s=Depends(current_session)):
    now = time.time()
    with lock:
        return [
            {"file_id": i, "format": f["format"], "expires_in": int(f["expires"] - now)}
            for i, f in files.items() if f["owner"] == s["email"]
        ]


@app.get("/files/{file_id}")
def download(file_id: str, s=Depends(current_session)):
    f = own_file(file_id, s)
    if not f["path"].exists():
        raise HTTPException(404, "Nie znaleziono pliku")
    return FileResponse(f["path"], filename=f"converted.{f['format']}",
                        headers={"X-Content-Type-Options": "nosniff"})


@app.delete("/files/{file_id}")
def delete(file_id: str, s=Depends(current_session)):
    own_file(file_id, s)
    with lock:
        f = files.pop(file_id, None)
    if f:
        f["path"].unlink(missing_ok=True)
    return {"deleted": file_id}
