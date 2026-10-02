# Kto to? – rozpoznawanie osób z kamery telefonu na żywo

Aplikacja na telefon (PWA) na zlot: wczytujesz **stare zdjęcie grupowe** (np. sprzed 25 lat),
kierujesz kamerę na ludzi, a aplikacja na żywo podpisuje, kto jest kim **ze zdjęcia**.
W kadrze może być kilka osób naraz – każda osoba ze zdjęcia jest przypisywana tylko jednej twarzy.
Działa w całości na urządzeniu – zdjęcia i dane twarzy **nigdzie nie są wysyłane**.
Po pierwszym uruchomieniu działa też offline.

## Jak zainstalować na telefonie

1. Włącz GitHub Pages dla repozytorium: **Settings → Pages → Source: GitHub Actions**.
   Workflow `.github/workflows/pages.yml` opublikuje aplikację pod adresem
   `https://<użytkownik>.github.io/zlot/`.
2. Otwórz ten adres na telefonie (kamera wymaga HTTPS).
   - **Android / Chrome:** menu ⋮ → *Dodaj do ekranu głównego* / *Zainstaluj aplikację*.
   - **iPhone / Safari:** przycisk *Udostępnij* → *Do ekranu początkowego*.
3. Uruchom „Kto to?” z ekranu głównego jak zwykłą aplikację.

## Dane na serwerze (bez zdjęcia)

Organizator przygotowuje dane raz, a uczestnicy dostają je automatycznie –
wystarczy otworzyć aplikację, bez wgrywania czegokolwiek i bez hasła.
**Samo zdjęcie nie trafia na serwer** – zostaje tylko na telefonie organizatora.

1. Organizator: **Zdjęcie → Wczytaj zdjęcie**, sprawdza twarze i wpisuje imiona.
2. **Utwórz plik dla serwera** → pobiera się plik `zlot.json`.
3. Wgrywa go do repozytorium jako **`data/zlot.json`**
   (GitHub → *Add file → Upload files*, folder `data`). Strona zaktualizuje się sama.
4. Uczestnicy otwierają https://traciborski.github.io/zlot/ i od razu mogą używać kamery.
   Gdy organizator wgra nową wersję pliku (np. poprawione imiona), telefony pobiorą ją same.

Plik `zlot.json` zawiera tylko: numer osoby, imię i wektor cech twarzy (128 liczb).
Nie ma w nim zdjęcia ani wycinków twarzy – u uczestników zamiast miniatury
„sprzed lat” widać numer osoby. Wektor cech to jednak dane biometryczne i plik
jest publicznie dostępny (repozytorium i strona są publiczne).

## Jak używać

1. **Zdjęcie → Wczytaj zdjęcie** – wybierz zdjęcie grupowe (skan, zdjęcie odbitki).
   Aplikacja znajduje wszystkie twarze (również małe w tylnych rzędach) i numeruje je.
   - Dotknij numeru, żeby wpisać imię (albo usunąć błędnie wykrytą „twarz”).
   - Dotknij twarzy bez ramki, żeby dodać osobę, której detektor nie znalazł.
   - Zdjęcia czarno-białe i w sepii są wykrywane automatycznie – wtedy obraz z kamery
     też jest analizowany w odcieniach szarości, żeby porównanie było uczciwe.
2. **Na żywo → Start** – skieruj kamerę na ludzi. **Każda twarz w kadrze dostaje jedno
   dopasowanie**: najbardziej podobną osobę ze zdjęcia, z procentem podobieństwa
   i miniaturą twarzy sprzed lat (np. „2. Basia 63%”):
   - 🔵 niebieska ramka – dopasowanie automatyczne,
   - 🟢 zielona ramka „✓” – dopasowanie potwierdzone,
   - ⚪ „Spoza zdjęcia” – osoba oznaczona jako nieobecna na zdjęciu.
   Jedna osoba ze zdjęcia trafia tylko do jednej twarzy – jeśli dwie twarze pasują
   do tej samej osoby, dostaje ją lepiej pasująca, a druga swoją kolejną najlepszą.
   Pod podglądem jest lista „twarz dziś → twarz ze zdjęcia, %”.
   **⏸ Zatrzymaj** zamraża klatkę, żeby spokojnie odczytać wyniki.
3. **Dotknij twarzy** (na podglądzie albo na liście), żeby poprawić dopasowanie –
   zobaczysz 3 najbardziej podobne osoby ze zdjęcia z procentami. Wybierz właściwą (albo inną z listy, albo „Nie ma go/jej na zdjęciu”).
   Po potwierdzeniu aplikacja zapamiętuje **dzisiejszy wygląd** tej osoby
   i od tej pory rozpoznaje ją pewnie (zielona ramka). Na liście w zakładce
   *Zdjęcie* widać „wtedy / dziś” i licznik „Znalezieni: X z Y”.
4. **Eksport / Import** – przeniesienie zdjęcia z imionami i dopasowaniami na inny telefon.
5. **Ustawienia** – rozdzielczość detekcji na żywo.

### Jak czytać procenty

Procent to podobieństwo wektorów twarzy (100% = praktycznie to samo ujęcie,
0% = zupełnie różne twarze), a nie prawdopodobieństwo, że to ta osoba.
W testach obca osoba podobnego typu urody dostała nawet ~65%, a ta sama osoba
na tym samym zdjęciu ~100%. Po 25 latach ta sama osoba zwykle wypada gdzieś
pośrodku. Aplikacja zawsze pokazuje najlepsze dopasowanie, także dla osób spoza
zdjęcia – niski procent (poniżej ~50%) oznacza, że to raczej ktoś inny.

### Czego się spodziewać

Rozpoznanie twarzy sprzed 25 lat jest trudne nawet dla ludzi – automat podpowiada,
ale przy dużej zmianie wyglądu może się mylić (niebieskie ramki). Dlatego ostateczne
przypisanie robi człowiek jednym dotknięciem, a każde potwierdzenie poprawia
kolejne rozpoznania. Najlepiej działa przy twarzach zwróconych do kamery,
w dobrym świetle, z odległości kilku metrów.

## Uruchomienie lokalnie

```sh
python3 -m http.server 8000
# otwórz http://localhost:8000
```

Na telefonie w sieci lokalnej kamera zadziała tylko przez HTTPS
(np. GitHub Pages albo tunel typu `ngrok` / `cloudflared`).

## Technologia

- [face-api (@vladmandic)](https://github.com/vladmandic/face-api) na TensorFlow.js
  (WebGL na GPU telefonu), dołączone w `vendor/` wraz z modelami:
  TinyFaceDetector + SSD MobileNet (detekcja; na zdjęciu grupowym także kafelkami),
  FaceLandmark68 (punkty twarzy), FaceRecognitionNet (wektor 128‑D do porównywania).
- Zdjęcie, imiona i dopasowania w IndexedDB przeglądarki, service worker do pracy offline.
- Bez kroku budowania – czysty HTML/CSS/JS.

## Prywatność

Dane biometryczne to dane szczególnej kategorii (RODO, art. 9).
Zapisuj twarze tylko osób, które wyraziły na to zgodę.
