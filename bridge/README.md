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
