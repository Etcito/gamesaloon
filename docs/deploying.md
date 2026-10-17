# Deploying

A generic recipe for one Linux machine: the server under systemd, a reverse proxy that terminates TLS and passes the WebSocket upgrade, and optionally coturn for WebRTC relay. Hostnames below (`rooms.example.com`) are placeholders. Example files live in `deploy/` (`rooms.service`, `rooms.env.example`, `nginx.conf.example`, `Caddyfile.example`, `turnserver.conf.example`); a container setup is in [../Dockerfile](../Dockerfile) and [../docker-compose.yml](../docker-compose.yml).

## What runs where

- One Node process listens on `127.0.0.1:8787` (plain HTTP and WebSocket). It serves `GET /health`, the WebSocket path `/ws`, and, when payments are used, `POST /webhooks/...` (see [economy.md](economy.md)).
- A reverse proxy listens on 443 with TLS and forwards to it. Clients use `wss://rooms.example.com/ws`.
- coturn (optional) relays WebRTC traffic for players behind restrictive networks. Only the rooms protocol uses ICE servers.
- State: with `PLAYER_STORE=memory` there is none; restarting the server drops all rooms and players. With `PLAYER_STORE=http` the state lives in the remote table service.
- **One instance.** Room state, locks and rate counters are in process. Do not run two copies behind a load balancer.

## 1. Install

Requirements: Node 22.18 or newer (the server runs straight from TypeScript source with `--experimental-strip-types`, no build step).

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin rooms
sudo mkdir -p /opt/gamesaloon
sudo cp -r . /opt/gamesaloon          # the repository, without .git if you like
cd /opt/gamesaloon && sudo npm install --omit=dev
sudo chown -R root:root /opt/gamesaloon
```

(`deploy/rooms.service` as shipped uses `/opt/kart-rooms`, `/etc/kart-rooms.env` and the unit name `kart-rooms`; use those names, or rename them consistently in the unit and below.)

## 2. Configure

Copy `deploy/rooms.env.example` to an environment file readable by the service user only, and edit it:

```sh
sudo cp deploy/rooms.env.example /etc/gamesaloon.env
sudo chown root:rooms /etc/gamesaloon.env && sudo chmod 640 /etc/gamesaloon.env
```

Typical content (all variables are in [configuration.md](configuration.md)):

```sh
PORT=8787
HOST=127.0.0.1
ALLOWED_ORIGINS=https://game.example.com
MAX_ROOMS=500
MAX_CLIENTS=2000
LOG_LEVEL=info
# TURN (see section 5)
#TURN_URLS=turn:rooms.example.com:3478?transport=udp,turn:rooms.example.com:3478?transport=tcp,turns:rooms.example.com:5349?transport=tcp
#TURN_SECRET=<long random secret, same as coturn static-auth-secret>
```

Keep secrets (`TURN_SECRET`, `ETCITO_GAME_KEYS`) in this file or a file referenced from it, never in the unit or the repository.

## 3. systemd

```ini
[Unit]
Description=GameSaloon server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rooms
WorkingDirectory=/opt/gamesaloon
EnvironmentFile=/etc/gamesaloon.env
ExecStart=/usr/bin/node --experimental-strip-types src/main.ts
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo cp deploy/rooms.service /etc/systemd/system/gamesaloon.service   # after editing the paths as above
sudo systemctl daemon-reload
sudo systemctl enable --now gamesaloon
journalctl -u gamesaloon -f
```

The process exits on a configuration error with a `[config] <NAME>` message, and shuts down gracefully on `SIGTERM` (`systemctl stop`). If you use `ETCITO_GAME_KEYS_FILE`, the service user needs read access to that file; with `ProtectSystem=strict` reading is all it needs.

## 4. Reverse proxy with TLS and WebSocket

The proxy must forward the HTTP/1.1 `Upgrade` and `Connection` headers on `/ws`, and keep idle connections longer than the server's heartbeats (the rooms side pings every 20 s, the relay every 30 s): a read timeout of 75 s is used below.

### nginx

```nginx
server {
    listen 80;
    server_name rooms.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name rooms.example.com;

    ssl_certificate     /etc/letsencrypt/live/rooms.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rooms.example.com/privkey.pem;

    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 75s;
    }

    location /health {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Only when payments are used (Wavedash / Stripe webhooks). Forward the whole prefix:
    # /webhooks/stripe/<game> must reach the server too.
    location /webhooks/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

`deploy/nginx.conf.example` has the `/ws`, `/health` and `/webhooks/` blocks (the last one is only needed if you take payments).

### Caddy

Caddy gets certificates automatically and passes the upgrade headers by itself:

```
rooms.example.com {
	@ws path /ws
	reverse_proxy @ws 127.0.0.1:8787
	reverse_proxy /health 127.0.0.1:8787
	reverse_proxy /webhooks/* 127.0.0.1:8787
}
```

### Check it

```sh
curl https://rooms.example.com/health
# {"ok":true,"rooms":0,"clients":0,"version":"0.1.0"}
```

and connect a WebSocket client to `wss://rooms.example.com/ws` ([client-integration.md](client-integration.md)). If `ALLOWED_ORIGINS` is set, the client's page origin must be listed exactly, or the upgrade is answered 403.

## 5. TURN (optional)

Most players connect peer to peer with the default public STUN server. For the rest you need TURN. The server issues time-limited credentials (valid 24 hours) derived from a shared secret, so coturn needs no user database.

1. Install coturn and start from `deploy/turnserver.conf.example`. The relevant lines: `use-auth-secret`, `static-auth-secret=<secret>`, `realm=rooms.example.com`, the TLS certificate paths, `min-port=49152`, `max-port=65535`, and `denied-peer-ip` ranges that keep the relay from reaching private networks.
2. Put the **same** secret in `TURN_SECRET` and the URLs in `TURN_URLS`.
3. The credentials are sent to rooms clients in `welcome.iceServers`: `username = "<unix expiry>:<client id>"`, `credential = base64(HMAC-SHA1(secret, username))`.

TURN is disabled when `TURN_SECRET` is empty.

## 6. Firewall

Open: `80/tcp` and `443/tcp` (proxy). With coturn also `3478/udp`, `3478/tcp`, `5349/tcp` and the relay range `49152-65535/udp`. Keep `8787` closed to the outside: the server binds to localhost.

## 7. Operating

- **Logs**: stdout and stderr to the journal. `LOG_LEVEL=debug` is verbose.
- **Upgrades**: stop, replace the files, `npm install --omit=dev`, start. Connected players are disconnected during the restart; rooms are lost (they are in memory), and with `PLAYER_STORE=memory` so are all players and ratings.
- **Limits to size for**: `MAX_ROOMS`, `MAX_CLIENTS` (rooms side), plus the fixed relay limits (200 sessions, 500 sockets). Frames: 64 KiB for rooms, 4 KiB for relay messages, 512 KiB for the extension messages.
- **Health checks**: `GET /health` is cheap and unauthenticated; do not expose anything else of the process.
- **Behind a proxy** the server does not read `X-Forwarded-For`; rate limits are per connection, not per client address.
