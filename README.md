[DOKUMENTACJA.md](https://github.com/user-attachments/files/34343632/DOKUMENTACJA.md)
# Backend konwertera plików (FastAPI)

Prosty backend w jednym pliku (`main.py`), który:

- loguje użytkownika **jednorazowym kodem (10 znaków A–Z/0–9) wysyłanym e-mailem przez Gmail**,
- po weryfikacji kodu ustawia **cookie sesji `HttpOnly` ważne 30 minut** (JavaScript na stronie nie widzi tokenu),
- przyjmuje pliki od użytkownika, **waliduje je**, **konwertuje** i oddaje z powrotem,
- pilnuje limitów: **30 zalogowanych osób naraz**, **5 plików na użytkownika**,
- każdy użytkownik ma dostęp **wyłącznie do własnych plików**, a pliki są **kasowane po 10 minutach**.

---

## 1. Wymagania i uruchomienie

**System:** Python 3.10+ oraz `ffmpeg` (do audio i wideo).

```bash
sudo apt install ffmpeg
pip install -r requirements.txt
```

**Zmienne środowiskowe lub zmienne w .env:**

| Zmienna               | Wymagana | Opis                                                                                                                  |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `GMAIL_USER`          | tak      | Adres Gmail, z którego wysyłamy kody                                                                                  |
| `GMAIL_APP_PASSWORD`  | tak      | 16-znakowe *hasło aplikacji* Google (nie zwykłe hasło)                                                                |
| `FRONTEND_ORIGIN`     | tak      | Dokładny origin frontendu (bez `/` na końcu), domyślnie `http://localhost:3000`. Używany w CORS **i** do ochrony CSRF |
| `COOKIE_SECURE`       | nie      | `1` (domyślnie) = cookie tylko przez HTTPS                                                                            |
| `MAX_SESSIONS_PER_IP` | nie      | Maks. równoczesnych sesji z jednego adresu IP, domyślnie 5                                                            |


**Start:**

```bash
export GMAIL_USER="twojadres@gmail.com"
export GMAIL_APP_PASSWORD="xxxxxxxxxxxxxxxx"
export FRONTEND_ORIGIN="http://localhost:3000"
uvicorn main:app --port 8000
```

Interaktywna dokumentacja Swagger jest dostępna pod `http://localhost:8000/docs`.

---

## 2. Obsługiwane formaty (whitelista)

| Rodzaj | Formaty | Narzędzie |
|---|---|---|
| Obraz | `jpg`, `png`, `gif`, `heic` | Pillow + pillow-heif |
| Audio | `mp3`, `wav`, `flac` | ffmpeg |
| Wideo | `mp4`, `mov` | ffmpeg |

Zasady:

- Każdy inny format jest odrzucany (400).
- Konwersja działa **tylko w obrębie rodzaju**: obraz→obraz, audio→audio, wideo→wideo. Np. `png→heic`, `wav→mp3`, `mov→mp4` działają, a `png→mp3` zwraca 400.
- Format rozpoznawany jest po **zawartości pliku**, a nie po rozszerzeniu.

---

## 3. Przepływ działania

```
Frontend                                 Backend
   |  POST /auth/request-otp {email}  ->   generuje kod, zapisuje w pamięci, wysyła Gmailem
   |  POST /auth/verify-otp {email,code} -> sprawdza kod, ustawia cookie sesji (30 min)
   |  POST /convert (cookie) ->            walidacja -> konwersja -> zapis (ważny 10 min)
   |  GET  /files (cookie) ->              lista własnych plików
   |  GET  /files/{id} (cookie) ->         pobranie pliku
   |  DELETE /files/{id} ->                usunięcie pliku (zwolnienie miejsca w limicie)
   |  GET  /auth/me ->                     czy sesja jest ważna (np. po odświeżeniu strony)
   |  POST /auth/logout ->                 unieważnienie sesji i usunięcie cookie
```

---

## 4. Dokumentacja API

Sesja jest w cookie `session` (`HttpOnly`, `SameSite=Strict`), które przeglądarka dołącza sama. Frontend musi wysyłać żądania z `credentials: "include"`. Wszystkie endpointy poza `/auth/request-otp` i `/auth/verify-otp` wymagają ważnej sesji.

**Ochrona CSRF:** każde `POST` i `DELETE` musi mieć nagłówek `Origin` równy `FRONTEND_ORIGIN`, inaczej serwer zwraca **403**. Przeglądarki dodają go automatycznie. Przy testach `curl` dodaj `-H "Origin: http://localhost:3000"`.

### `POST /auth/request-otp`

Wysyła kod logowania na e-mail.

- **Body (JSON):** `{"email": "jan@example.com"}`
- **200:** `{"message": "Kod wysłany na podany adres"}`
- **429:** kolejny kod można zamówić dopiero po 60 sekundach albo przekroczono limit 10 żądań `/auth/*` na minutę z jednego IP
- **422:** niepoprawny adres e-mail

Kod jest ważny 10 minut. Zamówienie nowego kodu unieważnia poprzedni.

### `POST /auth/verify-otp`

Weryfikuje kod i ustawia cookie sesji.

- **Body (JSON):** `{"email": "jan@example.com", "code": "AB12CD34EF"}`
- **200:** `{"expires_in": 1800}` oraz nagłówek `Set-Cookie: session=...; HttpOnly; SameSite=Strict; Max-Age=1800` (token **nie** występuje w treści odpowiedzi)
- **400:** niepoprawny lub wygasły kod albo przekroczono 5 prób (trzeba zamówić nowy)
- **429:** przekroczono limit żądań z IP albo limit sesji z jednego IP
- **503:** osiągnięto limit 30 zalogowanych osób

Kod jest jednorazowy i nie rozróżnia wielkości liter. Adresy Gmail są normalizowane (kropki i część po `+` są ignorowane), więc `k.tos+1@gmail.com` i `ktos@gmail.com` to ta sama osoba.

### `POST /auth/logout`

Unieważnia sesję i kasuje cookie. Pliki użytkownika zostają do końca swoich 10 minut.

- **200:** `{"message": "Wylogowano"}`

### `GET /auth/me`

Sprawdza, czy cookie sesji jest ważne. Frontend woła to po odświeżeniu strony.

- **200:** `{"email": "jan@example.com", "expires_in": 1500}`
- **401:** brak lub wygasła sesja

### `POST /convert`

Przyjmuje plik i konwertuje go.

- **Body (multipart/form-data):** `file` (plik) oraz `target` (docelowy format, np. `jpg`)
- **200:** `{"file_id": "...", "format": "jpg", "expires_in": 600}`
- **400:** niedozwolony format, konwersja między różnymi rodzajami, zawartość nie pasuje do rozszerzenia, obraz większy niż 50 mln pikseli, wynik większy niż 200 MB albo konwersja się nie powiodła
- **401:** brak lub wygasła sesja
- **403:** nieprawidłowy `Origin`
- **413:** żądanie większe niż ok. 100 MB (odrzucane od razu, zanim serwer zacznie przyjmować dane)
- **429:** użytkownik ma już 5 aktywnych plików **albo jego poprzednia konwersja jeszcze trwa** (jedna konwersja naraz na osobę, więc frontend powinien wysyłać pliki po kolei)

### `GET /files`

Lista własnych, aktywnych plików.

- **200:** `[{"file_id": "...", "format": "jpg", "expires_in": 412}]`

### `GET /files/{file_id}`

Pobiera plik jako załącznik (`converted.<format>`).

- **200:** zawartość pliku
- **404:** plik nie istnieje, wygasł **albo należy do kogoś innego**

### `DELETE /files/{file_id}`

Usuwa własny plik.

- **200:** `{"deleted": "<file_id>"}`
- **404:** jak wyżej

---

## 5. Przykłady użycia

### curl

`-c`/`-b` zapisują i odczytują cookie z pliku, a nagłówek `Origin` jest wymagany przy `POST` i `DELETE`.

```bash
O="Origin: http://localhost:3000"

# 1. kod na maila
curl -X POST localhost:8000/auth/request-otp -H "$O" \
  -H "Content-Type: application/json" -d '{"email":"jan@example.com"}'

# 2. logowanie kodem z maila (cookie ląduje w pliku jar.txt)
curl -c jar.txt -X POST localhost:8000/auth/verify-otp -H "$O" \
  -H "Content-Type: application/json" -d '{"email":"jan@example.com","code":"AB12CD34EF"}'

# 3. konwersja
curl -b jar.txt -X POST localhost:8000/convert -H "$O" \
  -F "file=@zdjecie.png" -F "target=jpg"

# 4. pobranie
curl -b jar.txt localhost:8000/files/$FILE_ID -o wynik.jpg
```

(Przy `COOKIE_SECURE=1` `curl` zapisze cookie z flagą `Secure` tylko dla HTTPS albo `localhost`. Lokalnie ustaw `COOKIE_SECURE=0`.)

### JavaScript (frontend)

Token nie jest w ogóle widoczny dla skryptu. Wystarczy `credentials: "include"` w każdym `fetch`.

```js
const API = "http://localhost:8000";
const opts = { credentials: "include" };   // wysyłaj i przyjmuj cookie

// logowanie (odpowiedź nie zawiera tokenu, cookie ustawia się samo)
await fetch(`${API}/auth/request-otp`, {
  ...opts, method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email }),
});
await fetch(`${API}/auth/verify-otp`, {
  ...opts, method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, code }),
});

// czy sesja jest ważna (np. po odświeżeniu strony)?
const me = await fetch(`${API}/auth/me`, opts);   // 200 = zalogowany, 401 = nie

// konwersja
const form = new FormData();
form.append("file", fileInput.files[0]);
form.append("target", "jpg");
const { file_id } = await (await fetch(`${API}/convert`, { ...opts, method: "POST", body: form })).json();

// pobranie: fetch + blob działa zawsze (też gdy front i backend są w różnych domenach)
const blob = await (await fetch(`${API}/files/${file_id}`, opts)).blob();
const url = URL.createObjectURL(blob);   // użyj jako href linku z atrybutem download
```

Gdy front i backend są w tej samej witrynie (np. `app.firma.pl` i `api.firma.pl`), pobranie może być też zwykłym linkiem `<a href="https://api.firma.pl/files/ID">`, bo przeglądarka sama dołączy cookie.

---

## 6. Jak działa kod

### 6.1 Konfiguracja i stan

Na górze `main.py` są stałe (limity, czasy życia, whitelista). Najważniejsze:

| Stała | Wartość | Znaczenie |
|---|---|---|
| `MAX_USERS` | 30 | maks. równoczesnych sesji |
| `MAX_FILES` | 5 | maks. aktywnych plików na użytkownika |
| `MAX_SIZE` | 100 MB | maks. rozmiar uploadu |
| `TOKEN_TTL` | 30 min | ważność sesji i cookie |
| `OTP_TTL` | 10 min | ważność kodu |
| `FILE_TTL` | 10 min | czas życia pliku |
| `KIND` | słownik | whitelista formatów i ich rodzaj |

Cały stan trzyma się w trzech słownikach w pamięci:

```python
otps     = {}  # email  -> {"code", "expires", "sent", "tries"}
sessions = {}  # token  -> {"email", "expires"}
files    = {}  # file_id -> {"owner": email, "path", "format", "expires"}
```

Brak bazy danych: restart serwera czyści wszystko (przy starcie czyszczony jest też katalog `storage/`, żeby nie zostały osierocone pliki).

### 6.2 Blokada `lock` i wątki

Endpointy są zwykłymi funkcjami (`def`, nie `async def`), więc FastAPI uruchamia każdy w puli wątków. Dzięki temu długa konwersja nie blokuje reszty serwera. Skutek uboczny: kilka wątków może jednocześnie zmieniać słowniki, dlatego każda operacja na `otps`, `sessions` i `files` odbywa się pod `with lock:`.

### 6.3 Sprzątanie: `cleanup()` i `janitor()`

`cleanup()` przechodzi po trzech słownikach i usuwa wpisy, których `expires` minęło. Dla plików usuwa też fizyczny plik z dysku. Wywoływana jest:

- na początku każdego żądania wymagającego logowania (w `current_session`) oraz przy kodach OTP, więc wygasły token lub plik nigdy nie zadziała,
- co 30 sekund przez wątek `janitor()`, więc pliki znikają po 10 minutach także wtedy, gdy nikt nie wysyła żądań.

### 6.4 Logowanie kodem

**`request_otp`**

1. Normalizuje e-mail (małe litery).
2. Jeśli kod był wysłany mniej niż 60 s temu → 429.
3. Generuje kod: 10 znaków z `A–Z0–9` przez `secrets.choice` (generator kryptograficzny).
4. Zapisuje go w `otps` z terminem ważności i licznikiem prób.
5. Wysyła mail w tle (`BackgroundTasks`), więc odpowiedź wraca od razu i nie czeka na Gmaila.

**`send_mail`** łączy się z `smtp.gmail.com:465` (SSL), loguje hasłem aplikacji i wysyła wiadomość.

**`verify_otp`**

1. Szuka kodu dla e-maila. Brak lub wygasły → 400.
2. Zwiększa licznik prób. Po 5 próbach kod jest kasowany.
3. Porównuje kod przez `secrets.compare_digest` (odporne na ataki czasowe). Wielkość liter nie ma znaczenia.
4. Kasuje kod, więc jest **jednorazowy**.
5. Usuwa poprzednią sesję tego samego e-maila (jedna sesja na osobę).
6. Jeśli aktywnych sesji jest już 30 → 503.
7. Tworzy token `secrets.token_urlsafe(32)` ważny 30 minut i **zapisuje go w cookie** (`HttpOnly`, `SameSite=Strict`, `Secure`, `Max-Age=1800`). W treści odpowiedzi jest tylko `expires_in`, więc skrypt na stronie nie ma jak odczytać tokenu.

### 6.5 Autoryzacja: `current_session`

Zależność FastAPI (`Depends`) użyta w każdym endpoincie plikowym. Czyta token z cookie `session` (`Cookie(alias=COOKIE_NAME)`), uruchamia `cleanup()` i szuka sesji. Nagłówek `Authorization` nie jest już obsługiwany. Brak sesji → 401. Zwraca słownik sesji z e-mailem użytkownika.

### 6.6 Rozpoznawanie formatu: `detect()`

Odczytuje pierwsze 16 bajtów pliku i porównuje z sygnaturami formatów:

| Format | Sygnatura |
|---|---|
| jpg | `FF D8 FF` |
| png | `89 50 4E 47 0D 0A 1A 0A` |
| gif | `GIF87a` / `GIF89a` |
| flac | `fLaC` |
| wav | `RIFF` ... `WAVE` |
| mp3 | `ID3` lub synchronizacja ramki `FF Ex` |
| heic / mov / mp4 | bajty 4–8 to `ftyp`, a rodzaj zależy od *brandu* (bajty 8–12): `heic`, `mif1` itd. → heic, `qt  ` → mov, reszta → mp4 |

Dzięki temu plik `.exe` przemianowany na `.png` zostanie odrzucony, bo jego początek nie pasuje do PNG.

### 6.7 Konwersja: `convert_file()`

- **Obrazy:** Pillow otwiera plik i zapisuje go w nowym formacie (`IMG_FORMAT`). Dla `jpg` i `heic` obraz jest najpierw konwertowany do trybu RGB (JPEG nie obsługuje przezroczystości). HEIC działa dzięki `register_heif_opener()`.
- **Audio:** `ffmpeg -i wejście -vn wyjście`. Opcja `-vn` odrzuca ewentualną okładkę. Kodek wybiera ffmpeg na podstawie rozszerzenia pliku wyjściowego.
- **Wideo:** `ffmpeg -i wejście -c:v libx264 -pix_fmt yuv420p -c:a aac wyjście` (H.264 + AAC, szeroko kompatybilne).

ffmpeg jest uruchamiany jako lista argumentów (bez powłoki), z `-nostdin` i limitem czasu 600 s. Dodatkowo:

- `-f <demuxer>`: format wejścia jest **narzucony** na podstawie rozpoznanego typu (`DEMUXER`), więc ffmpeg nie zgaduje go po treści (zamyka drogę do podszywania się pod inny format, np. playlistę HLS ukrytą za nagłówkiem MP3),
- `-protocol_whitelist file`: ffmpeg może czytać tylko lokalny plik, a nie sieć ani inne protokoły (zabezpieczenie przed SSRF),
- `-fs`: twardy limit rozmiaru pliku wynikowego.

Konwersje przechodzą przez `Semaphore(3)`, więc naraz działają maksymalnie 3. Pillow otwiera pliki z listą dozwolonych dekoderów (`formats=[JPEG, PNG, GIF, HEIF]`) i odrzuca obrazy powyżej 50 mln pikseli **przed** dekodowaniem.

### 6.8 Endpoint `/convert` krok po kroku

1. **Whitelista:** rozszerzenie pliku i `target` muszą być w `KIND`, a ich rodzaj ten sam. Inaczej 400.
2. **Rezerwacja miejsca (pod lockiem):** jeśli użytkownik ma już 5 plików albo trwa jego poprzednia konwersja → 429. W przeciwnym razie jego e-mail trafia do zbioru `converting`. Dzięki temu jedna osoba nie może uruchomić wielu konwersji równolegle ani obejść limitu 5 plików.
3. **Zapis uploadu na dysk kawałkami po 1 MB** do `storage/<uuid>.in`. Jeśli suma przekroczy 100 MB → 413. Plik nie ładuje się w całości do RAM-u.
4. **Sprawdzenie zawartości** przez `detect()` — musi zgadzać się z rozszerzeniem.
5. **Konwersja** wewnątrz semafora. Każdy błąd, a także wynik większy niż 200 MB → 400.
6. **Rejestracja pliku** pod lockiem, Zapisywane są: właściciel, ścieżka, format, termin ważności (teraz + 10 min).
7. **Sprzątanie:** w razie błędu usuwany jest plik wynikowy, a plik wejściowy `.in` jest usuwany zawsze (`finally`), razem ze zdjęciem blokady `converting`. Oryginał nie jest przechowywany.

Nazwy plików na dysku to losowe UUID. Nazwa od użytkownika nigdy nie trafia do ścieżki, więc nie ma ataku typu path traversal.

### 6.9 Izolacja użytkowników: `own_file()`

Każdy rekord w `files` ma pole `owner` (e-mail). Funkcja `own_file()` jest używana w `GET` i `DELETE` i zwraca plik tylko wtedy, gdy `owner` zgadza się z e-mailem z tokenu. W przeciwnym razie zwraca **404** (a nie 403), żeby nie ujawniać, że dany identyfikator istnieje. Ponieważ pliki są przypisane do e-maila, a nie do tokenu, użytkownik po ponownym zalogowaniu nadal widzi swoje pliki (do końca ich 10 minut).

### 6.10 Mechanizmy ochronne (strażnik, limity IP, normalizacja)

**Strażnik żądań (`guard`).** Middleware działa **przed** parsowaniem ciała żądania. Najpierw sprawdza **Origin**: każde `POST` i `DELETE` musi mieć nagłówek `Origin` równy `FRONTEND_ORIGIN` (ochrona CSRF), inaczej 403. Dla każdego `POST` sprawdza nagłówek `Content-Length`: limit to ok. 100 MB dla `/convert` i 10 kB dla pozostałych endpointów, a żądania bez `Content-Length` (chunked) są odrzucane. Dla `/convert` sprawdza też cookie sesji, więc bez ważnej sesji serwer nie przyjmie ani bajta pliku. Bez tego FastAPI najpierw przyjmuje cały upload, a dopiero potem sprawdza autoryzację. Strażnik jest dodany przed CORS, żeby odpowiedzi 401 i 413 miały nagłówki CORS i frontend mógł je odczytać.

**Limit żądań per IP (`rate_limit`).** Maks. 10 żądań `/auth/*` na minutę z jednego IP (zamawianie kodów i ich weryfikacja). Chroni przed zalewaniem cudzych skrzynek kodami i przed masowym zgadywaniem.

**Limit sesji per IP.** Maks. 5 równoczesnych sesji z jednego IP (`MAX_SESSIONS_PER_IP`), żeby jedna osoba nie zajęła wszystkich 30 miejsc.

**Normalizacja adresów (`normalize_email`).** Dla Gmaila ignorowane są kropki i część po `+`, więc jedna skrzynka nie może udawać wielu użytkowników (obejście limitów 5 plików i 30 sesji). Dla innych domen adresy **nie** są normalizowane, bo nie każdy dostawca traktuje `+` jak alias. Gdyby tak było, ktoś z osobną skrzynką `bob+x@firma.pl` mógłby przejąć tożsamość `bob@firma.pl`.

**Jedna konwersja naraz na użytkownika (`converting`).** Zapobiega obejściu limitu plików przez równoległe żądania i wyczerpaniu puli wątków serwera.

---

## 7. Bezpieczeństwo

### 7.1 Co zostało sprawdzone

Kod przeszedł test z użyciem prawdziwych ataków (uruchamianych na serwerze, a nie tylko analiza). Poniżej wynik dla wersji początkowej i obecnej.

| Atak | Wersja początkowa | Obecnie |
|---|---|---|
| Upload 50 MB bez tokenu (serwer przyjmował cały plik, zanim sprawdził autoryzację) | **Podatna** | Odrzucane od razu (401) |
| Żądanie o rozmiarze 2 GB, duży JSON, `Transfer-Encoding: chunked` | **Podatna** (ciało czytane w całości) | 413 od razu |
| Obejście limitu 5 plików przez 12 równoległych żądań (12 uploadów przyjętych) | **Podatna** | 1 przyjęte, 11 → 429 |
| Wzmocnienie rozmiaru: 1 MB mp3 → 10,5 MB wav (×11) | **Podatna** | Wynik > 200 MB odrzucany, `-fs` ogranicza zapis |
| 30 aliasów jednej skrzynki Gmail zapycha 30 slotów | **Podatna** | Jedna tożsamość + limit 5 sesji na IP |
| Zalewanie żądaniami `/auth/*` | **Podatna** | 10/min na IP, potem 429 |
| Fałszywy MP3 (nagłówek ID3 + playlista HLS) wywołujący SSRF przez ffmpeg | Nie udało się odtworzyć na tej wersji ffmpeg | Wymuszony demuxer + `protocol_whitelist file`; sieć zablokowana (zweryfikowane) |
| Dostęp do cudzych plików (GET/DELETE cudzego `file_id`) | Odporna | Odporna (404) |
| Path traversal przez nazwę pliku (`../../x.png`) | Odporna | Odporna |
| Fałszywe rozszerzenie (`.exe` jako `.png`, tekst jako `.png`) | Odporna | Odporna |
| Brute-force kodu OTP (6 prób, potem poprawny kod) | Odporna | Odporna (kod spalony po 5 próbach) |
| Wstrzyknięcie nagłówków do maila (`\r\nBcc:`) | Odporna | Odporna (422) |
| Bomba pikselowa (obraz 81 mln px) | Częściowo (tylko ostrzeżenie Pillow) | 400, twardy limit 50 mln px |
| Dostęp po wygaśnięciu pliku / sesji / po wylogowaniu | Odporna | Odporna |
| `DELETE`/`POST` z obcego `Origin` przy ważnym cookie (CSRF) | nie dotyczyło (token w nagłówku) | 403, sesja i pliki nietknięte |
| Stary nagłówek `Authorization: Bearer` / zmyślone cookie | nie dotyczyło | 401 |

### 7.2 Pozostałe mechanizmy

| Zagrożenie | Zabezpieczenie |
|---|---|
| Zgadywanie kodu | 10 znaków (ok. 3,6·10¹⁵ kombinacji), maks. 5 prób, ważność 10 min, jednorazowość, porównanie `compare_digest` |
| Podszywanie się pod sesję | Losowy token 256 bit, ważny 30 min, możliwość wylogowania |
| Kradzież sesji przez XSS | Cookie `HttpOnly`: skrypt na stronie nie może go odczytać ani wynieść (atakujący z XSS nadal może wysyłać żądania, ale tylko dopóki użytkownik ma otwartą stronę) |
| CSRF (cudza strona wysyła żądanie w imieniu zalogowanego) | `SameSite=Strict` (cookie nie jest wysyłane z obcych witryn) **oraz** wymagany `Origin` równy `FRONTEND_ORIGIN` przy `POST`/`DELETE` |
| Sniffing typu MIME przy pobraniu | Nagłówek `X-Content-Type-Options: nosniff`, wynik jest zawsze świeżo zakodowany |
| Ładowanie obcych dekoderów obrazów (np. EPS przez Ghostscript) | `Image.open(formats=[...])` oraz sygnatury bajtów |
| Dostęp z obcych stron | CORS ograniczony do `FRONTEND_ORIGIN` z `allow_credentials` (origin konkretny, nigdy `*`) |

---


## 9. Jak zmienić typowe ustawienia

| Co zmienić | Gdzie |
|---|---|
| Limit osób / plików / rozmiaru wejścia i wyniku | `MAX_USERS`, `MAX_FILES`, `MAX_SIZE`, `MAX_OUT` |
| Limit sesji per IP | zmienna środowiskowa `MAX_SESSIONS_PER_IP` |
| Limit żądań `/auth/*` na minutę per IP | `AUTH_PER_MIN` |
| Maks. rozmiar obrazu | `MAX_PIXELS` |
| Czas życia tokenu / kodu / pliku | `TOKEN_TTL`, `OTP_TTL`, `FILE_TTL` |
| Liczba równoległych konwersji | `Semaphore(3)` przy `slots` |
| Dodanie formatu | wpis w `KIND`, `detect()`, a dla obrazów `IMG_FORMAT` i `formats=[...]`, dla audio/wideo `DEMUXER` |
| Zmiana jakości wideo | argumenty ffmpeg w `convert_file()` (np. dodaj `-crf 23`) |
