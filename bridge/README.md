# Installation paa farm-pi

    sudo apt install -y git python3-venv
    cd ~
    git clone https://github.com/madsbierfreund/farm-dashboard.git
    python3 -m venv ~/bridge-venv
    ~/bridge-venv/bin/pip install paho-mqtt

Opret ~/farm-dashboard/bridge/.env med:

    MQTT_HOST=localhost
    MQTT_USER=farm
    MQTT_PASSWORD=...
    INGEST_URL=https://farm-dashboard.vercel.app/api/ingest
    INGEST_TOKEN=...
    INTERVAL_SECONDS=300
    LIVE_URL=https://farm-dashboard.vercel.app/api/live
    LIVE_INTERVAL_SECONDS=15
    DOSE_URL=https://farm-dashboard.vercel.app/api/dose
    ML_PER_SECOND=0.4
    SETTINGS_URL=https://farm-dashboard.vercel.app/api/settings
    SETTINGS_POLL_SECONDS=60

`LIVE_URL` er live-visningen paa dashboardet; udelades den, springes
live-opdateringerne over. `LIVE_INTERVAL_SECONDS` (standard 15) er den
korteste tid mellem to live-POST'er.

`DOSE_URL` logger doseringer i databasen: naar der kommer en koerselskommando
paa `farm/pump/1/run` (varighed i sekunder), udledes volumenet af varigheden
— `ml = sekunder * ML_PER_SECOND` (standard 0.4) — og sendes sammen med
sekunderne til endpointet. Saadan bliver reservoir-sporingen ved med at virke.
Udelades `DOSE_URL`, springes doseringsloggen over.

`SETTINGS_URL` henter doseringsindstillingerne fra web-panelet hvert
`SETTINGS_POLL_SECONDS` (standard 60) og relayer dem til MQTT-emnet
`farm/dose/settings` (retained), men kun naar de faktisk aendrede sig. Saadan
naar aendringer fra webben ud til doseren, uden at doseren nogensinde selv
afhaenger af internettet. Udelades `SETTINGS_URL`, springes relayet over.

Laas filen ned og start tjenesten:

    chmod 600 ~/farm-dashboard/bridge/.env
    sudo cp ~/farm-dashboard/bridge/ph-bridge.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now ph-bridge

Log:

    journalctl -u ph-bridge -f

# pH-doser

`ph_doser.py` styrer pH-down doseringen. Den taler kun med den lokale
MQTT-broker og publicerer varigheden i sekunder til `farm/pump/1/run`, hvorpaa
ESPHome-noden koerer pumpe 1 (pH-down) i `DOSE_SECONDS`. Homey-flowsene er ikke
laengere en del af doseringsvejen. Ingen internetadgang er noedvendig, og mistet
net stopper aldrig doseringen.

Opret `~/farm-dashboard/bridge/.env.doser` med:

    MQTT_HOST=localhost
    MQTT_USER=farm
    MQTT_PASSWORD=...
    DOSE_TOPIC=farm/pump/1/run
    DOSE_SECONDS=5.0
    ENABLED=true
    DOSE_ABOVE=6.3
    TARGET_PH=6.1
    COOLDOWN_MINUTES=30
    MAX_DOSES_PER_DAY=8
    CONSECUTIVE_READINGS=3
    STALE_SECONDS=120
    SANITY_MIN=4.0
    SANITY_MAX=9.0
    PH_EMERGENCY_FLOOR=5.0
    PH_EMERGENCY_LATCH_FILE=/var/lib/ph-doser/emergency.lock
    DOSE_WINDOW_S=8.0
    UNAUTHORIZED_MAX_STOPS=10
    STATE_STALE_S=900

Alle variabler har fornuftige standardvaerdier, saa kun MQTT-oplysningerne er
strengt noedvendige. Tilstanden (seneste dosistidspunkt, dagens taeller og de
sidst modtagne indstillinger) gemmes i `~/.ph_doser_state.json`, saa en
genstart hverken nulstiller nedkoelingen, det daglige loft eller falder
tilbage til env-vaerdierne.

**Indstillingerne aendres normalt fra web-panelet** ("Doseringsindstillinger"
under grafen). De felter — `enabled`, `dose_above` (doser over), `target_ph`
(maal), `cooldown_minutes` (nedkoeling), `max_doses_per_day` og
`consecutive_readings` (maalinger i traek) — relayes fra webben via
`farm/dose/settings` og overskriver env-vaerdierne i drift. Doseren validerer
dem paa ny og beholder de forrige, hvis noget er ugyldigt. `.env.doser` er
altsaa kun fallback ved foerste opstart (og hvis en modtaget besked er
ugyldig); de aktive vaerdier kan altid ses i `farm/dose/status`.

Laas filen ned og start tjenesten:

    chmod 600 ~/farm-dashboard/bridge/.env.doser
    sudo cp ~/farm-dashboard/bridge/ph-doser.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now ph-doser

Log:

    journalctl -u ph-doser -f

Foelg status live (beskeden er "retained", saa den sidste vises med det samme):

    mosquitto_sub -h localhost -u farm -P '...' -t farm/dose/status -v

## Stop doseringen med det samme

Stop tjenesten helt:

    sudo systemctl stop ph-doser

Eller saet doseringen paa pause uden at stoppe tjenesten — saet `ENABLED=false`
i `.env.doser` og genstart. Styringen bliver koerende og fortsaetter med at
sende status, men doserer ikke:

    sudo systemctl restart ph-doser

## Noedstop og laas (to uafhaengige sikkerhedsforanstaltninger)

Pumpen koeres nu af ESPHome-noden. Tidligere kunne Hue-broen selv taende
kontakten uden for vores kontrol — det skete én gang, og pumpen koerte i tolv
timer og trak tankens pH ned til 1,79. To uafhaengige sikkerhedsforanstaltninger
beskytter mod det:

1. **pH-gulv.** Falder pH under `PH_EMERGENCY_FLOOR` (standard 5,0) paa en
   maaling, sender doseren straks en besked til `farm/pump/stop_all` (som faar
   noden til at stoppe alle pumper), skriver en laasefil og logger en ERROR.
   Stop-beskeden gentages, saa laenge pH er under gulvet, hoejst én gang pr. 10
   sekunder. Tjekket koerer bevidst UDEN for sanitetstjekket, saa en reel,
   farligt lav pH ikke fejlagtigt ignoreres som "probe ude af vand".

2. **Laas.** Saa laenge laasefilen (`PH_EMERGENCY_LATCH_FILE`, standard
   `/var/lib/ph-doser/emergency.lock`) findes, doserer styringen **aldrig**,
   uanset pH. Den logger blokeringen som WARNING hoejst én gang pr. minut.
   Laasetilstanden vises ogsaa i `farm/dose/status` (`latched` og `latch`).

Laasen ryddes **kun** ved at slette filen manuelt — det er et bevidst valg, saa
en operatoer skal tjekke tanken, foer doseringen genoptages:

    sudo rm /var/lib/ph-doser/emergency.lock

Mappen `/var/lib/ph-doser` oprettes automatisk (ejet af tjenestens bruger) via
`StateDirectory=ph-doser` i unit-filen, saa den kan skrive laasefilen.

## Tilstands-watchdog (uautoriseret taend)

Noden publicerer pumpe 1's faktiske tilstand ("on"/"off", retained) til
`farm/pump/1/state`, og doseren lytter med som en watchdog:

- Kommer et **"on"** inden for `DOSE_WINDOW_S` (standard 8 s) af doserens egen
  seneste kommando til `farm/pump/1/run`, er det vores egen dosis — der sker
  intet.
- Ethvert andet "on" er **uautoriseret**: doseren sender straks et stop til
  `farm/pump/stop_all` og logger en ERROR med tiden siden sidste kommanderede
  dosis. Dette er uafhaengigt af pH og virker ogsaa, mens noedstop-laasen er
  sat.
- Bliver pumpen ved med at melde "on", gentages stoppet — hoejst ét pr. sekund.
  Efter `UNAUTHORIZED_MAX_STOPS` (standard 10) forgaeves stop uden et "off"
  saettes noedstop-laasen, og der logges en CRITICAL: pumpen reagerer ikke.
  Doseren bliver ved med at sende stop.
- Et **"off"** nulstiller taelleren for forgaeves stop.
- Er der ikke set en tilstand paa `farm/pump/1/state` i `STATE_STALE_S`
  (standard 900 s), logges en WARNING om, at watchdog'en er blind. Der laases
  **aldrig** paa staleness alene.

Pumpens sidst kendte tilstand, tidspunktet, om watchdog'en er blind, og
antallet af forgaeves stop vises ogsaa i `farm/dose/status`.

# EC-doser (goedning)

`ec_doser.py` styrer goedningsdoseringen (Terra Aquatica TriPart) ved siden af
pH-doseren. Den taler kun med den lokale MQTT-broker, samme moenster som
ph_doser.py. Pumperne er: 2 = Bloom, 3 = Micro, 4 = Grow.

En EC-dosis er TRE pumpekoersler i fast raekkefoelge med `PUMP_GAP_SECONDS`
(standard 60) imellem: **Micro (pumpe 3) → Grow (pumpe 4) → Bloom (pumpe 2)**.
Micro skal ALTID i foer Bloom — koncentreret calcium og fosfat udfaelder, hvis
de moedes. Volumener kommer fra et vaekststadie og en enkelt dosisstoerrelse
(`DOSE_ML_GROW`): Micro og Bloom skaleres fra Grow ved stadiets forhold. Hver
volumen omregnes til en varighed via pumpens gennemstroemning. Falder en
varighed uden for 0,5–30 s, springes HELE dosen over — en delvis dosis aendrer
forholdet.

Opret `~/farm-dashboard/bridge/.env.ec-doser` med:

    MQTT_HOST=localhost
    MQTT_USER=farm
    MQTT_PASSWORD=...
    EC_ENABLED=false
    EC_TARGET=1.8
    EC_DEADBAND=0.15
    EC_COOLDOWN_MINUTES=60
    EC_MAX_DOSES_PER_DAY=6
    EC_CONSECUTIVE_READINGS=3
    GROWTH_STAGE=growing
    DOSE_ML_GROW=2.0
    ML_PER_SECOND_PUMP_2=0.40
    ML_PER_SECOND_PUMP_3=0.36
    ML_PER_SECOND_PUMP_4=0.36
    PUMP_GAP_SECONDS=60
    EC_FLOOR=0.2
    EC_EMERGENCY_CEILING=4.0
    EC_EMERGENCY_LATCH_FILE=/var/lib/ec-doser/emergency.lock

Alle vaerdier har fornuftige standardvaerdier. `EC_ENABLED`, `EC_TARGET`,
`EC_DEADBAND`, `EC_COOLDOWN_MINUTES`, `EC_MAX_DOSES_PER_DAY`,
`EC_CONSECUTIVE_READINGS`, `GROWTH_STAGE` og `DOSE_ML_GROW` **aendres normalt fra
web-panelet** (afsnittet "EC-gødning") og relayes via `farm/ec/settings`;
env er kun fallback. Panelet viser de tre resulterende volumener, foer du gemmer.

Doseringsbeslutning: er EC under `EC_TARGET` minus `EC_DEADBAND` i
`EC_CONSECUTIVE_READINGS` maalinger i traek, doseres der (med nedkoeling og
dagligt loft som ph_doser).

Sikkerhed:

- **EC-gulv** (`EC_FLOOR`, standard 0,2): aflaesninger derunder ignoreres
  (probe ude af vand), saa der ikke doseres paa en falsk lav vaerdi.
- **EC-loft** (`EC_EMERGENCY_CEILING`, standard 4,0): gaar EC over loftet,
  sendes `farm/pump/stop_all`, en laasefil skrives, og der doseres ikke, foer
  filen slettes manuelt — samme form som ph_doser's pH-gulv og laas.
- Foer hver af de tre koersler tjekkes `farm/pump/<n>/state`; melder en pumpe
  "on" (fx pH-down koerer), afbrydes de resterende koersler.

Emner: EC laeses paa `farm/ph_node/sensor/ec/state`; koersler sendes til
`farm/pump/{3,4,2}/run`; status publiceres til `farm/ec/status` (aktuel EC,
taeller, nedkoeling, doser i dag, dagligt loft, stadie, de tre volumener og
varigheder, laasetilstand). Hver dosis logges ogsaa til `farm/ec/dose_log`, som
`ph_bridge.py` relayer til `/api/dose`, saa goedningsdoser ses paa dashboardet
med pumpenummer og goedningsnavn.

Laas filen ned, opret mappen til laasefilen (via unit'ens `StateDirectory`) og
start tjenesten:

    chmod 600 ~/farm-dashboard/bridge/.env.ec-doser
    sudo cp ~/farm-dashboard/bridge/ec-doser.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now ec-doser

Log og status:

    journalctl -u ec-doser -f
    mosquitto_sub -h localhost -u farm -P '...' -t farm/ec/status -v

Stop / ryd laas som for ph_doser:

    sudo systemctl stop ec-doser
    sudo rm /var/lib/ec-doser/emergency.lock

**Migration:** EC-indstillingerne kraever kolonnerne fra
`supabase/migrations/008_ec_settings.sql`. Koer den i Supabase' SQL Editor,
foer panelet og relayet bruges.

## Tests

    python3 -m unittest bridge.test_ph_doser bridge.test_ec_doser
