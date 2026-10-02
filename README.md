# Kto to? – rozpoznawanie osób z kamery telefonu na żywo

Aplikacja na telefon (PWA) do rozpoznawania osób w kadrze kamery w czasie rzeczywistym.
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

1. **Osoby → Dodaj osobę ze zdjęć** – wpisz imię i wybierz 3–5 zdjęć tej osoby
   (różne ujęcia i oświetlenie = lepsza skuteczność).
2. **Na żywo → Start** – kamera rozpoznaje twarze na bieżąco:
   - zielona ramka = rozpoznana osoba (z pewnością w %),
   - pomarańczowa ramka = „Nieznany”.
3. **Dotknij ramki** twarzy (albo „＋ Z kadru”), aby dodać nową osobę lub dopisać
   kolejne ujęcie do istniejącej – wpisz to samo imię.
4. **⟲ Kamera** przełącza przednią/tylną kamerę.
5. **Eksport / Import** w zakładce *Osoby* pozwala przenieść bazę na inne telefony
   (np. żeby kilka osób na zlocie miało tę samą bazę).
6. **Ustawienia** – próg rozpoznania (niżej = ostrzej) i rozdzielczość detekcji
   (wyżej = lepiej wykrywa małe/dalekie twarze, ale wolniej).

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
  TinyFaceDetector (detekcja), FaceLandmark68 (punkty twarzy),
  FaceRecognitionNet (wektor 128‑D do porównywania).
- Baza osób w IndexedDB przeglądarki, service worker do pracy offline.
- Bez kroku budowania – czysty HTML/CSS/JS.

## Prywatność

Dane biometryczne to dane szczególnej kategorii (RODO, art. 9).
Zapisuj twarze tylko osób, które wyraziły na to zgodę.
