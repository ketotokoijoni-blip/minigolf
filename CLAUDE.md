# Minigolf – projektin säännöt (CLAUDE.md)

Tämä tiedosto määrittelee, mitä Claude Code saa ja ei saa tehdä tässä projektissa.
Säännöt koskevat myös kaikkia aliagentteja ja workflow-ajoja.

## Projekti lyhyesti

Selainpohjainen 2D-minigolf (ylhäältä kuvattu, ruutupohjainen rata), joka on
pelattavuudeltaan klassisen suomalaisen verkkominigolfin henkinen jälkeläinen.
Kaikki koodi, grafiikka, nimet ja ratasuunnitelmat ovat **omaa, alkuperäistä
tuotantoa**. Alkuperäisen pelin grafiikkaa, ääniä, ratatiedostoja tai tavaramerkkejä
ei kopioida eikä ladata projektiin.

Tech stack: TypeScript, Vite, HTML5 Canvas (oma pieni pelimoottori), Node.js +
`ws` -WebSocket-palvelin moninpeliin, Vitest testeihin. Yksi npm-workspace, jossa
`packages/shared` (fysiikka, ratamalli, protokolla), `packages/client` ja
`packages/server`.

## SALLITTU (ilman erillistä kysymistä)

- Tiedostojen luominen ja muokkaaminen tämän projektikansion (`C:\Users\ketot\projektit\minigolf`) sisällä.
- `npm install`, `npm run build`, `npm run dev`, `npm test`, `npx vitest`, `npx tsc`, `npx vite` ja vastaavat kehityskomennot projektikansiossa.
- Kehityspalvelimien käynnistys ja pysäytys (vain prosessit, jotka tämä projekti on itse käynnistänyt).
- `git init`, `git add`, `git commit`, `git status`, `git diff`, `git log`, haaran luonti.
- Omien väliaikaistiedostojen luonti scratchpad-hakemistoon.
- Testien, lint-ajojen ja tyyppitarkistusten ajaminen.

## KIELLETTY (destruktiivinen toiminta)

- Tiedostojen tai kansioiden poistaminen projektikansion ulkopuolelta. Projektin sisällä poisto on sallittu vain tiedostoille, jotka Claude on itse luonut tässä projektissa, ja `node_modules`/`dist`-kansioille.
- `rm -rf` / `Remove-Item -Recurse -Force` kohdistettuna mihinkään muuhun kuin `node_modules`, `dist`, `.vite`, `coverage` tai scratchpadiin.
- `git push --force`, `git reset --hard`, `git clean -fdx`, `git checkout -- .`, historian uudelleenkirjoitus, haarojen poisto.
- Järjestelmän asetusten, rekisterin, PATH-muuttujan tai käyttäjäprofiilin muokkaaminen. (Poikkeus: Node.js:n asennus wingetillä on hyväksytty kertaluonteisesti, koska se on kehitystyön edellytys.)
- Muiden kuin projektin omien prosessien tappaminen (`Stop-Process`, `taskkill`) .
- Salaisuuksien (API-avaimet, tokenit, salasanat) kirjoittaminen koodiin tai lokiin; `.env`-tiedostot kuuluvat `.gitignore`en.
- Tietojen lähettäminen ulkoisiin palveluihin ilman käyttäjän nimenomaista pyyntöä (deploy, julkaisu, pakettien julkaisu npm:ään).
- Tekijänoikeudella suojatun materiaalin (alkuperäisen pelin grafiikka, äänet, radat, logo, nimi) kopiointi projektiin.
- Käyttäjän muiden projektien (`C:\Users\ketot\projektit\*` tämän kansion ulkopuolella) lukeminen tai muokkaaminen.

## Työtavat

- Ennen tiedoston ylikirjoitusta tarkista sen nykyinen sisältö.
- Pidä `packages/shared` riippumattomana DOM:ista, jotta sama fysiikka ajaa sekä selaimessa että palvelimella (deterministinen simulaatio).
- Jokainen fysiikan tai ratamallin muutos saa testit `packages/shared`-pakettiin.
- Käytä suomea käyttöliittymässä (englanti valinnaisena lokalisaationa), englantia koodissa ja kommenteissa.
- Älä lisää uusia runtime-riippuvuuksia ilman hyvää syytä; suosi pieniä, hyvin ylläpidettyjä paketteja.
- Kaikki komennot ajetaan projektikansiosta; älä `cd`:tä sen ulkopuolelle.
