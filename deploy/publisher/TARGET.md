# Target: the Etcito publisher sidecar on the game VM

The publisher runs the `wavedash` and `butler` CLIs for the backoffice. This is
the human-readable companion to `deploy/publisher/publisher-deploy.ts`; its dry
run renders the plan described here and executes nothing.

## Host

- One Linux VM with systemd.
- Node.js >= 22.18 (type stripping: the publisher runs straight from TypeScript).
- The `wavedash` and `butler` CLIs on the service user's `PATH` (or set
  `WAVEDASH_BIN` / `BUTLER_BIN`).
- A dedicated system user owning the install dir and `PUBLISHER_DATA`.

## Service (systemd)

The unit name and the install dir are site-specific, so the deploy script takes
them as `--service` and `--app-dir`. Read them on the VM with
`systemctl list-units | grep publisher` and `systemctl cat <service>`.

Sample unit:

```ini
[Unit]
Description=Etcito publisher (wavedash + butler runner)
After=network-online.target

[Service]
User=publisher
WorkingDirectory=/opt/etcito-publisher
EnvironmentFile=/etc/gamesaloon-publisher.env
# = npm run publisher
ExecStart=/usr/bin/node --experimental-strip-types src/publisher/main.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

It listens on `127.0.0.1:9997`, behind nginx; the port is never exposed.
`GET /health` answers `{"ok":true}` without the bearer key.

## Environment

The env file (default `/etc/gamesaloon-publisher.env`, mode `640`) is created
from `deploy/publisher/etcito-publisher.env.example`. Variables, from the
header of `src/publisher/main.ts`:

| Variable | Meaning |
| --- | --- |
| `PUBLISHER_KEY` | Required bearer service key of every route except `/health` |
| `PUBLISHER_HOST` / `PUBLISHER_PORT` | Bind address and port (`127.0.0.1`, `9997`) |
| `PUBLISHER_DATA` | Data dir (`/var/lib/etcito-publisher`): artifacts, runs, `games.json` |
| `PUBLISHER_HOME` | CLI credential HOME of owner-game runs and status probes (`PUBLISHER_DATA/home`); creator runs get a private per-run HOME |
| `WAVEDASH_BIN` | `wavedash` binary (`wavedash`) |
| `BUTLER_BIN` | `butler` binary (`butler`) |
| `OWNER_GAMES` | Comma-separated game names treated as owner games (default empty) |
| `PUBLISHER_GAMES` | Optional JSON path `{"my-game":{"name":...,"game_id":...}}` (default `PUBLISHER_DATA/games.json`) |
| `PUBLISHER_MAX_QUEUE` | Maximum queued runs (`8`) |
| `PUBLISHER_WAVEDASH_CREATE_ARGS` | Optional JSON argv after the binary, with `{slug}`/`{name}`, that creates a Wavedash project; unset = 501; a bad value stops the start |
| `ETCITO_URL` / `ETCITO_API_KEY` | Optional tenant API + key, to mirror owner-game runs into `etc_deploy_runs` |

The deploy script never writes a secret: it only sets or replaces the
`PUBLISHER_WAVEDASH_CREATE_ARGS=` line, and only when `--create-args` is given.

## Deploy script

```sh
# Dry run: writes <dir>/plan.json, executes nothing.
node --experimental-strip-types deploy/publisher/publisher-deploy.ts \
  --host <user@host> --service <unit> --app-dir <dir> \
  [--env-file <path>] [--backup-root <dir>] [--health-url <url>] \
  [--create-args '<json argv>'] --dry-run --out <dir>

# Apply (milestone 7 only, after the owner's go): same flags, --apply instead.
node --experimental-strip-types deploy/publisher/publisher-deploy.ts \
  --host <user@host> --service <unit> --app-dir <dir> [options] --apply
```

Steps, in order (the run stops at the first failing one):

1. `backup`: tar `<appDir>/src` + `package.json` and copy the env file into the backup dir;
2. `stage`: rsync `src/publisher`, `src/store` and `package.json` to `/tmp/etcito-publisher-deploy/`;
3. `install`: copy the staging dir into `<appDir>`;
4. `env`: set the `PUBLISHER_WAVEDASH_CREATE_ARGS` line (only with `--create-args`);
5. `restart`: `systemctl restart <service>`, the only restart;
6. `health`: `curl <healthUrl>` must contain `"ok":true`; on failure it prints the restore command.

## Backups

`<backupRoot>/<stamp>/` (default root `/var/backups/etcito-publisher`, stamp
`YYYYMMDDTHHMMSSZ` UTC, or `--stamp`) holds:

- `app.tgz`: `<appDir>/src` and `<appDir>/package.json`;
- a copy of the env file (same basename, e.g. `gamesaloon-publisher.env`).

`PUBLISHER_DATA` is not touched by a deploy and is not in the backup.

## Restore

```sh
B=<backupRoot>/<stamp>
sudo tar -xzf $B/app.tgz -C <appDir>
sudo cp -a $B/<basename of envFile> <envFile>
sudo systemctl restart <service>
curl -fsS http://127.0.0.1:9997/health   # expect {"ok":true}
```

## Warning

`--apply` changes the live publisher: it is run only in milestone 7, after the
owner's go. Otherwise use the dry run and review `plan.json`.
