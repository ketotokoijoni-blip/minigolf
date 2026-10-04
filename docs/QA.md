# Puttipeli – manuaalinen QA-tarkistuslista (WP-K)

Tämä lista täydentää automaattitestejä (`npm run typecheck && npm test && npm run lint`, DESIGN §16) niillä
asioilla, joita Node-ympäristön testit eivät näe: skaalaus, HiDPI, kosketus, kahden selaimen moninpeli, yhteyden
katkeaminen ja editori. Jokaisella rivillä on **Tulos**-sarake. Rivit, jotka voidaan ajaa Nodessa, on ajettu ja
tulos kirjattu (päivä, komento). Selainrivit kuuluvat WP-L:n Playwright-ajoon (`npm run e2e`, R18); niiden
kuvakaappaukset tallentuvat kansioon `e2e/screenshots/` (git-ignoroitu), ja lead täydentää tuloksen kuvakaappauksen
perusteella.

Merkinnät: **OK** = tarkistettu ja kunnossa · **VIKA** = havaittu poikkeama (kuvaus + omistaja-WP) ·
**WP-L** = odottaa leadin katselmusta WP-L:n kuvakaappauksesta (`e2e/screenshots/NN-*.png`) · **MANUAALINEN** = ei WP-L:n
Playwright-ajossa, lead tarkistaa selaimessa · **EI AJETTU** = ei voitu ajaa tässä ympäristössä.

Osoitteet aina muodossa `http://127.0.0.1:<portti>` (R16; `localhost` voi Windowsissa ratkaista `::1`:ksi).

---

## 0. Ajoympäristö ja automaattitestit

| # | Tarkistus | Miten | Odotus | Tulos |
|---|-----------|-------|--------|-------|
| 0.1 | Tyyppitarkistus | `npm run typecheck` | ei virheitä | **OK** 2026-10-04 – `tsc -b packages/shared packages/client packages/server`, exit 0 |
| 0.2 | Yksikkö- ja integraatiotestit | `npm test` | kaikki vihreitä | **OK** 2026-10-04 – kaikki testitiedostot vihreitä (WP-K lisäsi 4 tiedostoa: `integration.test.ts` 12 testiä, `solvability.test.ts` 21 testiä, `dev.screen.test.ts` 11, `fi.dev.test.ts` 5) |
| 0.3 | Lint (ml. simulaation determinismisäännöt) | `npm run lint` | ei virheitä | **OK** 2026-10-04 – `eslint .`, exit 0 |
| 0.4 | Tuotantobuild | `npm run build` | Vite → `packages/client/dist`, esbuild → `packages/server/dist/index.js` | **OK** 2026-10-04 – 108 moduulia, `main-*.js` 296 kB (gzip 89 kB), `main-*.css` 34 kB, `dev/render.html` mukana |
| 0.5 | Ratkaistavuus (D12) | `npx vitest run packages/shared/src/sim/solvability` | jokainen perusrata uppoaa ≤ par + 2 lyönnillä | **OK** – b_01…b_05 1 lyönti, b_06/b_07/b_09 2 lyöntiä, b_08 3 lyöntiä (par 3); `createWorldFromCourse` = `createWorld(decodeLayers)` kaikilla |

## 1. Tuotantoasettelu: yksi prosessi, sama origin

Ajettu komennolla `npm run build` ja `PORT=8093 HOST=127.0.0.1 node packages/server/dist/index.js`
(skriptattu käynnistys + pysäytys; palvelin sammutettiin ajon jälkeen).

| # | Tarkistus | Odotus | Tulos |
|---|-----------|--------|-------|
| 1.1 | `GET /healthz` | `200 {"ok":true}` | **OK** – `200 {"ok":true}` |
| 1.2 | `GET /api/stats` | `{rooms, players, spectators, uptimeSec, build}` | **OK** – `{"rooms":0,"players":0,"spectators":0,"uptimeSec":0,"build":"dev"}` |
| 1.3 | `GET /` | `index.html`, `Cache-Control: no-cache`, sisältää `#app` ja hashatun `main-*.js`-skriptin | **OK** – `200 text/html; charset=utf-8`, `no-cache`, `#app` ja skripti löytyvät |
| 1.4 | SPA-fallback `GET /room/K7PQ2` | `index.html` (hash-reititin hoitaa loput) | **OK** – `200 text/html` |
| 1.5 | Hashattu asset `GET /assets/*.js` | `200`, `Cache-Control: public, max-age=31536000, immutable` | **OK** – `text/javascript; charset=utf-8`, immutable |
| 1.6 | Puuttuva asset `GET /assets/nope-000000.js` | `404` (ei SPA-fallbackia tiedostopäätteellisille poluille) | **OK** – `404` |
| 1.7 | `GET /favicon.svg` | `200 image/svg+xml` | **OK** |
| 1.8 | `GET /ws` ilman Upgradea | `426 Upgrade Required` | **OK** – `426` |
| 1.9 | `POST /healthz` | `405`, `Allow: GET, HEAD` | **OK** – `405 allow=GET, HEAD` |
| 1.10 | Polun ulkopuolelle kurottava pyyntö `GET /..%2f..%2fpackage.json` | `400` tai `404`, ei tiedostoa | **OK** – `400` |
| 1.11 | WebSocket `ws://127.0.0.1:8093/ws` + `hello` | `welcome{protocolVersion:1, simVersion:1, build}` | **OK** – `{"t":"welcome","protocolVersion":1,"simVersion":1,"serverTimeMs":…,"build":"dev"}` |
| 1.12 | `PUBLIC_ORIGIN` asetettuna: upgrade ilman Origin-otsaketta / vieraalla Originilla | `403`; listatut originit hyväksytään (kirjainkoko, loppukauttaviiva) | **OK** – `integration.test.ts` ("Origin check on the WebSocket upgrade") |
| 1.13 | `PUBLIC_DIR=""` | vain `/healthz`, `/api/stats`, `/ws`; `/` → `404` | **OK** – `integration.test.ts` |
| 1.14 | Versioristiriita `hello`ssa | `error BAD_VERSION` + close 4000 | **OK** – `integration.test.ts` |
| 1.15 | Siisti sammutus SIGTERM/SIGINT (roomLeft{roomClosed}, close 1001) | prosessi poistuu koodilla 0 | **EI AJETTU** Windowsissa (`child.kill` tappaa prosessin ilman signaalinkäsittelyä); logiikka luettu `index.ts`:stä. **Lead ajaa Linux-kontissa** (WP-J:n `Dockerfile`): `docker build -t puttipeli .` → `docker run --rm --name pp -p 8080:8080 puttipeli` → avaa `http://127.0.0.1:8080`, luo huone → `docker stop pp` (lähettää SIGTERM). Odotus: lokissa `shutdown complete {"exitCode":0}`, selain saa `roomLeft{roomClosed}` ja socket sulkeutuu koodilla 1001; `docker inspect pp --format '{{.State.ExitCode}}'` (ennen `--rm`-poistoa, tai ilman `--rm`) = 0. |

## 2. Moninpeli kahdella (kolmella) asiakkaalla

Node-ajo: `packages/server/src/integration.test.ts` käynnistää oikean palvelimen porttiin 0 ja kolme oikeaa
`ws`-asiakasta, jotka pelaavat b_01:n yhden reiän käsikirjoitetuilla lyönneillä.

| # | Tarkistus | Odotus | Tulos |
|---|-----------|--------|-------|
| 2.1 | Huoneen luonti, liittyminen koodilla (pienet kirjaimet, välilyönnit normalisoidaan) | kolme pelaajaa aulassa, tilat identtiset | **OK** – integraatiotesti |
| 2.2 | `setCourses` lähettää radan täyden datan (§11.6) | `coursesChanged` kaikilla, `courses = [b_01]` | **OK** |
| 2.3 | Ei-isännän `startGame` → `NOT_HOST`; lyönti aulassa → `NOT_YOUR_TURN` | virheet vain lähettäjälle | **OK** |
| 2.4 | Countdown → `gameStarted` → `holeStarted` → vuorot → `holeEnded` → `roundEnded` | jokainen asiakas pelaa koko käsikirjoituksensa, lyöntimäärät täsmäävät | **OK** – 5 lyöntiä yhteensä (1 + 2 + 2) |
| 2.5 | Jokaisen `shotTaken`-tapahtuman uudelleensimulointi asiakkaalla (§9.6) | tarkistussumma, tulos ja tikit = palvelimen `outcome` | **OK** – 15/15 replay-tarkistusta kolmella asiakkaalla |
| 2.6 | `requestSnapshot` → `roomState` | = `gameStateToJson` asiakkaan reducer-tilasta, `hashSimState` joka pallolle sama | **OK** |
| 2.7 | Tapahtumajärjestys ja `seq` identtiset kaikilla asiakkailla | sama | **OK** |
| 2.8 | Yhteyden katkeaminen aulassa: muut näkevät `playerConnection{false}` | kyllä | **OK** |
| 2.9 | Uudelleenliittyminen `rejoin{code, token}` | väärä token → `SESSION_EXPIRED`; oikea → `roomJoined` samalla `playerId`llä, täysi tila, muut näkevät `playerConnection{true}` | **OK** |
| 2.9a | Uudelleenliittyjän tila = palvelimen tila | identtinen (myös `seq`) | **OK** – korjattu R20:ssä: `Room.rejoin` ottaa tilannekuvan ennen `authority.connection(true)`-kutsua ja uudelleenliittyjä saa `playerConnection{true}`/`turnStarted`-tapahtumat tavallisen lähetyksen kautta kuten muutkin; `integration.test.ts` vertaa tilat täsmälleen `seq` mukaan lukien. |
| 2.10 | Poistuminen: `leaveRoom` → `roomLeft{left}`, muut saavat `playerLeft`; viimeisen poistuttua huone katoaa heti, `/api/stats` → 0 | kyllä | **OK** |
| 2.11 | Viesti huoneen ulkopuolelta (`requestSnapshot` poistumisen jälkeen) | `error NOT_IN_ROOM`, socket pysyy auki | **OK** |
| 2.12 | Kahden selaimen kierros oikealla käyttöliittymällä (aula, Valmis, Aloita, vuorot, tuloskortti, chat) | molemmat ikkunat näkevät saman pelin; vuoromerkki ja ajastinrengas vaihtuvat | **WP-L** (`e2e/04-multiplayer.spec.ts`) – `e2e/screenshots/16-mp.png` (moninpelivalikko), `17-lobby-host.png` / `18-lobby-guest.png` (aula isäntä/vieras), `19-mp-game-host.png` / `20-mp-game-guest.png` (sama peli kahdessa ikkunassa, vuoromerkki), `21-mp-chat.png` (chat) |
| 2.13 | Liittyminen linkillä `#/room/CODE` ilman istuntoa | nimikysely → liittyminen | **WP-L** |
| 2.14 | Yhteyden katkaisu selaimessa (devtools offline) ja palautus | backoff 0.5→…→10 s, `rejoin`, peli jatkuu samasta tilasta, ei desync-lokia | **MANUAALINEN** – WP-L:n spec ei katkaise yhteyttä (ei kuvakaappausta); palvelinpuoli katettu rivillä 2.9. Lead: devtools → Network → Offline 3 s → Online, odotus yllä. |
| 2.15 | Katsoja: täysi aula / käynnissä oleva peli → `role: spectator`, voi chattailla, ei voi lyödä, "Liity pelaajaksi" aulassa kun paikka vapaa | kyllä | **WP-L** |
| 2.16 | `BAD_VERSION`-dialogi "Päivitä sivu" (vanha välilehti uuden palvelimen kanssa) | dialogi + lataa uudelleen | **WP-L** / manuaalinen (vaatii versioerotuksen) |
| 2.17 | Kierroksen yhteenveto → "Takaisin aulaan" (isäntä) ja "Valmis" (kaikki); huone palaa aulaan | kyllä | **OK** (`backToLobby` integraatiotestissä) + **WP-L** käyttöliittymä |

## 3. Skaalaus ja HiDPI (WP-D `camera.ts`, §12.2)

| # | Tarkistus | Odotus | Tulos |
|---|-----------|--------|-------|
| 3.1 | Pelinäkymä 1920×1080 | kenttä (765×405 logista px) skaalautuu kokonaisluvulla (2×), terävät reunat, kenttä keskitetty | **MANUAALINEN** – WP-L ajaa vain 1280×800 (`playwright.config.ts`); lead tarkistaa selaimessa tai pyytää WP-L:ltä lisäviewportin |
| 3.2 | Pelinäkymä 1366×768 ja 1280×720 | skaala < 2 → sopii kokonaan näkyviin ilman vieritystä, HUD ei peitä kenttää | **WP-L** 1280×800: `e2e/screenshots/07-game-mid-shot.png`, `08-game-aiming.png` (kenttä kokonaan näkyvissä, HUD ei peitä); 1366×768 **MANUAALINEN** |
| 3.3 | Kapea ikkuna 800×600 | kenttä pienenee (skaala ≈ 1), HUD rivittyy, ei vaakavieritystä | **MANUAALINEN** – ei WP-L:n ajossa |
| 3.4 | Ikkunan koon muutos pelin aikana | `ResizeObserver` sovittaa kentän uudelleen, tähtäysviiva osoittaa oikein muutoksen jälkeen (`toWorld` käyttää uutta skaalaa) | **WP-L** |
| 3.5 | HiDPI (`deviceScaleFactor: 2`) | backing store = CSS-koko × 2, viivat ja pallo terävät, ei sumeaa blit-skaalausta | **MANUAALINEN** – WP-L:n ajo on `deviceScaleFactor: 1`; lead tarkistaa HiDPI-näytöllä tai Playwrightin `deviceScaleFactor: 2` -kontekstilla |
| 3.6 | `imageSmoothingEnabled = false` kokonaisskaaloilla | ruutugrafiikka pikselitarkkaa | **WP-L** (kuvakaappauksen suurennos) |
| 3.7 | Renderöintiharjoitus `/dev/render.html` | kaikki pinnat, seinät, kohteet piirtyvät; skaalautuu ikkunan mukana | **MANUAALINEN** – ei WP-L:n ajossa (`npm run dev` → `http://127.0.0.1:5173/dev/render.html`) |
| 3.8 | Tähtäys: hiiri → `toWorld` → `quantizeShot`; esikatselu = lähetetty lyönti | viiva alkaa pallosta, pysähtyy 120 px:ssä, tehopalkki punainen yli rajan | **WP-L** |

## 4. Kosketus (best-effort, §12.3)

| # | Tarkistus | Odotus | Tulos |
|---|-----------|--------|-------|
| 4.1 | Kosketusemulointi (Playwright `hasTouch: true`, esim. 412×915) | HUD näyttää **Lyö**-painikkeen (asetus `touchFireButton`, oletus päällä) | **MANUAALINEN** – WP-L:n ajossa ei kosketuskontekstia; lead: devtools-laite-emulointi tai WP-L lisää `hasTouch`-projektin |
| 4.2 | Veto missä tahansa kentällä tähtää suhteessa palloon; irrotus ei lyö | kyllä | **WP-L** |
| 4.3 | **Lyö**-painike lähettää kvantisoidun lyönnin | pallo liikkuu, lyöntilaskuri +1 | **WP-L** |
| 4.4 | Asetus "Kosketusnäytön Lyö-painike" pois → irrotus lyö | kyllä | **WP-L** |
| 4.5 | Pystyasento kapealla näytöllä | kenttä mahtuu leveyteen, HUD rivittyy; valikot vieritettäviä | **WP-L** |

## 5. Yksinpeli ja pelinäkymä (WP-E, WP-G)

| # | Tarkistus | Odotus | Tulos |
|---|-----------|--------|-------|
| 5.1 | Päävalikko: viisi painiketta, `/api/stats`-teksti ("Pelaajia verkossa: N" tai "Palvelin ei tavoitettavissa") | kyllä | **WP-L** – `e2e/screenshots/01-menu.png` |
| 5.2 | `#/play`: Perusradat / Omat radat / Tiedostosta, esikatselukuva, Aloita | 9 rataa listassa pienoiskuvineen | **WP-L** – `e2e/screenshots/05-play-setup.png` |
| 5.3 | Täysi 9 reiän kierros (ratkaistavuusfixtuurin lyönnit) | reikäyhteenvedot, kierrosyhteenveto, tuloskortti, ei `desync`-lokia | **WP-L** (`e2e/02-singleplayer.spec.ts`, yhden radan kierros näppäimistölyönneillä; `desync`-varoitukset tarkistetaan `e2e/helpers/app.ts`:ssä) – `e2e/screenshots/06-game-title-card.png`, `07-game-mid-shot.png`, `09-hole-summary.png`, `10-round-summary.png`. Täysi 9 reiän kierros selaimessa: **MANUAALINEN** |
| 5.4 | Esc-tauko: Jatka / Lopeta (in-page vahvistus) | kyllä | **WP-L** – `e2e/screenshots/12-pause.png` |
| 5.5 | Tab = tuloskortti | kyllä | **WP-L** – `e2e/screenshots/11-scorecard.png` |
| 5.6 | Näppäimistötähtäys ←/→/↑/↓, Shift-tarkkuus, Space/Enter lyö | lyönti kvantisoituu samoin kuin hiirellä (`input.test.ts`) | **OK** (yksikkötesti) + **WP-L** |
| 5.7 | Kielen vaihto Asetuksissa | näkymä renderöityy uudelleen englanniksi | **WP-L** – `e2e/screenshots/02-settings.png` (suomi) → `03-settings-english.png` (englanti) |
| 5.8 | `#/help`: ruutulegenda piirretään `tileArt`illa | kuvakkeet = pelin grafiikka | **WP-L** – `e2e/screenshots/04-help.png` |

## 6. Editori (WP-I, §13)

| # | Tarkistus | Odotus | Tulos |
|---|-----------|--------|-------|
| 6.1 | Uusi rata, sivellin/suorakulmio/täyttö/viiva/pyyhin/pipetti/tarkastele | ruudut muuttuvat, esikatselu 60 % alpha, ruudukko G | **WP-L** (`e2e/03-editor.spec.ts`) – `e2e/screenshots/13-editor.png` |
| 6.2 | Kohteet: lähtö, reikä, teleporttipari (ryhmänumero), magneetti (napaisuus, voima 50–500), miina | sijoitusinvariantit (§7.7): magneetti vaatii seinän, vaaraan maalaus poistaa kohteen (toast) | **WP-L** |
| 6.3 | Kumoa/Tee uudelleen (200 askelta, yksi per veto) | kyllä | **OK** (`tools.test.ts`) + **WP-L** |
| 6.4 | Live-validointi: virheet punaisella estävät Testaa/Vie/Jaa; varoitukset eivät | kyllä | **WP-L** – `e2e/screenshots/14-editor-validation-issue.png` |
| 6.5 | Tallenna / Avaa / Monista / Poista omissa radoissa; luonnos säilyy sivun päivityksen yli | kyllä | **WP-L** – `e2e/screenshots/14b-editor-library.png` (Omat radat -kirjasto) |
| 6.6 | Vie JSON / Lataa JSON / pudotus kentälle / Jaa koodina / Tuo koodista | sama rata palaa identtisenä (`courseId` sama) | **WP-L** |
| 6.7 | Testaa → `#/game` (HUD "Testaus · Esc: takaisin") → paluu editoriin historia tallella | kyllä | **WP-L** – `e2e/screenshots/15-editor-testplay.png` |
| 6.8 | Editorissa tehty rata pelattavissa yksinpelissä ja moninpelihuoneessa (`{kind:'custom', course}`) | kyllä; `b_`-tunniste korvataan (R13) | **OK** palvelinpuoli (`courseStore.test.ts`) + **WP-L** käyttöliittymä |

## 7. Kehittäjän säätöpaneeli `#/dev` (WP-K, §12.1)

| # | Tarkistus | Odotus | Tulos |
|---|-----------|--------|-------|
| 7.1 | Reitti `#/dev` rekisteröityy kuten muut `*.screen.ts` | `getScreenRegistry().has('#/dev')` | **OK** (`dev.screen.test.ts`) |
| 7.2 | Liukusäädin jokaiselle `SIM_TUNING_KEYS`-avaimelle paitsi `MAX_PULL_PX`/`MIN_PULL_PX` (R3) ja neljälle `MAGNET_MIN/MAX_*`-rajalle (R20) | 33 säädintä neljässä ryhmässä (39 avainta − 6); oletusarvo jokaisen alueella | **OK** (`dev.screen.test.ts`) |
| 7.3 | Säätö vaikuttaa heti (`setSimTuning`), muutetut rivit korostuvat, "N arvoa muutettu" | seuraava lyönti käyttää uutta arvoa (esim. `FRICTION_GRASS` 50 → pallo rullaa paljon pidemmälle) | **OK** 2026-10-04 – WP-K:n headless Chromium -savutesti tuotantobundlea vasten (1400×900): 37 säädintä, 5 ryhmää (ennen R20:tä; nyt 33 säädintä, 4 ryhmää – `dev.screen.test.ts`), `FRICTION_GRASS` → 50 korostaa rivin ja näyttää "1 arvoa muutettu"; lyönti välilyönnillä kasvattaa HUD:n lyöntilaskuria; 0 konsolivirhettä. Virallinen kuvakaappaus: **WP-L** – `e2e/screenshots/22-dev.png` (`e2e/01-menu.spec.ts`: säätimet, upotettu peli, muutos + palautus) |
| 7.4 | Ratavalitsin (perusradat + validit omat radat) käynnistää valitun radan uudelleen upotetussa pelissä | kyllä | **OK** – savutesti: valinta "5. Portaali" → HUD "Portaali · PAR 3 · LYÖNNIT 0" |
| 7.5 | "Palauta oletukset" → `resetSimTuning`, säätimet palaavat | "Kaikki arvot ovat oletuksia" | **OK** – savutesti: teksti palaa, liukusäädin 200 |
| 7.6 | "Kopioi arvot" → leikepöydälle `constants.ts`-katkelma (`export const NAME = value; // was X`) | katkelma kattaa 33 avainta, ei R3/R20-avaimia | **OK** – muoto (`dev.screen.test.ts`) ja leikepöytä (savutesti luki `export const FRICTION_GRASS = 50; // was 200`); ilman leikepöytäoikeutta näytetään tekstikenttä |
| 7.7 | Poistuminen sivulta → `resetSimTuning()`; moninpeli (`RoomSession`) nollaa säädöt rakentajassa | `isSimTuningDefault()` tosi | **OK** koodiluku (`dev.screen.ts unmount`, `roomClient.ts:142`); savutesti: "Takaisin" → `#/` ilman virheitä |
| 7.8 | Upotettu peli = sama `GameController` + `LocalHost` kuin `#/game`, `testPlay: true` | HUD-etiketti "Testaus · Esc: takaisin"; yhteenvedon "Takaisin editoriin" aloittaa radan alusta paneelissa | **OK** – savutesti näyttää etiketin ja pelaajasirun; etiketti neutraali (R20) |

## 8. Alkuperäisyys ja sisältö

| # | Tarkistus | Odotus | Tulos |
|---|-----------|--------|-------|
| 8.1 | Ei ulkoisia kuva-/äänitiedostoja (`packages/client/public` sisältää vain `favicon.svg`; grafiikka proseduraalista, äänet syntetisoituja) | kyllä | **OK** – `ls packages/client/public` → `favicon.svg` |
| 8.2 | Ratojen nimet ja asettelut omia (`docs/COURSES.md`) | kyllä | **OK** (`builtin.test.ts` vertaa COURSES.md:hen) |
| 8.3 | Käyttöliittymä suomeksi, englanti valinnaisena; `fi`/`en`-sanakirjat samat avaimet (ydin, mp, editori, dev) | kyllä | **OK** – `i18n.test.ts`, `mp.test.ts`, `fi.editor.test.ts`, `fi.dev.test.ts` |

---

## Yhteenveto 2026-10-04 (WP-K)

- Node-ajettavat rivit (0.x, 1.1–1.14, 2.1–2.11, 7.1–7.2, 7.6 muoto, 8.x): **OK** (2.9a korjattu R20:ssä).
- Rivi 1.15 ei ajettavissa Windowsissa ilman konttia; rivillä on leadille valmis `docker`-resepti.
- Selainrivit (3–7) viittaavat WP-L:n (`npm run e2e`, R18) oikeasti kirjoittamiin kuvakaappauksiin
  `e2e/screenshots/NN-*.png` (numerot 01–22 kertovat specien suoritusjärjestyksen; nimet luettu
  `e2e/*.spec.ts`-tiedostojen `shot()`-kutsuista 2026-10-04). Lead täyttää tuloksen kuvakaappausten perusteella.
- WP-L ajaa vain yhden viewportin (1280×800, `deviceScaleFactor` 1, ei kosketusta, ei offline-katkoa), joten rivit
  3.1, 3.3, 3.5, 3.7, 4.x ja 2.14 on merkitty **MANUAALINEN**: lead tarkistaa ne selaimessa tai pyytää WP-L:ltä
  lisäprojektit (`viewport`, `deviceScaleFactor: 2`, `hasTouch: true`, `context.setOffline`).
