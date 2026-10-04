# Puttipeli

Puttipeli on selaimessa pelattava, ylhäältä kuvattu 2D-minigolf: yhdeksän alkuperäistä
perusrataa, rataeditori omien ratojen tekemiseen sekä vuoropohjainen verkkomoninpeli
2–4 pelaajalle huonekoodilla. Kaikki koodi, grafiikka, radat ja nimet ovat omaa tuotantoa.

- **Yksinpeli** – pelaa perusradat (par 27) tai omia ratoja, tuloskortti ja yhteenvedot.
- **Moninpeli** – isäntä luo huoneen, muut liittyvät viisimerkkisellä koodilla tai linkillä;
  palvelin on auktoriteetti ja kaikki näkevät saman deterministisen simulaation.
- **Rataeditori** – kaikki ruututyypit ja kohteet, kumoa/tee uudelleen, testipeli,
  tallennus selaimeen ja JSON-tiedostoon; omat radat pelattavissa yksin- ja moninpelissä.
- **Ohjeet** ja **Asetukset** (nimimerkki, pallon väri, äänet, kieli Suomi/English).

Tekniikka: TypeScript, Vite, HTML5 Canvas (oma pieni pelimoottori), Node.js + `ws`,
Vitest ja Playwright. Yksi npm-workspace:

| Paketti | Sisältö |
|---------|---------|
| `packages/shared` | fysiikka, ratamalli, pelin tilakone ja protokolla – DOM-vapaa, sama koodi selaimessa ja palvelimella |
| `packages/client` | Vite-sovellus: valikot, pelinäkymä, editori, moninpeliasiakas |
| `packages/server` | Node-palvelin: staattinen asiakas, `/healthz`, `/api/stats` ja WebSocket `/ws` samassa prosessissa |

Suunnitteludokumentti: [docs/DESIGN.md](docs/DESIGN.md). Perusradat: [docs/COURSES.md](docs/COURSES.md).

## Vaatimukset

- **Node.js 24** (npm 11 tulee mukana). Windowsilla Node ei välttämättä ole `PATH`:lla:
  PowerShellissä `$env:Path += ";C:\Program Files\nodejs"`.
- Moderni selain (Chrome, Edge, Firefox, Safari). Kosketusnäyttö toimii, mutta hiiri on ensisijainen.
- Valinnaisesti Docker (tuotantokuva) ja `flyctl` (julkaisu Fly.io:hon).

Käytä osoitteissa aina `127.0.0.1`, ei `localhost` – Windowsin työkalut saattavat
tulkita `localhost`-nimen ensin IPv6-osoitteeksi `::1`, jota palvelin ei kuuntele.

## Kehitys

```bash
npm install
npm run dev
```

`npm run dev` käynnistää kaksi prosessia samassa terminaalissa:

| Portti | Prosessi | Osoite |
|--------|----------|--------|
| 5173 | Vite (asiakas, hot reload) | http://127.0.0.1:5173 – **avaa tämä** |
| 8080 | `tsx watch` (palvelin) | http://127.0.0.1:8080/healthz, `/api/stats`, `/ws` |

Vite välittää `/ws`- ja `/api`-pyynnöt palvelimelle porttiin 8080, joten asiakas ja
moninpeli toimivat yhdestä osoitteesta. Moninpeliä testataan avaamalla kaksi
selainikkunaa (tai yksityinen ikkuna toiseksi pelaajaksi). Jos `packages/client/dist`
on olemassa aiemmasta buildista, portti 8080 tarjoilee sen vanhan version – kehitä
portista 5173.

WP-D:n renderöintiharjoitus löytyy osoitteesta http://127.0.0.1:5173/dev/render.html ja
yksinpelin säätöpaneeli reitistä `#/dev`.

## Testit, tyyppitarkistus ja lint

Kaikki komennot ajetaan projektin juuresta (Vitestin asetukset ovat vain juuressa).

| Komento | Tekee |
|---------|-------|
| `npm test` | Vitest, kaikki `packages/**/src/**/*.test.ts` (fysiikka, ratamalli, pelin tilakone, protokolla, palvelin, asiakaslogiikka) |
| `npm run test:watch` | sama tarkkailutilassa |
| `npm run test:golden-update` | päivittää fysiikan golden-tarkistussummat (vain tarkoituksellisen fysiikkamuutoksen jälkeen; nosta samalla `SIM_VERSION`) |
| `npm run typecheck` | `tsc -b` kaikille paketeille (vain tyyppitarkistus, ei tuota ajettavaa koodia) |
| `npm run lint` | ESLint, mukana simulaation determinismisäännöt |
| `npm run check` | typecheck + lint + test peräkkäin |
| `npm run e2e` | Playwright-selaintestit oikeaa käyttöliittymää vasten (`npm run e2e:headed` näkyvällä selaimella). Chromium asennetaan kerran: `npx playwright install chromium` |

## Tuotantobuild

```bash
npm run build     # Vite -> packages/client/dist, esbuild -> packages/server/dist/index.js
npm start         # node packages/server/dist/index.js
```

Palvelin kuuntelee oletuksena osoitteessa http://127.0.0.1:8080 ja tarjoilee samasta
originista staattisen asiakkaan, `/healthz` (`{"ok":true}`), `/api/stats`
(huoneet, pelaajat, katsojat, uptime, build) ja WebSocketin `/ws`. Asiakas muodostaa
yhteyden osoitteeseen `ws(s)://<sivun host>/ws`, joten CORS-asetuksia ei tarvita.
Palvelinbundle on itsenäinen lukuun ottamatta `ws`-pakettia, joka ladataan
`node_modules`-kansiosta.

Toinen portti: `PORT=8093 npm start` (bash) tai `$env:PORT=8093; npm start`
(PowerShell). Build-tunniste: `BUILD_ID=abc123 npm run build` leipoo tunnisteen
asiakkaaseen; palvelin lukee saman muuttujan käynnistyessään.

## Docker

```bash
docker build -t puttipeli --build-arg BUILD_ID=$(git rev-parse --short HEAD) .
docker run --rm -p 8080:8080 -e PUBLIC_ORIGIN=http://127.0.0.1:8080 puttipeli
```

`Dockerfile` on kaksivaiheinen: build-vaihe ajaa `npm ci`, `npm run build` ja
`npm prune --omit=dev`; ajovaihe (`node:24-alpine`, käyttäjä `node`) sisältää vain
karsitun `node_modules`-kansion (`ws` + workspace-linkit), `packages/client/dist` ja
`packages/server/dist`. Kuvassa on `HEALTHCHECK`, joka kutsuu `/healthz`-polkua.
`.dockerignore` jättää build-kontekstista pois `node_modules`-, `dist`-, `docs`- ja
`e2e`-kansiot, `.git`-historian ja markdown-tiedostot.

## Julkaisu Fly.io:hon (suositus)

Huoneet elävät palvelinprosessin muistissa, joten peli ajetaan **täsmälleen yhdellä**
koneella. Fly.io:n välityspalvelin päästää pitkäikäiset WebSocket-yhteydet läpi
katkaisematta niitä, ja `arn`-alue (Tukholma) on noin 10 ms:n päässä Suomesta.

1. Asenna `flyctl` ja kirjaudu: `fly auth login`.
2. Luo sovellus tämän repositorion `fly.toml`-tiedostosta julkaisematta vielä:
   `fly launch --no-deploy --copy-config`. Jos nimi `puttipeli` on varattu, anna uusi nimi
   ja päivitä `app = "..."` tiedostoon.
3. Aseta `fly.toml`-tiedoston `[env]`-osion `PUBLIC_ORIGIN` sovelluksen oikeaan osoitteeseen
   (`https://<app>.fly.dev`, ilman loppukauttaviivaa; useampi origin pilkulla eroteltuna).
4. Julkaise: `fly deploy --build-arg BUILD_ID=$(git rev-parse --short HEAD)`.
5. Varmista yksi kone: `fly scale count 1`. Älä koskaan skaalaa yli yhden – huoneita ei
   jaeta instanssien välillä.
6. Seuraa: `fly status`, `fly logs`, selaimessa `https://<app>.fly.dev/healthz`.

**Kustannus ja ajotilat** (`fly.toml`):

- **Tila A – aina päällä (oletus):** `auto_stop_machines = "off"`,
  `min_machines_running = 1`. Yksi `shared-cpu-1x` / 256 MB -kone maksaa noin 2–3 USD
  kuukaudessa ja pitää muistissa olevat huoneet hengissä.
- **Tila B – lähes ilmainen:** kommentoi A:n kolme riviä ja ota käyttöön
  `auto_stop_machines = "suspend"`, `min_machines_running = 0`. Kone keskeytetään, kun
  liikennettä ei ole, ja herää noin sekunnissa ensimmäiseen pyyntöön. Prosessin muisti
  säilyy keskeytyksessä, mutta pitkä tauko voi silti päättää huoneet (TTL-ajastimet
  jatkavat ja pysäytetty kone pudottaa WebSocket-yhteydet).

Agentti ei koskaan julkaise – `fly deploy` on aina käyttäjän oma komento.

## Vaihtoehto: Render

`render.yaml` on Render Blueprint, joka rakentaa saman Dockerfilen. Vie repositorio
GitHubiin/GitLabiin, valitse Renderissä *New → Blueprint* ja osoita tähän tiedostoon.
Päivitä `PUBLIC_ORIGIN` Renderin antamaan osoitteeseen (`https://<nimi>.onrender.com`).

Ilmainen `free`-taso toimii ja WebSocketit kulkevat, mutta palvelu **nukahtaa noin 15
minuutin käyttämättömyyden jälkeen** (kylmäkäynnistys 30–60 s) ja avoimet huoneet
katoavat samalla. Siksi Render on dokumentoitu varavaihtoehto, ei suositus;
`starter`-taso poistaa nukkumisen.

## Ympäristömuuttujat

Kaikki valinnaisia, ei salaisuuksia; malli tiedostossa [`.env.example`](.env.example).
Palvelin lukee vain `process.env`-muuttujat (ei `.env`-tiedostoa): aseta ne shellissä,
alustan asetuksissa tai Dockerille `--env-file .env`. Virheellinen arvo (esim. ei-
kokonaisluku) pysäyttää käynnistyksen heti.

| Muuttuja | Oletus | Merkitys |
|----------|--------|----------|
| `PORT` | `8080` | kuunneltava portti |
| `HOST` | `0.0.0.0` | kuunneltava osoite |
| `PUBLIC_DIR` | `packages/client/dist` | asiakasbuildin hakemisto; puuttuva hakemisto tai tyhjä arvo poistaa staattisen tarjoilun |
| `PUBLIC_ORIGIN` | (ei asetettu = kaikki sallittu) | sallitut `Origin`-arvot WebSocket-yhteyksille, pilkulla eroteltuna, ilman loppukauttaviivaa |
| `MAX_ROOMS` | `200` | huoneiden enimmäismäärä |
| `MAX_CONNECTIONS` | `1000` | yhtäaikaisten yhteyksien enimmäismäärä |
| `ROOM_IDLE_TTL_MIN` | `90` | huone poistetaan, kun siinä ei ole tapahtunut mitään näin moneen minuuttiin |
| `ROOM_EMPTY_TTL_SEC` | `120` | huone poistetaan, kun siinä ei ole ollut yhteyksiä näin moneen sekuntiin |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `TRUST_PROXY` | `false` | `true` = asiakkaan IP luetaan `X-Forwarded-For`-otsakkeesta (vain lokitukseen; välityspalvelimen takana) |
| `BUILD_ID` | `dev` | build-tunniste: asiakkaaseen build-aikana, palvelimelle ajonaikaisesti |

## Ratatiedoston muoto

Yksi rata per JSON-tiedosto, `"format": "puttipeli-course"`, `"formatVersion": 1`.
Kenttä on aina 49 × 25 ruutua (ruutu 15 px). Kaksi merkkiriveistä koostuvaa kerrosta
sekä kohdelista – helppo lukea, muokata käsin ja versioida:

```json
{
  "format": "puttipeli-course",
  "formatVersion": 1,
  "id": "c_…",
  "name": "Oma rata",
  "author": "Nimimerkki",
  "description": "Lyhyt kuvaus",
  "width": 49,
  "height": 25,
  "rules": { "maxStrokes": 20, "par": 3 },
  "surface": [ "… 25 riviä, 49 merkkiä …" ],
  "walls":   [ "… 25 riviä, 49 merkkiä …" ],
  "objects": [ { "type": "start", "x": 3, "y": 12 }, { "type": "hole", "x": 44, "y": 12 } ]
}
```

| Kerros | Merkit |
|--------|--------|
| `surface` | `.` nurmi · `s` hiekka · `i` jää · `t` terva · `w` vesi · `a` happo · `8 6 2 4` rinteet (numeronäppäimistön numero osoittaa alamäkeen) |
| `walls` | `.` ei seinää · `#` seinä · `7 9 3 1` viistot (numero = umpinainen kulma) · `x y z` murtuva 1/2/3 osumaa · `M` siirrettävä · `O` pomppuseinä · `^ > v <` yksisuuntainen |
| `objects` | `start`, `hole`, `teleport` (`group`), `magnet` (`polarity` ±1, `strength` 50–500, `radius`), `mine` |

Tunniste `id` lasketaan radan sisällöstä (`c_` + 16 heksamerkkiä); `b_01`…`b_09` on
varattu perusradoille, ja omalle radalle annettu `b_`-tunniste korvataan automaattisesti.
Editori tarkistaa radan live-tilassa (yksi `start`, vähintään yksi `hole`, teleportit
pareittain, oikeat rivipituudet ja merkit) ja varoittaa, jos reikä ei ole saavutettavissa
ilman seinän murtamista. Täysi määrittely: [docs/DESIGN.md §7](docs/DESIGN.md#7-course-format-validation-identity-editing-ops-wp-a).

## Pelaaminen lyhyesti

**Tavoite:** pallo reikään mahdollisimman vähillä lyönneillä. Par kertoo radan
tavoitetuloksen; lyöntiraja on oletuksena 20 lyöntiä rataa kohden.

| Ohjaus | Toiminto |
|--------|----------|
| Hiiri | Osoita suuntaan, johon haluat pallon lähtevän, ja pidä painike pohjassa: pallo lähtee osoitinta kohti, viivan pituus on voima (enintään 120 px). Vapauta lyödäksesi. Oikea painike tai veto kentän ulkopuolelle peruu. |
| `←` / `→` | käännä tähtäintä 2° (Shift: 0,25°) |
| `↑` / `↓` | säädä voimaa (Shift: hienosäätö) |
| `Space` / `Enter` | lyö (ilman tähtäystä: oletuslyönti lähintä reikää kohti 50 %:n voimalla) |
| `Esc` | peru tähtäys / taukovalikko |
| `Tab` | tuloskortti |
| `C` | keskustelu (moninpeli) |
| `G` | ruudukko (editori) |
| Kosketus | vedä missä tahansa kentällä; **Lyö**-painike laukaisee (vaihdettavissa asetuksista) |

**Säännöt:** vesi ja miina palauttavat pallon lyönnin alkupisteeseen, happo radan
lähtöön – kaikki +1 lyönti. Terva pysäyttää pallon heti. Teleportit toimivat pareittain
ja säilyttävät nopeuden. Magneetit vetävät (+) tai työntävät (−) kantamansa sisällä.
Murtuvat seinät hajoavat 1–3 osumasta, siirrettävät palikat liukuvat ruudun, yksisuuntaiset
seinät päästävät läpi vain nuolen suuntaan, pomppuseinät kiihdyttävät ja rinteet vievät
alamäkeen.

**Moninpeli:** isäntä luo huoneen (2–4 pelaajaa, 1–18 rataa, valinnainen vuoron
aikaraja 30/45/60 s, reiän yhteenveto 3/6/10 s tai "odota kaikkia") ja jakaa koodin tai linkin. Pelataan vuorotellen; ylittynyt
aikaraja maksaa yhden lyönnin, ja reiän jälkeen aloitusvuoro kiertää. Katsojat näkevät
pelin ja voivat keskustella; aulassa he voivat ottaa vapaan paikan. Yhteyden katketessa
paikka säilyy minuutin – sivun lataus palauttaa peliin.

## Alkuperäisyys ja lisenssi

Puttipeli on pelattavuudeltaan klassisen verkkominigolfin henkinen jälkeläinen, mutta
kaikki koodi, proseduraalinen grafiikka, syntetisoidut äänet, ratatiedostot, nimet ja
tekstit ovat tämän projektin omaa, alkuperäistä tuotantoa. Minkään olemassa olevan pelin
grafiikkaa, ääniä, ratoja tai tavaramerkkejä ei ole kopioitu eikä ladattu projektiin.

Lisenssiä ei ole vielä valittu. Kunnes repositorioon lisätään `LICENSE`-tiedosto,
kaikki oikeudet pidätetään.

---

## English summary

**Puttipeli** is an original browser minigolf game: nine built-in courses, a course
editor and turn-based online multiplayer for 2–4 players (5-character room codes).
TypeScript, Vite, Canvas 2D, Node 24 + `ws`, Vitest, Playwright. The UI is Finnish
(English available in settings); code and comments are English.

### Development

```bash
npm install
npm run dev        # Vite on http://127.0.0.1:5173 (open this), server on :8080 (/ws and /api are proxied)
npm test           # Vitest
npm run typecheck  # tsc -b
npm run lint       # ESLint
npm run e2e        # Playwright (once: npx playwright install chromium)
```

Use `127.0.0.1` rather than `localhost` on Windows (`localhost` may resolve to `::1` first).

### Production

```bash
npm run build && npm start      # one Node process on http://127.0.0.1:8080: static client, /healthz, /api/stats, /ws
docker build -t puttipeli . && docker run --rm -p 8080:8080 puttipeli
```

Rooms are held in memory, so run exactly **one** instance. Recommended host: Fly.io
(`fly launch --no-deploy --copy-config`, set `PUBLIC_ORIGIN`, `fly deploy`,
`fly scale count 1`; about 2–3 USD/month always-on, or near zero in suspend mode).
`render.yaml` is the free alternative (sleeps after ~15 min idle, open rooms are lost).
Environment variables are documented in `.env.example`; none are secrets.

### Originality

All code, procedural art, synthesized sounds, courses, names and text are original to
this project; nothing is copied from any existing game. No licence has been chosen yet –
all rights reserved until a `LICENSE` file is added.
