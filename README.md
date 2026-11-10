# R744 tweetraps koelkring

Statische GitHub Pages-webapp voor een transkritische CO₂-cyclus met:

- lage- en hogedrukcompressor;
- gaskoeler;
- gasintercooler;
- liquid receiver / flash tank;
- flashgas-bypass naar de hogedruktrap;
- twee expansieventielen;
- log(p)-h-diagram met verzadigingskoepel, isothermen, isentropen en dampgehaltelijnen;
- tien toestandspunten, ontwerpcontroles en CSV/SVG-export.

## Vereiste bestanden

Plaats alle bestanden rechtstreeks in de root van de GitHub Pages-repository:

```text
/
├── index.html
├── app.js
├── style.css
├── coolprop.js
├── coolprop.wasm      ← behoud het bestaande officiële bestand
└── README.md
```

`coolprop.js` is in dit pakket opgenomen. `coolprop.wasm` is niet opnieuw opgenomen omdat dit grote binaire bestand niet als bijlage beschikbaar was. Gebruik het bestaande `coolprop.wasm` dat bij exact dezelfde CoolProp-download hoort als `coolprop.js`.

## Publiceren

1. Vervang `index.html`, `app.js` en `style.css` in de repository.
2. Upload desgewenst ook de meegeleverde `coolprop.js`.
3. Laat het bestaande `coolprop.wasm` in de root staan.
4. Kies in GitHub **Settings → Pages → Deploy from a branch → main → /(root)**.
5. Wacht op de deployment en voer een harde refresh uit (`Ctrl+F5`).

De module wordt correct als ES-module geladen:

```js
import CoolPropFactory from './coolprop.js';
const CoolProp = await CoolPropFactory({
  locateFile: path => path.endsWith('.wasm')
    ? new URL('./coolprop.wasm', import.meta.url).href
    : path
});
```

De rekenkern gebruikt rechtstreeks de Embind-export `CoolProp.PropsSI(...)`; `cwrap` wordt nergens gebruikt.

## Cyclusmodel

De hogedrukstroom expandeert isenthalpisch naar de receiverdruk. De receiver levert verzadigde vloeistof aan de verdamper en verzadigd flashgas aan de hogedrukzuigleiding. De lage-trappersgasstroom wordt eerst gekoeld tot `T_sat(receiver) + intercooler-benadering` en mengt daarna met het flashgas.

Belangrijkste aannames:

- stationaire toestand;
- geen leidingdrukverliezen;
- geen warmteverlies buiten de gemodelleerde warmtewisselaars;
- isenthalpische expansie;
- verzadigde vloeistof- en dampuitgangen uit de receiver;
- één gemeenschappelijk koudemiddel: `HEOS::CO2`.

Dit is een didactische simulator. Gebruik voor definitief ontwerp ook fabrikantgegevens, veiligheidsberekeningen en gevalideerde projectsoftware.

## Lokaal testen

Open de HTML niet rechtstreeks met `file://`. Start in de map een lokale webserver:

```bash
python3 -m http.server 8000
```

Open daarna `http://localhost:8000/`.
