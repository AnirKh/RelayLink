# Running the server on the Raspberry Pi

The server on the Pi at home — the app's one server. It never sleeps, so the
first connection after a quiet hour is instant. Tailscale Funnel gives it its public
address, `https://raspberrypi.vulture-manta.ts.net/dc` — the path `/dc`,
because Funnel's root `/` already serves something else on port 8080, which
this leaves alone.

Written so that Claude on the Pi can follow it step by step. The person at the
Pi answers `sudo`'s password and fills in the secrets — **nobody pastes a key
into a chat**.

What is already known about the Pi (checked 2026-10-30): Raspberry Pi 4, 4 GB,
Kali Linux (aarch64), Node v24, git, systemd, Tailscale 1.104 with Funnel on
and `/` → `http://127.0.0.1:8080`. npm is missing.

## Ground rules

- Do not touch Funnel's existing `/` route or whatever runs on port 8080.
- Do not open any port on the router; Funnel is the only way in.
- Never print, log or ask for the contents of `/etc/direct-connection.env`
  past its variable names.
- Stop and report if a step fails, rather than improvising around it.

## 1. npm

```sh
sudo apt-get update
sudo apt-get install -y npm
node -v      # still v22 or newer
npm -v
command -v node    # the service file assumes /usr/bin/node — note it if not
```

## 2. A user of its own, and the code

The server runs as `dc`, a system user with no login and no password.

```sh
sudo useradd --system --home-dir /var/lib/direct-connection --create-home --shell /usr/sbin/nologin dc
sudo install -d -o dc -g dc /opt/direct-connection
sudo runuser -u dc -- env HOME=/var/lib/direct-connection git clone https://github.com/AnirKh/RelayLink.git /opt/direct-connection
cd /opt/direct-connection
sudo runuser -u dc -- env HOME=/var/lib/direct-connection npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

## 3. Its settings

```sh
sudo install -m 640 -o root -g dc deploy/pi/direct-connection.env.example /etc/direct-connection.env
```

Then **the person at the Pi** opens it — `sudo nano /etc/direct-connection.env`
— and fills in the two values: `KNOCK_PUBLIC_KEY` and `KNOCK_PRIVATE_KEY`
(made once with `node tools/knock-keys.js`; moving to a new Pi, copy the pair
from the old one's file, so alerts already turned on keep working). Leave the
rest as it is.

## 4. Start it, and keep it up to date

```sh
sudo install -m 644 deploy/pi/direct-connection.service deploy/pi/direct-connection-update.service deploy/pi/direct-connection-update.timer /etc/systemd/system/
sudo install -m 755 deploy/pi/update.sh /usr/local/sbin/direct-connection-update
sudo systemctl daemon-reload
sudo systemctl enable --now direct-connection.service direct-connection-update.timer
systemctl status direct-connection --no-pager | head -5
curl -s http://127.0.0.1:3000/api/ping
```

The last line should print `{"ok":true, …, "knockKey":"B…"}` — `knockKey` not
null means the keys were read. The timer then checks GitHub every two minutes
and restarts the server when there is something new that GitHub's tests have
passed. `update.sh` is installed as a copy: if it ever changes in the
repository, install it again by hand — see section 9.

## 5. The public address

Add `/dc` beside the existing route — `/` stays as it is:

```sh
sudo tailscale funnel --bg --set-path=/dc http://127.0.0.1:3000
tailscale funnel status
curl -s https://raspberrypi.vulture-manta.ts.net/dc/api/ping
```

The last line should print the same `{"ok":true, …}`. If instead it says
`Cannot GET /dc/api/ping`, Funnel passes `/dc` on instead of taking it off:
uncomment `BASE_PATH=/dc` in `/etc/direct-connection.env`,
`sudo systemctl restart direct-connection`, and try again.

## 6. Through Funnel from outside: the live link, and who it comes from

From the Pi itself the name resolves inside the tailnet, which skips Funnel.
`--doh-url` asks public DNS instead, so this goes out to the internet and
comes back in through Funnel, the way every user will:

```sh
curl -s --http1.1 --max-time 4 --doh-url https://cloudflare-dns.com/dns-query -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: https://anirkh.github.io" \
  https://raspberrypi.vulture-manta.ts.net/dc
```

It should print `101` (it then waits out the four seconds — that is fine).

The server writes a short hash of each link's address. Every rate limit keys
on that address, so it must be the visitor's own, not Funnel's `127.0.0.1`:

```sh
journalctl -u direct-connection --since "-3 min" --no-pager | grep "Client connected" | tail -3
printf '%s' 127.0.0.1 | sha256sum | cut -c1-10
printf '%s' ::ffff:127.0.0.1 | sha256sum | cut -c1-10
printf '%s' "$(curl -s https://api.ipify.org)" | sha256sum | cut -c1-10
```

The hash in the last "Client connected" line should match the **last** one
(this Pi's public address, as Funnel saw it) and **not** either of the
`127.0.0.1` ones.

## 7. Report back

- each step's result: npm version, the service's status line, both `/api/ping`
  answers (with `knockKey` shortened to its first 10 characters), whether
  `BASE_PATH` was needed, the WebSocket code, and the three hashes compared
- `tailscale funnel status`
- `journalctl -u direct-connection -n 15 --no-pager`
- anything that did not go as written

The app talks to the address in `DEFAULT_SERVER_URL` (app.js). A Pi at a new
address needs it changed there — in the repository, once this report says
everything works.

## 8. When the service file changes

The updater brings new code, never a new service file: that would let what
comes from GitHub change how — and as whom — it runs. When
`deploy/pi/direct-connection.service` changes, install it again by hand. It
did on 2026-10-30, for messages waiting for someone: a folder of the
server's own to keep them in, so a restart — every update is one — loses
none.

```sh
sudo install -m 644 /opt/direct-connection/deploy/pi/direct-connection.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart direct-connection
journalctl -u direct-connection -n 8 --no-pager | grep Mailbox
```

The last line should say `Mailbox: kept in /var/lib/direct-connection/mailbox.json`
— not "in memory only".

## 9. When update.sh changes

The timer runs the installed copy, `/usr/local/sbin/direct-connection-update`,
not the repository's — so what comes from GitHub never runs as root. When
`deploy/pi/update.sh` changes, install it again by hand. It did on 2026-11-06:
the Pi now moves only to a commit whose tests passed on GitHub
(`deploy/pi/ci-passed.js`), so a push that breaks the tests never reaches it.

```sh
sudo install -m 755 /opt/direct-connection/deploy/pi/update.sh /usr/local/sbin/direct-connection-update
grep -c ci-passed /usr/local/sbin/direct-connection-update
sudo systemctl start direct-connection-update
journalctl -u direct-connection-update -n 5 --no-pager
```

The `grep` should print `1`. The journal shows nothing new when the Pi is up
to date, "Waiting for GitHub's tests to pass for …" while a push is being
tested or after its tests failed, and "Direct Connection updated to …" once
they pass. "Could not ask GitHub about the tests" means GitHub did not answer
— the Pi stays as it is and asks again two minutes later.
