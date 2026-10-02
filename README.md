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

## Jak używać

1. **Zdjęcie → Wczytaj zdjęcie** – wybierz zdjęcie grupowe (skan, zdjęcie odbitki).
   Aplikacja znajduje wszystkie twarze (również małe w tylnych rzędach) i numeruje je.
   - Dotknij numeru, żeby wpisać imię (albo usunąć błędnie wykrytą „twarz”).
   - Dotknij twarzy bez ramki, żeby dodać osobę, której detektor nie znalazł.
   - Zdjęcia czarno-białe i w sepii są wykrywane automatycznie – wtedy obraz z kamery
     też jest analizowany w odcieniach szarości, żeby porównanie było uczciwe.
2. **Na żywo → Start** – skieruj kamerę na ludzi. Przy każdej twarzy pojawia się
   numer i imię ze zdjęcia oraz miniatura twarzy sprzed lat:
   - 🔵 niebieska ramka „Imię 63%” – prawdopodobnie ta osoba (% podobieństwa do starego zdjęcia),
   - 🟢 zielona ramka „Imię 90% ✓” – potwierdzona osoba,
   - 🟠 „Nie wiadomo” – nikt ze zdjęcia nie pasuje wystarczająco,
   - ⚪ „Spoza zdjęcia” – osoba oznaczona jako nieobecna na zdjęciu.
   Pod podglądem jest lista: dla każdej twarzy w kadrze 3 najbardziej podobne osoby
   ze zdjęcia z procentem podobieństwa. **⏸ Zatrzymaj** zamraża klatkę, żeby spokojnie
   odczytać wyniki.
3. **Dotknij ramki twarzy** – zobaczysz 3 najbardziej podobne osoby ze zdjęcia.
   Wybierz właściwą (albo inną z listy, albo „Nie ma go/jej na zdjęciu”).
   Po potwierdzeniu aplikacja zapamiętuje **dzisiejszy wygląd** tej osoby
   i od tej pory rozpoznaje ją pewnie (zielona ramka). Na liście w zakładce
   *Zdjęcie* widać „wtedy / dziś” i licznik „Znalezieni: X z Y”.
4. **Eksport / Import** – przeniesienie zdjęcia z imionami i dopasowaniami na inny telefon.
5. **Ustawienia** – minimalne podobieństwo (%), od którego twarz jest podpisywana
   (domyślnie 45%, bo przez 25 lat ludzie się zmieniają) i rozdzielczość detekcji na żywo.

### Jak czytać procenty

Procent to podobieństwo wektorów twarzy (100% = praktycznie to samo ujęcie,
0% = zupełnie różne twarze), a nie prawdopodobieństwo, że to ta osoba.
W testach obca osoba podobnego typu urody dostała nawet ~65%, a ta sama osoba
na tym samym zdjęciu ~100%. Po 25 latach ta sama osoba zwykle wypada gdzieś
pośrodku, więc najważniejsze jest **porównanie** – kto ma wyraźnie najwyższy
wynik na liście kandydatów – a nie sama liczba.

### Czego się spodziewać

Rozpoznanie twarzy sprzed 25 lat jest trudne nawet dla ludzi – automat podpowiada,
ale przy dużej zmianie wyglądu może się mylić (niebieskie „?”). Dlatego ostateczne
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
