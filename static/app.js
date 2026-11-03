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

// drag & drop + klik na plik
const dz = $("dropZone"), fileInput = $("file"), fileName = $("fileName");

function showFileName() {
  const f = fileInput.files[0];
  if (f) { fileName.textContent = f.name; fileName.hidden = false; }
  else { fileName.textContent = ""; fileName.hidden = true; }
}
fileInput.onchange = showFileName;

dz.onclick = () => fileInput.click();
dz.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fileInput.click(); } };

dz.ondragover = (ev) => { ev.preventDefault(); dz.classList.add("dragover"); };
dz.ondragleave = () => dz.classList.remove("dragover");
dz.ondrop = (ev) => {
  ev.preventDefault();
  dz.classList.remove("dragover");
  if (ev.dataTransfer.files.length) {
    fileInput.files = ev.dataTransfer.files;   // przekazanie pliku do istniejącej logiki
    showFileName();
  }
};

// slider z rozszerzeniami (ukryty input #target trzyma wybraną wartość)
document.querySelectorAll("#targetRow .pill").forEach((pill) => {
  pill.onclick = () => {
    $("target").value = pill.dataset.target;
    document.querySelectorAll("#targetRow .pill").forEach((p) => p.classList.toggle("active", p === pill));
  };
});

$("btnConvert").onclick = async () => {
  msg("convMsg", "", "info");
  const file = $("file").files[0];
  if (!file) return msg("convMsg", "Wybierz plik.", "err");
  if (busy) return;
  busy = true; $("btnConvert").disabled = true;   // backend: jedna konwersja naraz na użytkownika
  msg("convMsg", "Konwertowanie…", "info");
  const form = new FormData();
  form.append("file", file);
  form.append("target", $("target").value);
  const r = await api("POST", "/convert", form);
  busy = false; $("btnConvert").disabled = false;
  if (r.ok) {
    fileInput.value = "";
    showFileName();
    msg("convMsg", "Gotowe — plik pojawił się na liście.", "ok");
    refreshFiles();
  } else {
    msg("convMsg", "Konwersja nie powiodła się. Sprawdź format i spróbuj ponownie.", "err");
  }
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
