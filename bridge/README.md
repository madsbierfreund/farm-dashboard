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

`LIVE_URL` er live-visningen paa dashboardet; udelades den, springes
live-opdateringerne over. `LIVE_INTERVAL_SECONDS` (standard 15) er den
korteste tid mellem to live-POST'er.

Laas filen ned og start tjenesten:

    chmod 600 ~/farm-dashboard/bridge/.env
    sudo cp ~/farm-dashboard/bridge/ph-bridge.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now ph-bridge

Log:

    journalctl -u ph-bridge -f

# pH-doser

`ph_doser.py` styrer pH-down doseringen. Den taler kun med den lokale
MQTT-broker og publicerer en tom besked til `farm/dose/ph_down`, som et
Homey-flow lytter paa og koerer pumpen i faste 5 sekunder. Ingen internetadgang
er noedvendig, og mistet net stopper aldrig doseringen.

Opret `~/farm-dashboard/bridge/.env.doser` med:

    MQTT_HOST=localhost
    MQTT_USER=farm
    MQTT_PASSWORD=...
    DOSE_TOPIC=farm/dose/ph_down
    ENABLED=true
    DOSE_ABOVE=6.3
    TARGET_PH=6.1
    COOLDOWN_MINUTES=30
    MAX_DOSES_PER_DAY=8
    CONSECUTIVE_READINGS=3
    STALE_SECONDS=120
    SANITY_MIN=4.0
    SANITY_MAX=9.0

Alle variabler har fornuftige standardvaerdier, saa kun MQTT-oplysningerne er
strengt noedvendige. Tilstanden (seneste dosistidspunkt og dagens taeller)
gemmes i `~/.ph_doser_state.json`, saa en genstart hverken nulstiller
nedkoelingen eller det daglige loft.

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
