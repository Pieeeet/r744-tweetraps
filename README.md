# R744 tweetraps koelkring

Statische GitHub Pages-simulator voor een transkritische CO₂-cyclus met:

- lage- en hoge-trapcompressor;
- gasintercooler;
- gaskoeler;
- HP-expansieventiel;
- liquid receiver / flash tank;
- flashgas-bypass en mengpunt vóór de hoge trap;
- LP-expansieventiel en verdamper;
- log(p)-h-diagram met verzadigingskoepel, isothermen, isentropen en lijnen van constant dampgehalte.

## Bestanden

```text
r744-tweetraps/
├── index.html
├── style.css
├── app.js
├── sw.js
├── coolprop.js
└── coolprop.wasm   ← behoud je bestaande, bij coolprop.js passende bestand
```

`coolprop.wasm` is wegens de omvang niet opnieuw in dit pakket opgenomen. Kopieer het bestaande bestand van ongeveer 8,77 MB naar dezelfde map. Gebruik precies de WASM-binary die bij de meegeleverde ES-module `coolprop.js` hoort.

## GitHub Pages

1. Upload de bestanden naar de root van de repository.
2. Laat het bestaande `coolprop.wasm` staan.
3. Kies **Settings → Pages → Deploy from a branch → main → /(root)**.
4. Wacht tot **pages build and deployment** groen is.
5. Open de Pages-URL en voer na de eerste update één harde refresh uit.

Alle paden zijn relatief. De pagina werkt daardoor zowel als usersite als onder een projectpad zoals `/r744-tweetraps/`.

## Waarom deze versie sneller start

- `coolprop.js` en `coolprop.wasm` worden in de HTML direct voorbereid met modulepreload/preload.
- De interface rendert vóór de WebAssembly-initialisatie.
- Zodra CoolProp gereed is, worden eerst alleen de actuele cyclus en toestandspunten berekend.
- Diagramachtergrond en isolijnen worden daarna in kleine batches opgebouwd.
- De berekende isolijnen worden in browseropslag hergebruikt.
- Isentropen en dampgehaltelijnen worden pas berekend wanneer de gebruiker ze inschakelt.
- Een service worker bewaart de grote WASM-binary na de eerste geslaagde aanvraag voor volgende bezoeken.

Bij een nieuwe release kan de isolijncache worden vernieuwd door `CACHE_KEY` in `app.js` te verhogen. De serviceworkercache wordt vernieuwd door `CACHE` in `sw.js` te verhogen.

## Thermodynamisch model

Nummering:

1. LP-compressor in
2. LP-compressor uit
3. intercooler uit
4. verzadigd receiverflashgas
5. HP-compressor in na adiabatische menging van 3 en 4
6. HP-compressor uit
7. gaskoeler uit
8. HP-ventiel uit / receiver in
9. verzadigde receivervloeistof
10. LP-ventiel uit / verdamper in

De receiverbalans is:

```text
ṁlaag = (1 − x8) · ṁhoog
ṁflash = x8 · ṁhoog
h5 = (ṁlaag·h3 + ṁflash·h4) / ṁhoog
```

Het intercooler-uitlaatpunt wordt benaderd vanaf de oververhitte dampzijde als `T3 = Tsat(receiverdruk) + benadering`, begrensd door de LP-persgastemperatuur.

## Lokale test

Open de bestanden niet via `file://`. Start in de map een lokale server:

```bash
python3 -m http.server 8000
```

Open daarna `http://localhost:8000/`.

## Gebruik

De simulator is bedoeld voor onderwijs en conceptvergelijking. Controleer componentselectie, regelstrategie, drukverliezen, warmtewisselaarbenaderingen, oliebeheer en bedrijfsgrenzen afzonderlijk voor een werkelijk ontwerp.
