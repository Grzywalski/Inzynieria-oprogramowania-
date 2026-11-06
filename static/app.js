// Pusty adres = backend jest tam, skąd pochodzi strona (serwowanie przez backend, ten sam origin).
// Gdyby front stał osobno, wpisz tu np. "https://api.twojadomena.pl" i ustaw FRONTEND_ORIGIN w backendzie.
const API = "";

// Sesja siedzi w cookie HttpOnly ustawianym przez backend. JavaScript nie widzi tokenu,
// więc nie ma czego trzymać w zmiennej. Przeglądarka sama dokleja cookie do żądań.
let loggedIn = false, sessionExp = 0, busy = false, refreshing = false;
const $ = (id) => document.getElementById(id);

function msg(id, text, kind) {           // dyskretny komunikat zamiast debugowego loga
  const el = $(id);
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}

function setLoggedIn(on, expiresIn) {
  loggedIn = on;
  sessionExp = on ? Date.now() + expiresIn * 1000 : 0;
  // cała aplikacja (konwersja + pliki) istnieje w DOM dopiero po zalogowaniu
  $("appView").hidden = !on;
  $("loginView").hidden = on;
  if (on) msg("convMsg", "", "info");
  else {
    $("who").textContent = "";
    $("files").textContent = "";
    $("code").value = "";
    $("stepCode").hidden = true;
    $("stepEmail").hidden = false;
  }
}

// jedno miejsce, przez które idą wszystkie żądania; credentials:"include" = wysyłaj cookie
async function api(method, path, body) {
  const headers = {};
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  try {
    const r = await fetch(API + path, { method, headers, body, credentials: "include" });
    if (r.status === 401 && loggedIn) setLoggedIn(false);  // sesja wygasła
    let data = null;
    try { const t = await r.text(); data = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null };
  }
}

// czy przeglądarka ma ważne cookie sesji? (też po odświeżeniu strony)
async function checkSession() {
  const r = await api("GET", "/auth/me");
  if (r.ok) setLoggedIn(true, r.data.expires_in);
  if (r.ok) refreshFiles();
}

// ===== LOGOWANIE =====

$("stepEmail").onsubmit = async (ev) => {
  ev.preventDefault();
  const email = $("email").value.trim();
  msg("authMsg", "Wysyłanie…", "info");
  const r = await api("POST", "/auth/request-otp", { email });
  if (r.ok) {
    msg("authMsg", "", "info");
    $("sentTo").textContent = email;   // textContent — bezpieczne wstawianie danych
    $("stepEmail").hidden = true;
    $("stepCode").hidden = false;
    $("code").focus();
  } else {
    msg("authMsg", "Nie udało się wysłać kodu. Sprawdź e-mail i spróbuj ponownie.", "err");
  }
};

$("btnBack").onclick = () => {
 $("stepCode").hidden = true;              $("stepEmail").hidden = false;         $("code").value = "";
};

$("stepCode").onsubmit = async (ev) => {
  ev.preventDefault();
  msg("authMsg", "Logowanie…", "info");
  const r = await api("POST", "/auth/verify-otp", {
    email: $("sentTo").textContent,
    code: $("code").value.trim(),
  });
  if (r.ok) {
    $("code").value = "";                  // nie zostawiaj kodu w polu formularza
    await checkSession();                  // odpowiedź nie zawiera tokenu, cookie jest już ustawione
    if (!loggedIn) msg("authMsg", "Nieprawidłowy lub wygasły kod.", "err");
  } else {
    msg("authMsg", "Nieprawidłowy lub wygasły kod.", "err");
  }
};

$("btnLogout").onclick = async () => {
  await api("POST", "/auth/logout");
  setLoggedIn(false);
};

// ===== KONWERSJA =====

// drag & drop + klik na pliki (maksymalnie 3, wysyłane po kolei)
const dz = $("dropZone"), fileInput = $("file"), fileName = $("fileName");
const MAX_FILES = 3;

function ext(f) {                            // rozszerzenie pliku (do blokady "ten sam typ")
  const i = f.name.lastIndexOf(".");
  return i < 0 ? "" : f.name.slice(i + 1).toLowerCase();
}

function setSelected(list) {                 // ograniczenie wyboru do MAX_FILES
  const files = Array.from(list).slice(0, MAX_FILES);
  try {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    fileInput.files = dt.files;
  } catch (e) { /* brak DataTransfer — użyj tego, co jest */ }
  showFileName();
}

function showFileName() {
  const files = Array.from(fileInput.files);
  if (!files.length) {
    fileName.hidden = true;
  } else {
    const word = files.length === 1 ? "plik" : "pliki";
    fileName.textContent = files.length + " " + word + ": " + files.map((f) => f.name).join(", ");
    fileName.hidden = false;
  }
  updatePills();
}

// rozszerzenie zgodne z wybranym plikiem = nie można konwertować na ten sam typ
function updatePills() {
  const picked = new Set(Array.from(fileInput.files).map(ext));
  let changedTarget = false;
  document.querySelectorAll("#targetRow .pill").forEach((pill) => {
    const same = picked.has(pill.dataset.target);
    pill.disabled = same;
    if (same && $("target").value === pill.dataset.target) changedTarget = true;
  });
  if (changedTarget) {                       // aktywna pajlka stała się zablokowana → wybierz inną
    const free = document.querySelector("#targetRow .pill:not(:disabled)");
    if (free) free.click();
  }
}
fileInput.onchange = () => {
  if (fileInput.files.length > MAX_FILES)    // więcej niż 3 → zostaw pierwsze 3
    msg("convMsg", "Maksymalnie " + MAX_FILES + " pliki naraz — użyto pierwszych " + MAX_FILES + ".", "info");
  setSelected(fileInput.files);
};

dz.onclick = () => fileInput.click();
dz.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fileInput.click(); } };

dz.ondragover = (ev) => { ev.preventDefault(); dz.classList.add("dragover"); };
dz.ondragleave = () => dz.classList.remove("dragover");
dz.ondrop = (ev) => {
  ev.preventDefault();
  dz.classList.remove("dragover");
  if (ev.dataTransfer.files.length) {
    const toDrop = ev.dataTransfer.files;
    if (toDrop.length > MAX_FILES)
      msg("convMsg", "Maksymalnie " + MAX_FILES + " pliki naraz — użyto pierwszych " + MAX_FILES + ".", "info");
    setSelected(toDrop);                     // przekazanie plików do istniejącej logiki
  }
};

// slider z rozszerzeniami (ukryty input #target trzyma wybraną wartość)
document.querySelectorAll("#targetRow .pill").forEach((pill) => {
  pill.onclick = () => {
    $("target").value = pill.dataset.target;
    document.querySelectorAll("#targetRow .pill").forEach((p) => p.classList.toggle("active", p === pill));
  };
});

// backend obsługuje jedną konwersję naraz → kolejne pliki lecą sekwencyjnie
$("btnConvert").onclick = async () => {
  msg("convMsg", "", "info");
  const files = Array.from(fileInput.files);
  if (!files.length) return msg("convMsg", "Wybierz pliki.", "err");
  if (files.length > MAX_FILES) return msg("convMsg", "Maksymalnie " + MAX_FILES + " pliki naraz.", "err");
  if (busy) return;
  const target = $("target").value;
  const sameType = files.filter((f) => ext(f) === target);
  if (sameType.length)
    return msg("convMsg", "Nie można konwertować na ten sam typ: " + sameType.map((f) => f.name).join(", ") + ".", "err");

  busy = true; $("btnConvert").disabled = true;   // backend: jedna konwersja naraz na użytkownika
  let ok = 0;
  const errors = [];
  for (let i = 0; i < files.length; i++) {
    msg("convMsg", "Konwertowanie " + (i + 1) + "/" + files.length + " (" + files[i].name + ")…", "info");
    const form = new FormData();
    form.append("file", files[i]);
    form.append("target", target);
    const r = await api("POST", "/convert", form);
    if (r.ok) ok++;
    else if (r.status === 413) errors.push(files[i].name + ": plik jest za duży");
    else errors.push(files[i].name + ": konwersja nie powiodła się");
  }
  busy = false; $("btnConvert").disabled = false;
  fileInput.value = "";
  showFileName();
  if (errors.length)
    msg("convMsg", "Gotowe: " + ok + "/" + files.length + ". " + errors.join(" · "), errors.length === files.length ? "err" : "info");
  else
    msg("convMsg", "Gotowe — pliki pojawiły się na liście.", "ok");
  if (ok) refreshFiles();
};

// ===== LISTA PLIKÓW =====

$("btnRefresh").onclick = () => refreshFiles();

async function refreshFiles() {
  if (!loggedIn || refreshing) return;
  refreshing = true;
  const r = await api("GET", "/files");
  refreshing = false;
  if (!r.ok) return;
  const tb = $("files");
  tb.textContent = "";
  if (!r.data.length) {
    msg("filesMsg", "Brak plików.", "info");
    return;
  }
  msg("filesMsg", "", "info");
  for (const f of r.data) {
    const tr = document.createElement("tr");
    const cell = (text) => { const td = document.createElement("td"); td.textContent = text; tr.appendChild(td); return td; };
    cell(f.format);
    cell(f.file_id.slice(0, 8) + "…");
    const ttl = cell(fmt(f.expires_in));
    ttl.id = "exp-" + f.file_id;                 // odliczanie lokalne
    ttl.dataset.exp = Date.now() + f.expires_in * 1000;
    const act = cell("");
    const bDown = document.createElement("button");
    bDown.textContent = "Pobierz";
    bDown.className = "btn-ghost";
    bDown.onclick = () => download(f.file_id, f.format);
    const bDel = document.createElement("button");
    bDel.textContent = "Usuń";
    bDel.className = "btn-ghost";
    bDel.onclick = async () => { await api("DELETE", "/files/" + f.file_id); refreshFiles(); };
    act.append(bDown, bDel);
    tb.appendChild(tr);
  }
}

// fetch + blob działa niezależnie od tego, czy front i backend są w tej samej domenie
async function download(id, format) {
  const r = await fetch(API + "/files/" + id, { credentials: "include" });
  if (!r.ok) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await r.blob());
  a.download = "converted." + format;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// co sekundę: odliczanie sesji i plików
setInterval(() => {
  if (loggedIn) {
    const left = (sessionExp - Date.now()) / 1000;
    $("who").textContent = "Sesja wygasa za " + fmt(left);
    if (left <= 0) setLoggedIn(false);
  }
  document.querySelectorAll("[data-exp]").forEach((el) => {
    const left = (el.dataset.exp - Date.now()) / 1000;
    el.textContent = fmt(left);
  });
}, 1000);

checkSession();
