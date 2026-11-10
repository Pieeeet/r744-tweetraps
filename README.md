# R744 tweetraps simulator met DHW-heat recovery

Statische GitHub Pages-webapp voor een transkritische CO₂-koelkring met:

- tweetrapscompressie;
- intercooler op receiverdruk;
- flash receiver en flashgas-bypass;
- twee expansieventielen;
- optionele platenwarmtewisselaar in de hogetrap-persgasleiding;
- berekening van sanitair-warmwateruittrede, teruggewonnen warmte en resterende gaskoelerlast;
- log(p)-h-diagram met verzadigingskoepel, isothermen en optionele isentropen/dampgehaltelijnen;
- export van toestandspunten als CSV en het diagram als SVG.

Wanneer warmteterugwinning wordt uitgeschakeld, verdwijnt de platenwarmtewisselaar met toestandspunt 6a uit het processchema, de toestandstabel en het log(p)-h-traject. De hogedrukleiding schakelt dan zichtbaar over op de rechtstreekse bypass 6 → 7.

## Bestandsstructuur

```text
/
├── index.html
├── app.js
├── style.css
├── sw.js
├── coolprop.js
└── coolprop.wasm   ← vereist; behoud het bestaande bestand
```

`coolprop.wasm` is bewust niet dubbel in dit pakket opgenomen. Behoud het bestaande bestand van circa 8,77 MB in de root van de repository. `coolprop.js` en `coolprop.wasm` moeten uit dezelfde CoolProp-build komen.

## Publiceren

1. Pak het ZIP-bestand uit.
2. Upload de inhoud naar de root van de GitHub Pages-repository.
3. Laat het bestaande `coolprop.wasm` staan.
4. Controleer onder **Settings → Pages**: `Deploy from a branch`, branch `main`, map `/(root)`.
5. Wacht op de Pages-deployment en voer één harde refresh uit (`Ctrl+Shift+R`).

Open `index.html` niet rechtstreeks via `file://`; WebAssembly moet via HTTP(S) worden geladen.

## Model

De nummering volgt de werkelijke massastromen:

- 9 → 10 → 1 → 2 → 3: vloeistof uit receiver, LP-expansie, verdamper, LP-compressor, intercooler;
- 4 → 5: verzadigd flashgas uit receiver naar de menging;
- 3 + 4 → 5: enthalpie- en massabalans vóór de HP-compressor;
- 5 → 6 → 6a → 7 → 8: HP-compressor, platenwarmtewisselaar, gaskoeler en HP-expansie;
- 8 → 4 + 9: fasescheiding in de receiver.

De warmteterugwinning wordt begrensd door het ingestelde SWW-doel, het waterdebiet, het minimale temperatuurverschil en de enthalpie van de ingestelde gaskoeleruittrede. Het model is stationair en verwaarloost drukval en warmteverlies.

## Controle

Voer lokaal bijvoorbeeld uit:

```bash
python3 -m http.server 8000
```

Open daarna `http://localhost:8000`.
